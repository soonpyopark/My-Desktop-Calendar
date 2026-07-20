using System.Windows;
using System.Windows.Interop;
using MyDesktopCalendar.Native;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Single-HWND mode switcher. Desktop mode = locked window (no move/resize/chrome
/// buttons). Window mode = movable/resizable with title-bar controls. No wallpaper
/// embedding, SetParent, or desktop z-order.
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

    public void MarkAppCloakedAtBoot()
    {
        _appCloaked = true;
    }

    public DesktopEmbedService Embed => _embed;

    public IntPtr HostHwnd => GetAppHwnd();

    public bool IsDesktopSurfaceActive => _embed.IsEmbedded;

    public bool IsShellParented => _embed.IsShellParented;

    /// <param name="shouldCloakApp">
    /// When false (e.g. login wall), stay unlocked/visible instead of locking.
    /// </param>
    public async Task EnterDesktopModeAsync(
        DesktopEmbedService.Bounds? bounds = null,
        Func<bool>? shouldCloakApp = null)
    {
        EnsureAttached();
        var preferDesktop = shouldCloakApp?.Invoke() ?? true;

        if (!preferDesktop)
        {
            await EnsureUncloakedTopLevelAsync(Normalize(bounds ?? CaptureLiveBounds()), bringToFront: true);
            return;
        }

        // Always force show/uncloak — Win+D can leave the HWND hidden/minimized/cloaked
        // while our IsSurfaceVisible flag is still true (early-return used to skip restore).
        EnsureAppShown();
        SetAppCloak(false, force: true);

        var current = Normalize(bounds ?? CaptureLiveBounds());
        if (_embed.IsShellParented)
        {
            _embed.ShowSurface(current);
        }
        else
        {
            _embed.Embed(current);
        }

        ApplyHostLock(true);
        _embed.EnsureVisibleOnDesktop();
        _appCloaked = false;
        SetAppWebViewActive(true);
        await Task.CompletedTask;
    }

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
            var current = Normalize(CaptureLiveBounds());
            _embed.ReleaseShellHost(current);
        }
        else
        {
            Win32.ShowWindow(GetAppHwnd(), Win32.SW_SHOW);
        }

        ApplyHostLock(false);
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

    private DesktopEmbedService.Bounds CaptureLiveBounds()
        => CaptureAppPhysicalBounds() ?? _embed.GetCurrentBounds();

    public Task SuspendDesktopForUiAsync() => Task.CompletedTask;

    public void SuspendDesktopForUi()
    {
        /* in-place overlays */
    }

    public Task ResumeDesktopAfterUiAsync()
    {
        if (_embed.IsShellParented)
        {
            var target = Normalize(_embed.LockedBounds ?? _embed.GetCurrentBounds());
            _embed.ShowSurface(target);
            ApplyHostLock(true);
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

    private void ApplyHostLock(bool locked)
    {
        if (_app is MainWindow main)
        {
            main.ApplyWindowLockMode(locked);
        }
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

        ApplyHostLock(false);
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

    private void SetAppCloak(bool cloak, bool force = false)
    {
        if (!force && _appCloaked == cloak)
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
