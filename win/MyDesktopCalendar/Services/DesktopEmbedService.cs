using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Threading;
using MyDesktopCalendar;
using MyDesktopCalendar.Native;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Single-HWND chrome/lock helper for <see cref="MainWindow"/>.
/// Desktop mode = locked window + always-on-bottom z-order (no wallpaper SetParent).
/// Window mode = same HWND, unlocked for move/resize via WPF + TitleBar.
/// </summary>
internal sealed class DesktopEmbedService
{
    public sealed record Bounds(int X, int Y, int Width, int Height);

    public sealed record EmbedInfo(
        bool Active,
        string? ActiveMode,
        string PreferredStrategy,
        string Technique,
        IReadOnlyList<object> Attempts,
        string At);

    private readonly object _gate = new();
    private IntPtr _hwnd;
    private Window? _hostWindow;
    private EmbedInfo _last = new(false, null, "auto", "none", [], DateTime.UtcNow.ToString("o"));
    private Bounds? _lockedBounds;
    /// <summary>
    /// Screen bounds last actually applied to <see cref="_hwnd"/> via <see cref="SnapMoveAndSize"/>.
    /// Lets resume paths skip a redundant move/resize (and the WM_WINDOWPOSCHANGED/WM_SIZE churn
    /// it causes) when nothing has changed since the Host was hidden — a flicker source even
    /// though Host is still covered by App at that point.
    /// </summary>
    private Bounds? _lastAppliedBounds;
    /// <summary>
    /// Always true in desktop (locked) mode — native clicks reach WebView2; zone monitors
    /// must not synthesize clicks. Name retained for the status/JS API.
    /// </summary>
    private bool _popupStyleEmbed;

    /// <summary>Desktop mode: keep this HWND under other top-level windows.</summary>
    private bool _alwaysOnBottom;
    /// <summary>Temporarily allow raise (quick-edit / day double-click).</summary>
    private bool _foregroundOverride;
    private DispatcherTimer? _bottomZOrderTimer;
    /// <summary>Optional idle release (tray raise). React owns normal idle via activity session.</summary>
    private DispatcherTimer? _foregroundReleaseTimer;
    /// <summary>Tray "앞으로 가져오기" idle cap when no overlay keeps the raise alive.</summary>
    private static readonly TimeSpan TrayForegroundIdle = TimeSpan.FromSeconds(45);

    private Win32.LowLevelMouseProc? _outsideMouseProc;
    private IntPtr _outsideMouseHook = IntPtr.Zero;

    /// <summary>Fired when a temporary raise ends (idle, outside click, or explicit release).</summary>
    public event Action? ForegroundSessionEnded;

    /// <summary>Desktop (locked) mode active.</summary>
    public bool IsShellParented { get; private set; }

    /// <summary>True while desktop mode holds the window at HWND_BOTTOM.</summary>
    public bool IsAlwaysOnBottom => _alwaysOnBottom;

    /// <summary>True while quick-edit (etc.) has raised the window above other apps.</summary>
    public bool IsForegroundOverride => _foregroundOverride;

    /// <summary>Host HWND is visible.</summary>
    public bool IsSurfaceVisible { get; private set; }

    /// <summary>Desktop (locked) mode and currently visible.</summary>
    public bool IsEmbedded => IsShellParented && IsSurfaceVisible;

    /// <summary>True in locked desktop mode (native input; no zone click synthesis).</summary>
    public bool IsPopupStyleEmbed => _popupStyleEmbed;

    public EmbedInfo LastInfo => _last;
    public Bounds? LockedBounds => _lockedBounds;

    public void LockScreenBounds(Bounds bounds)
    {
        _lockedBounds = Normalize(bounds);
    }

    public void Attach(IntPtr hwnd)
    {
        _hwnd = hwnd;
        _lastAppliedBounds = null;
        ApplyStableBorderlessStyles(hwnd);
        DisableDwmTransitions(hwnd);
        ForceFullyOpaque();
    }

    public void AttachHost(Window host)
    {
        _hostWindow = host;
    }

    public IntPtr Hwnd => _hwnd;

    /// <summary>
    /// Re-apply fully-opaque chrome after theme/style changes.
    /// </summary>
    public void RefreshContentAlpha()
    {
        ForceFullyOpaque();
    }

    /// <summary>Drop layered alpha — window is always fully opaque.</summary>
    public void ForceFullyOpaque()
    {
        ApplyWpfHostOpacity(1.0);
        if (_hwnd != IntPtr.Zero && Win32.IsWindow(_hwnd))
        {
            ClearLayeredStyle(_hwnd);
        }
    }

    /// <summary>
    /// Desktop mode only: park under other windows and keep re-asserting HWND_BOTTOM
    /// so clicks/activation do not raise the calendar above other apps.
    /// </summary>
    public void EnableAlwaysOnBottom(bool enabled)
    {
        _alwaysOnBottom = enabled;
        if (!enabled)
        {
            CancelForegroundReleaseTimer();
            UninstallOutsideInputHook();
            var wasRaised = _foregroundOverride;
            _foregroundOverride = false;
            _bottomZOrderTimer?.Stop();
            if (wasRaised)
            {
                RaiseForegroundSessionEnded();
            }

            return;
        }

        if (!_foregroundOverride)
        {
            SendToBottom();
        }

        EnsureBottomZOrderTimer();
        _bottomZOrderTimer!.Start();
    }

    /// <summary>
    /// Raise above other windows. Pauses HWND_BOTTOM until <see cref="ReleaseForegroundOverride"/>
    /// (React idle session) or <paramref name="autoReleaseAfter"/> (tray).
    /// </summary>
    public void BringToFront(TimeSpan? autoReleaseAfter = null)
    {
        CancelForegroundReleaseTimer();
        _foregroundOverride = true;
        if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
        {
            return;
        }

        if (!Win32.IsWindowVisible(_hwnd) || Win32.IsIconic(_hwnd))
        {
            Win32.ShowWindow(_hwnd, Win32.SW_RESTORE);
            IsSurfaceVisible = true;
        }

        _ = Win32.SetWindowPos(
            _hwnd,
            Win32.HWND_TOP,
            0,
            0,
            0,
            0,
            Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_SHOWWINDOW);

        try
        {
            _hostWindow?.Activate();
        }
        catch
        {
            /* ignore */
        }

        Win32.SetForegroundWindow(_hwnd);
        InstallOutsideInputHook();

        if (autoReleaseAfter is { } delay && delay > TimeSpan.Zero)
        {
            ScheduleForegroundRelease(delay);
        }
    }

    /// <summary>End temporary raise immediately; return to always-on-bottom when still locked.</summary>
    public void ReleaseForegroundOverride()
    {
        CancelForegroundReleaseTimer();
        ApplyForegroundRelease();
    }

    /// <summary>Tray helper: raise with an idle cap (no quick-edit required).</summary>
    public void BringToFrontFromTray() => BringToFront(TrayForegroundIdle);

    private void ScheduleForegroundRelease(TimeSpan delay)
    {
        CancelForegroundReleaseTimer();
        var timer = new DispatcherTimer { Interval = delay };
        timer.Tick += (_, _) =>
        {
            CancelForegroundReleaseTimer();
            ApplyForegroundRelease();
        };
        _foregroundReleaseTimer = timer;
        timer.Start();
    }

    private void ApplyForegroundRelease()
    {
        if (!_foregroundOverride)
        {
            return;
        }

        UninstallOutsideInputHook();
        _foregroundOverride = false;
        if (_alwaysOnBottom)
        {
            SendToBottom();
        }

        RaiseForegroundSessionEnded();
    }

    private void CancelForegroundReleaseTimer()
    {
        if (_foregroundReleaseTimer is null)
        {
            return;
        }

        _foregroundReleaseTimer.Stop();
        _foregroundReleaseTimer = null;
    }

    private void RaiseForegroundSessionEnded()
    {
        try
        {
            ForegroundSessionEnded?.Invoke();
        }
        catch
        {
            /* ignore listener failures */
        }
    }

    private void InstallOutsideInputHook()
    {
        if (_outsideMouseHook != IntPtr.Zero)
        {
            return;
        }

        _outsideMouseProc = OutsideMouseHook;
        try
        {
            // WH_MOUSE_LL: module handle of the hook owner (exe). Null module also works on
            // current Windows builds; prefer the process module for older runtimes.
            var module = Win32.GetModuleHandle(null);
            _outsideMouseHook = Win32.SetWindowsHookEx(Win32.WH_MOUSE_LL, _outsideMouseProc, module, 0);
            if (_outsideMouseHook == IntPtr.Zero)
            {
                using var process = Process.GetCurrentProcess();
                var name = process.MainModule?.ModuleName;
                if (!string.IsNullOrEmpty(name))
                {
                    _outsideMouseHook = Win32.SetWindowsHookEx(
                        Win32.WH_MOUSE_LL,
                        _outsideMouseProc,
                        Win32.GetModuleHandle(name),
                        0);
                }
            }

            if (_outsideMouseHook == IntPtr.Zero)
            {
                _outsideMouseProc = null;
            }
        }
        catch
        {
            _outsideMouseHook = IntPtr.Zero;
            _outsideMouseProc = null;
        }
    }

    private void UninstallOutsideInputHook()
    {
        if (_outsideMouseHook == IntPtr.Zero)
        {
            _outsideMouseProc = null;
            return;
        }

        try
        {
            _ = Win32.UnhookWindowsHookEx(_outsideMouseHook);
        }
        catch
        {
            /* ignore */
        }

        _outsideMouseHook = IntPtr.Zero;
        _outsideMouseProc = null;
    }

    private IntPtr OutsideMouseHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && _foregroundOverride && _alwaysOnBottom && lParam != IntPtr.Zero)
        {
            var msg = unchecked((int)wParam.ToInt64());
            if (msg is Win32.WM_LBUTTONDOWN or Win32.WM_RBUTTONDOWN or Win32.WM_MBUTTONDOWN or Win32.WM_XBUTTONDOWN)
            {
                try
                {
                    var info = Marshal.PtrToStructure<Win32.MSLLHOOKSTRUCT>(lParam);
                    if (!IsPointOverOurWindow(info.pt))
                    {
                        var dispatcher = _hostWindow?.Dispatcher;
                        if (dispatcher is not null)
                        {
                            _ = dispatcher.BeginInvoke(() =>
                            {
                                if (_foregroundOverride && _alwaysOnBottom)
                                {
                                    ReleaseForegroundOverride();
                                }
                            });
                        }
                    }
                }
                catch
                {
                    /* ignore hook errors */
                }
            }
        }

        return Win32.CallNextHookEx(_outsideMouseHook, nCode, wParam, lParam);
    }

    private bool IsPointOverOurWindow(Win32.POINT pt)
    {
        if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
        {
            return false;
        }

        var hit = Win32.WindowFromPoint(pt);
        if (hit == IntPtr.Zero)
        {
            return false;
        }

        if (hit == _hwnd || Win32.IsChild(_hwnd, hit))
        {
            return true;
        }

        var root = Win32.GetAncestor(hit, Win32.GA_ROOT);
        return root == _hwnd;
    }

    /// <summary>
    /// Park under other apps but above the desktop shell (Progman/WorkerW).
    /// Absolute HWND_BOTTOM goes under Win+D's show-desktop WorkerW and "vanishes".
    /// </summary>
    public void SendToBottom()
    {
        if (_foregroundOverride || _hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
        {
            return;
        }

        var shell = FindDesktopShellWindow();
        if (shell != IntPtr.Zero && shell != _hwnd)
        {
            // Place immediately above the desktop shell: insert below the window that
            // currently precedes the shell in Z-order (GW_HWNDPREV = window above).
            var aboveShell = Win32.GetWindow(shell, Win32.GW_HWNDPREV);
            if (aboveShell == _hwnd)
            {
                return;
            }

            if (aboveShell != IntPtr.Zero)
            {
                _ = Win32.SetWindowPos(
                    _hwnd,
                    aboveShell,
                    0,
                    0,
                    0,
                    0,
                    Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE | Win32.SWP_SHOWWINDOW);
                return;
            }
        }

        _ = Win32.SetWindowPos(
            _hwnd,
            Win32.HWND_BOTTOM,
            0,
            0,
            0,
            0,
            Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE | Win32.SWP_SHOWWINDOW);
    }

    /// <summary>
    /// Desktop mode: undo Win+D / minimize-all / cloak so the calendar stays on the desktop.
    /// </summary>
    public void EnsureVisibleOnDesktop()
    {
        if (!_alwaysOnBottom || _hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
        {
            return;
        }

        // Force-uncloak — shell show-desktop can leave DWM cloak set.
        var cloakOff = 0;
        _ = Win32.DwmSetWindowAttribute(_hwnd, Win32.DWMWA_CLOAK, ref cloakOff, sizeof(int));

        try
        {
            if (_hostWindow is not null)
            {
                if (_hostWindow.WindowState != WindowState.Normal)
                {
                    _hostWindow.WindowState = WindowState.Normal;
                }

                if (_hostWindow.Visibility != Visibility.Visible)
                {
                    _hostWindow.Visibility = Visibility.Visible;
                }

                if (!_hostWindow.IsVisible)
                {
                    _hostWindow.Show();
                }
            }
        }
        catch
        {
            /* ignore */
        }

        if (!Win32.IsWindowVisible(_hwnd) || Win32.IsIconic(_hwnd) || IsDwmCloaked(_hwnd))
        {
            Win32.ShowWindow(_hwnd, Win32.SW_SHOWNOACTIVATE);
            Win32.ShowWindow(_hwnd, Win32.SW_RESTORE);
        }

        IsSurfaceVisible = true;

        if (!_foregroundOverride)
        {
            SendToBottom();
        }
    }

    private void EnsureBottomZOrderTimer()
    {
        if (_bottomZOrderTimer is not null)
        {
            return;
        }

        // Fast enough to undo Win+D before it "sticks"; light when already healthy.
        _bottomZOrderTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        _bottomZOrderTimer.Tick += (_, _) =>
        {
            if (_alwaysOnBottom && IsShellParented && !_foregroundOverride)
            {
                EnsureVisibleOnDesktop();
            }
        };
    }

    private static bool IsDwmCloaked(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            return false;
        }

        try
        {
            return Win32.DwmGetWindowAttribute(hwnd, Win32.DWMWA_CLOAKED, out var cloaked, sizeof(int)) == 0
                   && cloaked != 0;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Progman or WorkerW that hosts SHELLDLL_DefView — z-order anchor only (no SetParent).
    /// </summary>
    private static IntPtr FindDesktopShellWindow()
    {
        var progman = Win32.FindWindowW("Progman", "Program Manager");
        if (progman == IntPtr.Zero)
        {
            progman = Win32.FindWindowW("Progman", null);
        }

        if (progman != IntPtr.Zero
            && Win32.FindWindowExW(progman, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
        {
            return progman;
        }

        IntPtr result = IntPtr.Zero;
        Win32.EnumWindows((top, _) =>
        {
            if (Win32.FindWindowExW(top, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
            {
                result = top;
                return false;
            }

            return true;
        }, IntPtr.Zero);

        return result;
    }

    public Bounds GetCurrentBounds()
    {
        if (_hwnd == IntPtr.Zero || !Win32.GetWindowRect(_hwnd, out var rect))
        {
            return GetDefaultBounds();
        }

        return new Bounds(rect.Left, rect.Top, Math.Max(200, rect.Right - rect.Left), Math.Max(150, rect.Bottom - rect.Top));
    }

    /// <summary>
    /// First-install / first-run footprint on the primary monitor.
    /// Captured from the design session and snapped down to multiples of 5
    /// (31→30, 36→35). Subsequent launches use the user's saved bounds instead.
    /// </summary>
    public static Bounds GetDefaultBounds()
    {
        var primary = GetPrimaryMonitorBounds();
        var w = Math.Min(AppConstants.FactoryDefaultWidth, Math.Max(200, primary.Width));
        var h = Math.Min(AppConstants.FactoryDefaultHeight, Math.Max(150, primary.Height));
        w = SnapDownTo5(w);
        h = SnapDownTo5(h);

        var x = SnapDownTo5(primary.X + AppConstants.FactoryDefaultOffsetX);
        var y = SnapDownTo5(primary.Y + AppConstants.FactoryDefaultOffsetY);
        if (x + w > primary.X + primary.Width)
        {
            x = SnapDownTo5(primary.X + primary.Width - w);
        }

        if (y + h > primary.Y + primary.Height)
        {
            y = SnapDownTo5(primary.Y + primary.Height - h);
        }

        x = Math.Max(primary.X, x);
        y = Math.Max(primary.Y, y);
        return new Bounds(SnapDownTo5(x), SnapDownTo5(y), w, h);
    }

    /// <summary>Floor to a multiple of 5 (31→30, 36→35). Works for negative coords too.</summary>
    public static int SnapDownTo5(int value) => (int)(Math.Floor(value / 5.0) * 5);

    public static Bounds SnapBoundsDownTo5(Bounds bounds)
        => new(
            SnapDownTo5(bounds.X),
            SnapDownTo5(bounds.Y),
            Math.Max(200, SnapDownTo5(bounds.Width)),
            Math.Max(150, SnapDownTo5(bounds.Height)));

    private static Bounds GetPrimaryMonitorBounds()
    {
        try
        {
            var screen = System.Windows.Forms.Screen.PrimaryScreen;
            if (screen is not null)
            {
                var b = screen.Bounds;
                return new Bounds(b.X, b.Y, Math.Max(200, b.Width), Math.Max(150, b.Height));
            }
        }
        catch
        {
            /* fall through */
        }

        var w = Win32.GetSystemMetrics(0); // SM_CXSCREEN
        var h = Win32.GetSystemMetrics(1); // SM_CYSCREEN
        return new Bounds(0, 0, Math.Max(200, w), Math.Max(150, h));
    }

    /// <summary>
    /// Clamp/recenter bounds cached before a monitor sleep/wake, cable reconnect, resolution,
    /// DPI, or arrangement change onto the *current* virtual screen. Without this, a shrunk or
    /// reshuffled virtual desktop can leave <see cref="_lockedBounds"/> parked entirely over
    /// screen space that no longer exists — the calendar looks "gone".
    /// </summary>
    private static Bounds ClampToVirtualScreen(Bounds bounds)
    {
        var vx = Win32.GetSystemMetrics(Win32.SM_XVIRTUALSCREEN);
        var vy = Win32.GetSystemMetrics(Win32.SM_YVIRTUALSCREEN);
        var vw = Win32.GetSystemMetrics(Win32.SM_CXVIRTUALSCREEN);
        var vh = Win32.GetSystemMetrics(Win32.SM_CYVIRTUALSCREEN);
        if (vw <= 0 || vh <= 0)
        {
            return bounds;
        }

        var intersects = bounds.X < vx + vw && bounds.X + bounds.Width > vx
            && bounds.Y < vy + vh && bounds.Y + bounds.Height > vy;
        if (!intersects)
        {
            return GetDefaultBounds();
        }

        var w = Math.Min(bounds.Width, vw);
        var h = Math.Min(bounds.Height, vh);
        var x = Math.Max(vx, Math.Min(bounds.X, vx + vw - w));
        var y = Math.Max(vy, Math.Min(bounds.Y, vy + vh - h));
        return new Bounds(x, y, w, h);
    }

    /// <summary>
    /// After a display-topology change, reclamp locked bounds onto the virtual screen.
    /// </summary>
    public void HandleDisplayChanged()
    {
        lock (_gate)
        {
            _lastAppliedBounds = null;
            if (_lockedBounds is { } bounds)
            {
                _lockedBounds = ClampToVirtualScreen(bounds);
            }

            if (!IsShellParented || _hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd) || !IsSurfaceVisible)
            {
                return;
            }

            var target = _lockedBounds ?? GetCurrentBounds();
            ApplyBorderlessPopupStyles(_hwnd);
            if (!BoundsNearlyEqual(GetCurrentBounds(), target))
            {
                SnapMoveAndSize(target);
            }

            ForceFullyOpaque();
        }
    }

    /// <summary>Enter desktop (locked) mode — no wallpaper embed, no z-order park.</summary>
    public EmbedInfo Embed(Bounds? bounds = null)
    {
        lock (_gate)
        {
            if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
            {
                throw new InvalidOperationException("Window handle is not ready.");
            }

            var targetBounds = Normalize(bounds ?? _lockedBounds ?? GetCurrentBounds());
            _lockedBounds = targetBounds;

            if (IsShellParented)
            {
                ShowSurfaceUnlocked(targetBounds);
                _last = new EmbedInfo(
                    true,
                    "locked",
                    "auto",
                    "window-lock",
                    _last.Attempts,
                    DateTime.UtcNow.ToString("o"));
                return _last;
            }

            ApplyLockedDesktopMode(targetBounds);
            IsShellParented = true;
            IsSurfaceVisible = true;
            _popupStyleEmbed = true;
            _last = new EmbedInfo(
                true,
                "locked",
                "auto",
                "window-lock",
                [new { mode = "window-lock", ok = true }],
                DateTime.UtcNow.ToString("o"));
            return _last;
        }
    }

    /// <summary>Show the locked host without changing mode.</summary>
    public void ShowSurface(Bounds? bounds = null)
    {
        lock (_gate)
        {
            var target = Normalize(bounds ?? _lockedBounds ?? GetCurrentBounds());
            _lockedBounds = target;
            ShowSurfaceUnlocked(target);
        }
    }

    /// <summary>Hide host; stay in desktop (locked) mode until <see cref="ReleaseShellHost"/>.</summary>
    public void HideSurface()
    {
        lock (_gate)
        {
            if (_hwnd != IntPtr.Zero && Win32.IsWindow(_hwnd))
            {
                Win32.ShowWindow(_hwnd, Win32.SW_HIDE);
            }

            IsSurfaceVisible = false;

            _last = new EmbedInfo(
                false,
                null,
                "auto",
                IsShellParented ? "hidden-locked" : "none",
                [],
                DateTime.UtcNow.ToString("o"));
        }
    }

    /// <summary>Leave desktop (locked) mode — unlock chrome; keep footprint.</summary>
    public void ReleaseShellHost(Bounds? topLevelBounds = null)
    {
        lock (_gate)
        {
            var hwnd = _hwnd;
            if (hwnd != IntPtr.Zero && Win32.IsWindow(hwnd))
            {
                var live = GetCurrentBounds();
                _lockedBounds = Normalize(topLevelBounds ?? live);
                _lastAppliedBounds = live;
                ApplyBorderlessPopupStyles(hwnd);
                ForceFullyOpaque();
                _ = Win32.SetWindowPos(
                    hwnd,
                    Win32.HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_SHOWWINDOW | Win32.SWP_NOACTIVATE);
                Win32.ShowWindow(hwnd, Win32.SW_SHOW);
            }

            IsShellParented = false;
            IsSurfaceVisible = hwnd != IntPtr.Zero && Win32.IsWindow(hwnd);
            _popupStyleEmbed = false;
            EnableAlwaysOnBottom(false);
            _last = new EmbedInfo(
                false,
                null,
                "auto",
                "window",
                [],
                DateTime.UtcNow.ToString("o"));
        }
    }

    private void ShowSurfaceUnlocked(Bounds targetBounds)
    {
        if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
        {
            return;
        }

        _lockedBounds = targetBounds;
        Win32.ShowWindow(_hwnd, Win32.SW_SHOWNOACTIVATE);
        IsSurfaceVisible = true;
        ForceFullyOpaque();
    }

    /// <summary>
    /// Legacy name: hide desktop surface while keeping shell parent.
    /// AppWindow visibility is controlled by <see cref="DesktopSurfaceController"/>.
    /// </summary>
    public EmbedInfo Unlock(bool bringToFront = true)
    {
        _ = bringToFront;
        HideSurface();
        return _last;
    }

    public JsonObject GetDiagnostics()
    {
        var caps = DetectCapabilities();
        return new JsonObject
        {
            ["hwnd"] = _hwnd.ToInt64(),
            ["embedded"] = IsEmbedded,
            ["shellParented"] = IsShellParented,
            ["surfaceVisible"] = IsSurfaceVisible,
            ["preferredStrategy"] = "auto",
            ["popupStyleEmbed"] = _popupStyleEmbed,
            ["lockedBounds"] = _lockedBounds is null
                ? null
                : new JsonObject
                {
                    ["x"] = _lockedBounds.X,
                    ["y"] = _lockedBounds.Y,
                    ["width"] = _lockedBounds.Width,
                    ["height"] = _lockedBounds.Height,
                },
            ["last"] = new JsonObject
            {
                ["active"] = _last.Active,
                ["activeMode"] = _last.ActiveMode,
                ["technique"] = _last.Technique,
                ["at"] = _last.At,
            },
            ["capabilities"] = caps,
            ["platform"] = "wpf-native",
            ["flickerFree"] = true,
        };
    }

    /// <summary>OS / runtime snapshot for readiness and diagnostics.</summary>
    public JsonObject GetCapabilitySnapshot() => DetectCapabilities();

    public JsonObject GetStatus()
    {
        return new JsonObject
        {
            ["available"] = true,
            ["embedded"] = IsEmbedded,
            ["shellParented"] = IsShellParented,
            ["surfaceVisible"] = IsSurfaceVisible,
            ["editing"] = !IsEmbedded,
            ["editMode"] = !IsEmbedded,
            ["dualHwnd"] = false,
            ["platform"] = "wpf-native",
            // Locked desktop mode — native clicks reach the WebView DOM (no zone synthesis).
            ["popupStyleEmbed"] = _popupStyleEmbed,
            ["bounds"] = (_lockedBounds ?? GetCurrentBounds()) is var b
                ? new JsonObject { ["x"] = b.X, ["y"] = b.Y, ["width"] = b.Width, ["height"] = b.Height }
                : null,
            ["embed"] = new JsonObject
            {
                ["active"] = _last.Active,
                ["activeMode"] = _last.ActiveMode,
                ["preferredStrategy"] = _last.PreferredStrategy,
                ["technique"] = _last.Technique,
            },
        };
    }

    /// <summary>
    /// Lock desktop mode: keep footprint and borderless styles. Move/resize/chrome are
    /// blocked by <see cref="MainWindow.ApplyWindowLockMode"/> (WPF + WndProc).
    /// </summary>
    private void ApplyLockedDesktopMode(Bounds screenBounds)
    {
        ApplyBorderlessPopupStyles(_hwnd);
        ForceFullyOpaque();

        // Prefer the live HWND rect so in-session mode toggles never SnapMoveAndSize
        // from a slightly different CaptureLiveBounds / settings snapshot.
        var live = GetCurrentBounds();
        var target = Normalize(screenBounds);
        if (!BoundsNearlyEqual(live, target))
        {
            SnapMoveAndSize(target);
        }
        else
        {
            _lockedBounds = live;
            _lastAppliedBounds = live;
        }

        Win32.ShowWindow(_hwnd, Win32.SW_SHOWNOACTIVATE);
        _popupStyleEmbed = true;
    }

    private static bool BoundsNearlyEqual(Bounds a, Bounds b)
        => Math.Abs(a.X - b.X) <= 1
           && Math.Abs(a.Y - b.Y) <= 1
           && Math.Abs(a.Width - b.Width) <= 1
           && Math.Abs(a.Height - b.Height) <= 1;

    private static void DisableDwmTransitions(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd))
        {
            return;
        }

        var enabled = 1;
        _ = Win32.DwmSetWindowAttribute(
            hwnd,
            Win32.DWMWA_TRANSITIONS_FORCEDISABLED,
            ref enabled,
            sizeof(int));
    }

    /// <summary>
    /// Remove WS_EX_LAYERED from a window tree (legacy translucent sessions).
    /// </summary>
    private static void ClearLayeredStyle(IntPtr hwnd)
    {
        ClearLayeredStyleRecursive(hwnd);
    }

    private static void ClearLayeredStyleRecursive(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd))
        {
            return;
        }

        _ = Win32.EnumChildWindows(hwnd, (child, _) =>
        {
            ClearLayeredStyleRecursive(child);
            return true;
        }, IntPtr.Zero);

        var ex = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE).ToInt64();
        if ((ex & Win32.WS_EX_LAYERED) == 0)
        {
            return;
        }

        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE, new IntPtr(ex & ~Win32.WS_EX_LAYERED));
        _ = Win32.SetWindowPos(
            hwnd,
            IntPtr.Zero,
            0,
            0,
            0,
            0,
            Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE | Win32.SWP_FRAMECHANGED);
    }

    private void ApplyWpfHostOpacity(double opacity)
    {
        var host = _hostWindow;
        if (host is null)
        {
            return;
        }

        void Apply()
        {
            try
            {
                host.Opacity = opacity;
            }
            catch
            {
                /* disposed */
            }
        }

        if (host.Dispatcher.CheckAccess())
        {
            Apply();
        }
        else
        {
            _ = host.Dispatcher.BeginInvoke(Apply);
        }
    }

    /// <summary>
    /// Shared borderless popup styles for desktop and window mode (and initial Attach).
    /// Same bits both modes — toggling must not add/remove <c>WS_THICKFRAME</c> (that resized the window).
    /// </summary>
    private void ApplyStableBorderlessStyles(IntPtr hwnd) => ApplyBorderlessPopupStyles(hwnd);

    /// <summary>Alias kept for call sites that previously meant "window chrome".</summary>
    private void RestoreTopLevelStyles(IntPtr hwnd) => ApplyBorderlessPopupStyles(hwnd);

    private void ApplyBorderlessPopupStyles(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd))
        {
            return;
        }

        var style = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE).ToInt64();
        var nextStyle = style;
        nextStyle |= Win32.WS_POPUP | Win32.WS_VISIBLE | Win32.WS_THICKFRAME;
        nextStyle &= ~Win32.WS_CHILD;
        nextStyle &= ~(Win32.WS_CAPTION | Win32.WS_SYSMENU | Win32.WS_MINIMIZEBOX | Win32.WS_MAXIMIZEBOX);

        var ex = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE).ToInt64();
        var nextEx = ex;
        nextEx |= Win32.WS_EX_TOOLWINDOW;
        nextEx &= ~(Win32.WS_EX_APPWINDOW | Win32.WS_EX_NOACTIVATE | Win32.WS_EX_LAYERED);

        if (nextStyle == style && nextEx == ex)
        {
            return;
        }

        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE, new IntPtr(nextStyle));
        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE, new IntPtr(nextEx));
        ClearLayeredStyle(hwnd);

        // GWL_STYLE/EXSTYLE + SWP_FRAMECHANGED (inside ClearLayeredStyle) resets the
        // DWM border/caption color attributes to the system default — reassert the
        // theme border immediately so no default (often near-black) hairline shows.
        WindowFrameTheme.Reapply();
    }

    /// <summary>Reposition without changing size (eliminates transition flash).</summary>
    private void SnapMoveOnly(Bounds screen)
    {
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        Win32.SetWindowPos(
            _hwnd,
            IntPtr.Zero,
            screen.X,
            screen.Y,
            0,
            0,
            Win32.SWP_NOSIZE | Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE);
    }

    /// <summary>Place host at screen bounds with explicit size.</summary>
    private void SnapMoveAndSize(Bounds screen)
    {
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        Win32.SetWindowPos(
            _hwnd,
            IntPtr.Zero,
            screen.X,
            screen.Y,
            screen.Width,
            screen.Height,
            Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE);

        if (_hostWindow is not null)
        {
            try
            {
                WindowFootprint.Sync(_hostWindow, screen);
            }
            catch
            {
                /* ignore */
            }
        }

        _lastAppliedBounds = screen;
    }

    private static Bounds Normalize(Bounds b)
    {
        return new Bounds(b.X, b.Y, Math.Max(200, b.Width), Math.Max(150, b.Height));
    }

    private static JsonObject DetectCapabilities()
    {
        return new JsonObject
        {
            ["windowLock"] = true,
            ["os"] = Environment.OSVersion.VersionString,
            ["build"] = Environment.OSVersion.Version.Build,
        };
    }
}
