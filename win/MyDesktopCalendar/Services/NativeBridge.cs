using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using MyDesktopCalendar.Native;
using Application = System.Windows.Application;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Routes React UI requests (formerly HTTP /api/*) over WebView2 postMessage.
/// No network server — all calendar I/O is in-process.
/// </summary>
internal sealed class NativeBridge
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        TypeInfoResolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver(),
    };

    private readonly CalendarStoreService _store;
    private readonly AuthService _auth;
    private readonly DesktopEmbedService _embed;
    private readonly UndockZoneMonitor _undockZones;
    private readonly Window _window;
    private readonly EventAttachmentService _attachments;
    private DesktopSurfaceController? _surfaces;
    private WebView2? _webView;
    private string? _currentToken;
    private string? _currentUsername;
    private bool _currentRemember;

    /// <summary>Suspend/pending-reopen state for the App overlay — see <see cref="DesktopSurfaceState"/>.</summary>
    private readonly DesktopSurfaceState _surfaceState = new();
    /// <summary>Last applied frame theme; skip redundant Apply to avoid window-mode flash.</summary>
    private bool? _frameThemeDark;

    public CalendarWebServer? WebServer { get; set; }

    public NativeBridge(
        CalendarStoreService store,
        AuthService auth,
        DesktopEmbedService embed,
        UndockZoneMonitor undockZones,
        Window window)
    {
        _store = store;
        _auth = auth;
        _embed = embed;
        _undockZones = undockZones;
        _window = window;
        _attachments = new EventAttachmentService(store);
        _store.StoreChanged += OnStoreChanged;
        _store.AttachmentFilesDeleted += ids => _attachments.DeleteAllForEvents(ids);
    }

    public void BindSurfaces(DesktopSurfaceController surfaces)
    {
        _surfaces = surfaces;
    }

    /// <summary>LAN HTTP allowlist from settings (empty = allow all remote IPs).</summary>
    public JsonNode? GetAllowedIpCidrs()
    {
        try
        {
            var settings = _store.ReadStore()["settings"] as JsonObject;
            return settings?["allowedIpCidrs"];
        }
        catch
        {
            return null;
        }
    }

    public void Attach(WebView2 webView)
    {
        DetachPrimary();
        _webView = webView;
        webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        webView.CoreWebView2.NavigationCompleted += (_, args) =>
        {
            if (args.IsSuccess)
            {
                ApplyFrameTheme(ResolveDarkFromSettings());
                _embed.RefreshContentAlpha();
            }
        };
        ApplyFrameTheme(ResolveDarkFromSettings());
        _embed.RefreshContentAlpha();
    }

    public void DetachPrimary()
    {
        try
        {
            if (WebView2Safe.TryGetCore(_webView) is { } core)
            {
                core.WebMessageReceived -= OnWebMessageReceived;
            }
        }
        catch
        {
            /* disposed */
        }
        finally
        {
            _webView = null;
        }
    }

    public void NotifyWidgetStatus()
    {
        var status = BuildWidgetStatus();
        PostEvent(new JsonObject
        {
            ["type"] = "widget-status",
            ["status"] = status.DeepClone(),
        });
    }

    /// <summary>
    /// Period row chrome that stays on the desktop surface (no App unlock). Deliberately
    /// excludes hide/show-events and hide/show-completed — those toggle a persisted
    /// setting, so Header.jsx's own onClick never calls SuspendForUi for them at all
    /// (the settings-store "store-updated" broadcast already syncs both surfaces);
    /// listing them here used to race that broadcast and double-apply the toggle.
    /// </summary>
    private static bool IsChromeNavUiAction(string? action) =>
        action is "prev" or "next" or "today" or "prev-year" or "next-year"
            or "open-web" or "view-mode" or "view-month" or "view-week" or "view-year";

    /// <summary>
    /// Persisted viewOptions toggles — must never become pendingUiAction. Zone hits or
    /// stale SuspendForUi calls for these used to race Header's own updateSettings PATCH
    /// and flip the setting twice on one click.
    /// </summary>
    private static bool IsStoreSyncedUiAction(string? action) =>
        action is "hide-events" or "show-events" or "hide-completed" or "show-completed";


    /// <summary>Queue in-place create editor (single surface — no unlock).</summary>
    public void SuspendForCreate(string dateKey)
    {
        if (string.IsNullOrWhiteSpace(dateKey))
        {
            return;
        }

        _ = _window.Dispatcher.InvokeAsync(() =>
        {
            _surfaceState.UpdatePending(PendingAction.Create(dateKey.Trim()));
            NotifyWidgetStatus();
        });
    }

    /// <summary>Queue in-place edit editor (single surface — no unlock).</summary>
    public void SuspendForEdit(string eventId, string dayKey)
    {
        if (string.IsNullOrWhiteSpace(eventId) || string.IsNullOrWhiteSpace(dayKey))
        {
            return;
        }

        _ = _window.Dispatcher.InvokeAsync(() =>
        {
            _surfaceState.UpdatePending(PendingAction.Edit(eventId.Trim(), dayKey.Trim()));
            NotifyWidgetStatus();
        });
    }

    /// <summary>In-place UI action signal (single surface — no Host/App unlock).</summary>
    /// <param name="originSurface">Kept for API compat; ignored.</param>
    public void SuspendForUi(string action, string? originSurface = null)
    {
        var normalized = NormalizeUiAction(action);
        if (normalized is null || IsStoreSyncedUiAction(normalized))
        {
            return;
        }

        _ = _window.Dispatcher.InvokeAsync(() =>
        {
            // All UI actions (including search) stay in-place on the single surface.
            _surfaceState.UpdatePending(PendingAction.Ui(normalized, originSurface));
            NotifyWidgetStatus();
            if (IsChromeNavUiAction(normalized))
            {
                _surfaceState.ClearPending();
            }
        });
    }

    public bool IsEmbedSuspended => _surfaceState.Suspended;

    /// <summary>
    /// Claims the suspend flag before the very first desktop embed has happened yet (login
    /// wall auto-opening on App while the OnLoaded-deferred first EnterDesktopModeAsync is
    /// still ~400ms away). Without this, the deferred first embed would unconditionally
    /// cloak AppWindow once it runs, silently hiding an already-open login dialog behind
    /// DesktopHost with no way for the user to see or dismiss it. MainWindow's boot sequence
    /// checks IsEmbedSuspended and skips the cloak (embeds Host but keeps App on top) when
    /// this has been claimed. No-ops (returns false) once shell-parenting has already begun,
    /// since the normal SuspendForUi path covers that case.
    /// </summary>
    public bool ClaimBootSuspendForAuth()
    {
        return _window.Dispatcher.Invoke(() =>
        {
            if (_embed.IsShellParented || _embed.IsEmbedded)
            {
                return false;
            }

            _surfaceState.Suspend(PendingAction.None);
            NotifyWidgetStatus();
            return true;
        });
    }

    /// <summary>
    /// Recovery hook for AppWindow close/hide paths that bypass the normal JS resume flow
    /// (native OnClosing/Alt+F4, TitleBar's own close/minimize buttons, tray re-entry) while
    /// a temporary desktop-mode overlay (settings, quick-edit, auth, export) is suspended.
    /// The JS side normally clears suspend state via resumeDesktopEmbedAfterPaint()'s
    /// widget/resume call when the overlay unmounts; anything that hides/closes the window
    /// through a different path must call this first, or DesktopSurfaceState.Suspended stays stuck true —
    /// which makes every later SuspendForCreate/SuspendForEdit/SuspendForUi call take the
    /// "already suspended" shortcut against a window that is not actually shown, so the
    /// desktop calendar silently stops responding to double-click/settings until restart.
    /// Must be called on the UI dispatcher thread. Returns true if it cancelled an active
    /// overlay (caller should skip its own hide/minimize/close action); false if there was
    /// nothing suspended (caller should proceed normally).
    /// </summary>
    public bool CancelSuspendedOverlayIfActive()
    {
        if (!_surfaceState.Suspended)
        {
            return false;
        }

        ClearSuspendState();
        if (_embed.IsShellParented)
        {
            _surfaces?.ResumeDesktopAfterUi();
        }

        NotifyWidgetStatus();
        return true;
    }

    /// <summary>Native dialog owner — single MainWindow surface.</summary>
    private Window ResolvePickerOwner() => _window;

    private static string? NormalizeUiAction(string? action)
    {
        var normalized = (action ?? "").Trim().ToLowerInvariant();
        if (normalized.Length == 0 || normalized.Length > 64)
        {
            return null;
        }

        foreach (var ch in normalized)
        {
            if (ch is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-')
            {
                continue;
            }

            return null;
        }

        return normalized;
    }

    private void ClearPendingUi()
    {
        _surfaceState.ClearPending();
    }

    private void ClearSuspendState()
    {
        _surfaceState.Reset();
    }

    private JsonObject BuildWidgetStatus()
    {
        var status = _embed.GetStatus();
        var suspended = _surfaceState.Suspended;
        var pending = _surfaceState.Pending;
        status["embedSuspended"] = suspended;
        status["resumeDesktopPending"] = suspended;
        status["suspendToken"] = _surfaceState.SuspendToken;
        status["pendingCreateDate"] = suspended && pending.Kind == PendingActionKind.Create ? pending.DateKey : null;
        status["pendingUiAction"] = pending.Kind == PendingActionKind.Ui ? pending.UiAction : null;
        if (suspended && pending.Kind == PendingActionKind.Edit)
        {
            status["pendingEditEvent"] = new JsonObject
            {
                ["eventId"] = pending.EventId,
                ["dayKey"] = pending.DayKey,
            };
        }
        else
        {
            status["pendingEditEvent"] = null;
        }

        try
        {
            var readiness = DesktopReadiness.Evaluate(_embed);
            status["ready"] = readiness["ready"]?.DeepClone();
            status["checks"] = readiness["checks"]?.DeepClone();
            status["readiness"] = readiness.DeepClone();
        }
        catch
        {
            status["ready"] = false;
            status["checks"] = new JsonArray();
            status["readiness"] = new JsonObject
            {
                ["ready"] = false,
                ["checks"] = new JsonArray(),
            };
        }

        return status;
    }

    public void NotifyWindowMode()
    {
        ClearSuspendState();
        NotifyWidgetStatus();
    }

    private void OnStoreChanged(JsonObject payload)
    {
        var updatedAt = payload["updatedAt"]?.GetValue<string>();

        // Browser tabs connected via HTTP /ws refetch on store-changed.
        try
        {
            WebServer?.BroadcastStoreChanged(updatedAt);
        }
        catch
        {
            /* ignore */
        }

        _window.Dispatcher.InvokeAsync(() =>
        {
            PostEvent(new JsonObject
            {
                ["type"] = "store-updated",
                // Apply the same guest visibility filter as GET /api/store (native surface).
                ["store"] = FilterStore(_store.ReadStore(), _currentToken, fromNativeShell: true),
                ["updatedAt"] = updatedAt,
            });
        });
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonNode? root = null;
        try
        {
            root = JsonNode.Parse(e.WebMessageAsJson);
        }
        catch
        {
            try
            {
                root = JsonNode.Parse(e.TryGetWebMessageAsString());
            }
            catch
            {
                return;
            }
        }

        if (root is not JsonObject msg)
        {
            return;
        }

        var msgType = msg["type"]?.GetValue<string>();

        // React UI finished first paint — hide native boot splash if still up.
        if (msgType == "content-ready")
        {
            try
            {
                _ = _window.Dispatcher.InvokeAsync(() =>
                {
                    if (_window is MainWindow main)
                    {
                        main.HideBootSplashFromBridge();
                    }
                });
            }
            catch
            {
                /* ignore */
            }

            // DesktopHost may mount after App login — re-push shell auth once UI can listen.
            try
            {
                NotifyAuthChanged();
            }
            catch
            {
                /* ignore */
            }

            // This surface's own mount-time GET /api/store may have run before _currentToken
            // was bound (e.g. a persistent login surviving a PC reboot — App's WebView2
            // profile already has a token, this profile does not yet), returning the
            // guest/empty-events branch of FilterStore with no later resync. Re-push a
            // freshly filtered store now that the UI can listen, same reasoning as the
            // auth re-push above.
            try
            {
                BroadcastFilteredStore();
            }
            catch
            {
                /* ignore */
            }

            return;
        }

        // Sync calendar navigation between App and DesktopHost (separate WebView2 instances).
        if (msgType == "view-nav")
        {
            RelayViewNav(msg, sender as CoreWebView2);
            return;
        }

        // Renderer diagnostics (not an API request).
        if (msgType == "renderer-error")
        {
            var message = msg["message"]?.GetValue<string>() ?? "unknown";
            var source = msg["source"]?.GetValue<string>() ?? "";
            var line = msg["line"]?.GetValue<int>() ?? 0;
            System.Diagnostics.Trace.TraceError($"[renderer-error] {message} ({source}:{line})");
            try
            {
                var diag = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    AppConstants.AppName,
                    "webview-diag.txt");
                Directory.CreateDirectory(Path.GetDirectoryName(diag)!);
                File.AppendAllText(diag, $"[renderer-error] {DateTime.Now:o}\n{message}\n{source}:{line}\n\n");
            }
            catch
            {
                /* ignore */
            }

            // Promise rejections (e.g. transient file IO) are logged only — avoid modal spam on first launch.
            var isRejection = source.Contains("unhandledrejection", StringComparison.OrdinalIgnoreCase);
            var isAccessDenied = message.Contains("Access to the path", StringComparison.OrdinalIgnoreCase)
                || message.Contains("액세스가 거부", StringComparison.OrdinalIgnoreCase);
            if (!isRejection && !isAccessDenied)
            {
                try
                {
                    _ = _window.Dispatcher.InvokeAsync(() =>
                    {
                        System.Windows.MessageBox.Show(
                            _window,
                            $"화면 스크립트 오류:\n{message}\n{source}:{line}",
                            AppConstants.AppTitle,
                            MessageBoxButton.OK,
                            MessageBoxImage.Warning);
                    });
                }
                catch
                {
                    /* ignore */
                }
            }

            return;
        }

        var id = ReadString(msg, "id");
        var method = ReadString(msg, "method") ?? "";
        var path = ReadString(msg, "path") ?? "";
        var body = ReadBodyObject(msg["body"]);
        var token = ReadString(msg, "token");
        var replyTarget = sender as CoreWebView2;

        try
        {
            var result = await Task.Run(() => Dispatch(method, path, body, token, fromNativeShell: true));
            Reply(replyTarget, id, true, result, null);
        }
        catch (Exception ex)
        {
            try
            {
                var diag = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    AppConstants.AppName,
                    "webview-diag.txt");
                Directory.CreateDirectory(Path.GetDirectoryName(diag)!);
                File.WriteAllText(
                    diag,
                    $"[bridge-error] {DateTime.Now:o}\n{method} {path}\n{ex}\n");
            }
            catch
            {
                /* ignore */
            }
            Reply(replyTarget, id, false, null, ex.Message);
        }
    }

    private static string? ReadString(JsonObject msg, string key)
    {
        if (!msg.TryGetPropertyValue(key, out var node) || node is null)
        {
            return null;
        }

        if (node is JsonValue value)
        {
            if (value.TryGetValue<string>(out var s)) return s;
            return null;
        }

        return node.ToJsonString();
    }

    private static JsonObject ReadBodyObject(JsonNode? node)
    {
        if (node is JsonObject obj)
        {
            return obj;
        }

        if (node is JsonValue value && value.TryGetValue<string>(out var raw)
            && !string.IsNullOrWhiteSpace(raw))
        {
            try
            {
                return JsonNode.Parse(raw) as JsonObject ?? new JsonObject();
            }
            catch (JsonException)
            {
                return new JsonObject();
            }
        }

        return new JsonObject();
    }

    public JsonNode? HandleApi(string method, string path, JsonObject body, string? token)
        => Dispatch(method, path, body, token, fromNativeShell: false);

    private JsonNode? Dispatch(string method, string path, JsonObject body, string? token, bool fromNativeShell)
    {
        method = method.ToUpperInvariant();
        path = path.Split('?', 2)[0];

        // Dual WebView2 profiles (App vs DesktopHost) do not share localStorage, so the
        // Host surface often posts API calls with a null/stale token even while the shell
        // session (_currentToken) is already bound by App. Without this fallback, Host-side
        // eye-toggles (PATCH /api/calendars visible) and the follow-up GET /api/store hit
        // RequireLogin/guest filtering and the optimistic hide is wiped or never persisted.
        if (fromNativeShell && !_auth.IsValid(token) && _auth.IsValid(_currentToken))
        {
            token = _currentToken;
        }

        // Desktop shell chrome / embed / shutdown must never be driven by LAN browser tabs.
        if (!fromNativeShell && IsShellOnlyApi(path))
        {
            throw new UnauthorizedAccessException("이 API는 바탕화면 앱에서만 사용할 수 있습니다.");
        }

        if (path == "/api/health" && method == "GET")
        {
            return new JsonObject
            {
                ["ok"] = true,
                ["name"] = AppConstants.AppName,
                ["version"] = AppConstants.AppVersion,
                ["platform"] = "wpf-native",
            };
        }

        if (path == "/api/sync-info" && method == "GET")
        {
            var server = WebServer;
            var addresses = new JsonArray();
            if (server is not null)
            {
                foreach (var a in server.Addresses)
                {
                    addresses.Add(a);
                }
            }

            return new JsonObject
            {
                ["running"] = server?.IsRunning == true,
                ["port"] = server?.Port ?? 0,
                ["addresses"] = addresses,
                ["lanMode"] = server?.LanMode == true,
                ["hostname"] = server?.Hostname,
                ["platform"] = "wpf-native",
            };
        }

        if (path == "/api/auth/session" && method == "GET")
        {
            // Browser and native each keep their own session. HTTP must never BindShellSession
            // or pull the shell token — that made browser login/logout take over the desktop UI.
            if (!string.IsNullOrEmpty(token) && _auth.IsValid(token))
            {
                if (fromNativeShell)
                {
                    BindShellSession(token, username: null, remember: null, notify: true);
                    return BuildAuthPayload(includeToken: true);
                }

                return BuildAuthPayloadForToken(token, includeToken: false);
            }

            if (fromNativeShell && _auth.IsValid(_currentToken))
            {
                // Cold WebView may check session before localStorage is restored — re-push store.
                BroadcastFilteredStore();
                return BuildAuthPayload(includeToken: true);
            }

            return new JsonObject
            {
                ["authenticated"] = false,
                ["admin"] = false,
            };
        }

        if (path == "/api/auth/login" && method == "POST")
        {
            var id = body["id"]?.GetValue<string>() ?? body["username"]?.GetValue<string>() ?? "";
            var pw = body["password"]?.GetValue<string>() ?? "";
            // Browser login sends rememberMe; native shell sends persistent/remember.
            var persistent = body["persistent"]?.GetValue<bool>() == true
                || body["remember"]?.GetValue<bool>() == true
                || body["rememberMe"]?.GetValue<bool>() == true;
            var identity = _auth.TryAuthenticate(id, pw);
            if (identity is null)
            {
                throw new InvalidOperationException("아이디 또는 비밀번호가 올바르지 않습니다.");
            }

            var sessionToken = _auth.CreateSession(persistent, identity);
            if (fromNativeShell)
            {
                BindShellSession(sessionToken, username: identity.LoginId, remember: persistent, notify: true);
                return BuildAuthPayload(includeToken: true);
            }

            // Browser: new token only for this client — do not rebind or notify the shell.
            return BuildAuthPayloadForToken(sessionToken, includeToken: true, remember: persistent);
        }

        if (path == "/api/auth/logout" && method == "POST")
        {
            if (fromNativeShell)
            {
                var revoke = string.IsNullOrEmpty(token) ? _currentToken : token;
                _auth.Revoke(revoke);
                ClearShellSession(notify: true);
            }
            else if (!string.IsNullOrEmpty(token))
            {
                // Browser logout revokes only that tab's token — never the desktop shell session.
                _auth.Revoke(token);
            }

            return new JsonObject { ["ok"] = true };
        }

        if (path == "/api/members" && method == "GET")
        {
            RequireSuperAdmin(token);
            return new JsonObject { ["members"] = _auth.Members.ListPublicMembers() };
        }

        if (path == "/api/members" && method == "PUT")
        {
            RequireSuperAdmin(token);
            RejectMemberLoginCollidingWithBootstrapAdmin(body);
            var (members, deletedLoginIds) = _auth.Members.SaveMembersPayload(body);
            foreach (var deletedLoginId in deletedLoginIds)
            {
                _store.PurgeMemberOwnedData(deletedLoginId);
                _auth.RevokeSessionsForLoginId(deletedLoginId);
            }
            foreach (var node in members)
            {
                if (node is not JsonObject member) continue;
                if (member["active"]?.GetValue<bool>() == false) continue;
                var loginId = member["loginId"]?.GetValue<string>()?.Trim() ?? "";
                var displayName = member["displayName"]?.GetValue<string>()?.Trim();
                if (loginId.Length > 0)
                {
                    _store.EnsurePersonalCalendar(loginId, displayName, hideForAdminLoginId: _auth.AdminId);
                }
            }
            return new JsonObject { ["ok"] = true, ["members"] = members };
        }

        if (path == "/api/store" && method == "GET")
        {
            return FilterStore(_store.ReadStore(), token, fromNativeShell);
        }

        if (path == "/api/events" && method == "POST")
        {
            var session = RequireLogin(token);
            ApplyEventWriteScope(session, body, existingEvent: null);
            return _store.CreateEvent(body);
        }

        if (path.StartsWith("/api/events/", StringComparison.Ordinal) && method == "PUT")
        {
            var session = RequireLogin(token);
            var id = Uri.UnescapeDataString(path["/api/events/".Length..].Split('/')[0]);
            var existing = _store.FindEvent(id)
                ?? throw new InvalidOperationException("일정을 찾을 수 없습니다.");
            RequireEventOwnership(session, existing);
            ApplyEventWriteScope(session, body, existing);
            return _store.UpdateEvent(id, body);
        }

        // POST /api/events/{id}/attachments — native file picker
        if (path.StartsWith("/api/events/", StringComparison.Ordinal)
            && path.EndsWith("/attachments", StringComparison.Ordinal)
            && method == "POST"
            && !path.Contains("/attachments/", StringComparison.Ordinal))
        {
            var session = RequireLogin(token);
            if (!fromNativeShell)
            {
                throw new UnauthorizedAccessException("파일 첨부는 데스크톱 앱에서만 가능합니다.");
            }

            var id = Uri.UnescapeDataString(
                path["/api/events/".Length..^"/attachments".Length]);
            var existing = _store.FindEvent(id)
                ?? throw new InvalidOperationException("일정을 찾을 수 없습니다.");
            RequireEventOwnership(session, existing);
            return _attachments.AddFromPicker(ResolvePickerOwner(), id);
        }

        // POST /api/events/{id}/attachments/{attachmentId}/open
        if (path.StartsWith("/api/events/", StringComparison.Ordinal)
            && path.Contains("/attachments/", StringComparison.Ordinal)
            && path.EndsWith("/open", StringComparison.Ordinal)
            && method == "POST")
        {
            var session = RequireLogin(token);
            if (!fromNativeShell)
            {
                throw new UnauthorizedAccessException("첨부 파일 열기는 데스크톱 앱에서만 가능합니다.");
            }

            var rest = path["/api/events/".Length..^"/open".Length];
            var parts = rest.Split("/attachments/", 2, StringSplitOptions.None);
            if (parts.Length != 2)
            {
                throw new InvalidOperationException("잘못된 첨부 경로입니다.");
            }

            var eventId = Uri.UnescapeDataString(parts[0]);
            var attachmentId = Uri.UnescapeDataString(parts[1]);
            var existing = _store.FindEvent(eventId)
                ?? throw new InvalidOperationException("일정을 찾을 수 없습니다.");
            RequireEventOwnership(session, existing);
            _attachments.Open(eventId, attachmentId);
            return new JsonObject { ["ok"] = true };
        }

        // DELETE /api/events/{id}/attachments/{attachmentId}
        if (path.StartsWith("/api/events/", StringComparison.Ordinal)
            && path.Contains("/attachments/", StringComparison.Ordinal)
            && method == "DELETE")
        {
            var session = RequireLogin(token);
            var rest = path["/api/events/".Length..];
            var parts = rest.Split("/attachments/", 2, StringSplitOptions.None);
            if (parts.Length != 2)
            {
                throw new InvalidOperationException("잘못된 첨부 경로입니다.");
            }

            var eventId = Uri.UnescapeDataString(parts[0]);
            var attachmentId = Uri.UnescapeDataString(parts[1]);
            var existing = _store.FindEvent(eventId)
                ?? throw new InvalidOperationException("일정을 찾을 수 없습니다.");
            RequireEventOwnership(session, existing);
            return _attachments.Remove(eventId, attachmentId);
        }

        if (path.StartsWith("/api/events/", StringComparison.Ordinal) && method == "DELETE"
            && !path.Contains("/attachments", StringComparison.Ordinal))
        {
            var session = RequireLogin(token);
            var id = Uri.UnescapeDataString(path["/api/events/".Length..]);
            var existing = _store.FindEvent(id)
                ?? throw new InvalidOperationException("일정을 찾을 수 없습니다.");
            RequireEventOwnership(session, existing);
            _store.DeleteEvent(id);
            return null;
        }

        if (path == "/api/calendars" && method == "POST")
        {
            var session = RequireLogin(token);
            ApplyCalendarWriteScope(session, body, existingCalendar: null);
            var created = _store.CreateCalendar(body);
            // Member-owned calendars start hidden for the bootstrap admin (eye off).
            _store.HideNewMemberCalendarForAdmin(created, _auth.AdminId);
            return created;
        }

        if (path.StartsWith("/api/calendars/", StringComparison.Ordinal) && method == "PATCH")
        {
            var session = RequireLogin(token);
            var id = Uri.UnescapeDataString(path["/api/calendars/".Length..].Split('/')[0]);
            var existing = _store.FindCalendar(id)
                ?? throw new InvalidOperationException("캘린더를 찾을 수 없습니다.");

            // Eye-toggle is per-member + per-surface (native vs browser), not shared calendar.visible.
            var clientSurface = fromNativeShell
                ? CalendarStoreService.SurfaceNative
                : CalendarStoreService.SurfaceBrowser;
            if (body.ContainsKey("visible"))
            {
                var wantVisible = body["visible"]?.GetValue<bool>() != false;
                _store.SetCalendarHiddenForLogin(session.LoginId, id, hidden: !wantVisible, clientSurface);
                body.Remove("visible");
            }

            JsonObject result;
            if (body.Count == 0)
            {
                // Visibility-only patch — any logged-in member may toggle calendars they can see.
                result = _store.FindCalendar(id)
                    ?? throw new InvalidOperationException("캘린더를 찾을 수 없습니다.");
            }
            else
            {
                RequireCalendarOwnership(session, existing, allowHolidaysReadOnly: false);
                ApplyCalendarWriteScope(session, body, existing);
                result = _store.PatchCalendar(id, body);
            }

            var probe = new JsonObject
            {
                ["settings"] = _store.ReadStore()["settings"]?.DeepClone(),
                ["calendars"] = new JsonArray { (JsonObject)result.DeepClone() },
            };
            CalendarStoreService.ProjectCalendarVisibilityForClient(probe, session.LoginId, clientSurface);
            if (probe["calendars"] is JsonArray arr && arr[0] is JsonObject projected)
            {
                return projected;
            }

            return result;
        }

        if (path.StartsWith("/api/calendars/", StringComparison.Ordinal)
            && path.EndsWith("/import", StringComparison.Ordinal)
            && method == "POST")
        {
            var session = RequireLogin(token);
            var id = Uri.UnescapeDataString(
                path["/api/calendars/".Length..^"/import".Length].Split('/')[0]);
            var existing = _store.FindCalendar(id)
                ?? throw new InvalidOperationException("캘린더를 찾을 수 없습니다.");
            RequireCalendarOwnership(session, existing, allowHolidaysReadOnly: false);
            var events = body["events"] as JsonArray
                ?? throw new InvalidOperationException("가져올 일정이 없습니다.");
            var result = _store.ImportEventsIntoCalendar(id, events, session.LoginId);
            result["store"] = FilterStore(_store.ReadStore(), token, fromNativeShell);
            return result;
        }

        if (path.StartsWith("/api/calendars/", StringComparison.Ordinal)
            && path.EndsWith("/events", StringComparison.Ordinal)
            && method == "DELETE")
        {
            var session = RequireLogin(token);
            var id = Uri.UnescapeDataString(path["/api/calendars/".Length..].Replace("/events", ""));
            var existing = _store.FindCalendar(id)
                ?? throw new InvalidOperationException("캘린더를 찾을 수 없습니다.");
            RequireCalendarOwnership(session, existing, allowHolidaysReadOnly: false);
            _store.ClearCalendarEvents(id);
            return null;
        }

        if (path.StartsWith("/api/calendars/", StringComparison.Ordinal) && method == "DELETE")
        {
            var session = RequireLogin(token);
            var id = Uri.UnescapeDataString(path["/api/calendars/".Length..]);
            var existing = _store.FindCalendar(id)
                ?? throw new InvalidOperationException("캘린더를 찾을 수 없습니다.");
            RequireCalendarOwnership(session, existing, allowHolidaysReadOnly: false);
            _store.DeleteCalendar(id);
            return null;
        }

        if (path == "/api/tags" && method == "POST")
        {
            RequireLogin(token);
            return _store.CreateTag(body);
        }

        if (path.StartsWith("/api/tags/", StringComparison.Ordinal) && method == "PATCH")
        {
            RequireLogin(token);
            var id = Uri.UnescapeDataString(path["/api/tags/".Length..].Split('/')[0]);
            return _store.PatchTag(id, body);
        }

        if (path.StartsWith("/api/tags/", StringComparison.Ordinal) && method == "DELETE")
        {
            RequireLogin(token);
            var id = Uri.UnescapeDataString(path["/api/tags/".Length..]);
            _store.DeleteTag(id);
            return null;
        }

        if (path == "/api/settings" && method == "PATCH")
        {
            var session = RequireLogin(token);
            if (SettingsPatchRequiresSuperAdmin(body) && !session.IsSuperAdmin)
            {
                throw new UnauthorizedAccessException("총괄관리자만 변경할 수 있는 설정입니다.");
            }

            var clientSurface = fromNativeShell
                ? CalendarStoreService.SurfaceNative
                : CalendarStoreService.SurfaceBrowser;

            // Browser must not move/resize the WPF shell or change startup registration.
            if (!fromNativeShell)
            {
                body.Remove("widget");
                if (body["viewOptions"] is JsonObject vo)
                {
                    vo.Remove("runAtStartup");
                }
            }

            // Opacity control removed — always strip from patches.
            if (body["widget"] is JsonObject widgetBody)
            {
                widgetBody.Remove("opacity");
            }

            var result = _store.PatchSettings(body, session.LoginId, clientSurface);
            if (fromNativeShell)
            {
                ApplyShellSettings(result);
            }

            return result;
        }

        if (path == "/api/store/import" && method == "POST")
        {
            RequireSuperAdmin(token);
            return _store.ImportStore(body);
        }

        if (path == "/api/holidays/sync" && method == "POST")
        {
            RequireSuperAdmin(token);
            return HolidaySyncService.Sync(_store, body);
        }

        if (path == "/api/app/open-external" && method == "POST")
        {
            // WebView2 shell only. HTTP/LAN callers must open links in their own browser;
            // ShellExecute here would launch URLs on the server host (wrong + unsafe).
            if (!fromNativeShell)
            {
                throw new UnauthorizedAccessException("open-external is only available in the desktop app.");
            }

            var url = body["url"]?.GetValue<string>() ?? AppConstants.SiteUrl;
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            return new JsonObject { ["ok"] = true };
        }

        if (path == "/api/desktop/widget/status" && method == "GET")
        {
            return BuildWidgetStatus();
        }

        if (path == "/api/desktop/widget/readiness" && method == "GET")
        {
            return DesktopReadiness.Evaluate(_embed);
        }

        if (path == "/api/desktop/widget/diagnostics" && method == "GET")
        {
            return _embed.GetDiagnostics();
        }

        if ((path == "/api/desktop/widget/edit" || path == "/api/desktop/window/show") && method == "POST")
        {
            _window.Dispatcher.Invoke(() =>
            {
                ClearSuspendState();
                _surfaces?.EnterWindowMode(bringToFront: true);
            });
            PersistLaunchMode("window");
            var status = BuildWidgetStatus();
            PostEvent(new JsonObject
            {
                ["type"] = "widget-status",
                ["status"] = status.DeepClone(),
            }, broadcastToDesktopHost: false);
            return status;
        }

        if ((path == "/api/desktop/widget/apply"
                || path == "/api/desktop/widget/embed"
                || path == "/api/desktop/widget/resume")
            && method == "POST")
        {
            string? reopenCreate = null;
            string? reopenEditId = null;
            string? reopenEditDay = null;

            _window.Dispatcher.Invoke(() =>
            {
                var pending = _surfaceState.Pending;
                reopenCreate = pending.Kind == PendingActionKind.Create ? pending.DateKey : null;
                reopenEditId = pending.Kind == PendingActionKind.Edit ? pending.EventId : null;
                reopenEditDay = pending.Kind == PendingActionKind.Edit ? pending.DayKey : null;
                ClearSuspendState();
            });

            if (path == "/api/desktop/widget/resume" && _embed.IsShellParented)
            {
                _window.Dispatcher.Invoke(() => _surfaces?.ResumeDesktopAfterUi());
            }
            else
            {
                var bounds = _embed.LockedBounds;
                _window.Dispatcher.InvokeAsync(async () =>
                {
                    if (_surfaces is not null)
                    {
                        await _surfaces.EnterDesktopModeAsync(bounds).ConfigureAwait(true);
                    }
                }).Task.Unwrap().GetAwaiter().GetResult();
            }

            _window.Dispatcher.Invoke(() =>
            {
                if (!string.IsNullOrEmpty(reopenCreate))
                {
                    SuspendForCreate(reopenCreate);
                }
                else if (!string.IsNullOrEmpty(reopenEditId) && !string.IsNullOrEmpty(reopenEditDay))
                {
                    SuspendForEdit(reopenEditId, reopenEditDay);
                }
            });

            PersistLaunchMode("desktop");
            // Dual WebView: push shell auth so DesktopHost localStorage catches up after App login.
            NotifyAuthChanged();
            var status = BuildWidgetStatus();
            PostEvent(new JsonObject
            {
                ["type"] = "widget-status",
                ["status"] = status.DeepClone(),
            }, broadcastToDesktopHost: false);
            return status;
        }

        if (path == "/api/desktop/widget/undock-zone" && method == "POST")
        {
            // Empty / null body clears zones.
            if (body.Count == 0 || (body["clientRect"] is null && body["clientRects"] is null))
            {
                _undockZones.Clear();
            }
            else
            {
                _undockZones.SetZones(body);
            }

            return new JsonObject { ["ok"] = true, ["zones"] = true };
        }

        if ((path == "/api/desktop/widget/create-zones") && method == "POST")
        {
            if (body.Count == 0 || (body["clientRects"] is null && body["clientRect"] is null && body["zones"] is null))
            {
                _undockZones.ClearCreateZones();
            }
            else
            {
                _undockZones.SetCreateZones(body);
            }

            return new JsonObject { ["ok"] = true, ["createZones"] = true };
        }

        if ((path == "/api/desktop/widget/edit-zones") && method == "POST")
        {
            if (body.Count == 0 || (body["clientRects"] is null && body["clientRect"] is null && body["zones"] is null))
            {
                _undockZones.ClearEditZones();
            }
            else
            {
                _undockZones.SetEditZones(body);
            }

            return new JsonObject { ["ok"] = true, ["editZones"] = true };
        }

        if ((path == "/api/desktop/widget/ack-create" || path == "/api/desktop/widget/ack-edit" || path == "/api/desktop/widget/ack-ui") && method == "POST")
        {
            ClearPendingUi();
            return new JsonObject { ["ok"] = true };
        }

        if (path == "/api/desktop/widget/suspend-ui" && method == "POST")
        {
            var action = body["action"]?.GetValue<string>() ?? "";
            var surface = body["surface"]?.GetValue<string>();
            SuspendForUi(action, surface);
            return BuildWidgetStatus();
        }

        if (path == "/api/desktop/widget/claim-boot-suspend" && method == "POST")
        {
            var claimed = ClaimBootSuspendForAuth();
            return new JsonObject { ["ok"] = true, ["claimed"] = claimed };
        }

        if (path == "/api/desktop/widget/ui-zones" && method == "POST")
        {
            if (body.Count == 0 || (body["clientRects"] is null && body["clientRect"] is null && body["zones"] is null))
            {
                _undockZones.ClearUiActionZones();
            }
            else
            {
                _undockZones.SetUiActionZones(body);
            }

            return new JsonObject { ["ok"] = true, ["uiZones"] = true };
        }

        if (path == "/api/desktop/fonts/korean" && method == "GET")
        {
            return ReadKoreanFontPayload();
        }

        if (path == "/api/desktop/window/frame-theme" && method == "POST")
        {
            var dark = body["dark"]?.GetValue<bool>() ?? false;
            // Idempotent — opening Settings was re-applying the same theme and flashing.
            _window.Dispatcher.Invoke(() => ApplyFrameTheme(dark, force: false));
            return new JsonObject { ["ok"] = true, ["dark"] = dark };
        }

        if (path == "/api/desktop/window/ensure-resizable" && method == "POST")
        {
            return new JsonObject { ["ok"] = true };
        }

        if (path == "/api/app/shutdown" && method == "POST")
        {
            _window.Dispatcher.Invoke(() =>
            {
                if (_window is MainWindow main)
                {
                    main.ExitApplication();
                }
                else
                {
                    Application.Current.Shutdown();
                }
            });
            return new JsonObject { ["ok"] = true };
        }

        if (path == "/api/window/drag" && method == "POST")
        {
            _window.Dispatcher.Invoke(() =>
            {
                if (_embed.IsEmbedded || (_surfaces?.IsDesktopSurfaceActive ?? false))
                {
                    return;
                }

                try
                {
                    // WebView2 posts async — DragMove() often fails (mouse already up).
                    // WM_NCLBUTTONDOWN + HT_CAPTION continues a native title-bar drag.
                    var helper = new System.Windows.Interop.WindowInteropHelper(_window);
                    var hwnd = helper.Handle;
                    if (hwnd != IntPtr.Zero)
                    {
                        Win32.ReleaseCapture();
                        Win32.SendMessageW(hwnd, Win32.WM_NCLBUTTONDOWN, new IntPtr(Win32.HT_CAPTION), IntPtr.Zero);
                    }
                    else
                    {
                        _window.DragMove();
                    }
                }
                catch
                {
                    /* ignore if mouse not pressed */
                }
            });
            return new JsonObject { ["ok"] = true };
        }

        if (path == "/api/window/minimize" && method == "POST")
        {
            _window.Dispatcher.Invoke(() =>
            {
                // Desktop (locked) mode: no minimize. Overlay suspend: cancel overlay instead.
                if (_embed.IsShellParented || (_surfaces?.IsDesktopSurfaceActive ?? false))
                {
                    _ = CancelSuspendedOverlayIfActive();
                    return;
                }

                if (CancelSuspendedOverlayIfActive())
                {
                    return;
                }

                _window.WindowState = WindowState.Minimized;
            });
            return new JsonObject { ["ok"] = true };
        }

        if (path == "/api/window/maximize" && method == "POST")
        {
            _window.Dispatcher.Invoke(() =>
            {
                if (_embed.IsShellParented || _embed.IsEmbedded || (_surfaces?.IsDesktopSurfaceActive ?? false))
                {
                    return;
                }

                _window.WindowState = _window.WindowState == WindowState.Maximized
                    ? WindowState.Normal
                    : WindowState.Maximized;
            });
            return new JsonObject
            {
                ["ok"] = true,
                ["maximized"] = _window.Dispatcher.Invoke(() => _window.WindowState == WindowState.Maximized),
            };
        }

        if (path == "/api/window/is-maximized" && method == "GET")
        {
            var maximized = _window.Dispatcher.Invoke(() => _window.WindowState == WindowState.Maximized);
            return new JsonObject { ["maximized"] = maximized };
        }

        if (path == "/api/window/bring-to-front" && method == "POST")
        {
            _window.Dispatcher.Invoke(() =>
            {
                // Only meaningful in desktop (locked) mode; window mode is already free to raise.
                if (_embed.IsShellParented || (_surfaces?.IsDesktopSurfaceActive ?? false) || _embed.IsAlwaysOnBottom)
                {
                    _embed.BringToFront();
                    try
                    {
                        _window.Activate();
                    }
                    catch
                    {
                        /* ignore */
                    }
                }
            });
            return new JsonObject { ["ok"] = true };
        }

        if (path == "/api/window/release-foreground" && method == "POST")
        {
            _window.Dispatcher.Invoke(() =>
            {
                _embed.ReleaseForegroundOverride();
            });
            return new JsonObject { ["ok"] = true };
        }

        if (path == "/api/window/close" && method == "POST")
        {
            _window.Dispatcher.Invoke(() =>
            {
                // Desktop (locked) mode: no close from title chrome. Overlay: cancel overlay.
                if (_embed.IsShellParented || (_surfaces?.IsDesktopSurfaceActive ?? false))
                {
                    _ = CancelSuspendedOverlayIfActive();
                    return;
                }

                if (CancelSuspendedOverlayIfActive())
                {
                    return;
                }

                _window.Hide();
            });
            return new JsonObject { ["ok"] = true };
        }

        throw new InvalidOperationException($"Unknown route {method} {path}");
    }

    public void ApplyFrameThemeFromSettings()
    {
        var dark = ResolveDarkFromSettings();
        // Same theme: do nothing. Reapply() on every Activate rewrote DWM attrs and
        // flashed when Settings unlocked to window (Search masked it with a full overlay).
        if (_frameThemeDark == dark)
        {
            return;
        }

        ApplyFrameTheme(dark, force: true);
    }

    private void ApplyFrameTheme(bool dark, bool force = true)
    {
        if (!force && _frameThemeDark == dark)
        {
            return;
        }

        _frameThemeDark = dark;
        var hwnd = new WindowInteropHelper(_window).Handle;
        WindowFrameTheme.Apply(hwnd, dark);

        // Match CSS page fills so unpainted/composition frames never flash black or white.
        var page = dark
            ? System.Windows.Media.Color.FromRgb(0x20, 0x21, 0x24)
            : System.Windows.Media.Color.FromRgb(0xEE, 0xF0, 0xF2);
        _window.Background = new System.Windows.Media.SolidColorBrush(page);
        if (hwnd != IntPtr.Zero)
        {
            var source = HwndSource.FromHwnd(hwnd);
            if (source?.CompositionTarget is not null)
            {
                source.CompositionTarget.BackgroundColor = page;
            }
        }

        if (_webView is not null)
        {
            _webView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, page.R, page.G, page.B);
        }

        // Never RefreshContentAlpha here — rewriting DWM on the wallpaper surface flashes DefView.
        WindowFrameTheme.Reapply();
    }

    private bool ResolveDarkFromSettings()
    {
        try
        {
            var settings = _store.ReadStore()["settings"] as JsonObject;
            // Theme is per-surface; the WPF frame follows the native (shell) preference.
            var scheme = settings?["viewOptionsBySurface"]?[CalendarStoreService.SurfaceNative]?["colorScheme"]
                    ?.GetValue<string>()
                ?? settings?["viewOptions"]?["colorScheme"]?.GetValue<string>()
                ?? "light";
            if (string.Equals(scheme, "dark", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (string.Equals(scheme, "light", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            // system
            return Microsoft.Win32.Registry.GetValue(
                    @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                    "AppsUseLightTheme",
                    1) is int light
                && light == 0;
        }
        catch
        {
            return false;
        }
    }

    private void PersistLaunchMode(string mode)
    {
        try
        {
            var widget = new JsonObject
            {
                ["launchMode"] = mode,
                ["enabled"] = mode == "desktop",
            };
            if (_embed.LockedBounds is { } bounds)
            {
                widget["bounds"] = new JsonObject
                {
                    ["x"] = bounds.X,
                    ["y"] = bounds.Y,
                    ["width"] = bounds.Width,
                    ["height"] = bounds.Height,
                };
            }

            _store.PatchSettings(new JsonObject { ["widget"] = widget });
        }
        catch
        {
            /* ignore */
        }
    }

    /// <summary>Apply run-at-startup from the current store settings; force fully opaque chrome.</summary>
    public void ApplyShellSettingsFromStore()
    {
        try
        {
            if (_store.ReadStore()["settings"] is JsonObject settings)
            {
                ApplyShellSettings(settings);
            }
        }
        catch
        {
            /* ignore */
        }
    }

    private void ApplyShellSettings(JsonObject settings)
    {
        try
        {
            var viewOptions = settings["viewOptions"] as JsonObject;
            if (viewOptions?["runAtStartup"] is JsonValue runAtStartupNode
                && runAtStartupNode.TryGetValue<bool>(out var runAtStartup))
            {
                StartupRegistrationService.Apply(runAtStartup);
            }

            _embed.ForceFullyOpaque();
            try
            {
                if (_window.Dispatcher.CheckAccess())
                {
                    _window.Opacity = 1.0;
                }
                else
                {
                    _ = _window.Dispatcher.BeginInvoke(() =>
                    {
                        try { _window.Opacity = 1.0; } catch { /* disposed */ }
                    });
                }
            }
            catch
            {
                /* ignore */
            }
        }
        catch
        {
            /* ignore */
        }
    }

    private static JsonObject ReadKoreanFontPayload()
    {
        var windir = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var candidates = new[]
        {
            Path.Combine(windir, "Fonts", "malgun.ttf"),
            Path.Combine(windir, "Fonts", "malgunbd.ttf"),
            Path.Combine(windir, "Fonts", "malgunsl.ttf"),
            Path.Combine(AppContext.BaseDirectory, "wwwroot", "fonts", "NotoSansKR-Regular.otf"),
        };

        foreach (var path in candidates)
        {
            if (!File.Exists(path))
            {
                continue;
            }

            var bytes = File.ReadAllBytes(path);
            return new JsonObject
            {
                ["ok"] = true,
                ["name"] = Path.GetFileName(path),
                ["base64"] = Convert.ToBase64String(bytes),
            };
        }

        throw new InvalidOperationException("PDF 생성을 위한 한글 폰트를 찾을 수 없습니다.");
    }

    private AuthSession RequireLogin(string? token)
    {
        var session = _auth.GetSession(token);
        if (session is null)
        {
            throw new UnauthorizedAccessException("로그인이 필요합니다.");
        }

        return session;
    }

    private AuthSession RequireSuperAdmin(string? token)
    {
        var session = RequireLogin(token);
        if (!session.IsSuperAdmin)
        {
            throw new UnauthorizedAccessException("총괄관리자만 사용할 수 있습니다.");
        }

        return session;
    }

    /// <summary>
    /// The seeded bootstrap admin row may keep the .env admin login id; other members may not.
    /// </summary>
    private void RejectMemberLoginCollidingWithBootstrapAdmin(JsonObject? body)
    {
        if (body?["members"] is not JsonArray members) return;
        var adminId = _auth.AdminId;
        foreach (var node in members)
        {
            if (node is not JsonObject item) continue;
            if (item["_delete"]?.GetValue<bool>() == true) continue;
            var loginId = item["loginId"]?.GetValue<string>()?.Trim() ?? "";
            if (loginId.Length == 0
                || !string.Equals(loginId, adminId, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var id = item["id"]?.GetValue<string>()?.Trim() ?? "";
            if (MembersService.IsBootstrapAdminMemberId(id))
            {
                continue;
            }

            throw new InvalidOperationException(
                $"아이디 「{loginId}」는 기본 관리자 계정과 겹칠 수 없습니다.");
        }
    }

    private static bool SettingsPatchRequiresSuperAdmin(JsonObject? body)
    {
        if (body is null) return false;
        return body.ContainsKey("allowedIpCidrs")
            || body.ContainsKey("holidaysKr");
    }

    private void RequireEventOwnership(AuthSession session, JsonObject ev)
    {
        var calId = ev["calendarId"]?.GetValue<string>() ?? "";
        if (string.Equals(calId, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException("공휴일 일정은 수정할 수 없습니다.");
        }

        if (session.IsSuperAdmin) return;
        var owner = ev["ownerLoginId"]?.GetValue<string>()?.Trim() ?? "";
        if (!string.Equals(owner, session.LoginId, StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException("다른 회원의 일정입니다.");
        }
    }

    private void RequireCalendarOwnership(AuthSession session, JsonObject cal, bool allowHolidaysReadOnly)
    {
        var id = cal["id"]?.GetValue<string>() ?? "";
        if (string.Equals(id, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
        {
            if (allowHolidaysReadOnly) return;
            throw new UnauthorizedAccessException("공휴일 캘린더는 변경할 수 없습니다.");
        }

        if (session.IsSuperAdmin) return;
        var owner = cal["ownerLoginId"]?.GetValue<string>()?.Trim() ?? "";
        if (!string.Equals(owner, session.LoginId, StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException("다른 회원의 캘린더입니다.");
        }
    }

    private void ApplyEventWriteScope(AuthSession session, JsonObject body, JsonObject? existingEvent)
    {
        var calendarId = body["calendarId"]?.GetValue<string>()
            ?? existingEvent?["calendarId"]?.GetValue<string>()
            ?? "";
        if (string.Equals(calendarId, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException("공휴일 캘린더에는 일정을 추가할 수 없습니다.");
        }

        if (calendarId.Length > 0)
        {
            var cal = _store.FindCalendar(calendarId)
                ?? throw new InvalidOperationException("캘린더를 찾을 수 없습니다.");
            RequireCalendarOwnership(session, cal, allowHolidaysReadOnly: false);
        }

        if (session.IsSuperAdmin)
        {
            if (string.IsNullOrWhiteSpace(body["ownerLoginId"]?.GetValue<string>())
                && existingEvent?["ownerLoginId"]?.GetValue<string>() is { Length: > 0 } keep)
            {
                body["ownerLoginId"] = keep;
            }
            else if (string.IsNullOrWhiteSpace(body["ownerLoginId"]?.GetValue<string>())
                && calendarId.Length > 0)
            {
                var cal = _store.FindCalendar(calendarId);
                var fromCal = cal?["ownerLoginId"]?.GetValue<string>()?.Trim();
                body["ownerLoginId"] = string.IsNullOrEmpty(fromCal) ? session.LoginId : fromCal;
            }
            else if (string.IsNullOrWhiteSpace(body["ownerLoginId"]?.GetValue<string>()))
            {
                body["ownerLoginId"] = session.LoginId;
            }
        }
        else
        {
            body["ownerLoginId"] = session.LoginId;
            body["createdBy"] = session.LoginId;
        }
    }

    private void ApplyCalendarWriteScope(AuthSession session, JsonObject body, JsonObject? existingCalendar)
    {
        var id = body["id"]?.GetValue<string>()
            ?? existingCalendar?["id"]?.GetValue<string>()
            ?? "";
        if (string.Equals(id, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException("공휴일 캘린더는 변경할 수 없습니다.");
        }

        if (session.IsSuperAdmin)
        {
            if (string.IsNullOrWhiteSpace(body["ownerLoginId"]?.GetValue<string>())
                && existingCalendar?["ownerLoginId"]?.GetValue<string>() is { Length: > 0 } keep)
            {
                body["ownerLoginId"] = keep;
            }
            else if (string.IsNullOrWhiteSpace(body["ownerLoginId"]?.GetValue<string>()))
            {
                body["ownerLoginId"] = session.LoginId;
            }
        }
        else
        {
            body["ownerLoginId"] = session.LoginId;
            body["owner"] = "local";
        }
    }

    private JsonObject FilterStore(JsonObject store, string? token, bool fromNativeShell)
    {
        var clientSurface = fromNativeShell
            ? CalendarStoreService.SurfaceNative
            : CalendarStoreService.SurfaceBrowser;
        var session = _auth.GetSession(token);
        if (session is null)
        {
            // Guests are not allowed — return an empty store (no calendars/events).
            var empty = store.DeepClone()!.AsObject();
            empty["calendars"] = new JsonArray();
            empty["events"] = new JsonArray();
            empty["tags"] = new JsonArray();
            if (empty["settings"] is JsonObject guestSettings)
            {
                if (guestSettings["holidaysKr"] is JsonObject holidaysKr)
                {
                    holidaysKr["serviceKey"] = "";
                }

                guestSettings["allowedIpCidrs"] = new JsonArray();
                CalendarStoreService.ProjectSettingsDayColorsForClient(guestSettings, loginId: null);
                CalendarStoreService.ProjectViewOptionsForClient(guestSettings, clientSurface);
            }

            return empty;
        }

        JsonObject clone;
        if (session.IsSuperAdmin)
        {
            // Always detach — Reply/PostEvent must not adopt a live tree (parent-node errors).
            clone = (JsonObject)store.DeepClone();
        }
        else
        {
            // Member: personal calendars/events + holidays-kr (read-only system calendar).
            var calendars = store["calendars"] as JsonArray ?? [];
            var events = store["events"] as JsonArray ?? [];
            var allowedIds = new HashSet<string>(StringComparer.Ordinal);
            var filteredCalendars = new JsonArray();
            foreach (var node in calendars)
            {
                if (node is not JsonObject cal) continue;
                var id = cal["id"]?.GetValue<string>() ?? "";
                if (string.IsNullOrEmpty(id)) continue;

                var isHoliday = string.Equals(id, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal);
                var owner = cal["ownerLoginId"]?.GetValue<string>()?.Trim() ?? "";
                if (!isHoliday
                    && !string.Equals(owner, session.LoginId, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                allowedIds.Add(id);
                filteredCalendars.Add(cal.DeepClone());
            }

            var filteredEvents = new JsonArray();
            foreach (var node in events)
            {
                if (node is not JsonObject ev) continue;
                var calId = ev["calendarId"]?.GetValue<string>() ?? "";
                if (!allowedIds.Contains(calId)) continue;

                if (string.Equals(calId, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
                {
                    filteredEvents.Add(ev.DeepClone());
                    continue;
                }

                var owner = ev["ownerLoginId"]?.GetValue<string>()?.Trim() ?? "";
                if (string.Equals(owner, session.LoginId, StringComparison.OrdinalIgnoreCase)
                    || (owner.Length == 0
                        && allowedIds.Contains(calId)))
                {
                    filteredEvents.Add(ev.DeepClone());
                }
            }

            clone = store.DeepClone()!.AsObject();
            clone["calendars"] = filteredCalendars;
            clone["events"] = filteredEvents;

            // Never expose holiday API key / IP allowlist to members.
            if (clone["settings"] is JsonObject memberSettings)
            {
                if (memberSettings["holidaysKr"] is JsonObject holidaysKr)
                {
                    holidaysKr["serviceKey"] = "";
                }

                memberSettings["allowedIpCidrs"] = new JsonArray();
            }
        }

        if (clone["settings"] is JsonObject settings)
        {
            CalendarStoreService.ProjectSettingsDayColorsForClient(settings, session.LoginId);
            CalendarStoreService.ProjectViewOptionsForClient(settings, clientSurface);
        }

        CalendarStoreService.ProjectCalendarVisibilityForClient(clone, session.LoginId, clientSurface);
        return clone;
    }

    private static bool IsShellOnlyApi(string path)
    {
        if (path.StartsWith("/api/window/", StringComparison.Ordinal)) return true;
        if (path.StartsWith("/api/desktop/", StringComparison.Ordinal)) return true;
        if (string.Equals(path, "/api/app/shutdown", StringComparison.Ordinal)) return true;
        return false;
    }

    private void Reply(CoreWebView2? target, string? id, bool ok, JsonNode? result, string? error)
    {
        var core = target ?? WebView2Safe.TryGetCore(_webView);
        if (core is null || string.IsNullOrEmpty(id))
        {
            return;
        }

        var payload = new JsonObject
        {
            ["type"] = "response",
            ["id"] = id,
            ["ok"] = ok,
            ["result"] = result?.DeepClone(),
            ["error"] = error,
        };
        try
        {
            core.PostWebMessageAsJson(payload.ToJsonString(JsonUtil.Compact));
        }
        catch
        {
            /* disposed between resolve and post */
        }
    }

    private void BindShellSession(string token, string? username, bool? remember, bool notify)
    {
        var changed = !string.Equals(_currentToken, token, StringComparison.Ordinal);
        if (!string.IsNullOrEmpty(username)
            && !string.Equals(_currentUsername, username, StringComparison.Ordinal))
        {
            changed = true;
        }

        _currentToken = token;
        if (!string.IsNullOrEmpty(username))
        {
            _currentUsername = username;
        }
        else
        {
            _currentUsername ??= _auth.AdminId;
        }

        _currentRemember = remember ?? _auth.IsPersistent(token);

        if (notify && changed)
        {
            NotifyAuthChanged();
            BroadcastFilteredStore();
        }
    }

    private void ClearShellSession(bool notify)
    {
        var hadSession = !string.IsNullOrEmpty(_currentToken);
        _currentToken = null;
        _currentUsername = null;
        _currentRemember = false;
        if (notify && hadSession)
        {
            NotifyAuthChanged();
            BroadcastFilteredStore();
        }
    }

    private JsonObject BuildAuthPayload(bool includeToken) =>
        BuildAuthPayloadForToken(_currentToken, includeToken, remember: _currentRemember);

    /// <summary>Auth payload for an arbitrary token (browser clients; does not read shell bind).</summary>
    private JsonObject BuildAuthPayloadForToken(string? token, bool includeToken, bool? remember = null)
    {
        var session = _auth.GetSession(token);
        var ok = session is not null;
        var rememberFlag = remember ?? (ok && _auth.IsPersistent(token));
        var payload = new JsonObject
        {
            ["authenticated"] = ok,
            ["admin"] = ok && session!.IsSuperAdmin,
            ["username"] = ok ? session!.LoginId : null,
            ["loginId"] = ok ? session!.LoginId : null,
            ["role"] = ok ? session!.Role : null,
            ["isSuperAdmin"] = ok && session!.IsSuperAdmin,
            ["remember"] = ok && rememberFlag,
        };
        if (includeToken && ok)
        {
            payload["token"] = token;
        }

        return payload;
    }

    /// <summary>Push shell auth into the native WebView.</summary>
    public void NotifyAuthChangedFromShell() => NotifyAuthChanged();

    /// <summary>Tray Start/Stop Server — refresh "브라우저에서 편집" enablement in the WebView.</summary>
    public void NotifyServerModeChanged()
    {
        try
        {
            var server = WebServer;
            PostEvent(new JsonObject
            {
                ["type"] = "server-mode-changed",
                ["running"] = server?.IsRunning == true,
                ["port"] = server?.Port ?? 0,
                ["lanMode"] = server?.LanMode == true,
            }, broadcastToDesktopHost: true);
        }
        catch
        {
            /* ignore */
        }
    }

    private void NotifyAuthChanged()
    {
        var payload = BuildAuthPayload(includeToken: true);
        payload["type"] = "auth-changed";
        PostEvent(payload, broadcastToDesktopHost: true);
    }

    private void BroadcastFilteredStore()
    {
        try
        {
            PostEvent(new JsonObject
            {
                ["type"] = "store-updated",
                ["store"] = FilterStore(_store.ReadStore(), _currentToken, fromNativeShell: true),
                ["updatedAt"] = DateTime.UtcNow.ToString("o"),
            });
        }
        catch
        {
            /* ignore */
        }
    }

    private void PostEvent(JsonObject payload, bool broadcastToDesktopHost = true)
    {
        _ = broadcastToDesktopHost;
        payload["type"] ??= "event";
        WebView2Safe.TryPostJson(_webView, payload.ToJsonString(JsonUtil.Compact));
    }

    /// <summary>No-op — single surface has no peer to relay view-nav to.</summary>
    private static void RelayViewNav(JsonObject msg, CoreWebView2? from)
    {
        _ = msg;
        _ = from;
    }
}
