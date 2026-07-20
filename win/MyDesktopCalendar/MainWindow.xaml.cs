using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Forms;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using MyDesktopCalendar.Native;
using MyDesktopCalendar.Services;
using Application = System.Windows.Application;
using MessageBox = System.Windows.MessageBox;

namespace MyDesktopCalendar;

public partial class MainWindow : Window
{
    private readonly CalendarStoreService _store;
    private readonly AuthService _auth;
    private readonly DesktopEmbedService _embed = new();
    private readonly DesktopSurfaceController _surfaces;
    private readonly UndockZoneMonitor _undockZones;
    private readonly NativeBridge _bridge;
    private CalendarWebServer? _webServer;
    private NotifyIcon? _tray;
    private ToolStripMenuItem? _trayStartLocalServer;
    private ToolStripMenuItem? _trayStartWebServer;
    private ToolStripMenuItem? _trayStopServer;
    private bool _forceClose;
    private bool _closeToTrayTipShown;
    private IntPtr _hwnd;
    private HwndSource? _hwndSource;
    private bool _inSizeMove;
    private bool _resizeContentFrozen;
    private bool _webViewSizePinned;
    private bool _windowLocked;
    private System.Windows.Threading.DispatcherTimer? _displayChangeDebounce;

    public MainWindow()
    {
        InitializeComponent();

        Title = AppConstants.AppTitle;
        var windowIcon = AppIcons.GetWindowImageSource();
        if (windowIcon is not null)
        {
            Icon = windowIcon;
        }

        TrySetBootSplashIcon();

        var dataRoot = ResolveDataRoot();
        Directory.CreateDirectory(dataRoot);
        _store = new CalendarStoreService(dataRoot);
        _auth = new AuthService(dataRoot);
        try
        {
            var memberIds = _auth.Members.ListPublicMembers()
                .Select(n => n is JsonObject o ? o["loginId"]?.GetValue<string>() : null)
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Select(id => id!)
                .ToList();
            _store.EnsureMemberOwnership(_auth.AdminId, memberIds);
        }
        catch
        {
            /* ownership migrate best-effort */
        }
        SyncStartupRegistration();
        _bridge = null!;
        _surfaces = new DesktopSurfaceController(this, _embed, () => _bridge);
        _undockZones = new UndockZoneMonitor(
            _embed,
            () => _hwnd,
            ShowFromTray,
            dateKey => _bridge.SuspendForCreate(dateKey),
            (eventId, dayKey) => _bridge.SuspendForEdit(eventId, dayKey),
            action => _bridge.SuspendForUi(action));
        _bridge = new NativeBridge(_store, _auth, _embed, _undockZones, this);
        _bridge.BindSurfaces(_surfaces);
        StartWebServerOnLaunch();

        SourceInitialized += OnSourceInitialized;
        Loaded += OnLoaded;
        // Skip theme re-paint while temporary-unlocking for quick-edit —
        // DWM caption reapply on Activate can flash the desktop.
        Activated += (_, _) =>
        {
            if (_bridge.IsEmbedSuspended)
            {
                return;
            }

            _bridge.ApplyFrameThemeFromSettings();
            // Desktop mode: clicks may activate us — push back under other windows
            // unless quick-edit (etc.) has temporarily raised the surface.
            if (_windowLocked && !_embed.IsForegroundOverride)
            {
                _embed.SendToBottom();
                return;
            }

            if (_windowLocked)
            {
                return;
            }

            // Recover from rare WebView2 blank surfaces after move/minimize on older runtimes.
            if (!_embed.IsEmbedded && !_resizeContentFrozen)
            {
                EnsureWebViewRematerialized();
            }
        };
        Closing += OnClosing;
        StateChanged += OnStateChanged;
        // Track footprint + (on size-drag only) pin WebView size under a solid cover.
        // Never Visibility.Collapsed during resize — that rematerialized blank on some
        // WebView2/GPU combos. Idle-surface Low memory (Visible) is applied separately via
        // WebViewSurfaceMemory when the App HWND is DWM-cloaked. Pinning defers Chromium
        // layout to mouse-up so resize stays lightweight without the blank risk.
        LocationChanged += OnWindowLocationChanged;
        SizeChanged += OnWindowSizeChanged;

        // Monitor sleep/wake, cable reconnect, resolution/DPI, or arrangement changes can
        // leave locked bounds over screen space that no longer exists — reclamp on change.
        SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
    }

    private void TrySetBootSplashIcon()
    {
        try
        {
            var candidates = new[]
            {
                Path.Combine(AppContext.BaseDirectory, "Assets", "icon.png"),
                Path.Combine(AppContext.BaseDirectory, "wwwroot", "icon.png"),
                Path.Combine(AppContext.BaseDirectory, "wwwroot", "icons", "appIcon.png"),
            };
            var path = candidates.FirstOrDefault(File.Exists);
            if (path is null)
            {
                return;
            }

            var bitmap = new System.Windows.Media.Imaging.BitmapImage();
            bitmap.BeginInit();
            bitmap.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
            bitmap.UriSource = new Uri(path, UriKind.Absolute);
            bitmap.EndInit();
            bitmap.Freeze();
            BootSplashIcon.Source = bitmap;
        }
        catch
        {
            /* icon optional */
        }
    }

    private void RememberWindowBoundsIfNeeded()
    {
        if (_embed.IsEmbedded || WindowState != WindowState.Normal)
        {
            return;
        }

        try
        {
            _embed.LockScreenBounds(CapturePhysicalBounds());
        }
        catch
        {
            /* ignore during early init */
        }
    }

    /// <summary>
    /// Persist size/position/mode so the next launch restores the last session.
    /// Bounds are stored as physical pixels (same units as <see cref="CapturePhysicalBounds"/>).
    /// </summary>
    private void PersistWindowSession()
    {
        try
        {
            RememberWindowBoundsIfNeeded();
            var bounds = DesktopEmbedService.SnapBoundsDownTo5(
                _embed.LockedBounds ?? CapturePhysicalBounds());
            // Always reboot into desktop (locked) mode; window mode is in-session only.
            // Persist the user's last size/position for the next launch.
            _store.PatchSettings(new JsonObject
            {
                ["widget"] = new JsonObject
                {
                    ["launchMode"] = "desktop",
                    ["enabled"] = true,
                    ["bounds"] = new JsonObject
                    {
                        ["x"] = bounds.X,
                        ["y"] = bounds.Y,
                        ["width"] = bounds.Width,
                        ["height"] = bounds.Height,
                    },
                },
            });
        }
        catch
        {
            /* ignore */
        }
    }

    private void RestoreWindowSession()
    {
        try
        {
            DesktopEmbedService.Bounds physical;
            var settings = _store.ReadStore()["settings"]?.AsObject();
            var widget = settings?["widget"]?.AsObject();
            if (widget?["bounds"]?.AsObject() is { } boundsNode && boundsNode["width"] is not null)
            {
                var x = (int)Math.Round(ReadJsonNumber(boundsNode, "x", 0));
                var y = (int)Math.Round(ReadJsonNumber(boundsNode, "y", 0));
                var w = Math.Max(200, (int)Math.Round(ReadJsonNumber(boundsNode, "width", Width)));
                var h = Math.Max(150, (int)Math.Round(ReadJsonNumber(boundsNode, "height", Height)));
                physical = ClampBoundsToVirtualScreen(
                    DesktopEmbedService.SnapBoundsDownTo5(new DesktopEmbedService.Bounds(x, y, w, h)));
            }
            else
            {
                // First install / missing bounds → primary-monitor factory default.
                physical = DesktopEmbedService.GetDefaultBounds();
            }

            // CenterScreen would overwrite Left/Top after SourceInitialized — lock Manual.
            WindowStartupLocation = WindowStartupLocation.Manual;
            WindowFootprint.Sync(this, physical);
            _embed.LockScreenBounds(physical);
        }
        catch
        {
            /* keep defaults */
        }
    }

    private static double ReadJsonNumber(JsonObject obj, string key, double fallback)
    {
        if (obj[key] is not JsonValue value)
        {
            return fallback;
        }

        if (value.TryGetValue<double>(out var d))
        {
            return d;
        }

        if (value.TryGetValue<int>(out var i))
        {
            return i;
        }

        if (value.TryGetValue<long>(out var l))
        {
            return l;
        }

        return fallback;
    }

    private static DesktopEmbedService.Bounds ClampBoundsToVirtualScreen(DesktopEmbedService.Bounds bounds)
    {
        try
        {
            var area = System.Windows.Forms.SystemInformation.VirtualScreen;
            var width = Math.Min(bounds.Width, Math.Max(200, area.Width));
            var height = Math.Min(bounds.Height, Math.Max(150, area.Height));
            var maxX = area.Right - Math.Min(width, 120);
            var maxY = area.Bottom - Math.Min(height, 80);
            var x = Math.Min(Math.Max(bounds.X, area.Left), Math.Max(area.Left, maxX));
            var y = Math.Min(Math.Max(bounds.Y, area.Top), Math.Max(area.Top, maxY));
            return new DesktopEmbedService.Bounds(x, y, width, height);
        }
        catch
        {
            return bounds;
        }
    }

    private void OnWindowLocationChanged(object? sender, EventArgs e)
    {
        // Pure title-bar move: keep WebView painting — no ghost / no pin.
        RememberWindowBoundsIfNeeded();
    }

    private void OnWindowSizeChanged(object? sender, SizeChangedEventArgs e)
    {
        RememberWindowBoundsIfNeeded();

        // Edge/corner resize drag: pin WebView to its pre-drag size so Chromium does not
        // reflow on every mouse move. A full-client ghost covers the frozen surface until drop.
        if (_inSizeMove && !_resizeContentFrozen && !_embed.IsEmbedded && WindowState == WindowState.Normal)
        {
            BeginDeferredContentResize();
        }
    }

    private void BeginDeferredContentResize()
    {
        if (_resizeContentFrozen)
        {
            return;
        }

        _resizeContentFrozen = true;
        try
        {
            PinWebViewSizeForResizeDrag();
            // Cover only — never Visibility.Collapsed during the drag.
            ResizeGhost.Visibility = Visibility.Visible;
            if (WebView.Visibility != Visibility.Visible)
            {
                WebView.Visibility = Visibility.Visible;
            }
        }
        catch
        {
            /* ignore */
        }
    }

    private void EndDeferredContentResize()
    {
        if (!_resizeContentFrozen)
        {
            EnsureWebViewRematerialized();
            return;
        }

        _resizeContentFrozen = false;
        try
        {
            // Unlock layout under the cover so Chromium does one resize to final size,
            // then drop the cover so the painted surface is already ready.
            UnpinWebViewSizeAfterResizeDrag();
            WebView.UpdateLayout();
            ResizeGhost.Visibility = Visibility.Collapsed;
            EnsureWebViewRematerialized();
        }
        catch
        {
            /* ignore */
        }

        // Commit footprint + let Chromium layout once at the final size.
        try
        {
            if (!_embed.IsEmbedded && WindowState == WindowState.Normal)
            {
                _embed.LockScreenBounds(CapturePhysicalBounds());
            }
        }
        catch
        {
            /* ignore */
        }

        // One more kick after layout settles — offline / older WebView2 can miss the first show.
        _ = Dispatcher.BeginInvoke(
            EnsureWebViewRematerialized,
            System.Windows.Threading.DispatcherPriority.Loaded);
    }

    /// <summary>
    /// Freeze WebView's layout box at the drag-start size so HWND/Chromium ignore intermediate
    /// parent resizes. Drag feel stays lightweight without tearing the composition down.
    /// </summary>
    private void PinWebViewSizeForResizeDrag()
    {
        if (_webViewSizePinned)
        {
            return;
        }

        var w = WebView.ActualWidth;
        var h = WebView.ActualHeight;
        if (w < 1 || h < 1)
        {
            return;
        }

        WebView.Width = w;
        WebView.Height = h;
        WebView.HorizontalAlignment = System.Windows.HorizontalAlignment.Left;
        WebView.VerticalAlignment = VerticalAlignment.Top;
        _webViewSizePinned = true;
    }

    private void UnpinWebViewSizeAfterResizeDrag()
    {
        if (!_webViewSizePinned)
        {
            return;
        }

        WebView.ClearValue(WidthProperty);
        WebView.ClearValue(HeightProperty);
        WebView.ClearValue(HorizontalAlignmentProperty);
        WebView.ClearValue(VerticalAlignmentProperty);
        _webViewSizePinned = false;
    }

    /// <summary>
    /// Force WebView visible + Normal memory and a compositor invalidation.
    /// Safe to call anytime; used after size-move and as a recovery path.
    /// </summary>
    private void EnsureWebViewRematerialized() => SetAppWebViewActive(true);

    /// <summary>
    /// Memory throttle for the single WebView (see <see cref="WebViewSurfaceMemory"/>).
    /// </summary>
    internal void SetAppWebViewActive(bool active) => WebViewSurfaceMemory.SetActive(WebView, active);

    /// <summary>
    /// Desktop mode = locked window (no move/resize) + always-on-bottom.
    /// Window mode unlocks chrome. TitleBar hides min/max/close while <c>embedded</c>.
    /// </summary>
    internal void ApplyWindowLockMode(bool locked)
    {
        _windowLocked = locked;
        try
        {
            ResizeMode = locked ? ResizeMode.NoResize : ResizeMode.CanResize;
            if (locked && WindowState != WindowState.Normal)
            {
                WindowState = WindowState.Normal;
            }
        }
        catch
        {
            /* ignore */
        }

        _embed.EnableAlwaysOnBottom(locked);
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        const int wmEnterSizeMove = 0x0231;
        const int wmExitSizeMove = 0x0232;
        const int wmSysCommand = 0x0112;
        const int wmNcLButtonDown = 0x00A1;
        const int scMove = 0xF010;
        const int scSize = 0xF000;
        const int scMinimize = 0xF020;
        const int scMaximize = 0xF030;
        const int scClose = 0xF060;
        const int scRestore = 0xF120;
        const int htCaption = 2;
        const int htLeft = 10;
        const int htBottomRight = 17;

        if (_windowLocked)
        {
            // Keep under other apps (unless quick-edit raised us). Refuse Win+D hide.
            if (msg == Win32.WM_WINDOWPOSCHANGING && lParam != IntPtr.Zero)
            {
                try
                {
                    var pos = System.Runtime.InteropServices.Marshal.PtrToStructure<Win32.WINDOWPOS>(lParam);
                    var changed = false;
                    if ((pos.flags & Win32.SWP_HIDEWINDOW) != 0)
                    {
                        pos.flags = (pos.flags & ~Win32.SWP_HIDEWINDOW) | Win32.SWP_SHOWWINDOW;
                        changed = true;
                    }

                    // Block raises to top. Do NOT force HWND_BOTTOM here — that parks under
                    // Win+D's show-desktop WorkerW and the calendar vanishes. Desktop-layer
                    // placement is owned by DesktopEmbedService.SendToBottom().
                    if (!_embed.IsForegroundOverride && (pos.flags & Win32.SWP_NOZORDER) == 0)
                    {
                        var after = pos.hwndInsertAfter;
                        if (after == Win32.HWND_TOP || after == Win32.HWND_TOPMOST)
                        {
                            pos.flags |= Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE;
                            changed = true;
                        }
                    }

                    if (changed)
                    {
                        System.Runtime.InteropServices.Marshal.StructureToPtr(pos, lParam, false);
                    }
                }
                catch
                {
                    /* ignore */
                }
            }

            // ShowWindow(SW_HIDE / FORCEMINIMIZE) path used by Win+D on some builds.
            if (msg == Win32.WM_SHOWWINDOW && wParam == IntPtr.Zero)
            {
                handled = true;
                _ = Dispatcher.BeginInvoke(() =>
                {
                    if (_windowLocked)
                    {
                        _embed.EnsureVisibleOnDesktop();
                    }
                });
                return IntPtr.Zero;
            }

            if (msg == Win32.WM_SIZE && wParam.ToInt32() == Win32.SIZE_MINIMIZED)
            {
                handled = true;
                _ = Dispatcher.BeginInvoke(() =>
                {
                    if (!_windowLocked)
                    {
                        return;
                    }

                    try
                    {
                        if (WindowState != WindowState.Normal)
                        {
                            WindowState = WindowState.Normal;
                        }
                    }
                    catch
                    {
                        /* ignore */
                    }

                    _embed.EnsureVisibleOnDesktop();
                });
                return IntPtr.Zero;
            }

            if (msg == Win32.WM_ACTIVATE)
            {
                _ = Dispatcher.BeginInvoke(() =>
                {
                    if (_windowLocked && !_embed.IsForegroundOverride)
                    {
                        _embed.SendToBottom();
                    }
                });
            }

            if (msg == wmSysCommand)
            {
                var cmd = wParam.ToInt32() & 0xFFF0;
                if (cmd is scMove or scSize or scMinimize or scMaximize or scClose or scRestore)
                {
                    handled = true;
                    return IntPtr.Zero;
                }
            }

            if (msg == wmNcLButtonDown)
            {
                var hit = wParam.ToInt32();
                if (hit == htCaption || (hit >= htLeft && hit <= htBottomRight))
                {
                    handled = true;
                    return IntPtr.Zero;
                }
            }

            if (msg == wmEnterSizeMove)
            {
                handled = true;
                return IntPtr.Zero;
            }
        }

        if (msg == wmEnterSizeMove)
        {
            _inSizeMove = true;
        }
        else if (msg == wmExitSizeMove)
        {
            _inSizeMove = false;
            EndDeferredContentResize();
            PersistWindowSession();
        }

        return IntPtr.Zero;
    }

    private static string ResolveDataRoot()
    {
        // Prefer portable / MSI data next to the executable.
        var beside = Path.Combine(AppContext.BaseDirectory, AppConstants.DefaultDataDir);
        if (Directory.Exists(beside))
        {
            return beside;
        }

        // Dev only: when running from win/*/bin/…, reuse the repo workspace data/.
        var baseDir = AppContext.BaseDirectory;
        var looksLikeDevBin = baseDir.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase)
            || baseDir.Contains($"{Path.AltDirectorySeparatorChar}bin{Path.AltDirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase);
        if (looksLikeDevBin)
        {
            var repo = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", "..", "data"));
            if (Directory.Exists(repo))
            {
                return repo;
            }

            var workspace = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", "data"));
            if (Directory.Exists(workspace))
            {
                return workspace;
            }
        }

        Directory.CreateDirectory(beside);
        return beside;
    }

    /// <summary>Reconciles the Windows "Run at startup" registry entry with the saved setting on launch.</summary>
    private void SyncStartupRegistration()
    {
        try
        {
            var viewOptions = _store.ReadStore()["settings"]?["viewOptions"]?.AsObject();
            var runAtStartup = viewOptions?["runAtStartup"]?.GetValue<bool>() ?? true;
            StartupRegistrationService.Sync(runAtStartup);
        }
        catch
        {
            /* ignore */
        }
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        _hwnd = new WindowInteropHelper(this).Handle;
        // Cloak before first paint so boot does not flash unlocked chrome, then enter
        // locked desktop mode (or window mode if that fails).
        CloakAppWindowAtBoot(_hwnd);
        _surfaces.MarkAppCloakedAtBoot();
        ApplyNativeWindowIcons(_hwnd);
        // Single HWND: DesktopEmbedService attaches here on first EnterDesktopMode.
        DisableAppDwmTransitions(_hwnd);
        _hwndSource = HwndSource.FromHwnd(_hwnd);
        _hwndSource?.AddHook(WndProc);
        _bridge.ApplyFrameThemeFromSettings();
        // HWND exists now — apply startup registration + force opaque chrome.
        _bridge.ApplyShellSettingsFromStore();

        RestoreWindowSession();
    }

    private static void CloakAppWindowAtBoot(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd))
        {
            return;
        }

        var value = 1;
        _ = Win32.DwmSetWindowAttribute(hwnd, Win32.DWMWA_CLOAK, ref value, sizeof(int));
    }

    private static void DisableAppDwmTransitions(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd))
        {
            return;
        }

        var enabled = 1;
        _ = Win32.DwmSetWindowAttribute(hwnd, Win32.DWMWA_TRANSITIONS_FORCEDISABLED, ref enabled, sizeof(int));
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        SetupTray();
        await InitWebViewAsync();
        _bridge.ApplyFrameThemeFromSettings();

        // Desktop (locked) mode is the launch default. Window mode is a manual in-session
        // tool for move/resize; it is never restored as the boot mode.
        _ = Dispatcher.BeginInvoke(async () =>
        {
            await Task.Delay(400);
            try
            {
                // If the React login wall already opened and claimed suspend, stay
                // unlocked until the dialog closes (shouldCloakApp / preferDesktop).
                await _surfaces.EnterDesktopModeAsync(
                    _embed.LockedBounds ?? CapturePhysicalBounds(),
                    shouldCloakApp: () => !_bridge.IsEmbedSuspended);
                _bridge.NotifyWidgetStatus();
            }
            catch (Exception ex)
            {
                MessageBox.Show($"바탕화면 모드 전환 실패: {ex.Message}", AppConstants.AppTitle);
                try
                {
                    // Lock failed at boot — fall back to a real window instead of
                    // leaving the HWND cloaked (invisible) forever.
                    _surfaces.EnterWindowMode();
                }
                catch
                {
                    /* best-effort — nothing more we can do here */
                }
            }
        }, System.Windows.Threading.DispatcherPriority.Background);
    }

    /// <summary>
    /// SystemEvents fires on its own worker thread, and a single physical monitor change
    /// (sleep/wake, cable reconnect, resolution/DPI change) commonly raises this several times
    /// in a row while Windows settles on a final topology — marshal to the UI thread and
    /// debounce before touching any Win32/WPF window state.
    /// </summary>
    private void OnDisplaySettingsChanged(object? sender, EventArgs e)
    {
        try
        {
            Dispatcher.BeginInvoke(() =>
            {
                _displayChangeDebounce?.Stop();
                _displayChangeDebounce ??= new System.Windows.Threading.DispatcherTimer
                {
                    Interval = TimeSpan.FromMilliseconds(700),
                };
                _displayChangeDebounce.Tick -= OnDisplayChangeSettled;
                _displayChangeDebounce.Tick += OnDisplayChangeSettled;
                _displayChangeDebounce.Start();
            });
        }
        catch
        {
            /* ignore — window may be tearing down */
        }
    }

    private void OnDisplayChangeSettled(object? sender, EventArgs e)
    {
        _displayChangeDebounce?.Stop();
        try
        {
            _embed.HandleDisplayChanged();
            _bridge.NotifyWidgetStatus();
        }
        catch
        {
            /* best-effort recovery — next manual apply/tray retry keeps trying */
        }
    }

    private DesktopEmbedService.Bounds CapturePhysicalBounds()
    {
        if (_hwnd != IntPtr.Zero && Win32.GetWindowRect(_hwnd, out var rect))
        {
            return new DesktopEmbedService.Bounds(
                rect.Left,
                rect.Top,
                Math.Max(200, rect.Right - rect.Left),
                Math.Max(150, rect.Bottom - rect.Top));
        }

        return DesktopEmbedService.GetDefaultBounds();
    }

    private async Task InitWebViewAsync(bool afterRuntimeInstall = false)
    {
        Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0xFFEEF0F2");

        if (!WebView2RuntimeGuide.IsRuntimeAvailable())
        {
            BootSplash.Visibility = Visibility.Collapsed;
            var ready = await WebView2RuntimeGuide.EnsureRuntimeOrGuideAsync(this);
            if (!ready)
            {
                _forceClose = true;
                Close();
                return;
            }
        }

        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                AppConstants.AppName,
                "webview2-data");
            Directory.CreateDirectory(userData);

            var options = new CoreWebView2EnvironmentOptions(
                additionalBrowserArguments: string.Join(' ',
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-background-networking",
                    "--disable-component-update",
                    "--disable-features=msSmartScreenProtection,CalculateNativeWinOcclusion"));
            var env = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: userData,
                options: options);
            await WebView.EnsureCoreWebView2Async(env);

            WebView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 0xEE, 0xF0, 0xF2);
            WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            WebView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            WebView.CoreWebView2.Settings.AreDevToolsEnabled = true;
            WebView.CoreWebView2.NavigationCompleted += OnWebViewNavigationCompleted;
            WebView.CoreWebView2.ProcessFailed += (_, args) =>
            {
                try
                {
                    Dispatcher.Invoke(() =>
                    {
                        MessageBox.Show(
                            this,
                            $"WebView2 프로세스 오류: {args.ProcessFailedKind}\n앱을 다시 실행해 주세요.",
                            AppConstants.AppTitle,
                            MessageBoxButton.OK,
                            MessageBoxImage.Warning);
                    });
                }
                catch
                {
                    /* ignore */
                }
            };

            var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            if (!Directory.Exists(wwwroot) || !File.Exists(Path.Combine(wwwroot, "index.html")))
            {
                // Dev fallback: load Vite dist from repo
                var dist = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "dist"));
                if (Directory.Exists(dist))
                {
                    wwwroot = dist;
                }
            }

            if (!Directory.Exists(wwwroot))
            {
                Directory.CreateDirectory(wwwroot);
                await File.WriteAllTextAsync(Path.Combine(wwwroot, "index.html"), """
                    <!doctype html><html><body style="font-family:Segoe UI;padding:2rem">
                    <h1>My Desktop Calendar</h1>
                    <p>UI 빌드가 없습니다. 프로젝트 루트에서 <code>npm run build</code> 후
                    <code>npm run win:sync-ui</code> 를 실행하세요.</p>
                    </body></html>
                    """);
            }

            WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                AppConstants.VirtualHost,
                wwwroot,
                CoreWebView2HostResourceAccessKind.Allow);

            try
            {
                var fontsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Fonts");
                if (Directory.Exists(fontsDir))
                {
                    WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                        "winfonts.local",
                        fontsDir,
                        CoreWebView2HostResourceAccessKind.Allow);
                }
            }
            catch
            {
                /* optional */
            }

            _bridge.Attach(WebView);
            await WebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                """
                window.addEventListener('error', function (e) {
                  try {
                    console.error('[mycalendar]', e.message, e.filename, e.lineno);
                    if (window.chrome && window.chrome.webview) {
                      window.chrome.webview.postMessage({
                        type: 'renderer-error',
                        message: String(e.message || 'error'),
                        source: String(e.filename || ''),
                        line: e.lineno || 0,
                      });
                    }
                  } catch (_) {}
                });
                window.addEventListener('unhandledrejection', function (e) {
                  try {
                    var reason = e && e.reason;
                    var message = reason && reason.message ? reason.message : String(reason || 'rejection');
                    console.error('[mycalendar] unhandledrejection', message);
                    if (window.chrome && window.chrome.webview) {
                      window.chrome.webview.postMessage({
                        type: 'renderer-error',
                        message: message,
                        source: 'unhandledrejection',
                        line: 0,
                      });
                    }
                  } catch (_) {}
                });
                """);
            WebView.CoreWebView2.Navigate($"https://{AppConstants.VirtualHost}/index.html");
        }
        catch (Exception ex)
        {
            BootSplash.Visibility = Visibility.Collapsed;
            if (!afterRuntimeInstall && !WebView2RuntimeGuide.IsRuntimeAvailable())
            {
                var ready = await WebView2RuntimeGuide.EnsureRuntimeOrGuideAsync(this, ex);
                if (ready)
                {
                    await InitWebViewAsync(afterRuntimeInstall: true);
                    return;
                }

                _forceClose = true;
                Close();
                return;
            }

            MessageBox.Show(
                this,
                $"화면을 초기화하지 못했습니다.\n{ex.Message}",
                AppConstants.AppTitle,
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
    }

    private void OnWebViewNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
        {
            BootSplash.Visibility = Visibility.Collapsed;
            MessageBox.Show(
                this,
                "화면을 불러오지 못했습니다.\n앱을 종료한 뒤 다시 실행해 주세요.",
                AppConstants.AppTitle,
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
            return;
        }

        // Keep WPF splash until React signals ready (or fallback probe succeeds).
        _ = ProbeUiReadyAsync();
    }

    private async Task ProbeUiReadyAsync()
    {
        try
        {
            for (var attempt = 0; attempt < 40; attempt++)
            {
                await Task.Delay(250);

                var core = WebView2Safe.TryGetCore(WebView);
                if (core is null)
                {
                    return;
                }

                var raw = await core.ExecuteScriptAsync(
                    """
                    (function () {
                      var root = document.getElementById('root');
                      if (!root) return JSON.stringify({ ok: false, reason: 'no-root' });
                      var text = (root.innerText || '').trim();
                      var hasUi = !!root.querySelector('.month-view, .year-view, header, [data-shell-chrome]');
                      var hasBoot = !!document.getElementById('boot-splash');
                      return JSON.stringify({
                        ok: hasUi || (text.length > 0 && !hasBoot),
                        hasUi: hasUi,
                        hasBoot: hasBoot,
                        textLen: text.length,
                        text: text.slice(0, 120)
                      });
                    })()
                    """);

                var ok = false;
                var payload = raw ?? "";
                try
                {
                    // ExecuteScriptAsync JSON-encodes the JS string return value.
                    var inner = System.Text.Json.JsonSerializer.Deserialize<string>(raw ?? "\"\"");
                    payload = inner ?? payload;
                    using var doc = System.Text.Json.JsonDocument.Parse(payload);
                    ok = doc.RootElement.TryGetProperty("ok", out var okProp) && okProp.GetBoolean();
                }
                catch
                {
                    ok = payload.Contains("\"ok\":true", StringComparison.Ordinal);
                }

                if (ok)
                {
                    HideBootSplash();
                    return;
                }

                // Persist last probe for troubleshooting blank screens.
                try
                {
                    var diag = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        AppConstants.AppName,
                        "webview-diag.txt");
                    Directory.CreateDirectory(Path.GetDirectoryName(diag)!);
                    await File.WriteAllTextAsync(diag, $"{DateTime.Now:o}\nnavigation probe\n{payload}\n");
                }
                catch
                {
                    /* ignore */
                }
            }

            HideBootSplash();
            MessageBox.Show(
                this,
                "캘린더 UI가 준비되지 않았습니다.\n앱을 종료한 뒤 다시 실행해 주세요.",
                AppConstants.AppTitle,
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
        catch (Exception ex)
        {
            HideBootSplash();
            MessageBox.Show(
                this,
                $"화면 확인 중 오류:\n{ex.Message}",
                AppConstants.AppTitle,
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }

    private void HideBootSplash()
    {
        if (BootSplash.Visibility != Visibility.Collapsed)
        {
            BootSplash.Visibility = Visibility.Collapsed;
        }
    }

    public void HideBootSplashFromBridge() => HideBootSplash();

    /// <summary>Called when a second instance tries to start — surface the existing window.</summary>
    public void BringToForegroundFromSecondInstance()
    {
        ShowFromTray();
        try
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            if (hwnd != IntPtr.Zero)
            {
                Win32.ShowWindow(hwnd, Win32.SW_RESTORE);
                Win32.SetForegroundWindow(hwnd);
            }
        }
        catch
        {
            /* ignore */
        }
    }

    private static void ApplyNativeWindowIcons(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            return;
        }

        // Ensure taskbar / Alt-Tab use the app icon (borderless WPF can miss this).
        Win32.SendMessageW(hwnd, Win32.WM_SETICON, new IntPtr(Win32.ICON_SMALL), AppIcons.GetSmallWindowIcon().Handle);
        Win32.SendMessageW(hwnd, Win32.WM_SETICON, new IntPtr(Win32.ICON_BIG), AppIcons.GetLargeWindowIcon().Handle);
    }

    private void SetupTray()
    {
        _tray = new NotifyIcon
        {
            Visible = true,
            Text = AppConstants.AppTitle,
            Icon = AppIcons.GetTrayIcon(),
        };

        var menu = new ContextMenuStrip();
        _trayStartLocalServer = new ToolStripMenuItem(
            "Start Server (local)",
            null,
            (_, _) => RunOnUi(StartLocalWebServerFromTray));
        _trayStartWebServer = new ToolStripMenuItem(
            "Start Server (Web)",
            null,
            (_, _) => RunOnUi(StartLanWebServerFromTray));
        _trayStopServer = new ToolStripMenuItem("Stop Server", null, (_, _) => RunOnUi(StopWebServerFromTray));
        menu.Items.Add(_trayStartLocalServer);
        menu.Items.Add(_trayStartWebServer);
        menu.Items.Add(_trayStopServer);
        menu.Items.Add(new ToolStripSeparator());

        try
        {
            menu.ImageScalingSize = new System.Drawing.Size(16, 16);
            var appBmp = AppIcons.GetAppIcon().ToBitmap();
            menu.Items.Add("바탕화면 모드", appBmp, (_, _) => RunOnUi(EnterDesktopModeFromTray));
        }
        catch
        {
            menu.Items.Add("바탕화면 모드", null, (_, _) => RunOnUi(EnterDesktopModeFromTray));
        }
        menu.Items.Add("창 모드 (Unlock)", null, (_, _) => RunOnUi(ShowFromTray));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("정보", null, (_, _) => RunOnUi(() =>
        {
            MessageBox.Show(
                $"{AppConstants.AppTitle}\nWindows 네이티브 (WPF) 셸\n{AppConstants.SiteUrl}",
                "정보",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
        }));
        menu.Items.Add("종료", null, (_, _) => RunOnUi(ExitApplication));

        menu.Opening += (_, _) => RefreshTrayServerMenu();
        _tray.ContextMenuStrip = menu;
        _tray.DoubleClick += (_, _) => RunOnUi(ShowFromTray);
        RefreshTrayServerMenu();
    }

    private void RefreshTrayServerMenu()
    {
        var running = _webServer?.IsRunning == true;
        var lanMode = running && _webServer?.LanMode == true;

        if (_trayStartLocalServer is not null)
        {
            // Only one mode at a time: disable the item that matches the active mode.
            _trayStartLocalServer.Enabled = !running || lanMode;
            _trayStartLocalServer.Checked = running && !lanMode;
        }

        if (_trayStartWebServer is not null)
        {
            _trayStartWebServer.Enabled = !running || !lanMode;
            _trayStartWebServer.Checked = lanMode;
        }

        if (_trayStopServer is not null)
        {
            _trayStopServer.Enabled = running;
        }
    }

    /// <summary>
    /// Tray Start Server (local): loopback-only in effect (Allowed-Hosts restricts to
    /// 127.0.0.1/localhost per request), but binds the same "+" wildcard prefix as Web mode —
    /// http.sys URL-ACL reservations are matched by exact prefix string, so a literal
    /// "127.0.0.1" prefix needs its own separate admin-registered ACL and fails with
    /// Access Denied for non-admin processes even when "http://+:{port}/" is already reserved.
    /// Stops Web/LAN mode first so only one listener is active.
    /// </summary>
    private void StartLocalWebServerFromTray()
        => StartWebServerFromTray(
            hostnameOverride: "+",
            allowedHostsOverride: "127.0.0.1,localhost",
            balloon: true,
            failTitle: "Start Server (local)");

    /// <summary>
    /// Tray Start Server (Web): force LAN bind (HOSTNAME=0.0.0.0, ALLOWED_HOSTS=*) regardless of .env.
    /// PORT still comes from .env when set; otherwise 3010. Stops local mode first.
    /// </summary>
    private void StartLanWebServerFromTray()
        => StartWebServerFromTray(
            hostnameOverride: "0.0.0.0",
            allowedHostsOverride: "*",
            balloon: true,
            failTitle: "Start Server (Web)");

    private void StartWebServerFromTray(
        string hostnameOverride,
        string? allowedHostsOverride,
        bool balloon,
        string failTitle)
    {
        try
        {
            var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            if (!Directory.Exists(wwwroot))
            {
                MessageBox.Show("wwwroot 를 찾을 수 없습니다.", AppConstants.AppTitle);
                return;
            }

            // Mutual exclusion: stop whatever is listening before binding the other mode.
            StopWebServerInternal();

            var server = new CalendarWebServer(_bridge, wwwroot);
            if (server.TryStart(
                    hostnameOverride,
                    allowedHostsOverride,
                    requirePortInEnv: false,
                    out var message))
            {
                _webServer = server;
                _bridge.WebServer = server;
                System.Diagnostics.Trace.WriteLine($"[web] tray start ({hostnameOverride}): {message}");
                _bridge.NotifyServerModeChanged();
                if (balloon)
                {
                    try
                    {
                        _tray?.ShowBalloonTip(
                            4000,
                            AppConstants.AppTitle,
                            message,
                            ToolTipIcon.Info);
                    }
                    catch
                    {
                        /* ignore */
                    }
                }
            }
            else
            {
                server.Dispose();
                MessageBox.Show(message, AppConstants.AppTitle, MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"{failTitle} 실패:\n{ex.Message}", AppConstants.AppTitle);
        }
        finally
        {
            RefreshTrayServerMenu();
        }
    }

    private void StopWebServerFromTray()
    {
        try
        {
            if (_webServer?.IsRunning != true)
            {
                return;
            }

            StopWebServerInternal();
            System.Diagnostics.Trace.WriteLine("[web] tray stop");
            _bridge.NotifyServerModeChanged();
            try
            {
                _tray?.ShowBalloonTip(
                    2500,
                    AppConstants.AppTitle,
                    "HTTP server stopped.",
                    ToolTipIcon.Info);
            }
            catch
            {
                /* ignore */
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Stop Server 실패:\n{ex.Message}", AppConstants.AppTitle);
        }
        finally
        {
            RefreshTrayServerMenu();
        }
    }

    private void StopWebServerInternal()
    {
        if (_webServer is null)
        {
            return;
        }

        try
        {
            _webServer.Dispose();
        }
        catch
        {
            /* ignore */
        }

        _webServer = null;
        _bridge.WebServer = null;
    }

    /// <summary>
    /// NotifyIcon callbacks run on a WinForms thread — always marshal to the WPF UI thread.
    /// </summary>
    private void RunOnUi(Action action)
    {
        if (Dispatcher.CheckAccess())
        {
            action();
            return;
        }

        Dispatcher.Invoke(action);
    }

    private void EnterDesktopModeFromTray()
    {
        try
        {
            var bounds = _embed.LockedBounds ?? CapturePhysicalBounds();
            _ = EnterDesktopModeFromTrayAsync(bounds);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"바탕화면 모드 실패:\n{ex.Message}", AppConstants.AppTitle);
        }
    }

    private async Task EnterDesktopModeFromTrayAsync(DesktopEmbedService.Bounds bounds)
    {
        try
        {
            var readiness = DesktopReadiness.Evaluate(_embed);
            if (readiness["ready"]?.GetValue<bool>() != true)
            {
                MessageBox.Show(
                    DesktopReadiness.FormatMissingMessage(readiness),
                    AppConstants.AppTitle,
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
                return;
            }

            await _surfaces.EnterDesktopModeAsync(bounds);
            // Defensive: if a prior abnormal close left the suspended flag stuck (see
            // OnClosing / NativeBridge window/close|minimize), re-entering desktop mode
            // from the tray must not inherit it — otherwise every later quick-edit/settings
            // open would silently no-op. No-op when nothing was actually suspended.
            _ = _bridge.CancelSuspendedOverlayIfActive();

            try
            {
                var snapped = DesktopEmbedService.SnapBoundsDownTo5(bounds);
                _store.PatchSettings(new JsonObject
                {
                    ["widget"] = new JsonObject
                    {
                        ["launchMode"] = "desktop",
                        ["enabled"] = true,
                        ["bounds"] = new JsonObject
                        {
                            ["x"] = snapped.X,
                            ["y"] = snapped.Y,
                            ["width"] = snapped.Width,
                            ["height"] = snapped.Height,
                        },
                    },
                });
            }
            catch
            {
                /* ignore */
            }

            _bridge.NotifyAuthChangedFromShell();
            _bridge.NotifyWidgetStatus();

            if (!_embed.IsEmbedded)
            {
                MessageBox.Show(
                    "바탕화면 모드 전환에 실패했습니다.",
                    AppConstants.AppTitle);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"바탕화면 모드 실패:\n{ex.Message}", AppConstants.AppTitle);
        }
    }

    private void ShowFromTray()
    {
        try
        {
            _surfaces.EnterWindowMode(bringToFront: true);

            try
            {
                var bounds = DesktopEmbedService.SnapBoundsDownTo5(
                    _embed.LockedBounds ?? CapturePhysicalBounds());
                _store.PatchSettings(new JsonObject
                {
                    ["widget"] = new JsonObject
                    {
                        ["launchMode"] = "window",
                        ["enabled"] = false,
                        ["bounds"] = new JsonObject
                        {
                            ["x"] = bounds.X,
                            ["y"] = bounds.Y,
                            ["width"] = bounds.Width,
                            ["height"] = bounds.Height,
                        },
                    },
                });
            }
            catch
            {
                /* ignore */
            }

            _bridge.NotifyWindowMode();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"창을 표시하지 못했습니다.\n{ex.Message}", AppConstants.AppTitle);
        }
    }

    private void OnStateChanged(object? sender, EventArgs e)
    {
        if (!_windowLocked)
        {
            return;
        }

        // Win+D / minimize-all must not tuck the desktop widget away.
        if (WindowState != WindowState.Normal)
        {
            try
            {
                WindowState = WindowState.Normal;
            }
            catch
            {
                /* ignore */
            }
        }

        _embed.EnsureVisibleOnDesktop();
    }

    /// <summary>
    /// App launch: start HTTP server from .env HOSTNAME.
    /// Missing / empty / localhost / 127.0.0.1 → Start Server (local).
    /// 0.0.0.0 → Start Server (Web / LAN).
    /// PORT from .env or 3010. See <see cref="StartLocalWebServerFromTray"/> for why
    /// local mode binds "+" instead of a literal "127.0.0.1" prefix.
    /// </summary>
    private void StartWebServerOnLaunch()
    {
        try
        {
            var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            if (!Directory.Exists(wwwroot))
            {
                return;
            }

            StopWebServerInternal();

            var (hostnameOverride, allowedHostsOverride, modeLabel) = ResolveLaunchServerMode();

            var server = new CalendarWebServer(_bridge, wwwroot);
            if (server.TryStart(
                    hostnameOverride,
                    allowedHostsOverride,
                    requirePortInEnv: false,
                    out var message))
            {
                _webServer = server;
                _bridge.WebServer = server;
                System.Diagnostics.Trace.WriteLine($"[web] launch {modeLabel}: {message}");
                _bridge.NotifyServerModeChanged();
            }
            else
            {
                server.Dispose();
                System.Diagnostics.Trace.WriteLine($"[web] launch {modeLabel} skipped: {message}");
                _bridge.NotifyServerModeChanged();
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Trace.WriteLine($"[web] launch failed: {ex.Message}");
        }
        finally
        {
            RefreshTrayServerMenu();
        }
    }

    /// <summary>
    /// Map .env HOSTNAME to tray-equivalent start modes:
    /// local (loopback Allowed-Hosts) vs Web (LAN bind).
    /// </summary>
    private static (string HostnameOverride, string AllowedHostsOverride, string ModeLabel) ResolveLaunchServerMode()
    {
        var env = DotEnv.Load();
        var hostname = PickEnv(env, "HOSTNAME", "MYCALENDAR_HOSTNAME", "NEOCALENDAR_HOSTNAME")?.Trim() ?? "";
        if (hostname is "" or "localhost")
        {
            hostname = "127.0.0.1";
        }

        if (hostname == "0.0.0.0")
        {
            return ("0.0.0.0", "*", "web");
        }

        return ("+", "127.0.0.1,localhost", "local");
    }

    private static string? PickEnv(Dictionary<string, string> env, params string[] keys)
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

    /// <summary>Persist session then quit for real (tray Exit / shutdown API).</summary>
    public void ExitApplication()
    {
        PersistWindowSession();
        _forceClose = true;
        Application.Current.Shutdown();
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        PersistWindowSession();

        if (_forceClose)
        {
            if (_hwndSource is not null)
            {
                _hwndSource.RemoveHook(WndProc);
                _hwndSource = null;
            }

            SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
            _displayChangeDebounce?.Stop();

            _webServer?.Dispose();
            _tray?.Dispose();
            return;
        }

        e.Cancel = true;

        // Alt+F4 / system close while a desktop-mode overlay is open: cancel the overlay
        // (same as the in-UI close) instead of hiding the single surface.
        if (_bridge.CancelSuspendedOverlayIfActive())
        {
            return;
        }

        Hide();
        MaybeShowCloseToTrayTip();
    }

    private void MaybeShowCloseToTrayTip()
    {
        if (_closeToTrayTipShown || _tray is null)
        {
            return;
        }

        try
        {
            var tipPath = Path.Combine(_store.DataRoot, ".close-to-tray-tip-shown");
            if (File.Exists(tipPath))
            {
                _closeToTrayTipShown = true;
                return;
            }

            File.WriteAllText(tipPath, DateTime.UtcNow.ToString("o"));
            _closeToTrayTipShown = true;
            _tray.BalloonTipTitle = AppConstants.AppName;
            _tray.BalloonTipText = "닫으면 트레이로 이동합니다. 완전히 종료하려면 트레이 아이콘 → 종료를 선택하세요.";
            _tray.BalloonTipIcon = ToolTipIcon.Info;
            _tray.ShowBalloonTip(5000);
        }
        catch
        {
            /* ignore */
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
        _displayChangeDebounce?.Stop();
        _webServer?.Dispose();
        _tray?.Dispose();
        base.OnClosed(e);
        Application.Current.Shutdown();
    }
}
