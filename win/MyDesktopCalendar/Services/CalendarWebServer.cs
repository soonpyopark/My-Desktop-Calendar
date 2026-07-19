using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Optional local HTTP server (PORT / HOSTNAME / ALLOWED_HOSTS from .env)
/// so the same React UI can be opened in a browser while the WPF app runs.
/// Exposes <c>/ws</c> for live <c>store-changed</c> push to browser tabs.
/// </summary>
internal sealed class CalendarWebServer : IDisposable
{
    private readonly NativeBridge _bridge;
    private readonly string _wwwroot;
    private readonly ConcurrentDictionary<Guid, WebSocket> _sockets = new();
    private HttpListener? _listener;
    private CancellationTokenSource? _cts;
    private Task? _loop;

    public int Port { get; private set; }
    public string Hostname { get; private set; } = "127.0.0.1";
    public bool IsRunning => _listener?.IsListening == true;
    public bool LanMode { get; private set; }
    public IReadOnlyList<string> Addresses { get; private set; } = [];

    public CalendarWebServer(NativeBridge bridge, string wwwroot)
    {
        _bridge = bridge;
        _wwwroot = wwwroot;
    }

    /// <summary>
    /// Start using PORT / HOSTNAME / ALLOWED_HOSTS from .env (skipped when PORT is unset).
    /// </summary>
    public bool TryStart(out string message)
        => TryStart(hostnameOverride: null, allowedHostsOverride: null, requirePortInEnv: true, out message);

    /// <summary>
    /// Start the HTTP listener. Non-null overrides win over .env for hostname / Allowed-Hosts.
    /// When <paramref name="requirePortInEnv"/> is false and PORT is missing, defaults to 3010
    /// (tray Start Server local/Web modes).
    /// </summary>
    public bool TryStart(
        string? hostnameOverride,
        string? allowedHostsOverride,
        bool requirePortInEnv,
        out string message)
    {
        message = "";
        if (IsRunning)
        {
            message = "HTTP server is already running.";
            return false;
        }

        var env = DotEnv.Load();
        if (!TryReadPort(env, out var port))
        {
            if (requirePortInEnv)
            {
                message = "PORT not set — HTTP server skipped.";
                return false;
            }

            port = 3010;
        }

        var hostname = (hostnameOverride ?? Pick(env, "HOSTNAME", "MYCALENDAR_HOSTNAME", "NEOCALENDAR_HOSTNAME") ?? "127.0.0.1").Trim();
        if (hostname is "" or "localhost")
        {
            hostname = "127.0.0.1";
        }

        var allowedHosts = ParseAllowedHosts(
            allowedHostsOverride
            ?? Pick(env, "ALLOWED_HOSTS", "MYCALENDAR_ALLOWED_HOSTS", "NEOCALENDAR_ALLOWED_HOSTS"));
        // http.sys ACL reservations are matched by exact prefix string, not by IP scope — a
        // reservation for "http://+:{port}/" does NOT cover a literal "127.0.0.1" prefix.
        // So "local" mode must also bind the wildcard prefix (same namespace as "Web" mode);
        // Allowed-Hosts (checked per-request, see IsHostAllowed) is what keeps it loopback-only.
        var loopbackOnly = IsLoopbackOnlyHosts(allowedHosts);

        Port = port;
        Hostname = hostname;
        LanMode = hostname is "0.0.0.0" or "*" or "+" && !loopbackOnly;

        var prefixes = BuildPrefixes(hostname, port);
        var listener = new HttpListener();
        foreach (var prefix in prefixes)
        {
            listener.Prefixes.Add(prefix);
        }

        try
        {
            listener.Start();
        }
        catch (HttpListenerException ex)
        {
            var usesWildcardPrefix = hostname is "0.0.0.0" or "*" or "+";
            message =
                $"HTTP listen failed ({ex.Message}). "
                + (usesWildcardPrefix
                    ? $"관리자 PowerShell에서 URL ACL이 필요할 수 있습니다:\nnetsh http add urlacl url=http://+:{port}/ user=Everyone"
                    : "다른 프로그램이 포트를 사용 중이거나 권한이 없습니다.");
            listener.Close();
            return false;
        }

        _listener = listener;
        _cts = new CancellationTokenSource();
        Addresses = loopbackOnly
            ? [$"http://127.0.0.1:{port}/"]
            : BuildAddressList(hostname, port);
        _loop = Task.Run(() => ListenLoop(allowedHosts, _cts.Token));
        message = $"HTTP {string.Join(", ", Addresses)} (+ /ws)";
        return true;
    }

    /// <summary>Stop listening without disposing the instance (can <see cref="TryStart"/> again).</summary>
    public void Stop()
    {
        try
        {
            _cts?.Cancel();
            foreach (var pair in _sockets)
            {
                try
                {
                    pair.Value.Abort();
                    pair.Value.Dispose();
                }
                catch
                {
                    /* ignore */
                }
            }

            _sockets.Clear();
            _listener?.Stop();
            _listener?.Close();
        }
        catch
        {
            /* ignore */
        }

        _listener = null;
        _cts = null;
        _loop = null;
        Addresses = [];
        LanMode = false;
    }

    public void Dispose()
    {
        Stop();
    }

    /// <summary>Push store-changed to all browser WebSocket clients (local app already gets WebView postMessage).</summary>
    public void BroadcastStoreChanged(string? updatedAt)
    {
        if (_sockets.IsEmpty)
        {
            return;
        }

        var payload = new JsonObject
        {
            ["type"] = "store-changed",
            ["updatedAt"] = updatedAt ?? DateTime.UtcNow.ToString("o"),
        };
        var bytes = Encoding.UTF8.GetBytes(payload.ToJsonString(JsonUtil.Compact));
        _ = Task.Run(() => BroadcastAsync(bytes));
    }

    private async Task BroadcastAsync(byte[] bytes)
    {
        foreach (var pair in _sockets)
        {
            var socket = pair.Value;
            if (socket.State != WebSocketState.Open)
            {
                RemoveSocket(pair.Key, socket);
                continue;
            }

            try
            {
                await socket.SendAsync(
                    bytes,
                    WebSocketMessageType.Text,
                    endOfMessage: true,
                    CancellationToken.None);
            }
            catch
            {
                RemoveSocket(pair.Key, socket);
            }
        }
    }

    private void RemoveSocket(Guid id, WebSocket socket)
    {
        _sockets.TryRemove(id, out _);
        try
        {
            socket.Dispose();
        }
        catch
        {
            /* ignore */
        }
    }

    private async Task ListenLoop(HashSet<string> allowedHosts, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && _listener is { IsListening: true } listener)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = await listener.GetContextAsync().WaitAsync(ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (HttpListenerException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }

            _ = Task.Run(() => HandleRequestAsync(ctx, allowedHosts, ct), ct);
        }
    }

    private async Task HandleRequestAsync(HttpListenerContext ctx, HashSet<string> allowedHosts, CancellationToken ct)
    {
        try
        {
            var req = ctx.Request;
            var res = ctx.Response;

            if (!IsHostAllowed(req.UserHostName, allowedHosts))
            {
                WriteText(res, 403, "Forbidden host");
                return;
            }

            var clientIp = IpAccessGuard.GetClientIp(req);
            if (!IpAccessGuard.IsClientAllowed(clientIp, _bridge.GetAllowedIpCidrs()))
            {
                WriteHtml(res, 403, IpAccessGuard.BlockedHtml());
                return;
            }

            if (req.HttpMethod == "OPTIONS")
            {
                AddCors(res);
                res.StatusCode = 204;
                res.Close();
                return;
            }

            var path = req.Url?.AbsolutePath ?? "/";
            if (path.Equals("/ws", StringComparison.OrdinalIgnoreCase))
            {
                await AcceptWebSocketAsync(ctx, ct);
                return;
            }

            if (path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase))
            {
                HandleApi(req, res, path);
                return;
            }

            ServeStatic(res, path);
        }
        catch (Exception ex)
        {
            try
            {
                WriteJson(ctx.Response, 500, new JsonObject { ["error"] = ex.Message });
            }
            catch
            {
                /* ignore */
            }
        }
    }

    private async Task AcceptWebSocketAsync(HttpListenerContext ctx, CancellationToken ct)
    {
        if (!ctx.Request.IsWebSocketRequest)
        {
            WriteText(ctx.Response, 400, "Expected WebSocket upgrade");
            return;
        }

        HttpListenerWebSocketContext wsContext;
        try
        {
            wsContext = await ctx.AcceptWebSocketAsync(subProtocol: null);
        }
        catch (Exception ex)
        {
            try
            {
                WriteText(ctx.Response, 500, ex.Message);
            }
            catch
            {
                /* ignore */
            }

            return;
        }

        var id = Guid.NewGuid();
        var socket = wsContext.WebSocket;
        _sockets[id] = socket;

        var buffer = new byte[1024];
        try
        {
            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            /* shutting down */
        }
        catch (WebSocketException)
        {
            /* client gone */
        }
        finally
        {
            try
            {
                if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                {
                    await socket.CloseAsync(
                        WebSocketCloseStatus.NormalClosure,
                        "bye",
                        CancellationToken.None);
                }
            }
            catch
            {
                /* ignore */
            }

            RemoveSocket(id, socket);
        }
    }

    private void HandleApi(HttpListenerRequest req, HttpListenerResponse res, string path)
    {
        JsonObject body = new();
        if (req.HttpMethod is "POST" or "PUT" or "PATCH")
        {
            using var reader = new StreamReader(req.InputStream, req.ContentEncoding);
            var raw = reader.ReadToEnd();
            if (!string.IsNullOrWhiteSpace(raw))
            {
                try
                {
                    body = JsonNode.Parse(raw) as JsonObject ?? new JsonObject();
                }
                catch (JsonException)
                {
                    WriteJson(res, 400, new JsonObject { ["error"] = "Invalid JSON body" });
                    return;
                }
            }
        }

        var token = AuthService.ExtractToken(req.Headers["Authorization"], req.Headers["X-Admin-Token"]);
        try
        {
            var result = _bridge.HandleApi(req.HttpMethod, path, body, token);
            if (result is null)
            {
                res.StatusCode = 204;
                AddCors(res);
                res.Close();
                return;
            }

            WriteJson(res, 200, result);
        }
        catch (UnauthorizedAccessException ex)
        {
            WriteJson(res, 401, new JsonObject { ["error"] = ex.Message });
        }
        catch (Exception ex)
        {
            WriteJson(res, 400, new JsonObject { ["error"] = ex.Message });
        }
    }

    private void ServeStatic(HttpListenerResponse res, string urlPath)
    {
        var relative = urlPath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
        if (string.IsNullOrEmpty(relative) || relative.EndsWith(Path.DirectorySeparatorChar))
        {
            relative = "index.html";
        }

        var full = Path.GetFullPath(Path.Combine(_wwwroot, relative));
        var rootFull = Path.GetFullPath(_wwwroot);
        if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
        {
            // SPA fallback
            full = Path.Combine(rootFull, "index.html");
            if (!File.Exists(full))
            {
                WriteText(res, 404, "Not found");
                return;
            }
        }

        var bytes = File.ReadAllBytes(full);
        res.StatusCode = 200;
        res.ContentType = GuessContentType(full);
        res.ContentLength64 = bytes.Length;
        AddCors(res);
        res.OutputStream.Write(bytes, 0, bytes.Length);
        res.Close();
    }

    private static string GuessContentType(string path)
    {
        var ext = Path.GetExtension(path).ToLowerInvariant();
        return ext switch
        {
            ".html" => "text/html; charset=utf-8",
            ".js" => "text/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            ".ico" => "image/x-icon",
            ".woff2" => "font/woff2",
            ".map" => "application/json",
            _ => "application/octet-stream",
        };
    }

    private static void WriteJson(HttpListenerResponse res, int status, JsonNode payload)
    {
        var json = payload.ToJsonString(JsonUtil.Compact);
        var bytes = Encoding.UTF8.GetBytes(json);
        res.StatusCode = status;
        res.ContentType = "application/json; charset=utf-8";
        res.ContentLength64 = bytes.Length;
        AddCors(res);
        res.OutputStream.Write(bytes, 0, bytes.Length);
        res.Close();
    }

    private static void WriteText(HttpListenerResponse res, int status, string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        res.StatusCode = status;
        res.ContentType = "text/plain; charset=utf-8";
        res.ContentLength64 = bytes.Length;
        AddCors(res);
        res.OutputStream.Write(bytes, 0, bytes.Length);
        res.Close();
    }

    private static void WriteHtml(HttpListenerResponse res, int status, string html)
    {
        var bytes = Encoding.UTF8.GetBytes(html);
        res.StatusCode = status;
        res.ContentType = "text/html; charset=utf-8";
        res.ContentLength64 = bytes.Length;
        AddCors(res);
        res.OutputStream.Write(bytes, 0, bytes.Length);
        res.Close();
    }

    private static void AddCors(HttpListenerResponse res)
    {
        res.Headers["Access-Control-Allow-Origin"] = "*";
        res.Headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Admin-Token";
        res.Headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
    }

    private static bool TryReadPort(Dictionary<string, string> env, out int port)
    {
        port = 0;
        var raw = Pick(env, "PORT", "MYCALENDAR_PORT", "NEOCALENDAR_PORT");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        return int.TryParse(raw.Trim(), out port) && port is > 0 and < 65536;
    }

    private static string? Pick(Dictionary<string, string> env, params string[] keys)
    {
        foreach (var key in keys)
        {
            var fromProcess = Environment.GetEnvironmentVariable(key);
            if (!string.IsNullOrWhiteSpace(fromProcess))
            {
                return fromProcess;
            }

            if (env.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        return null;
    }

    private static HashSet<string> ParseAllowedHosts(string? raw)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(raw) || raw.Trim() == "*")
        {
            set.Add("*");
            return set;
        }

        foreach (var part in raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            set.Add(part);
        }

        return set;
    }

    /// <summary>True when Allowed-Hosts is a non-wildcard set containing only loopback host names.</summary>
    private static bool IsLoopbackOnlyHosts(HashSet<string> allowed)
    {
        if (allowed.Contains("*") || allowed.Count == 0)
        {
            return false;
        }

        return allowed.All(host => host is "127.0.0.1" or "localhost" or "::1" or "[::1]");
    }

    private static bool IsHostAllowed(string? userHostName, HashSet<string> allowed)
    {
        if (allowed.Contains("*"))
        {
            return true;
        }

        var host = (userHostName ?? "").Split(':')[0].Trim();
        if (host.Length == 0)
        {
            return true;
        }

        return allowed.Contains(host);
    }

    private static List<string> BuildPrefixes(string hostname, int port)
    {
        if (hostname is "0.0.0.0" or "*" or "+")
        {
            return [$"http://+:{port}/"];
        }

        return [$"http://{hostname}:{port}/"];
    }

    private static List<string> BuildAddressList(string hostname, int port)
    {
        if (hostname is "0.0.0.0" or "*" or "+")
        {
            var list = new List<string> { $"http://127.0.0.1:{port}/" };
            try
            {
                foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up)
                    {
                        continue;
                    }

                    var props = ni.GetIPProperties();
                    foreach (var addr in props.UnicastAddresses)
                    {
                        if (addr.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork
                            && !IPAddress.IsLoopback(addr.Address))
                        {
                            list.Add($"http://{addr.Address}:{port}/");
                        }
                    }
                }
            }
            catch
            {
                /* ignore */
            }

            return list.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }

        return [$"http://{hostname}:{port}/"];
    }
}
