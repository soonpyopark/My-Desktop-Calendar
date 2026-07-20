using System.Windows;
using System.Windows.Interop;
using MyDesktopCalendar.Native;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Single-HWND surface switcher: <see cref="MainWindow"/> is either shell-parented
/// (desktop mode) or top-level (window mode). One WebView2 stays attached for both.
/// Mode switches toggle top-level <c>WS_POPUP</c> desktop vs window styles
/// (no <c>SetParent</c>), covered by <see cref="DesktopTransitionCover"/>.
/// Overlays (settings/search/quick-edit) stay in-place — no second surface.
/// </summary>
internal sealed class DesktopSurfaceController
{
    private readonly Window _app;
    private readonly DesktopEmbedService _embed;
    private readonly Func<NativeBridge> _bridge;
    private bool _attached;
    private bool _appCloaked;

    public DesktopSurfaceController(Window app, DesktopEmbedService embed, Func<NativeBridge> bridge)
    {
        _app = app;
        _embed = embed;
        _bridge = bridge;
    }

    /// <summary>
    /// MainWindow DWM-cloaks at OnSourceInitialized; sync the flag so boot embed
    /// does not assume the window is visible.
    /// </summary>
    public void MarkAppCloakedAtBoot()
    {
        _appCloaked = true;
    }

    public DesktopEmbedService Embed => _embed;

    /// <summary>Single surface HWND (MainWindow).</summary>
    public IntPtr HostHwnd => GetAppHwnd();

    public bool IsDesktopSurfaceActive => _embed.IsEmbedded;

    public bool IsShellParented => _embed.IsShellParented;

    /// <param name="shouldCloakApp">
    /// Legacy boot-suspend hook: when false, stay top-level (login wall) instead of
    /// embedding. Null means prefer desktop embed.
    /// </param>
    public async Task EnterDesktopModeAsync(
        DesktopEmbedService.Bounds? bounds = null,
        Func<bool>? shouldCloakApp = null)
    {
        EnsureAttached();
        var preferDesktop = shouldCloakApp?.Invoke() ?? true;

        if (!preferDesktop)
        {
            // Boot suspend (e.g. login): keep top-level and visible.
            await EnsureUncloakedTopLevelAsync(Normalize(bounds ?? CaptureLiveBounds()), bringToFront: true);
            return;
        }

        if (_embed.IsShellParented && _embed.IsSurfaceVisible)
        {
            return;
        }

        EnsureAppShown();

        // Uncloak before cover/capture so PrintWindow can see pixels if needed.
        SetAppCloak(false);
        // No recalculation: whatever footprint the HWND already has is what the cover
        // snapshots and what stays applied — a toggle is style/z-order only.
        var current = Normalize(bounds ?? CaptureLiveBounds());

        var covered = DesktopTransitionCover.TryShow(_app, GetAppHwnd(), current);
        // Hide the real HWND while desktop popup styles/z-order apply — cover stays visible.
        SetAppCloak(true);
        try
        {
            if (_embed.IsShellParented)
            {
                _embed.ShowSurface(current);
            }
            else
            {
                _embed.Embed(current);
            }
        }
        finally
        {
            SetAppCloak(false);
            if (covered)
            {
                DesktopTransitionCover.HideAfterComposition(_app);
            }
        }

        _appCloaked = false;
        SetAppWebViewActive(true);
    }

    /// <summary>Permanent window mode — unparent MainWindow and restore top-level chrome.</summary>
    public Task EnterWindowModeAsync(bool bringToFront = true) => EnterWindowModeCoreAsync(bringToFront);

    public void EnterWindowMode(bool bringToFront = true) =>
        _ = EnterWindowModeCoreAsync(bringToFront);

    private async Task EnterWindowModeCoreAsync(bool bringToFront)
    {
        EnsureAttached();
        EnsureAppShown();
        SetAppCloak(false);

        if (_embed.IsShellParented)
        {
            // No recalculation: the HWND footprint is not touched by this toggle,
            // only styles/z-order — a border simply appears as it comes to the front.
            var current = Normalize(CaptureLiveBounds());
            var covered = DesktopTransitionCover.TryShow(_app, GetAppHwnd(), current);
            // Cloak while switching popup styles so intermediate frames stay hidden.
            SetAppCloak(true);
            try
            {
                _embed.ReleaseShellHost(current);
            }
            finally
            {
                SetAppCloak(false);
                if (covered)
                {
                    DesktopTransitionCover.HideAfterComposition(_app);
                }
            }
        }
        else
        {
            Win32.ShowWindow(GetAppHwnd(), Win32.SW_SHOW);
        }

        SetAppWebViewActive(true);
        if (bringToFront)
        {
            _app.Activate();
            var hwnd = GetAppHwnd();
            if (hwnd != IntPtr.Zero)
            {
                Win32.SetForegroundWindow(hwnd);
            }
        }

        await Task.CompletedTask;
    }

    /// <summary>Current on-screen HWND rect; falls back to embed service measurement.</summary>
    private DesktopEmbedService.Bounds CaptureLiveBounds()
        => CaptureAppPhysicalBounds() ?? _embed.GetCurrentBounds();

    /// <summary>Overlays stay in-place on the single surface — no mode switch.</summary>
    public Task SuspendDesktopForUiAsync() => Task.CompletedTask;

    public void SuspendDesktopForUi()
    {
        /* in-place overlays */
    }

    /// <summary>No-op resume; desktop enter re-embeds if needed.</summary>
    public Task ResumeDesktopAfterUiAsync()
    {
        if (_embed.IsShellParented)
        {
            var target = Normalize(_embed.LockedBounds ?? _embed.GetCurrentBounds());
            _embed.ShowSurface(target);
            SetAppCloak(false);
            SetAppWebViewActive(true);
            return Task.CompletedTask;
        }

        return EnterDesktopModeAsync();
    }

    public void ResumeDesktopAfterUi() => _ = ResumeDesktopAfterUiAsync();

    public Task EnsureHostReadyAsync()
    {
        EnsureAttached();
        return Task.CompletedTask;
    }

    private void EnsureAttached()
    {
        if (_attached && _embed.Hwnd != IntPtr.Zero)
        {
            return;
        }

        var hwnd = GetAppHwnd();
        if (hwnd == IntPtr.Zero)
        {
            EnsureAppShown();
            hwnd = GetAppHwnd();
        }

        if (hwnd == IntPtr.Zero)
        {
            throw new InvalidOperationException("MainWindow HWND is not ready.");
        }

        _embed.Attach(hwnd);
        _embed.AttachHost(_app);
        _attached = true;
    }

    private async Task EnsureUncloakedTopLevelAsync(DesktopEmbedService.Bounds target, bool bringToFront)
    {
        EnsureAttached();
        if (_embed.IsShellParented)
        {
            _embed.ReleaseShellHost(target);
        }
        else
        {
            PlaceAppWindow(target);
        }

        SetAppCloak(false);
        SetAppWebViewActive(true);
        if (bringToFront)
        {
            _app.Activate();
        }

        await Task.CompletedTask;
    }

    private void EnsureAppShown()
    {
        if (!_app.IsVisible)
        {
            _app.Show();
        }

        _app.WindowState = WindowState.Normal;
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
        var hwnd = GetAppHwnd();
        if (hwnd == IntPtr.Zero)
        {
            return;
        }

        // Skip no-op moves — mode toggles must not churn size when already correct.
        if (Win32.GetWindowRect(hwnd, out var rect))
        {
            var same =
                Math.Abs(rect.Left - physical.X) <= 1
                && Math.Abs(rect.Top - physical.Y) <= 1
                && Math.Abs((rect.Right - rect.Left) - physical.Width) <= 1
                && Math.Abs((rect.Bottom - rect.Top) - physical.Height) <= 1;
            if (same)
            {
                try
                {
                    WindowFootprint.Sync(_app, physical);
                }
                catch
                {
                    /* ignore */
                }

                return;
            }
        }

        // Win32 first (physical px), then sync WPF DIP.
        Win32.SetWindowPos(
            hwnd,
            Win32.HWND_TOP,
            physical.X,
            physical.Y,
            physical.Width,
            physical.Height,
            Win32.SWP_NOACTIVATE | Win32.SWP_SHOWWINDOW);

        try
        {
            WindowFootprint.Sync(_app, physical);
        }
        catch
        {
            /* ignore */
        }
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
