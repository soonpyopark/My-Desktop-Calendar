using System.Windows;
using System.Windows.Interop;
using MyDesktopCalendar.Native;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Dual-HWND surface switcher (rule #1): AppWindow stays top-level forever;
/// DesktopHost is SetParent'd when desktop mode needs it. AppWindow visibility
/// toggles use DWM cloak (DWMWA_CLOAK) instead of Show/Hide.
///
/// Single-WebView memory policy: the idle surface's WebView2 is disposed (not merely
/// Low) so Task Manager shows one Chromium tree in steady state — App parked while
/// desktop-cloaked; Host torn down in permanent window mode. Temporary UI suspend
/// keeps Host Hidden+Low for a fast resume (brief dual trees only while overlays open).
/// </summary>
internal sealed class DesktopSurfaceController
{
    private readonly Window _app;
    private readonly DesktopEmbedService _embed;
    private readonly Func<NativeBridge> _bridge;
    private DesktopHostWindow? _host;
    private bool _hostReady;
    private Task? _ensureHostTask;

    /// <summary>
    /// True once AppWindow has been DWM-cloaked. AppWindow stays real WS_VISIBLE
    /// forever after its first Show — visibility toggles use DWMWA_CLOAK. While
    /// cloaked, App WebView is parked (disposed) so only DesktopHost Chromium remains.
    /// </summary>
    private bool _appCloaked;

    public DesktopSurfaceController(Window app, DesktopEmbedService embed, Func<NativeBridge> bridge)
    {
        _app = app;
        _embed = embed;
        _bridge = bridge;
    }

    /// <summary>
    /// MainWindow DWM-cloaks its own HWND directly in OnSourceInitialized, before this
    /// controller ever touches it, to stop the boot-splash/normal-window flash. Call this
    /// right after so <see cref="_appCloaked"/> matches reality — no <see cref="_app"/>.Show()
    /// or redundant SetWindowAttribute call here, MainWindow already did the real work.
    /// </summary>
    public void MarkAppCloakedAtBoot()
    {
        _appCloaked = true;
    }

    public DesktopEmbedService Embed => _embed;
    public DesktopHostWindow? Host => _host;
    public IntPtr HostHwnd => _host?.EnsureHwnd() ?? IntPtr.Zero;

    /// <summary>DesktopHost is shell-parented and currently visible.</summary>
    public bool IsDesktopSurfaceActive => _embed.IsEmbedded;

    /// <summary>DesktopHost remains parented even when hidden for window/overlay mode.</summary>
    public bool IsShellParented => _embed.IsShellParented;

    /// <param name="shouldCloakApp">
    /// Evaluated as late as possible — right before the cloak/hide decision, after
    /// EnsureHostReadyAsync's await (which can take a while on a cold WebView2 profile) —
    /// so a React login-wall claim that lands mid-await is still honored. Return false when
    /// a temporary App-side overlay (e.g. the login wall auto-opening at boot) has claimed
    /// the suspend flag before this first embed ran: Host still gets embedded/parented
    /// normally, but AppWindow is left visible on top instead of being cloaked out from
    /// under the open overlay. Caller is responsible for the later resume (same
    /// ResumeDesktopAfterUi path used by every other temporary-unlock case). Null means
    /// always cloak (the default/normal path).
    /// </param>
    public async Task EnterDesktopModeAsync(DesktopEmbedService.Bounds? bounds = null, Func<bool>? shouldCloakApp = null)
    {
        await EnsureHostReadyAsync();
        var target = Normalize(bounds ?? _embed.LockedBounds ?? CaptureAppPhysicalBounds() ?? _embed.GetCurrentBounds());
        _embed.LockScreenBounds(target);
        var cloakApp = shouldCloakApp?.Invoke() ?? true;

        if (!_embed.IsShellParented)
        {
            // First (and only routine) SetParent — freeze-frame cover for this one-time attach.
            // This is the sole remaining PrintWindow-cover usage; every later mode/UI switch
            // uses DWM cloak on AppWindow instead (see EnterWindowMode / SuspendDesktopForUi /
            // ResumeDesktopAfterUi below), because AppWindow is always already fully painted.
            // Skip the cover when staying uncloaked — App is already the visible surface, so
            // there is nothing to freeze/hide during the SetParent. Also skip it when App is
            // already cloaked (the normal boot path — see MainWindow.OnSourceInitialized's
            // boot-cloak): nothing is visible to freeze-frame in the first place. Kept as a
            // fallback for the rare case the boot-cloak didn't happen (e.g. a later, non-boot
            // first embed).
            //
            // Capture source must be AppWindow, never HostHwnd: at this point Host still sits
            // at its CreateHostAsync placeholder geometry (16x16, off-screen at -32000,-32000) —
            // _embed.Embed(target) below is what resizes/repositions/reparents it. Printing
            // HostHwnd here only ever captures that tiny off-screen sliver, which either fails
            // the IsMostlyBlack check (rejected) or falls through to TryCaptureScreen, which then
            // photographs the bare desktop wallpaper at the target position (AppWindow may not
            // be there) — producing the flat gray "everything vanished" cover instead of a real
            // frozen frame. AppWindow, by contrast, is guaranteed on-screen at `target` right now
            // (target defaults to CaptureAppPhysicalBounds() above) and fully painted, so it's
            // always the correct freeze source for this transition.
            // Right after a fresh reboot/login our own auto-start frequently wins the race
            // against Explorer still building the desktop icon list — embedding before
            // SysListView32 exists yet permanently commits this process to the heavier
            // WS_CHILD/auto fallback (see IsSysListView32Ready's doc) for its entire
            // lifetime, since a later Embed() call never re-attempts it once shell-parented.
            // No-op almost instantly once the shell is already up (manual re-launch, not a
            // fresh boot) — only actually waits right after a reboot.
            await WaitForSysListView32ReadyAsync();

            var covered = cloakApp && !_appCloaked && DesktopTransitionCover.TryShow(
                _app,
                GetAppHwnd(),
                target);
            try
            {
                _embed.Embed(target);
            }
            finally
            {
                if (covered)
                {
                    DesktopTransitionCover.HideAfterComposition(_app);
                }
            }

            if (cloakApp)
            {
                CloakAppWindow(parkWebView: false);
                // Defer dispose until after this turn — boot ProbeUiReadyAsync / NavigationCompleted
                // may still be touching App WebView on the same dispatcher frame.
                ScheduleParkAppWebView();
            }
            else
            {
                // Login wall / boot-suspend claimed before this first embed: Host must stay
                // hidden under the App overlay until resume. App was already DWM-cloaked at
                // OnSourceInitialized (CloakAppWindowAtBoot) to hide the splash flash — so
                // "keep App on top" here means we must *uncloak* it. Without that, both
                // surfaces stay invisible (classic MSI first-run blank screen: claimBootSuspend
                // for the login dialog + Host HideSurface + App still cloaked).
                PlaceAppWindow(target);
                await UncloakAppWindowAsync(bringToFront: true);
                _embed.HideSurface();
            }

            return;
        }

        // Already shell-parented: same ShowHost→CloakApp path as temporary resume.
        if (cloakApp)
        {
            await ResumeDesktopAfterUiAsync();
        }
    }

    private void ScheduleParkAppWebView()
    {
        if (_app is not MainWindow main)
        {
            return;
        }

        _ = main.Dispatcher.BeginInvoke(
            () =>
            {
                if (_appCloaked)
                {
                    main.ParkAppWebViewForDesktop();
                }
            },
            System.Windows.Threading.DispatcherPriority.ApplicationIdle);
    }

    /// <summary>Permanent window mode — show App, dispose DesktopHost WebView2 entirely.</summary>
    public Task EnterWindowModeAsync(bool bringToFront = true) => EnterWindowModeCoreAsync(bringToFront);

    /// <summary>Sync entry for legacy call sites; prefer <see cref="EnterWindowModeAsync"/>.</summary>
    public void EnterWindowMode(bool bringToFront = true) =>
        _ = EnterWindowModeCoreAsync(bringToFront);

    private async Task EnterWindowModeCoreAsync(bool bringToFront)
    {
        var target = Normalize(_embed.LockedBounds ?? CaptureAppPhysicalBounds() ?? _embed.GetCurrentBounds());
        _embed.LockScreenBounds(target);

        PlaceAppWindow(target);
        await UncloakAppWindowAsync(bringToFront);

        if (_embed.IsShellParented)
        {
            _embed.HideSurface();
        }

        // Drop the Host Chromium tree so window mode keeps a single WebView2 process group.
        DestroyHost();
    }

    /// <summary>Temporary App overlay for editors/settings while desktop mode remains preferred.</summary>
    public Task SuspendDesktopForUiAsync() => SuspendDesktopForUiCoreAsync();

    public void SuspendDesktopForUi() => _ = SuspendDesktopForUiCoreAsync();

    private async Task SuspendDesktopForUiCoreAsync()
    {
        var target = Normalize(_embed.LockedBounds ?? CaptureAppPhysicalBounds() ?? _embed.GetCurrentBounds());
        _embed.LockScreenBounds(target);

        PlaceAppWindow(target);
        await UncloakAppWindowAsync(bringToFront: true);

        if (_embed.IsShellParented)
        {
            _embed.HideSurface();
        }
        // Host stays parented + Low (HideSurface) for a fast resume — briefly two trees
        // only while the overlay is open.
    }

    /// <summary>Return to desktop host after temporary overlay/window mode.</summary>
    public Task ResumeDesktopAfterUiAsync() => ResumeDesktopAfterUiCoreAsync();

    public void ResumeDesktopAfterUi() => _ = ResumeDesktopAfterUiCoreAsync();

    private async Task ResumeDesktopAfterUiCoreAsync()
    {
        if (!_embed.IsShellParented || _host is null || !_hostReady)
        {
            await EnterDesktopModeAsync();
            return;
        }

        var target = Normalize(_embed.LockedBounds ?? _embed.GetCurrentBounds());

        _embed.ShowSurface(target);
        CloakAppWindow(parkWebView: false);
        ScheduleParkAppWebView();
    }

    /// <summary>See the call site's comment in <see cref="EnterDesktopModeAsync"/>.</summary>
    private static async Task WaitForSysListView32ReadyAsync()
    {
        const int maxAttempts = 16;
        const int intervalMs = 150;
        for (var i = 0; i < maxAttempts; i++)
        {
            if (DesktopEmbedService.IsSysListView32Ready())
            {
                return;
            }

            await Task.Delay(intervalMs);
        }
    }

    public async Task EnsureHostReadyAsync()
    {
        if (_hostReady && _host is not null)
        {
            return;
        }

        if (_ensureHostTask is not null)
        {
            await _ensureHostTask;
            return;
        }

        _ensureHostTask = CreateHostAsync();
        try
        {
            await _ensureHostTask;
        }
        finally
        {
            _ensureHostTask = null;
        }
    }

    private async Task CreateHostAsync()
    {
        if (_host is not null)
        {
            return;
        }

        _host = new DesktopHostWindow();
        // Create HWND without activating / flashing in the taskbar.
        _host.ShowActivated = false;
        _host.ShowInTaskbar = false;
        // Size to the bounds this session already expects to embed at (persisted from a prior
        // run via RestoreWindowSession → _embed.LockScreenBounds, which always runs before
        // OnLoaded ever reaches this call) instead of a fixed tiny placeholder. WebView2 then
        // lays out/renders the real calendar at its true final size while still off-screen, so
        // the first embed is a pure reposition — no in-place resize (and the WebView2 resize-
        // latency flash that comes with one) right as the surface becomes visible.
        var initialSize = _embed.LockedBounds ?? DesktopEmbedService.GetDefaultBounds();
        _host.Width = initialSize.Width;
        _host.Height = initialSize.Height;
        _host.Left = -32000;
        _host.Top = -32000;
        _host.Show();
        var hwnd = _host.EnsureHwnd();
        _embed.Attach(hwnd);
        _embed.AttachHost(_host);

        await _host.InitWebViewAsync(_bridge());
        // Wait for the Host's React UI to actually paint before treating it as embed-ready.
        // A fixed short delay here used to let the first-embed freeze-frame cover capture/
        // reveal a still-loading (blank/splash) surface on a cold WebView2 profile — the
        // real readiness probe (same signal as the App WebView boot splash) fixes that.
        await _host.WaitForUiReadyAsync();
        _hostReady = true;
    }

    /// <summary>
    /// Tear down DesktopHost WebView2 + HWND. Next <see cref="EnsureHostReadyAsync"/> recreates it.
    /// </summary>
    private void DestroyHost()
    {
        if (_host is null && !_hostReady)
        {
            return;
        }

        try
        {
            _bridge().DetachSecondary();
        }
        catch
        {
            /* ignore */
        }

        _embed.ReleaseShellHost();

        var host = _host;
        _host = null;
        _hostReady = false;
        _ensureHostTask = null;

        if (host is null)
        {
            return;
        }

        try
        {
            host.TearDownWebView();
        }
        catch
        {
            /* ignore */
        }

        try
        {
            host.Close();
        }
        catch
        {
            /* ignore */
        }
    }

    /// <summary>Real Show() only — never Hide() again once called (rule: cloak controls visibility).</summary>
    private void EnsureAppShown()
    {
        if (!_app.IsVisible)
        {
            _app.Show();
        }
    }

    /// <summary>
    /// Hide AppWindow via DWM cloak, then optionally dispose App WebView (single-process policy).
    /// </summary>
    private void CloakAppWindow(bool parkWebView)
    {
        EnsureAppShown();
        SetAppCloak(true);
        if (parkWebView && _app is MainWindow main)
        {
            main.ParkAppWebViewForDesktop();
        }
        else
        {
            SetAppWebViewActive(false);
        }
    }

    /// <summary>
    /// Rematerialize App WebView if parked, wake it under the cloak, then DWM-uncloak.
    /// </summary>
    private async Task UncloakAppWindowAsync(bool bringToFront)
    {
        EnsureAppShown();
        // Resolve WindowState *before* the reveal, not after — WPF's own state-change
        // layout/restore work should happen while still invisible (cloaked), not race the
        // DWM composite the user is actually looking at.
        _app.WindowState = WindowState.Normal;

        if (_app is MainWindow main)
        {
            await main.EnsureAppWebViewReadyAsync();
        }
        else
        {
            SetAppWebViewActive(true);
        }

        SetAppCloak(false);

        if (bringToFront)
        {
            _app.Activate();
            var hwnd = GetAppHwnd();
            if (hwnd != IntPtr.Zero)
            {
                Win32.SetForegroundWindow(hwnd);
            }
        }
    }

    private void SetAppWebViewActive(bool active)
    {
        if (_app is MainWindow main)
        {
            main.SetAppWebViewActive(active);
        }
    }

    private void SetAppCloak(bool cloak)
    {
        if (_appCloaked == cloak)
        {
            return;
        }

        var hwnd = GetAppHwnd();
        if (hwnd == IntPtr.Zero)
        {
            return;
        }

        var value = cloak ? 1 : 0;
        _ = Win32.DwmSetWindowAttribute(hwnd, Win32.DWMWA_CLOAK, ref value, sizeof(int));
        _appCloaked = cloak;
    }

    private void PlaceAppWindow(DesktopEmbedService.Bounds physical)
    {
        WindowFootprint.Sync(_app, physical);
        var hwnd = GetAppHwnd();
        if (hwnd == IntPtr.Zero)
        {
            return;
        }

        Win32.SetWindowPos(
            hwnd,
            Win32.HWND_TOP,
            physical.X,
            physical.Y,
            physical.Width,
            physical.Height,
            Win32.SWP_NOACTIVATE | Win32.SWP_SHOWWINDOW);
    }

    private DesktopEmbedService.Bounds? CaptureAppPhysicalBounds()
    {
        var hwnd = GetAppHwnd();
        if (hwnd == IntPtr.Zero || !Win32.GetWindowRect(hwnd, out var rect))
        {
            return null;
        }

        return new DesktopEmbedService.Bounds(
            rect.Left,
            rect.Top,
            Math.Max(200, rect.Right - rect.Left),
            Math.Max(150, rect.Bottom - rect.Top));
    }

    private IntPtr GetAppHwnd()
    {
        try
        {
            return new WindowInteropHelper(_app).Handle;
        }
        catch
        {
            return IntPtr.Zero;
        }
    }

    private static DesktopEmbedService.Bounds Normalize(DesktopEmbedService.Bounds b) =>
        new(b.X, b.Y, Math.Max(200, b.Width), Math.Max(150, b.Height));
}
