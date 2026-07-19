using System.Text.Json.Nodes;
using System.Windows;
using MyDesktopCalendar.Native;

namespace MyDesktopCalendar.Services;

/// <summary>
/// DesktopHost wallpaper embed. SetParent runs once; thereafter Show/Hide only.
/// AppWindow must never be passed here — dual-HWND flicker rule #1.
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
    private System.Windows.Threading.DispatcherTimer? _recompositeHeartbeat;
    private IntPtr _embedParent;
    /// <summary>
    /// True when the *current* embed connection is the SysListView32/WS_POPUP path
    /// (<see cref="EmbedSysListView32"/>) rather than one of the existing WS_CHILD
    /// Progman/WorkerW paths. WS_POPUP windows always use screen coordinates in
    /// SetWindowPos regardless of parent, so every parent-relative coordinate
    /// conversion in this class must be skipped while this is true.
    /// </summary>
    private bool _popupStyleEmbed;

    /// <summary>Host is parented under the shell (may be hidden).</summary>
    public bool IsShellParented { get; private set; }

    /// <summary>Host HWND is visible on the desktop surface.</summary>
    public bool IsSurfaceVisible { get; private set; }

    /// <summary>Shell-parented and currently the visible desktop surface.</summary>
    public bool IsEmbedded => IsShellParented && IsSurfaceVisible;

    /// <summary>
    /// True when the current embed is the SysListView32/WS_POPUP path (see
    /// <see cref="EmbedSysListView32"/>). Unlike the WS_CHILD Progman/WorkerW paths,
    /// SHELLDLL_DefView does not steal clicks from this path — real mouse input reaches
    /// WebView2 natively. Callers (e.g. <see cref="UndockZoneMonitor"/>) must not also
    /// synthesize click-zone matching for anything the native path already delivers, or
    /// the same click ends up double-firing.
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
        EnsureOpaqueLayeredStyle(hwnd);
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
        // Window transparency feature removed — always fully opaque.
        _ = opacity;
        _alpha = 255;
        ApplyAlphaTree();
    }

    public double GetOpacity() => _alpha / 255.0;

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
                SnapMoveAndSize(target, parentRelative: !_popupStyleEmbed);
                if (wasVisible)
                {
                    ForceRecomposite(_hwnd);
                    ScheduleRecompositeRetries(_hwnd);
                }

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

            BeginSilentTransition(_hwnd);
            try
            {
                ApplyAlphaTree();
                _popupStyleEmbed = false;

                var attempts = new List<object>();
                foreach (var mode in ResolveAttemptOrder())
                {
                    try
                    {
                        if (TryEmbed(mode, targetBounds))
                        {
                            SnapMoveAndSize(
                                targetBounds,
                                parentRelative: !_popupStyleEmbed && mode == "auto");
                            attempts.Add(new
                            {
                                mode,
                                ok = true,
                                parent = _embedParent.ToInt64(),
                                ancestor = Win32.GetAncestor(_hwnd, Win32.GA_PARENT).ToInt64(),
                            });
                            IsShellParented = true;
                            IsSurfaceVisible = true;
                            Win32.ShowWindow(_hwnd, Win32.SW_SHOW);
                            ForceRecomposite(_hwnd);
                            ScheduleRecompositeRetries(_hwnd);
                            _last = new EmbedInfo(
                                true,
                                mode,
                                "auto",
                                "parent",
                                attempts,
                                DateTime.UtcNow.ToString("o"));
                            StartMaintenance(targetBounds);
                            return _last;
                        }

                        attempts.Add(new
                        {
                            mode,
                            ok = false,
                            error = "unavailable",
                            ancestor = Win32.GetAncestor(_hwnd, Win32.GA_PARENT).ToInt64(),
                            getParent = Win32.GetParent(_hwnd).ToInt64(),
                        });
                    }
                    catch (Exception ex)
                    {
                        attempts.Add(new { mode, ok = false, error = ex.Message });
                    }
                }

                _last = new EmbedInfo(false, null, "auto", "none", attempts, DateTime.UtcNow.ToString("o"));
                var caps = DetectCapabilities();
                throw new InvalidOperationException(
                    $"Desktop embed failed. Caps={caps}. Attempts: {string.Join("; ", attempts)}");
            }
            finally
            {
                EndSilentTransition(_hwnd);
            }
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
            SnapMoveAndSize(targetBounds, parentRelative: !_popupStyleEmbed && IsShellParented && _embedParent != IntPtr.Zero);
        }

        IsSurfaceVisible = true;
        ApplyAlphaTree();
        ForceRecomposite(_hwnd);
        ScheduleRecompositeRetries(_hwnd);
    }

    /// <summary>
    /// DWM occasionally fails to recomposite a WS_CHILD WebView2 host after an SW_HIDE →
    /// SW_SHOW cycle under Progman/WorkerW (both use the "no redirection bitmap" desktop
    /// optimization — see capabilities.progmanNoRedirectionBitmap) — the window/children stay
    /// genuinely IsWindowVisible=true, correctly parented and positioned (confirmed via
    /// WindowFromPoint/EnumChildWindows), yet nothing paints on screen (invisible calendar,
    /// e.g. right after login resumes desktop mode). A plain repaint or move doesn't fix it;
    /// only an explicit RedrawWindow + a no-op SetWindowPos with SWP_FRAMECHANGED reliably
    /// forces DWM to recomposite the surface. Cheap and safe to call on every show.
    /// </summary>
    private static void ForceRecomposite(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd))
        {
            return;
        }

        try
        {
            Win32.RedrawWindow(
                hwnd,
                IntPtr.Zero,
                IntPtr.Zero,
                Win32.RDW_INVALIDATE | Win32.RDW_ERASE | Win32.RDW_ALLCHILDREN | Win32.RDW_UPDATENOW | Win32.RDW_FRAME);
            Win32.SetWindowPos(
                hwnd,
                IntPtr.Zero,
                0,
                0,
                0,
                0,
                Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE | Win32.SWP_FRAMECHANGED);
        }
        catch
        {
            /* ignore — best-effort repaint nudge */
        }
    }

    /// <summary>
    /// The immediate <see cref="ForceRecomposite"/> call can land before WebView2's own
    /// compositor has produced a fresh frame after being hidden for a while (e.g. during a
    /// real login: suspend → type credentials → submit → refresh() reloads the store → resume
    /// — several seconds, not the near-instant hide/show this was first verified against),
    /// so DWM has nothing new to show yet and the calendar stays invisible until *something
    /// else* happens to repaint (observed: reappears "after a while" — really the 5s
    /// maintenance tick incidentally forcing it). Re-fire a few short-delay follow-ups on the
    /// UI thread so one of them lands after the first real frame is ready, without waiting on
    /// the maintenance timer.
    /// </summary>
    private void ScheduleRecompositeRetries(IntPtr hwnd)
    {
        foreach (var delayMs in new[] { 120, 350, 800, 1600 })
        {
            var timer = new System.Windows.Threading.DispatcherTimer
            {
                Interval = TimeSpan.FromMilliseconds(delayMs),
            };
            timer.Tick += (sender, _) =>
            {
                ((System.Windows.Threading.DispatcherTimer)sender!).Stop();
                if (IsShellParented && IsSurfaceVisible && hwnd == _hwnd)
                {
                    ForceRecomposite(hwnd);
                }
            };
            timer.Start();
        }
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
            // SysListView32/WS_POPUP embed — lets the renderer know real clicks reach its
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

    private bool TryEmbed(string mode, Bounds bounds)
    {
        return mode switch
        {
            "syslistview32" => EmbedSysListView32(bounds),
            "auto" => EmbedAuto(bounds),
            _ => false,
        };
    }

    /// <summary>
    /// v1.1.6 experiment, tried first in the Auto attempt order: parent DesktopHost
    /// *inside* SysListView32 (the desktop icon ListView, a child of SHELLDLL_DefView)
    /// instead of as a Progman/WorkerW sibling like every other strategy in this class.
    /// Live testing showed SHELLDLL_DefView only intercepts clicks meant for its
    /// sibling windows — once we're a genuine child of its own SysListView32 control,
    /// real mouse input reaches WebView2 natively, without <c>UndockZoneMonitor</c>'s
    /// click-zone polling.
    /// Requires WS_POPUP (see <see cref="PrepareAsPopupChild"/>), not WS_CHILD: WS_POPUP
    /// windows always use screen (not parent-relative) coordinates in SetWindowPos
    /// regardless of parent, which is what let xdiary reposition without ever
    /// detaching. Every parent-relative computation elsewhere in this class is gated
    /// on <see cref="_popupStyleEmbed"/> so it never runs for this path.
    /// Automatically falls back to the existing, Win11-24H2-safe WS_CHILD chain
    /// (raised/workerw/progman) via <see cref="ResolveAttemptOrder"/> when this
    /// doesn't verify — untouched by this change.
    /// </summary>
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
        PrepareAsPopupChild(_hwnd);
        Win32.SetParent(_hwnd, listView);
        _embedParent = listView;

        // WS_POPUP ignores parent-relative client offsets — always absolute screen
        // coordinates. Raise to the top of the ListView's own child z-order so the
        // surface sits above the desktop icons it now lives among.
        Win32.SetWindowPos(
            _hwnd,
            Win32.HWND_TOP,
            screenBounds.X,
            screenBounds.Y,
            screenBounds.Width,
            screenBounds.Height,
            Win32.SWP_NOACTIVATE | Win32.SWP_FRAMECHANGED | Win32.SWP_NOREDRAW);

        ApplyAlphaTree();
        TryRefreshShellDesktopComposition(progman);

        var verified = IsParentedTo(_hwnd, listView);
        _popupStyleEmbed = verified;
        return verified;
    }

    /// <summary>
    /// Cross-version entry: Win11 24H2+ → Progman raised; older → WorkerW sibling; last resort Progman.
    /// WPF outer HWND is the stable reparent target (WebView2 stays a WPF child).
    /// </summary>
    private bool EmbedAuto(Bounds bounds)
    {
        var progman = FindProgman();
        if (progman == IntPtr.Zero)
        {
            return false;
        }

        SpawnWorkerW(progman);

        if (IsModernDesktopComposition(progman))
        {
            return EmbedModernRaised(bounds);
        }

        var classicWorker = FindClassicSiblingWorkerW();
        if (classicWorker != IntPtr.Zero && EmbedToShellParent(classicWorker, bounds))
        {
            return true;
        }

        var childWorker = FindWorkerWChild(progman);
        if (childWorker != IntPtr.Zero && EmbedToShellParent(childWorker, bounds))
        {
            return true;
        }

        return EmbedModernRaised(bounds);
    }

    private bool EmbedModernRaised(Bounds screenBounds)
    {
        var progman = FindProgman();
        if (progman == IntPtr.Zero)
        {
            return false;
        }

        SpawnWorkerW(progman);
        return EmbedToShellParent(progman, screenBounds);
    }

    /// <summary>
    /// WS_CHILD fallback used only when the SysListView32 path (<see cref="EmbedSysListView32"/>)
    /// can't be found/verified. No Z-order enforcement — the abandoned "calendar behind icons"
    /// goal used to fight the shell's Z-order here; this just leaves whatever stacking SetParent
    /// itself produces.
    /// </summary>
    private bool EmbedToShellParent(IntPtr parent, Bounds screenBounds)
    {
        if (parent == IntPtr.Zero || _hwnd == IntPtr.Zero)
        {
            return false;
        }

        ApplyAlphaTree();
        // Avoid ShowWindow during re-embed — it can flash a blank frame.

        var local = ScreenToParentClient(parent, screenBounds);
        PrepareAsDesktopChild(_hwnd);
        Win32.SetParent(_hwnd, parent);
        _embedParent = parent;

        // First attach: set position + size (DesktopHost boots tiny off-screen).
        Win32.SetWindowPos(
            _hwnd,
            IntPtr.Zero,
            local.X,
            local.Y,
            screenBounds.Width,
            screenBounds.Height,
            Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE | Win32.SWP_FRAMECHANGED | Win32.SWP_NOREDRAW);

        ApplyAlphaTree();
        TryRefreshShellDesktopComposition(parent);
        return IsParentedTo(_hwnd, parent);
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
                        if (_popupStyleEmbed)
                        {
                            PrepareAsPopupChild(_hwnd);
                        }
                        else
                        {
                            PrepareAsDesktopChild(_hwnd);
                        }

                        Win32.SetParent(_hwnd, _embedParent);
                        SnapMoveOnly(bounds, parentRelative: !_popupStyleEmbed);
                    }
                    catch
                    {
                        /* ignore */
                    }
                }

                // Keep geometry in sync without touching Z-order — SysListView32/WS_POPUP
                // embeds always use screen coordinates; the WS_CHILD fallback needs
                // parent-relative coordinates converted.
                if (_lastAppliedBounds != bounds)
                {
                    SnapMoveOnly(bounds, parentRelative: !_popupStyleEmbed);
                }
            }

            ApplyAlphaTree();
        };
        _maintenance.Start();
        StartRecompositeHeartbeat();
    }

    private void StopMaintenance()
    {
        StopRecompositeHeartbeat();
        if (_maintenance is null)
        {
            return;
        }

        _maintenance.Stop();
        _maintenance = null;
    }

    /// <summary>
    /// The Progman/WorkerW desktop-icon-layer trick occasionally drops composition of this
    /// WS_CHILD host spontaneously mid-session — not just after an explicit hide/show cycle
    /// (<see cref="ScheduleRecompositeRetries"/> covers that case) — observed more readily on
    /// hybrid-GPU / mixed-monitor rigs where DWM's "no redirection bitmap" desktop optimization
    /// is more prone to skipping a recomposite. Rather than wait up to 5s for the parenting/
    /// z-order maintenance tick to incidentally fix it, run a separate, cheap (RedrawWindow +
    /// no-op SetWindowPos only — no z-order/parent touching, so no DefView/icon flash risk)
    /// nudge on a tighter cadence for as long as the surface is supposed to be visible.
    /// </summary>
    private void StartRecompositeHeartbeat()
    {
        StopRecompositeHeartbeat();
        _recompositeHeartbeat = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(1.5),
        };
        _recompositeHeartbeat.Tick += (_, _) =>
        {
            if (IsShellParented && IsSurfaceVisible && _hwnd != IntPtr.Zero && Win32.IsWindow(_hwnd))
            {
                ForceRecomposite(_hwnd);
            }
        };
        _recompositeHeartbeat.Start();
    }

    private void StopRecompositeHeartbeat()
    {
        if (_recompositeHeartbeat is null)
        {
            return;
        }

        _recompositeHeartbeat.Stop();
        _recompositeHeartbeat = null;
    }

    /// <summary>
    /// Prefer SWP_NOREDRAW only. WM_SETREDRAW blanks WebView2's Chromium surface
    /// and is a common flash source (see WebView2 feedback / WPF host notes).
    /// </summary>
    private static void BeginSilentTransition(IntPtr hwnd)
    {
        _ = hwnd;
    }

    private static void EndSilentTransition(IntPtr hwnd)
    {
        _ = hwnd;
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
    /// WPF keeps WS_POPUP; GetParent then returns the owner (often 0), not the real parent.
    /// Always verify with GetAncestor(GA_PARENT). Also force WS_CHILD before SetParent (Win11 24H2+).
    /// </summary>
    private static void PrepareAsDesktopChild(IntPtr hwnd)
    {
        var style = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE).ToInt64();
        style |= Win32.WS_CHILD | Win32.WS_VISIBLE | Win32.WS_THICKFRAME;
        style &= ~unchecked((long)Win32.WS_POPUP);
        style &= ~(Win32.WS_CAPTION | Win32.WS_SYSMENU | Win32.WS_MINIMIZEBOX | Win32.WS_MAXIMIZEBOX);
        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE, new IntPtr(style));

        // About to SetParent under the shell — do not keep WS_EX_LAYERED (desktop haze).
        ClearLayeredStyle(hwnd);
    }

    /// <summary>
    /// Style prep for the SysListView32 embed path only (see <see cref="EmbedSysListView32"/>).
    /// Unlike <see cref="PrepareAsDesktopChild"/>, this deliberately KEEPS WS_POPUP and clears
    /// WS_CHILD — SysListView32 is a real system control with its own message/paint handling,
    /// and reparenting a WS_CHILD window into it produced inconsistent input routing during
    /// testing. WS_POPUP is what makes SetWindowPos use absolute screen coordinates here.
    /// </summary>
    private static void PrepareAsPopupChild(IntPtr hwnd)
    {
        var style = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE).ToInt64();
        style |= unchecked((long)Win32.WS_POPUP) | Win32.WS_VISIBLE;
        style &= ~Win32.WS_CHILD;
        style &= ~(Win32.WS_CAPTION | Win32.WS_SYSMENU | Win32.WS_MINIMIZEBOX | Win32.WS_MAXIMIZEBOX | Win32.WS_THICKFRAME);
        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE, new IntPtr(style));

        // About to SetParent under the shell — do not keep WS_EX_LAYERED (desktop haze).
        ClearLayeredStyle(hwnd);
    }

    private static void RestoreAsTopLevel(IntPtr hwnd)
    {
        var style = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE).ToInt64();
        style |= unchecked((long)Win32.WS_POPUP) | Win32.WS_VISIBLE | Win32.WS_THICKFRAME;
        style &= ~Win32.WS_CHILD;
        style &= ~(Win32.WS_CAPTION | Win32.WS_SYSMENU | Win32.WS_MINIMIZEBOX | Win32.WS_MAXIMIZEBOX);
        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE, new IntPtr(style));

        EnsureOpaqueLayeredStyle(hwnd);
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
    /// Top-level / parked Host: opaque WS_EX_LAYERED (alpha 255). Under the shell this can
    /// wash wallpaper+icons on some GPUs — use <see cref="ClearLayeredStyle"/> once parented.
    /// </summary>
    private static void EnsureOpaqueLayeredStyle(IntPtr hwnd)
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

        _ = Win32.SetLayeredWindowAttributes(hwnd, 0, 255, Win32.LWA_ALPHA);
    }

    /// <summary>
    /// Remove WS_EX_LAYERED from a shell-parented Host. Layered composition under
    /// Progman/WorkerW/DefView leaves a milky wash over the whole desktop on some machines
    /// even at alpha 255; non-layered opaque HWND avoids that path.
    /// </summary>
    private static void ClearLayeredStyle(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd))
        {
            return;
        }

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
        // Once shell-parented, also drop WS_EX_LAYERED — opaque layered under DefView
        // still fogs wallpaper/icons on a subset of GPU/driver builds.
        if (_embedParent != IntPtr.Zero || IsShellParented)
        {
            ClearLayeredStyle(_hwnd);
        }
        else
        {
            EnsureOpaqueLayeredStyle(_hwnd);
        }
    }

    private static void ApplyAlpha(IntPtr hwnd, byte alpha)
    {
        // Kept for API compatibility; constant-alpha mode is intentionally unused.
        _ = hwnd;
        _ = alpha;
    }

    /// <summary>
    /// Stable borderless styles applied once at attach — never toggled on embed/unlock.
    /// Keep WS_THICKFRAME so WPF CanResize still works in window mode.
    /// </summary>
    private static void ApplyStableBorderlessStyles(IntPtr hwnd)
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
        _ = Win32.SetLayeredWindowAttributes(hwnd, 0, 255, Win32.LWA_ALPHA);
    }

    private static Bounds ScreenToParentClient(IntPtr parent, Bounds screen)
    {
        var pt = new Win32.POINT { X = screen.X, Y = screen.Y };
        if (!Win32.ScreenToClient(parent, ref pt))
        {
            return screen;
        }

        return new Bounds(pt.X, pt.Y, screen.Width, screen.Height);
    }

    /// <summary>Reposition without changing size (eliminates transition flash).</summary>
    private void SnapMoveOnly(Bounds screen, bool parentRelative)
    {
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        int x = screen.X;
        int y = screen.Y;
        if (parentRelative && _embedParent != IntPtr.Zero)
        {
            var local = ScreenToParentClient(_embedParent, screen);
            x = local.X;
            y = local.Y;
        }

        Win32.SetWindowPos(
            _hwnd,
            IntPtr.Zero,
            x,
            y,
            0,
            0,
            Win32.SWP_NOSIZE | Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE);
    }

    /// <summary>Place host at screen bounds with explicit size (first attach / host boot).</summary>
    private void SnapMoveAndSize(Bounds screen, bool parentRelative)
    {
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        int x = screen.X;
        int y = screen.Y;
        if (parentRelative && _embedParent != IntPtr.Zero)
        {
            var local = ScreenToParentClient(_embedParent, screen);
            x = local.X;
            y = local.Y;
        }

        Win32.SetWindowPos(
            _hwnd,
            IntPtr.Zero,
            x,
            y,
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

    /// <summary>
    /// Fixed attempt order — no user-selectable strategy. Prefer SysListView32/WS_POPUP
    /// first: it parents *inside* the icon ListView itself, so real mouse input reaches
    /// WebView2 natively (no <see cref="UndockZoneMonitor"/> click-zone polling needed).
    /// Falls back to the single WS_CHILD chain (<see cref="EmbedAuto"/>, itself cross-version
    /// aware) when SysListView32 can't be found/verified.
    /// </summary>
    private static IEnumerable<string> ResolveAttemptOrder() => ["syslistview32", "auto"];

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
