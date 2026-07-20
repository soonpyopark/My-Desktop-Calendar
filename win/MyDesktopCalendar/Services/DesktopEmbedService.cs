using System.Text.Json.Nodes;
using System.Windows;
using MyDesktopCalendar.Native;

namespace MyDesktopCalendar.Services;

/// <summary>
/// DesktopHost wallpaper embed. SetParent runs once; thereafter Show/Hide only.
/// AppWindow must never be passed here — dual-HWND flicker rule #1.
/// The only embed technique is <see cref="EmbedSysListView32"/>: DesktopHost becomes a
/// real <c>WS_CHILD</c> of the desktop icon ListView (SysListView32), matching the
/// CalendarTask/desktopcal host parenting model. SetWindowPos uses parent-client
/// coordinates once parented. If SysListView32 can never be resolved (icons hidden by
/// policy, remote/kiosk session, shell replacement), <see cref="Embed"/> throws and the
/// caller falls back to window mode.
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
    private IntPtr _embedParent;
    /// <summary>
    /// True once <see cref="EmbedSysListView32"/> has actually verified its parenting.
    /// SysListView32/WS_CHILD is the only embed path this class has — see
    /// <see cref="IsPopupStyleEmbed"/> — so this is false only before the first
    /// successful embed of the process's lifetime. (Name kept for the JS/status API.)
    /// </summary>
    private bool _popupStyleEmbed;

    /// <summary>Host is parented under the shell (may be hidden).</summary>
    public bool IsShellParented { get; private set; }

    /// <summary>Host HWND is visible on the desktop surface.</summary>
    public bool IsSurfaceVisible { get; private set; }

    /// <summary>Shell-parented and currently the visible desktop surface.</summary>
    public bool IsEmbedded => IsShellParented && IsSurfaceVisible;

    /// <summary>
    /// True once actually embedded under SysListView32 as a <c>WS_CHILD</c> (see
    /// <see cref="EmbedSysListView32"/>). The host sits in the ListView's own child
    /// z-order (HWND_TOP), so real mouse input reaches WebView2 natively for its
    /// client area. Callers (e.g. <see cref="UndockZoneMonitor"/>) must not also
    /// synthesize click-zone matching for anything this native path already delivers,
    /// or the same click ends up double-firing. Name retained for the status/JS API.
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
        // Apply borderless styles ONCE. Never toggle during embed↔unlock (size flash source).
        ApplyStableBorderlessStyles(hwnd);
        DisableDwmTransitions(hwnd);
        EnsureLayeredAlpha(hwnd);
        // Do NOT call DwmExtendFrameIntoClientArea on DesktopHost. Even with zero margins it
        // can put SHELLDLL_DefView / WorkerW into a washed-out (foggy) composition on some
        // GPUs and Windows builds once the host is shell-parented. AppWindow frame theming
        // is handled separately via WindowFrameTheme on MainWindow.
        ApplyAlphaTree();
    }

    public void AttachHost(Window host)
    {
        _hostWindow = host;
    }

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
        ApplyWpfHostOpacity(clamped);
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
    /// Re-validate/re-anchor after a display-topology change (monitor sleep/wake, cable
    /// reconnect, resolution/DPI/arrangement change). Explorer commonly recreates
    /// Progman/WorkerW/DefView across these — the 5s maintenance tick's <see
    /// cref="IsParentedTo"/> check would notice the mismatch but then keep retrying
    /// <c>SetParent</c> against the now-dead cached <see cref="_embedParent"/> handle forever
    /// (see <see cref="StartMaintenance"/>). This instead re-resolves the shell parent fresh
    /// and forces a real re-embed through the normal <see cref="Embed"/> attempt-order path
    /// when the cached parent is actually stale; otherwise it just re-clamps bounds and nudges
    /// a repaint, since most display-change notifications don't actually break parenting.
    /// </summary>
    public void HandleDisplayChanged()
    {
        var wasVisible = false;
        Bounds? boundsForReembed = null;
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

            wasVisible = IsSurfaceVisible;
            var parentStale = _embedParent == IntPtr.Zero
                || !Win32.IsWindow(_embedParent)
                || !IsParentedTo(_hwnd, _embedParent);

            if (!parentStale)
            {
                var target = _lockedBounds ?? GetCurrentBounds();
                SnapMoveAndSize(target);
                return;
            }

            // Force Embed()'s already-parented skip (IsShellParented && IsParentedTo) to fall
            // through to its normal fresh-SetParent attempt order below, instead of duplicating
            // that parent-resolution logic here.
            IsShellParented = false;
            boundsForReembed = _lockedBounds ?? GetCurrentBounds();
        }

        if (boundsForReembed is { } rebounds)
        {
            try
            {
                Embed(rebounds);
            }
            catch
            {
                /* best-effort — next manual apply/tray retry or 5s maintenance tick keeps trying */
            }

            if (!wasVisible)
            {
                // Re-embed always shows the surface — restore whatever hidden/suspended state
                // (e.g. settings/quick-edit overlay open) was active before the display change.
                HideSurface();
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

            // Already shell-parented: Show/Hide only — never SetParent again.
            if (IsShellParented && _embedParent != IntPtr.Zero && IsParentedTo(_hwnd, _embedParent))
            {
                ShowSurfaceUnlocked(targetBounds);
                var active = _last.ActiveMode ?? "auto";
                _last = new EmbedInfo(
                    true,
                    active,
                    "auto",
                    _last.Technique == "none" ? "parent" : _last.Technique,
                    _last.Attempts,
                    DateTime.UtcNow.ToString("o"));
                StartMaintenance(targetBounds);
                return _last;
            }

            ApplyAlphaTree();
            _popupStyleEmbed = false;

            var attempts = new List<object>();
            try
            {
                if (EmbedSysListView32(targetBounds))
                {
                    SnapMoveAndSize(targetBounds);
                    attempts.Add(new
                    {
                        mode = "syslistview32",
                        ok = true,
                        parent = _embedParent.ToInt64(),
                        ancestor = Win32.GetAncestor(_hwnd, Win32.GA_PARENT).ToInt64(),
                    });
                    IsShellParented = true;
                    IsSurfaceVisible = true;
                    Win32.ShowWindow(_hwnd, Win32.SW_SHOW);

                    _last = new EmbedInfo(
                        true,
                        "syslistview32",
                        "auto",
                        "parent",
                        attempts,
                        DateTime.UtcNow.ToString("o"));
                    StartMaintenance(targetBounds);
                    return _last;
                }

                attempts.Add(new
                {
                    mode = "syslistview32",
                    ok = false,
                    error = "unavailable",
                    ancestor = Win32.GetAncestor(_hwnd, Win32.GA_PARENT).ToInt64(),
                    getParent = Win32.GetParent(_hwnd).ToInt64(),
                });
            }
            catch (Exception ex)
            {
                attempts.Add(new { mode = "syslistview32", ok = false, error = ex.Message });
            }

            _last = new EmbedInfo(false, null, "auto", "none", attempts, DateTime.UtcNow.ToString("o"));
            var caps = DetectCapabilities();
            throw new InvalidOperationException(
                $"Desktop embed failed. Caps={caps}. Attempts: {string.Join("; ", attempts)}");
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

    /// <summary>Hide host; keep shell parent (no SetParent(null)).</summary>
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
            if (_hostWindow is DesktopHostWindow host)
            {
                host.SetSurfaceActive(false);
            }

            _last = new EmbedInfo(
                false,
                null,
                "auto",
                IsShellParented ? "hidden-parented" : "none",
                [],
                DateTime.UtcNow.ToString("o"));
        }
    }

    /// <summary>
    /// Fully detach DesktopHost from the shell and drop HWND ownership so the Host
    /// WebView2 process tree can be disposed (single-WebView memory policy).
    /// Next desktop enter must <see cref="Attach"/> a new HWND and <see cref="Embed"/> again.
    /// </summary>
    public void ReleaseShellHost()
    {
        lock (_gate)
        {
            StopMaintenance();
            if (_hwnd != IntPtr.Zero && Win32.IsWindow(_hwnd))
            {
                try
                {
                    Win32.ShowWindow(_hwnd, Win32.SW_HIDE);
                }
                catch
                {
                    /* ignore */
                }

                if (IsShellParented)
                {
                    try
                    {
                        Win32.SetParent(_hwnd, IntPtr.Zero);
                    }
                    catch
                    {
                        /* ignore */
                    }
                }
            }

            IsShellParented = false;
            IsSurfaceVisible = false;
            _popupStyleEmbed = false;
            _embedParent = IntPtr.Zero;
            _hwnd = IntPtr.Zero;
            _hostWindow = null;
            _lastAppliedBounds = null;
            _last = new EmbedInfo(
                false,
                null,
                "auto",
                "none",
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
        if (_hostWindow is DesktopHostWindow host)
        {
            host.SetSurfaceActive(true);
        }

        Win32.ShowWindow(_hwnd, Win32.SW_SHOW);

        // Skip the move/resize entirely when geometry hasn't changed since it was last applied
        // (the common case on settings/quick-edit resume — Host was only hidden, never moved).
        if (_lastAppliedBounds != targetBounds)
        {
            SnapMoveAndSize(targetBounds);
        }

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
            ["dualHwnd"] = true,
            ["platform"] = "wpf-native",
            // SysListView32/WS_CHILD embed — lets the renderer know real clicks reach its
            // own DOM directly (see Header.jsx withUiSuspend's Settings-in-place branch).
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

    private bool EmbedSysListView32(Bounds screenBounds)
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

        var listView = Win32.FindWindowExW(defView, IntPtr.Zero, "SysListView32", null);
        if (listView == IntPtr.Zero)
        {
            return false;
        }

        ApplyAlphaTree();
        PrepareAsListViewChild(_hwnd);
        Win32.SetParent(_hwnd, listView);
        _embedParent = listView;

        // WS_CHILD SetWindowPos is parent-client relative. Raise to the top of the
        // ListView's own child z-order so the surface sits above the desktop icons.
        var client = ScreenToParentClient(screenBounds);
        Win32.SetWindowPos(
            _hwnd,
            Win32.HWND_TOP,
            client.X,
            client.Y,
            client.Width,
            client.Height,
            Win32.SWP_NOACTIVATE | Win32.SWP_FRAMECHANGED | Win32.SWP_NOREDRAW);

        ApplyAlphaTree();
        TryRefreshShellDesktopComposition(progman);

        var verified = IsParentedTo(_hwnd, listView);
        _popupStyleEmbed = verified;
        return verified;
    }

    /// <summary>
    /// After raise-desktop / SetParent, some machines leave wallpaper or icons looking washed
    /// until the shell surfaces are redrawn. Harmless no-op when handles are stale.
    /// </summary>
    private static void TryRefreshShellDesktopComposition(IntPtr shellParent)
    {
        try
        {
            const uint flags = Win32.RDW_INVALIDATE | Win32.RDW_ERASE | Win32.RDW_ALLCHILDREN | Win32.RDW_UPDATENOW;
            var progman = FindProgman();
            if (progman != IntPtr.Zero)
            {
                _ = Win32.RedrawWindow(progman, IntPtr.Zero, IntPtr.Zero, flags);
            }

            if (shellParent != IntPtr.Zero && shellParent != progman)
            {
                _ = Win32.RedrawWindow(shellParent, IntPtr.Zero, IntPtr.Zero, flags);
            }

            var defView = FindDefViewUnder(shellParent);
            if (defView == IntPtr.Zero)
            {
                defView = FindDefViewUnder(progman);
            }

            if (defView != IntPtr.Zero)
            {
                _ = Win32.RedrawWindow(defView, IntPtr.Zero, IntPtr.Zero, flags);
            }
        }
        catch
        {
            /* ignore */
        }
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

            if (_embedParent != IntPtr.Zero)
            {
                if (!IsParentedTo(_hwnd, _embedParent))
                {
                    try
                    {
                        PrepareAsListViewChild(_hwnd);
                        Win32.SetParent(_hwnd, _embedParent);
                        SnapMoveOnly(bounds);
                    }
                    catch
                    {
                        /* ignore */
                    }
                }

                // WS_CHILD uses parent-client coordinates (see SnapMoveOnly).
                if (_lastAppliedBounds != bounds)
                {
                    SnapMoveOnly(bounds);
                }
            }

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

    /// <summary>
    /// Style prep for the SysListView32 embed path (see <see cref="EmbedSysListView32"/>).
    /// Makes DesktopHost a real <c>WS_CHILD</c> of the ListView (CalendarTask/desktopcal
    /// host model). Clears <c>WS_POPUP</c> so SetWindowPos is parent-client relative.
    /// </summary>
    private static void PrepareAsListViewChild(IntPtr hwnd)
    {
        var style = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE).ToInt64();
        style |= Win32.WS_CHILD | Win32.WS_VISIBLE | Win32.WS_CLIPSIBLINGS | Win32.WS_CLIPCHILDREN;
        style &= unchecked((long)~(uint)Win32.WS_POPUP);
        style &= ~(Win32.WS_CAPTION | Win32.WS_SYSMENU | Win32.WS_MINIMIZEBOX | Win32.WS_MAXIMIZEBOX | Win32.WS_THICKFRAME);
        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE, new IntPtr(style));

        // About to SetParent under the shell — do not keep WS_EX_LAYERED (desktop haze).
        ClearLayeredStyle(hwnd);
    }

    /// <summary>
    /// Convert screen bounds to <see cref="_embedParent"/> client coordinates for
    /// <c>WS_CHILD</c> SetWindowPos. Falls back to the input when the parent is missing.
    /// </summary>
    private Bounds ScreenToParentClient(Bounds screen)
    {
        if (_embedParent == IntPtr.Zero || !Win32.IsWindow(_embedParent))
        {
            return screen;
        }

        var origin = new Win32.POINT { X = screen.X, Y = screen.Y };
        if (!Win32.ScreenToClient(_embedParent, ref origin))
        {
            return screen;
        }

        return new Bounds(origin.X, origin.Y, screen.Width, screen.Height);
    }

    private static bool IsParentedTo(IntPtr hwnd, IntPtr expectedParent)
    {
        if (hwnd == IntPtr.Zero || expectedParent == IntPtr.Zero)
        {
            return false;
        }

        var ancestor = Win32.GetAncestor(hwnd, Win32.GA_PARENT);
        if (ancestor == expectedParent)
        {
            return true;
        }

        // Fallback: after WS_CHILD, GetParent should also match.
        return Win32.GetParent(hwnd) == expectedParent;
    }

    /// <summary>
    /// Apply <c>WS_EX_LAYERED</c> + alpha via SetLayeredWindowAttributes (LWA_ALPHA).
    /// Top-level: root only (children are blended with the parent). Shell-parented child:
    /// walk WebView2 descendant HWNDs — alpha on the WPF host alone leaves Chromium opaque.
    /// </summary>
    private void EnsureLayeredAlpha(IntPtr hwnd)
    {
        var shellParented = _embedParent != IntPtr.Zero || IsShellParented;
        if (shellParented)
        {
            ApplyLayeredAlphaRecursive(hwnd, _alpha);
        }
        else
        {
            ApplyLayeredAlphaToWindow(hwnd, _alpha);
        }
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

    private static void ApplyLayeredAlphaRecursive(IntPtr hwnd, byte alpha)
    {
        ApplyLayeredAlphaToWindow(hwnd, alpha);
        if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd))
        {
            return;
        }

        _ = Win32.EnumChildWindows(hwnd, (child, _) =>
        {
            ApplyLayeredAlphaRecursive(child, alpha);
            return true;
        }, IntPtr.Zero);
    }

    /// <summary>
    /// Remove WS_EX_LAYERED from a shell-parented Host. Layered composition under
    /// Progman/WorkerW/DefView leaves a milky wash over the whole desktop on some machines
    /// even at alpha 255; non-layered opaque HWND avoids that path.
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

        // Never DwmExtendFrameIntoClientArea on DesktopHost (washes the shell).
        // Fully opaque + shell-parented: drop WS_EX_LAYERED — opaque layered under
        // DefView still fogs wallpaper/icons on a subset of GPU/driver builds.
        // Translucent: layered alpha on Host + WebView2 child HWNDs.
        var shellParented = _embedParent != IntPtr.Zero || IsShellParented;
        if (shellParented && _alpha >= 255)
        {
            ClearLayeredStyle(_hwnd);
        }
        else
        {
            EnsureLayeredAlpha(_hwnd);
        }
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
    /// Stable borderless styles applied once at attach — never toggled on embed/unlock.
    /// Keep WS_THICKFRAME so WPF CanResize still works in window mode.
    /// </summary>
    private void ApplyStableBorderlessStyles(IntPtr hwnd)
    {
        var style = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE).ToInt64();
        style |= Win32.WS_POPUP | Win32.WS_VISIBLE | Win32.WS_THICKFRAME;
        style &= ~Win32.WS_CHILD;
        style &= ~(Win32.WS_CAPTION | Win32.WS_SYSMENU | Win32.WS_MINIMIZEBOX | Win32.WS_MAXIMIZEBOX);
        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE, new IntPtr(style));

        var ex = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE).ToInt64();
        ex |= Win32.WS_EX_TOOLWINDOW | Win32.WS_EX_LAYERED;
        ex &= ~(Win32.WS_EX_APPWINDOW | Win32.WS_EX_NOACTIVATE);
        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE, new IntPtr(ex));
        _ = Win32.SetLayeredWindowAttributes(hwnd, 0, _alpha, Win32.LWA_ALPHA);
    }

    /// <summary>
    /// True when <see cref="_hwnd"/> is a real <c>WS_CHILD</c> of <see cref="_embedParent"/>
    /// — SetWindowPos must then use parent-client coordinates. Prefer this over
    /// <see cref="IsShellParented"/> so the first Snap after SetParent (before the
    /// flag flips) still converts correctly.
    /// </summary>
    private bool UsesParentClientCoords =>
        _embedParent != IntPtr.Zero
        && Win32.IsWindow(_embedParent)
        && IsParentedTo(_hwnd, _embedParent);

    /// <summary>
    /// Reposition without changing size (eliminates transition flash).
    /// When shell-parented as <c>WS_CHILD</c>, converts screen bounds to parent-client.
    /// </summary>
    private void SnapMoveOnly(Bounds screen)
    {
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        var pos = UsesParentClientCoords ? ScreenToParentClient(screen) : screen;
        Win32.SetWindowPos(
            _hwnd,
            IntPtr.Zero,
            pos.X,
            pos.Y,
            0,
            0,
            Win32.SWP_NOSIZE | Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE);
    }

    /// <summary>Place host at screen bounds with explicit size (first attach / host boot).</summary>
    private void SnapMoveAndSize(Bounds screen)
    {
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        var pos = UsesParentClientCoords ? ScreenToParentClient(screen) : screen;
        Win32.SetWindowPos(
            _hwnd,
            IntPtr.Zero,
            pos.X,
            pos.Y,
            pos.Width,
            pos.Height,
            Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE);

        if (_hostWindow is not null)
        {
            try
            {
                // WPF Left/Top are still screen-space regardless of Win32 child parenting.
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
