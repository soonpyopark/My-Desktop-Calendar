using System.Text.Json.Nodes;
using System.Windows;
using MyDesktopCalendar;
using MyDesktopCalendar.Native;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Single-HWND desktop surface for <see cref="MainWindow"/>.
/// Desktop mode: top-level <c>WS_POPUP</c> at the locked bounds, z-ordered to the bottom
/// (sits on the desktop, covered by normal apps). No <c>SetParent</c> / SysListView32 child.
/// Window mode: same HWND with thick-frame popup styles brought to the foreground.
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
    private byte _alpha = 255;
    private System.Windows.Threading.DispatcherTimer? _maintenance;

    /// <summary>
    /// Desktop mode uses a top-level <c>WS_POPUP</c>, so WebView2 receives native clicks.
    /// Name retained for the status/JS API (<c>popupStyleEmbed</c>).
    /// </summary>
    private bool _popupStyleEmbed;

    /// <summary>Desktop-mode surface active (top-level WS_POPUP on the desktop z-band).</summary>
    public bool IsShellParented { get; private set; }

    /// <summary>Host HWND is visible on the desktop surface.</summary>
    public bool IsSurfaceVisible { get; private set; }

    /// <summary>Desktop mode and currently visible.</summary>
    public bool IsEmbedded => IsShellParented && IsSurfaceVisible;

    /// <summary>
    /// Always true in desktop mode (top-level popup). Zone monitors skip synthetic
    /// create/edit clicks that would double-fire with native WebView input.
    /// </summary>
    public bool IsPopupStyleEmbed => _popupStyleEmbed;

    public EmbedInfo LastInfo => _last;
    public Bounds? LockedBounds => _lockedBounds;
    /// <summary>True when window alpha is fully opaque (no wallpaper see-through).</summary>
    public bool IsFullyOpaque => _alpha >= 255;

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
        // Do NOT call DwmExtendFrameIntoClientArea while shell-parented (washes DefView).
        ApplyAlphaTree();
    }

    public void AttachHost(Window host)
    {
        _hostWindow = host;
    }

    public IntPtr Hwnd => _hwnd;

    /// <summary>
    /// Re-apply DWM frame after theme/style changes.
    /// </summary>
    public void RefreshContentAlpha()
    {
        ApplyAlphaTree();
    }

    public void SetOpacity(double opacity)
    {
        var clamped = NormalizeOpacity(opacity);
        _alpha = (byte)Math.Clamp((int)Math.Round(clamped * 255.0), 13, 255);
        // Never use WPF Opacity for translucency (blends against a dark intermediate).
        // See-through is a single Win32 LWA_ALPHA on the host HWND when alpha < 255.
        ApplyWpfHostOpacity(1.0);
        ApplyAlphaTree();
    }

    public double GetOpacity() => _alpha / 255.0;

    /// <summary>Snap to 5% steps in [MinOpacity, 1].</summary>
    public static double NormalizeOpacity(double opacity)
    {
        var clamped = Math.Clamp(opacity, AppConstants.MinOpacity, 1.0);
        clamped = Math.Round(clamped * 20.0) / 20.0;
        return Math.Clamp(clamped, AppConstants.MinOpacity, 1.0);
    }

    public Bounds GetCurrentBounds()
    {
        if (_hwnd == IntPtr.Zero || !Win32.GetWindowRect(_hwnd, out var rect))
        {
            return GetDefaultBounds();
        }

        return new Bounds(rect.Left, rect.Top, Math.Max(200, rect.Right - rect.Left), Math.Max(150, rect.Bottom - rect.Top));
    }

    public static Bounds GetDefaultBounds()
    {
        var vx = Win32.GetSystemMetrics(Win32.SM_XVIRTUALSCREEN);
        var vy = Win32.GetSystemMetrics(Win32.SM_YVIRTUALSCREEN);
        var vw = Win32.GetSystemMetrics(Win32.SM_CXVIRTUALSCREEN);
        var vh = Win32.GetSystemMetrics(Win32.SM_CYVIRTUALSCREEN);
        var w = (int)Math.Round(1920 * 0.8);
        var h = (int)Math.Round(1080 * 0.8);
        return new Bounds(vx + Math.Max(0, (vw - w) / 2), vy + Math.Max(0, (vh - h) / 2), w, h);
    }

    /// <summary>
    /// Clamp/recenter bounds cached before a monitor sleep/wake, cable reconnect, resolution,
    /// DPI, or arrangement change onto the *current* virtual screen. Without this, a shrunk or
    /// reshuffled virtual desktop can leave <see cref="_lockedBounds"/> parked entirely over
    /// screen space that no longer exists — the calendar looks "gone" even once re-parented.
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
    /// After a display-topology change, reclamp locked bounds and re-assert
    /// top-level popup desktop styles + z-order.
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

            if (!IsShellParented || _hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
            {
                return;
            }

            var target = _lockedBounds ?? GetCurrentBounds();
            if (IsSurfaceVisible)
            {
                ApplyBorderlessPopupStyles(_hwnd);
                if (!BoundsNearlyEqual(GetCurrentBounds(), target))
                {
                    SnapMoveAndSize(target);
                }

                ApplyDesktopZOrder();
            }
        }
    }

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

            // Already in desktop popup mode — show/reposition only.
            if (IsShellParented)
            {
                ShowSurfaceUnlocked(targetBounds);
                ApplyDesktopZOrder();
                _last = new EmbedInfo(
                    true,
                    "popup",
                    "auto",
                    "ws-popup",
                    _last.Attempts,
                    DateTime.UtcNow.ToString("o"));
                StartMaintenance(targetBounds);
                return _last;
            }

            EmbedAsTopLevelPopup(targetBounds);
            var attempts = new List<object>
            {
                new { mode = "ws-popup", ok = true, zorder = "HWND_BOTTOM" },
            };
            IsShellParented = true;
            IsSurfaceVisible = true;
            _popupStyleEmbed = true;
            _last = new EmbedInfo(
                true,
                "popup",
                "auto",
                "ws-popup",
                attempts,
                DateTime.UtcNow.ToString("o"));
            StartMaintenance(targetBounds);
            return _last;
        }
    }

    /// <summary>Show the shell-parented host without reparenting.</summary>
    public void ShowSurface(Bounds? bounds = null)
    {
        lock (_gate)
        {
            var target = Normalize(bounds ?? _lockedBounds ?? GetCurrentBounds());
            _lockedBounds = target;
            ShowSurfaceUnlocked(target);
            if (IsShellParented)
            {
                StartMaintenance(target);
            }
        }
    }

    /// <summary>Hide host; stay in desktop-mode style until <see cref="ReleaseShellHost"/>.</summary>
    public void HideSurface()
    {
        lock (_gate)
        {
            StopMaintenance();
            if (_hwnd != IntPtr.Zero && Win32.IsWindow(_hwnd))
            {
                Win32.ShowWindow(_hwnd, Win32.SW_HIDE);
            }

            IsSurfaceVisible = false;

            _last = new EmbedInfo(
                false,
                null,
                "auto",
                IsShellParented ? "hidden-popup" : "none",
                [],
                DateTime.UtcNow.ToString("o"));
        }
    }

    /// <summary>
    /// Leave desktop mode: raise z-order only. Styles and footprint stay identical
    /// so the window does not resize on every mode toggle.
    /// </summary>
    public void ReleaseShellHost(Bounds? topLevelBounds = null)
    {
        lock (_gate)
        {
            StopMaintenance();
            var hwnd = _hwnd;
            if (hwnd != IntPtr.Zero && Win32.IsWindow(hwnd))
            {
                // Remember live rect for persistence — do not SetWindowPos size/pos.
                var live = GetCurrentBounds();
                _lockedBounds = Normalize(topLevelBounds ?? live);
                _lastAppliedBounds = live;
                // ApplyBorderlessPopupStyles already manages WS_EX_LAYERED consistently
                // for the current alpha. A second blind re-add here (old EnsureLayeredAlpha)
                // set WS_EX_LAYERED without SWP_FRAMECHANGED right after it had just been
                // cleared, leaving DWM's redirection surface inconsistent for a frame —
                // that was the recurring black side-bar flash on every mode toggle.
                ApplyBorderlessPopupStyles(hwnd);
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
        // Desktop show: z-order only — never resize (mode toggle / resume).
        ApplyDesktopZOrder();
        IsSurfaceVisible = true;
        ApplyAlphaTree();
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
            ["opacity"] = GetOpacity(),
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

    /// <summary>Snapshot of Progman/WorkerW/DefView/OS for readiness and diagnostics.</summary>
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
            // Top-level WS_POPUP desktop mode — native clicks reach the WebView DOM.
            ["popupStyleEmbed"] = _popupStyleEmbed,
            ["opacity"] = GetOpacity(),
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
    /// True when the SysListView32/WS_CHILD path's shell targets (Progman → DefView →
    /// SysListView32) can currently be resolved, with no side effects on <c>_hwnd</c>.
    /// Immediately after a fresh login/reboot our own auto-start commonly wins the race
    /// against Explorer still building the desktop icon list, so the very first boot embed
    /// can find nothing here and <see cref="Embed"/> throws (no other embed path exists —
    /// see this class's summary). Callers (see DesktopSurfaceController's boot wait) use
    /// this to poll briefly before committing to the first <see cref="Embed"/> call.
    /// </summary>
    public static bool IsSysListView32Ready()
    {
        var progman = FindProgman();
        if (progman == IntPtr.Zero)
        {
            return false;
        }

        SpawnWorkerW(progman);

        var defView = FindDefViewUnder(progman);
        if (defView == IntPtr.Zero)
        {
            defView = FindDesktopDefView();
        }

        if (defView == IntPtr.Zero)
        {
            return false;
        }

        return Win32.FindWindowExW(defView, IntPtr.Zero, "SysListView32", null) != IntPtr.Zero;
    }

    /// <summary>
    /// Desktop mode: same borderless popup styles as window mode, z-ordered to
    /// <c>HWND_BOTTOM</c>. No size/position recalculation — a mode toggle only ever
    /// changes style + z-order, never touches the HWND's live footprint. Whatever the
    /// window was positioned/sized at (via <see cref="SnapMoveAndSize"/> on boot/restore
    /// or plain user resize) carries over untouched.
    /// </summary>
    private void EmbedAsTopLevelPopup(Bounds screenBounds)
    {
        ApplyBorderlessPopupStyles(_hwnd);
        ApplyWpfHostOpacity(1.0);
        ApplyAlphaTree();

        _ = screenBounds;
        _lockedBounds = GetCurrentBounds();
        _lastAppliedBounds = _lockedBounds;

        ApplyDesktopZOrder();
        Win32.ShowWindow(_hwnd, Win32.SW_SHOWNOACTIVATE);
        _popupStyleEmbed = true;
    }

    private static bool BoundsNearlyEqual(Bounds a, Bounds b)
        => Math.Abs(a.X - b.X) <= 1
           && Math.Abs(a.Y - b.Y) <= 1
           && Math.Abs(a.Width - b.Width) <= 1
           && Math.Abs(a.Height - b.Height) <= 1;

    /// <summary>Park the calendar under ordinary app windows (desktop wallpaper band).</summary>
    private void ApplyDesktopZOrder()
    {
        if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
        {
            return;
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

    private void StartMaintenance(Bounds bounds)
    {
        StopMaintenance();
        _maintenance = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(5),
        };
        _maintenance.Tick += (_, _) =>
        {
            if (!IsShellParented || !IsSurfaceVisible || _hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
            {
                return;
            }

            // Re-assert bottom z-order only — never restyle/resize (that jumped size on toggle).
            ApplyDesktopZOrder();
            ApplyAlphaTree();
        };
        _maintenance.Start();
    }

    private void StopMaintenance()
    {
        if (_maintenance is null)
        {
            return;
        }

        _maintenance.Stop();
        _maintenance = null;
    }

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

    private static void ApplyLayeredAlphaToWindow(IntPtr hwnd, byte alpha)
    {
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

    /// <summary>
    /// Remove WS_EX_LAYERED from a window tree. Fully-opaque layered under DefView can
    /// fog wallpaper/icons on some GPU/driver builds.
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

    private void ApplyAlphaTree()
    {
        if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
        {
            return;
        }

        // Fully opaque: drop layered styles (avoids milky/dark DefView wash).
        if (_alpha >= 255)
        {
            ClearLayeredStyle(_hwnd);
            return;
        }

        // One alpha on the host HWND only. Per-Chromium-child LWA double-darkened the UI.
        ApplyLayeredAlphaToWindow(_hwnd, _alpha);
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
        nextEx &= ~(Win32.WS_EX_APPWINDOW | Win32.WS_EX_NOACTIVATE);
        if (_alpha >= 255)
        {
            nextEx &= ~Win32.WS_EX_LAYERED;
        }

        if (nextStyle == style && nextEx == ex)
        {
            return;
        }

        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE, new IntPtr(nextStyle));
        if (_alpha >= 255)
        {
            Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE, new IntPtr(nextEx));
            ClearLayeredStyle(hwnd);
        }
        else
        {
            Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE, new IntPtr(nextEx));
            ApplyLayeredAlphaToWindow(hwnd, _alpha);
        }

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

    private static IntPtr FindProgman()
    {
        var hwnd = Win32.FindWindowW("Progman", "Program Manager");
        return hwnd != IntPtr.Zero ? hwnd : Win32.FindWindowW("Progman", null);
    }

    /// <summary>
    /// Win11 24H2+ desktop uses Progman with WS_EX_NOREDIRECTIONBITMAP and child DefView/WorkerW.
    /// </summary>
    private static bool IsModernDesktopComposition(IntPtr progman)
    {
        if (progman == IntPtr.Zero)
        {
            return false;
        }

        var ex = Win32.GetWindowLongPtrCompat(progman, Win32.GWL_EXSTYLE).ToInt64();
        if ((ex & Win32.WS_EX_NOREDIRECTIONBITMAP) != 0)
        {
            return true;
        }

        return FindDefViewUnder(progman) != IntPtr.Zero;
    }

    private static void SpawnWorkerW(IntPtr progman)
    {
        if (progman == IntPtr.Zero)
        {
            return;
        }

        // Classic raise-desktop
        Win32.SendMessageTimeoutW(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, Win32.SMTO_NORMAL, 1000, out _);
        // Dynamic wallpaper / Ivy / newer shells
        Win32.SendMessageTimeoutW(progman, 0x052C, new IntPtr(0xD), IntPtr.Zero, Win32.SMTO_NORMAL, 1000, out _);
        Win32.SendMessageTimeoutW(progman, 0x052C, new IntPtr(0xD), new IntPtr(1), Win32.SMTO_NORMAL, 1000, out _);
    }

    private static IntPtr FindWorkerW()
    {
        var progman = FindProgman();
        SpawnWorkerW(progman);

        var child = FindWorkerWChild(progman);
        if (child != IntPtr.Zero)
        {
            return child;
        }

        return FindClassicSiblingWorkerW();
    }

    private static IntPtr FindWorkerWChild(IntPtr progman)
    {
        if (progman == IntPtr.Zero)
        {
            return IntPtr.Zero;
        }

        IntPtr child = IntPtr.Zero;
        while (true)
        {
            child = Win32.FindWindowExW(progman, child, "WorkerW", null);
            if (child == IntPtr.Zero)
            {
                return IntPtr.Zero;
            }

            // Wallpaper host WorkerW has no DefView; DefView lives as Progman sibling on 24H2+.
            if (FindDefViewUnder(child) == IntPtr.Zero)
            {
                return child;
            }
        }
    }

    private static IntPtr FindClassicSiblingWorkerW()
    {
        IntPtr result = IntPtr.Zero;
        Win32.EnumWindows((top, _) =>
        {
            var shell = Win32.FindWindowExW(top, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (shell == IntPtr.Zero)
            {
                return true;
            }

            var worker = Win32.FindWindowExW(IntPtr.Zero, top, "WorkerW", null);
            if (worker != IntPtr.Zero && FindDefViewUnder(worker) == IntPtr.Zero)
            {
                result = worker;
                return false;
            }

            return true;
        }, IntPtr.Zero);
        return result;
    }

    private static IntPtr FindDefViewUnder(IntPtr parent)
    {
        if (parent == IntPtr.Zero)
        {
            return IntPtr.Zero;
        }

        return Win32.FindWindowExW(parent, IntPtr.Zero, "SHELLDLL_DefView", null);
    }

    private static IntPtr FindDesktopDefView()
    {
        var progman = FindProgman();
        var underProgman = FindDefViewUnder(progman);
        if (underProgman != IntPtr.Zero)
        {
            return underProgman;
        }

        IntPtr result = IntPtr.Zero;
        Win32.EnumWindows((top, _) =>
        {
            var defView = Win32.FindWindowExW(top, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (defView != IntPtr.Zero)
            {
                result = defView;
                return false;
            }

            return true;
        }, IntPtr.Zero);
        return result;
    }

    private static JsonObject DetectCapabilities()
    {
        var progman = FindProgman();
        SpawnWorkerW(progman);
        var modern = IsModernDesktopComposition(progman);
        return new JsonObject
        {
            ["progman"] = progman != IntPtr.Zero,
            ["workerw"] = FindWorkerW() != IntPtr.Zero,
            ["defView"] = FindDesktopDefView() != IntPtr.Zero,
            ["modernDesktop"] = modern,
            ["progmanNoRedirectionBitmap"] = progman != IntPtr.Zero
                && (Win32.GetWindowLongPtrCompat(progman, Win32.GWL_EXSTYLE).ToInt64() & Win32.WS_EX_NOREDIRECTIONBITMAP) != 0,
            ["os"] = Environment.OSVersion.VersionString,
            ["build"] = Environment.OSVersion.Version.Build,
        };
    }
}
