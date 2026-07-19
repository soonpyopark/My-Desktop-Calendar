using System.Windows;
using System.Windows.Interop;
using MyDesktopCalendar.Native;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Dual-HWND surface switcher (rule #1): AppWindow stays top-level forever;
/// DesktopHost is SetParent'd once. AppWindow visibility toggles use DWM cloak
/// (DWMWA_CLOAK) instead of Show/Hide — it stays fully composed/rendering while
/// cloaked, so switching surfaces is an atomic DWM step with nothing to freeze.
/// DesktopHost (a WS_CHILD embedded surface) still uses Show/Hide, which is
/// cheap since AppWindow, once uncloaked, already covers it before it disappears.
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
    /// forever after its first Show — visibility toggles use DWMWA_CLOAK so
    /// WebView2 never stops rendering between surface switches (rule: no freeze-frame
    /// needed because the destination is always already fully painted).
    /// </summary>
    private bool _appCloaked;

    public DesktopSurfaceController(Window app, DesktopEmbedService embed, Func<NativeBridge> bridge)
    {
        _app = app;
        _embed = embed;
        _bridge = bridge;
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
            // there is nothing to freeze/hide during the SetParent.
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
            var covered = cloakApp && DesktopTransitionCover.TryShow(
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
                CloakAppWindow();
            }
            else
            {
                // Host is now parented but must stay hidden underneath the still-visible App
                // overlay until the caller resumes (ResumeDesktopAfterUi shows it + cloaks App).
                _embed.HideSurface();
            }

            return;
        }

        // Already shell-parented: same ShowHost→CloakApp path as temporary resume.
        if (cloakApp)
        {
            ResumeDesktopAfterUi();
        }
    }

    /// <summary>Permanent window mode — hide desktop host, keep shell parent.</summary>
    public void EnterWindowMode(bool bringToFront = true)
    {
        var target = Normalize(_embed.LockedBounds ?? CaptureAppPhysicalBounds() ?? _embed.GetCurrentBounds());
        _embed.LockScreenBounds(target);

        // Uncloak App directly over Host's current bounds before Host disappears.
        // App was kept fully composed while cloaked (WebView2 never stopped rendering),
        // so this is a single atomic DWM step — nothing to freeze, no timing race.
        PlaceAppWindow(target);
        UncloakAppWindow(bringToFront);

        if (_embed.IsShellParented)
        {
            _embed.HideSurface();
        }
    }

    /// <summary>Temporary App overlay for editors/settings while desktop mode remains preferred.</summary>
    public void SuspendDesktopForUi()
    {
        var target = Normalize(_embed.LockedBounds ?? CaptureAppPhysicalBounds() ?? _embed.GetCurrentBounds());
        _embed.LockScreenBounds(target);

        // Uncloak App (already rendered) over Host, then hide Host underneath — no
        // wallpaper peek because App already covers the bounds before Host disappears.
        PlaceAppWindow(target);
        UncloakAppWindow(bringToFront: true);

        if (_embed.IsShellParented)
        {
            _embed.HideSurface();
        }
    }

    /// <summary>Return to desktop host after temporary overlay/window mode.</summary>
    public void ResumeDesktopAfterUi()
    {
        if (!_embed.IsShellParented)
        {
            // Should not happen; fall back to ensuring desktop.
            _ = EnterDesktopModeAsync();
            return;
        }

        var target = Normalize(_embed.LockedBounds ?? _embed.GetCurrentBounds());

        // Show Host underneath first — App (uncloaked, on top) still covers it, so this
        // is invisible. Then cloak App to reveal the already-current Host in one step.
        _embed.ShowSurface(target);
        CloakAppWindow();
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
        _host.Width = 16;
        _host.Height = 16;
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

    /// <summary>Real Show() only — never Hide() again once called (rule: cloak controls visibility).</summary>
    private void EnsureAppShown()
    {
        if (!_app.IsVisible)
        {
            _app.Show();
        }
    }

    /// <summary>
    /// Hide AppWindow via DWM cloak instead of Hide(). The window (and its WebView2)
    /// keeps being composed while cloaked, so the next Uncloak is instant with nothing
    /// stale to repaint — this is what replaces the old freeze-frame cover entirely.
    /// </summary>
    private void CloakAppWindow()
    {
        EnsureAppShown();
        SetAppCloak(true);
    }

    /// <summary>Reveal AppWindow via DWM uncloak — already fully rendered, so this is instant.</summary>
    private void UncloakAppWindow(bool bringToFront)
    {
        EnsureAppShown();
        SetAppCloak(false);

        _app.WindowState = WindowState.Normal;
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
