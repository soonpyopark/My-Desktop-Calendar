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
    private WebView2? _secondaryWebView;
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

    /// <summary>DesktopHost WebView — shares store events; keeps zones in sync while host is visible.</summary>
    public void AttachSecondary(WebView2 webView)
    {
        DetachSecondary();
        _secondaryWebView = webView;
        webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
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

    public void DetachSecondary()
    {
        try
        {
            if (WebView2Safe.TryGetCore(_secondaryWebView) is { } core)
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
            _secondaryWebView = null;
        }
    }

    public void NotifyWidgetStatus()
    {
        var status = BuildWidgetStatus();
        var payload = new JsonObject
        {
            ["type"] = "widget-status",
            ["status"] = status.DeepClone(),
        };

        // Chrome nav must reach DesktopHost while embedded; while in window mode the App
        // already applied the click — only mirror to the host surface.
        var pending = _surfaceState.Pending;
        if (pending.Kind == PendingActionKind.Ui && IsChromeNavUiAction(pending.UiAction))
        {
            if (_embed.IsEmbedded)
            {
                // SysListView32/WS_POPUP embed: the real click already reached whichever
                // surface's own React onClick raised this (see pending.UiActionSurface) —
                // it ran fn() locally there already. Echoing this push back to that same
                // surface re-applies the nav a second time (prev/next silently skipping a
                // month/week). Legacy Progman/WorkerW (WS_CHILD) embeds still need the full
                // broadcast — DefView swallows the real click before DesktopHost's DOM
                // ever sees it there, so the push is the only way the action reaches it.
                if (_embed.IsPopupStyleEmbed && pending.UiActionSurface == "desktop")
                {
                    PostEventToAppOnly(payload);
                }
                else if (_embed.IsPopupStyleEmbed && pending.UiActionSurface == "app")
                {
                    PostEventToDesktopHostOnly(payload);
                }
                else
                {
                    PostEvent(payload, broadcastToDesktopHost: true);
                }
            }
            else
            {
                PostEventToDesktopHostOnly(payload);
            }

            return;
        }

        // Settings/search/auth/export — App only (search uses permanent window unlock;
        // settings/auth/export temporarily unlock and resume desktop on close).
        PostEvent(payload, broadcastToDesktopHost: false);
    }

    private void PostEventToDesktopHostOnly(JsonObject payload)
    {
        payload["type"] ??= "event";
        WebView2Safe.TryPostJson(_secondaryWebView, payload.ToJsonString(JsonUtil.Compact));
    }

    private void PostEventToAppOnly(JsonObject payload)
    {
        payload["type"] ??= "event";
        WebView2Safe.TryPostJson(_webView, payload.ToJsonString(JsonUtil.Compact));
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


    /// <summary>Temporary unlock for embedded day double-click → create editor.</summary>
    public void SuspendForCreate(string dateKey)
    {
        if (string.IsNullOrWhiteSpace(dateKey))
        {
            return;
        }

        _ = _window.Dispatcher.InvokeAsync(async () =>
        {
            var normalized = dateKey.Trim();

            // Already temporarily unlocked (editor just closed, or still open) — refresh pending.
            if (_surfaceState.Suspended)
            {
                _surfaceState.UpdatePending(PendingAction.Create(normalized));
                NotifyWidgetStatus();
                return;
            }

            if (!_embed.IsEmbedded && !_embed.IsShellParented)
            {
                return;
            }

            // Claim before surface switch so a second caller (Host React + zone) cannot
            // run SuspendDesktopForUi twice (desktop-wide flash).
            _surfaceState.Suspend(PendingAction.Create(normalized));

            if (_surfaces is not null)
            {
                await _surfaces.SuspendDesktopForUiAsync();
            }

            if (!_window.IsVisible)
            {
                _window.Show();
            }

            _window.WindowState = WindowState.Normal;
            _window.Activate();
            NotifyWidgetStatus();
        });
    }

    /// <summary>Temporary unlock for embedded event-bar double-click → edit editor.</summary>
    public void SuspendForEdit(string eventId, string dayKey)
    {
        if (string.IsNullOrWhiteSpace(eventId) || string.IsNullOrWhiteSpace(dayKey))
        {
            return;
        }

        _ = _window.Dispatcher.InvokeAsync(async () =>
        {
            var normalizedEventId = eventId.Trim();
            var normalizedDayKey = dayKey.Trim();

            if (_surfaceState.Suspended)
            {
                _surfaceState.UpdatePending(PendingAction.Edit(normalizedEventId, normalizedDayKey));
                NotifyWidgetStatus();
                return;
            }

            if (!_embed.IsEmbedded && !_embed.IsShellParented)
            {
                return;
            }

            _surfaceState.Suspend(PendingAction.Edit(normalizedEventId, normalizedDayKey));

            if (_surfaces is not null)
            {
                await _surfaces.SuspendDesktopForUiAsync();
            }

            if (!_window.IsVisible)
            {
                _window.Show();
            }

            _window.WindowState = WindowState.Normal;
            _window.Activate();
            NotifyWidgetStatus();
        });
    }

    /// <summary>Temporary unlock for embedded header button clicks.</summary>
    /// <param name="originSurface">"desktop" or "app" — which WebView2 raised this
    /// (see PendingAction.UiActionSurface); null for calls with no browser-side origin
    /// (e.g. the legacy zone-monitor poll, which always targets DesktopHost).</param>
    public void SuspendForUi(string action, string? originSurface = null)
    {
        var normalized = NormalizeUiAction(action);
        if (normalized is null)
        {
            return;
        }

        // Store-synced toggles are applied only by the surface that received the real
        // click (Header onClick → updateSettings). Never queue them as pendingUiAction.
        if (IsStoreSyncedUiAction(normalized))
        {
            return;
        }

        _ = _window.Dispatcher.InvokeAsync(async () =>
        {
            void SignalUi(string normalizedAction, bool stayEmbedded)
            {
                _surfaceState.UpdatePending(PendingAction.Ui(normalizedAction, originSurface));
                NotifyWidgetStatus();
                // Chrome nav: clear after push so App poll does not double-apply when
                // the click handler already ran onClick (window mode).
                if (stayEmbedded && IsChromeNavUiAction(normalizedAction))
                {
                    _surfaceState.ClearPending();
                }
            }

            if (!_embed.IsEmbedded && !_embed.IsShellParented)
            {
                // Window mode — App onClick applies locally; Notify mirrors nav to DesktopHost.
                SignalUi(normalized, stayEmbedded: true);
                return;
            }

            // Already showing App (window mode / host hidden) — never re-run surface switch.
            // Shell-parented-but-hidden used to fall through into UnlockToWindowModeForUi and flash.
            if (!_embed.IsEmbedded)
            {
                SignalUi(normalized, stayEmbedded: IsChromeNavUiAction(normalized));
                return;
            }

            // Search while wallpaper-embedded: permanent window unlock (stays in window
            // mode after close). Settings falls through to the temporary-unlock path below
            // so closing it resumes desktop embed automatically.
            if (normalized is "search")
            {
                await UnlockToWindowModeForUiAsync(normalized, originSurface);
                return;
            }

            // Month/year navigation can run while staying embedded — unlocking first
            // made the first click feel like a no-op (unlock only, action on 2nd click).
            if (!UiActionRequiresUnlock(normalized))
            {
                SignalUi(normalized, stayEmbedded: true);
                return;
            }

            // Same path as SuspendForCreate / day quick-edit.
            // Claim suspend before surface switch — zone + Host onClick used to
            // double SuspendDesktopForUi and flash the whole desktop.
            if (_surfaceState.Suspended)
            {
                _surfaceState.UpdatePending(PendingAction.Ui(normalized, originSurface));
                NotifyWidgetStatus();
                return;
            }

            _surfaceState.Suspend(PendingAction.Ui(normalized, originSurface));

            if (_surfaces is not null)
            {
                await _surfaces.SuspendDesktopForUiAsync();
            }

            if (!_window.IsVisible)
            {
                _window.Show();
            }

            _window.WindowState = WindowState.Normal;
            _window.Activate();
            NotifyWidgetStatus();
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

    /// <summary>
    /// Permanent window mode for UI that should leave desktop (e.g. search).
    /// Rematerializes App WebView and disposes DesktopHost (single-process window mode).
    /// </summary>
    private async Task UnlockToWindowModeForUiAsync(string pendingAction, string? originSurface = null)
    {
        // Keep Activate from ApplyFrameTheme during Show (same guard as temp unlock).
        // Do not ClearSuspendState() first — that wiped pending and dropped the guard,
        // so Settings opened after the cover and flashed the desktop.
        _surfaceState.Suspend(PendingAction.Ui(pendingAction, originSurface));

        // Start App overlay mount while Host is still visible.
        NotifyWidgetStatus();

        if (_surfaces is not null)
        {
            await _surfaces.EnterWindowModeAsync(bringToFront: true);
        }

        // Permanent window — no resume. Clear suspend flag only; keep pending until ack.
        _surfaceState.MarkResumed();

        PersistLaunchMode("window");
        NotifyWidgetStatus();
    }

    /// <summary>
    /// Actions that temporary-unlock to App (same SuspendDesktopForUi as day quick-edit)
    /// and resume desktop embed automatically once the App-side UI closes. Search uses
    /// UnlockToWindowModeForUi instead (permanent — no resume on close).
    /// </summary>
    private static bool UiActionRequiresUnlock(string action) =>
        action is "auth" or "export-excel" or "export-pdf" or "settings";

    /// <summary>
    /// Native dialog owner (file picker, MessageBox) — whichever WPF window is actually
    /// the visible/interactive surface right now. Under SysListView32/WS_POPUP embed,
    /// attachments are added in place on DesktopHost (Header.jsx opens the day/event
    /// editor there directly, same as Settings) while App stays cloaked, so a dialog
    /// owned by the cloaked App window would have no visible owner to anchor to.
    /// </summary>
    private Window ResolvePickerOwner() =>
        _surfaces?.IsDesktopSurfaceActive == true && _surfaces.Host is Window host ? host : _window;

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
                // Apply the same guest visibility filter as GET /api/store.
                ["store"] = FilterStore(_store.ReadStore(), _currentToken),
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
            // Valid client token: bind shell session so DesktopHost can sync (dual WebView storage).
            if (!string.IsNullOrEmpty(token) && _auth.IsValid(token))
            {
                BindShellSession(token, username: null, remember: null, notify: true);
                // Native WebViews may request the token to mirror into the other profile.
                return BuildAuthPayload(includeToken: fromNativeShell);
            }

            // Dual WebView: App logged in while Host was not ready — Host pulls shell session.
            // HTTP browser clients must never receive the shell token this way.
            if (fromNativeShell && _auth.IsValid(_currentToken))
            {
                // This surface's own earlier GET /api/store (fired on mount, in parallel with
                // this session check) ran before it had a token, so FilterStore returned it the
                // guest/empty-events branch — most visible after a PC reboot with a persistent
                // login, where the App profile's WebView2 storage already has a token but this
                // Host profile's storage does not yet. BindShellSession's own broadcast above
                // only fires when the bound token *changes*; since App already bound this same
                // token earlier, that branch is a no-op here, so nothing else will ever re-push
                // a correctly-filtered store to this surface. Resync explicitly.
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

            var session = _auth.CreateSession(persistent, identity);
            BindShellSession(session, username: identity.LoginId, remember: persistent, notify: true);
            return BuildAuthPayload(includeToken: true);
        }

        if (path == "/api/auth/logout" && method == "POST")
        {
            _auth.Revoke(token ?? _currentToken);
            ClearShellSession(notify: true);
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
            return FilterStore(_store.ReadStore(), token);
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

            // Eye-toggle is per-member (settings.hiddenCalendarIdsByLoginId), not shared calendar.visible.
            if (body.ContainsKey("visible"))
            {
                var wantVisible = body["visible"]?.GetValue<bool>() != false;
                _store.SetCalendarHiddenForLogin(session.LoginId, id, hidden: !wantVisible);
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
            CalendarStoreService.ProjectCalendarVisibilityForClient(probe, session.LoginId);
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
            result["store"] = FilterStore(_store.ReadStore(), token);
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

            var result = _store.PatchSettings(body, session.LoginId);
            ApplyShellSettings(result);
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
                // TitleBar enables these controls whenever DesktopHost isn't actively shown —
                // which includes a temporary desktop-mode overlay (settings/quick-edit/auth/
                // export). Minimizing there would hide AppWindow with no taskbar entry to
                // restore it from (ShowInTaskbar=false) while DesktopHost is already hidden
                // underneath — the calendar would vanish from the desktop until the user finds
                // the tray menu, and the suspend flag would stay stuck true. Cancel the overlay
                // and resume the desktop surface instead, same as the in-UI close button.
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
                if (_embed.IsEmbedded || (_surfaces?.IsDesktopSurfaceActive ?? false))
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

        if (path == "/api/window/close" && method == "POST")
        {
            _window.Dispatcher.Invoke(() =>
            {
                // Same reasoning as /api/window/minimize above: a bare Hide() while a
                // temporary desktop-mode overlay is suspended would leave AppWindow AND
                // DesktopHost both invisible with the suspended flag stuck.
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

        var page = dark ? WindowFrameTheme.PageDark : WindowFrameTheme.PageLight;
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

        // Never RefreshContentAlpha here — that HWND is DesktopHost. Rewriting DWM on the
        // wallpaper surface flashes DefView (also when Chrome web UI POSTs frame-theme).
        WindowFrameTheme.Reapply();
    }

    private bool ResolveDarkFromSettings()
    {
        try
        {
            var scheme = _store.ReadStore()["settings"]?["viewOptions"]?["colorScheme"]?.GetValue<string>()
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

    /// <summary>Apply run-at-startup + window opacity from the current store settings.</summary>
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

            var opacity = ReadWidgetOpacity(settings);
            _embed.SetOpacity(opacity);
            ApplyMainWindowOpacity(opacity);
        }
        catch
        {
            /* ignore */
        }
    }

    private static double ReadWidgetOpacity(JsonObject settings)
    {
        if (settings["widget"] is not JsonObject widget
            || widget["opacity"] is not JsonValue value)
        {
            return AppConstants.DefaultOpacity;
        }

        if (value.TryGetValue<double>(out var d))
        {
            return DesktopEmbedService.NormalizeOpacity(d);
        }

        if (value.TryGetValue<int>(out var i))
        {
            return DesktopEmbedService.NormalizeOpacity(i);
        }

        if (value.TryGetValue<long>(out var l))
        {
            return DesktopEmbedService.NormalizeOpacity(l);
        }

        if (value.TryGetValue<string>(out var s)
            && double.TryParse(s, System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture, out var parsed))
        {
            return DesktopEmbedService.NormalizeOpacity(parsed);
        }

        return AppConstants.DefaultOpacity;
    }

    /// <summary>
    /// Main (App) window opacity: WPF <see cref="Window.Opacity"/> + top-level LWA_ALPHA
    /// (covers WebView2 child HWNDs when the App window is top-level).
    /// </summary>
    private void ApplyMainWindowOpacity(double opacity)
    {
        try
        {
            var clamped = DesktopEmbedService.NormalizeOpacity(opacity);
            var alpha = (byte)Math.Clamp((int)Math.Round(clamped * 255.0), 13, 255);

            void ApplyWpf()
            {
                try
                {
                    _window.Opacity = clamped;
                }
                catch
                {
                    /* disposed */
                }
            }

            if (_window.Dispatcher.CheckAccess())
            {
                ApplyWpf();
            }
            else
            {
                _ = _window.Dispatcher.BeginInvoke(ApplyWpf);
            }

            var hwnd = new WindowInteropHelper(_window).Handle;
            if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd))
            {
                return;
            }

            var ex = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE).ToInt64();
            if ((ex & Win32.WS_EX_LAYERED) == 0)
            {
                Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE, new IntPtr(ex | Win32.WS_EX_LAYERED));
            }

            _ = Win32.SetLayeredWindowAttributes(hwnd, 0, alpha, Win32.LWA_ALPHA);
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

    private JsonObject FilterStore(JsonObject store, string? token)
    {
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
        }

        CalendarStoreService.ProjectCalendarVisibilityForClient(clone, session.LoginId);
        return clone;
    }

    private void Reply(CoreWebView2? target, string? id, bool ok, JsonNode? result, string? error)
    {
        var core = target ?? WebView2Safe.TryGetCore(_webView) ?? WebView2Safe.TryGetCore(_secondaryWebView);
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

    private JsonObject BuildAuthPayload(bool includeToken)
    {
        var session = _auth.GetSession(_currentToken);
        var ok = session is not null;
        var payload = new JsonObject
        {
            ["authenticated"] = ok,
            ["admin"] = ok && session!.IsSuperAdmin,
            ["username"] = ok ? (session!.LoginId) : null,
            ["loginId"] = ok ? session!.LoginId : null,
            ["role"] = ok ? session!.Role : null,
            ["isSuperAdmin"] = ok && session!.IsSuperAdmin,
            ["remember"] = ok && _currentRemember,
        };
        if (includeToken && ok)
        {
            payload["token"] = _currentToken;
        }

        return payload;
    }

    /// <summary>Push shell auth to App + DesktopHost (separate WebView2 profiles).</summary>
    public void NotifyAuthChangedFromShell() => NotifyAuthChanged();

    /// <summary>Tray Start/Stop Server — refresh "브라우저에서 편집" enablement in both WebViews.</summary>
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
                ["store"] = FilterStore(_store.ReadStore(), _currentToken),
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
        payload["type"] ??= "event";
        var json = payload.ToJsonString(JsonUtil.Compact);
        WebView2Safe.TryPostJson(_webView, json);

        if (!broadcastToDesktopHost)
        {
            return;
        }

        WebView2Safe.TryPostJson(_secondaryWebView, json);
    }

    /// <summary>Forward view-nav to the other surface only (avoid echo loops).</summary>
    private void RelayViewNav(JsonObject msg, CoreWebView2? from)
    {
        var viewDate = msg["viewDate"]?.GetValue<string>();
        var selectedDate = msg["selectedDate"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(viewDate) || string.IsNullOrWhiteSpace(selectedDate))
        {
            return;
        }

        var mode = msg["viewMode"]?.GetValue<string>() ?? "month";
        if (mode is not ("month" or "week" or "year"))
        {
            mode = "month";
        }

        var payload = new JsonObject
        {
            ["type"] = "view-nav",
            ["viewMode"] = mode,
            ["viewDate"] = viewDate,
            ["selectedDate"] = selectedDate,
        };
        var json = payload.ToJsonString(JsonUtil.Compact);

        void TryPost(CoreWebView2? core)
        {
            if (core is null || ReferenceEquals(core, from))
            {
                return;
            }

            try
            {
                core.PostWebMessageAsJson(json);
            }
            catch
            {
                /* ignore */
            }
        }

        TryPost(WebView2Safe.TryGetCore(_webView));
        TryPost(WebView2Safe.TryGetCore(_secondaryWebView));
    }
}
