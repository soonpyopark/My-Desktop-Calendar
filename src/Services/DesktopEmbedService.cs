using MyDesktopCalendar.Native;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Desktop-embed experiment: tries to <c>SetParent</c> the host window directly into
/// <c>SysListView32</c> (the desktop icon ListView, a child of <c>SHELLDLL_DefView</c>) —
/// the technique observed in a live inspection of xdiary's <c>desktopcal.exe</c> — and
/// falls back to the proven Progman-raised strategy (parent = Progman, positioned
/// immediately below DefView in z-order) used by My Desktop Calendar today if
/// <c>SysListView32</c> can't be found or the attach can't be verified.
///
/// Every step is written to <see cref="DiagLog"/> so the outcome is visible without a
/// debugger attached.
/// </summary>
internal sealed class DesktopEmbedService
{
    public sealed record Bounds(int X, int Y, int Width, int Height);

    private const uint WM_SPAWN_WORKERW = 0x052C;

    private readonly object _gate = new();
    private IntPtr _hwnd;
    private IntPtr _embedParent;
    private System.Windows.Threading.DispatcherTimer? _maintenance;

    /// <summary>True once SetParent into the shell succeeded and the surface is visible.</summary>
    public bool IsEmbedded { get; private set; }

    /// <summary>"SysListView32" or "Progman-raised" — whichever strategy is currently active.</summary>
    public string? ActiveStrategy { get; private set; }

    public void Attach(IntPtr hwnd)
    {
        _hwnd = hwnd;
    }

    /// <summary>
    /// The host's current on-screen bounds (works whether it's currently floating/undocked
    /// or already embedded — <c>GetWindowRect</c> always returns screen coordinates regardless
    /// of parent). Used so re-embedding after an unlock+resize lands exactly where the user
    /// left it instead of snapping back to <see cref="GetDefaultBounds"/>.
    /// </summary>
    public Bounds? GetCurrentBounds()
    {
        if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
        {
            return null;
        }

        Win32.GetWindowRect(_hwnd, out var rect);
        return new Bounds(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }

    public static Bounds GetDefaultBounds()
    {
        var vx = Win32.GetSystemMetrics(Win32.SM_XVIRTUALSCREEN);
        var vy = Win32.GetSystemMetrics(Win32.SM_YVIRTUALSCREEN);
        var vw = Win32.GetSystemMetrics(Win32.SM_CXVIRTUALSCREEN);
        var vh = Win32.GetSystemMetrics(Win32.SM_CYVIRTUALSCREEN);
        const int w = 420;
        const int h = 260;
        return new Bounds(vx + Math.Max(0, (vw - w) / 2), vy + Math.Max(0, (vh - h) / 2), w, h);
    }

    public bool EmbedToDesktop(Bounds bounds)
    {
        lock (_gate)
        {
            if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
            {
                DiagLog.Write("Embed aborted: host hwnd invalid");
                return false;
            }

            if (IsEmbedded && _embedParent != IntPtr.Zero && IsParentedTo(_hwnd, _embedParent))
            {
                DiagLog.Write($"Embed: already parented to 0x{_embedParent.ToInt64():X} ({ActiveStrategy}) — show + reposition only");
                ShowAt(bounds, parentRelative: true);
                return true;
            }

            var progman = FindProgman();
            DiagLog.Write($"Embed attempt: Progman=0x{progman.ToInt64():X}");
            if (progman == IntPtr.Zero)
            {
                DiagLog.Write("Embed failed: Progman not found");
                return false;
            }

            SpawnWorkerW(progman);

            var defView = FindDefView(progman);
            DiagLog.Write($"Embed attempt: SHELLDLL_DefView=0x{defView.ToInt64():X}");

            var listView = defView != IntPtr.Zero
                ? Win32.FindWindowExW(defView, IntPtr.Zero, "SysListView32", null)
                : IntPtr.Zero;
            DiagLog.Write($"Embed attempt: SysListView32=0x{listView.ToInt64():X}");

            if (listView != IntPtr.Zero && AttachTo(listView, bounds, raisedZOrder: false, defView: IntPtr.Zero))
            {
                ActiveStrategy = "SysListView32";
                IsEmbedded = true;
                DiagLog.Write("Embed SUCCEEDED via SysListView32 (experimental strategy)");
                StartMaintenance(bounds);
                return true;
            }

            DiagLog.Write("SysListView32 strategy unavailable or failed verification — falling back to Progman-raised");
            if (AttachTo(progman, bounds, raisedZOrder: true, defView: defView))
            {
                ActiveStrategy = "Progman-raised";
                IsEmbedded = true;
                DiagLog.Write("Embed SUCCEEDED via Progman-raised (proven fallback)");
                StartMaintenance(bounds);
                return true;
            }

            DiagLog.Write("Embed FAILED: both strategies exhausted");
            IsEmbedded = false;
            ActiveStrategy = null;
            return false;
        }
    }

    /// <summary>
    /// Detaches the host from the desktop shell and restores it as a real top-level window —
    /// still headless/chromeless (no title bar, no system menu, no min/max box), but with a
    /// native sizing border (<c>WS_THICKFRAME</c>) so the OS itself provides the usual 4-edge +
    /// 4-corner resize hit-testing (HTLEFT/HTRIGHT/HTTOP/HTBOTTOM/HTTOPLEFT/etc. via
    /// DefWindowProc), no custom hit-testing needed. Mirrors what live inspection showed
    /// xdiary's "unlocked" state does for its own window (still <c>WS_POPUP</c>, never
    /// converted to <c>WS_CHILD</c>, so screen coordinates keep working). Returns the
    /// on-screen bounds the window ends up at, or null if there was nothing to undock.
    /// </summary>
    public Bounds? Undock()
    {
        lock (_gate)
        {
            StopMaintenance();
            if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
            {
                IsEmbedded = false;
                return null;
            }

            Win32.GetWindowRect(_hwnd, out var rect);
            var screenBounds = new Bounds(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);

            Win32.SetParent(_hwnd, IntPtr.Zero);
            RestoreTopLevelStyle(_hwnd);
            Win32.SetWindowPos(
                _hwnd,
                Win32.HWND_TOP,
                screenBounds.X,
                screenBounds.Y,
                screenBounds.Width,
                screenBounds.Height,
                Win32.SWP_FRAMECHANGED | Win32.SWP_SHOWWINDOW);
            Win32.ShowWindow(_hwnd, Win32.SW_SHOW);
            Win32.SetForegroundWindow(_hwnd);
            ForceRecomposite(_hwnd);

            DiagLog.Write($"Undock: SetParent(null) — restored as top-level window at ({screenBounds.X},{screenBounds.Y}) {screenBounds.Width}x{screenBounds.Height}");

            IsEmbedded = false;
            ActiveStrategy = null;
            _embedParent = IntPtr.Zero;
            return screenBounds;
        }
    }

    private bool AttachTo(IntPtr parent, Bounds bounds, bool raisedZOrder, IntPtr defView)
    {
        PrepareAsChild(_hwnd);

        var local = ScreenToParentClient(parent, bounds);
        Win32.SetParent(_hwnd, parent);
        Win32.SetWindowPos(
            _hwnd,
            IntPtr.Zero,
            local.X,
            local.Y,
            bounds.Width,
            bounds.Height,
            Win32.SWP_NOACTIVATE | Win32.SWP_FRAMECHANGED);

        if (raisedZOrder)
        {
            ApplyRaisedZOrder(_hwnd, defView);
        }
        else
        {
            // Inside SysListView32 there is no DefView to stay under — just make sure we're
            // not accidentally buried behind existing icon items.
            Win32.SetWindowPos(_hwnd, Win32.HWND_TOP, 0, 0, 0, 0, Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
        }

        Win32.ShowWindow(_hwnd, Win32.SW_SHOW);
        ForceRecomposite(_hwnd);

        var ok = IsParentedTo(_hwnd, parent);
        DiagLog.Write($"AttachTo(0x{parent.ToInt64():X}) verified={ok}");
        if (ok)
        {
            _embedParent = parent;
        }

        return ok;
    }

    private void ShowAt(Bounds bounds, bool parentRelative)
    {
        var local = parentRelative && _embedParent != IntPtr.Zero
            ? ScreenToParentClient(_embedParent, bounds)
            : bounds;
        Win32.SetWindowPos(_hwnd, IntPtr.Zero, local.X, local.Y, bounds.Width, bounds.Height, Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE);
        Win32.ShowWindow(_hwnd, Win32.SW_SHOW);
        ForceRecomposite(_hwnd);
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
            if (!IsEmbedded || _hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
            {
                return;
            }

            if (_embedParent == IntPtr.Zero || !Win32.IsWindow(_embedParent) || !IsParentedTo(_hwnd, _embedParent))
            {
                DiagLog.Write("Maintenance: parent stale (Explorer likely recreated it) — re-embedding");
                IsEmbedded = false;
                EmbedToDesktop(bounds);
            }
        };
        _maintenance.Start();
    }

    private void StopMaintenance()
    {
        _maintenance?.Stop();
        _maintenance = null;
    }

    private static void PrepareAsChild(IntPtr hwnd)
    {
        var style = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE).ToInt64();
        style |= Win32.WS_CHILD | Win32.WS_VISIBLE;
        style &= ~unchecked((long)Win32.WS_POPUP);
        style &= ~(Win32.WS_CAPTION | Win32.WS_SYSMENU | Win32.WS_MINIMIZEBOX | Win32.WS_MAXIMIZEBOX | Win32.WS_THICKFRAME);
        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE, new IntPtr(style));
    }

    /// <summary>
    /// Inverse of <see cref="PrepareAsChild"/> — top-level again (no WS_CHILD), headless (no
    /// caption/sysmenu/min/max box — <see cref="DesktopHostWindow"/> stays chromeless), but
    /// with <c>WS_THICKFRAME</c> so the native sizing border still works on all 4 edges/corners.
    /// </summary>
    private static void RestoreTopLevelStyle(IntPtr hwnd)
    {
        var style = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE).ToInt64();
        style &= ~unchecked((long)Win32.WS_CHILD);
        style &= ~(Win32.WS_CAPTION | Win32.WS_SYSMENU | Win32.WS_MINIMIZEBOX | Win32.WS_MAXIMIZEBOX);
        style |= Win32.WS_POPUP | Win32.WS_VISIBLE | Win32.WS_THICKFRAME;
        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE, new IntPtr(style));
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

    private static bool IsParentedTo(IntPtr hwnd, IntPtr expected)
    {
        if (hwnd == IntPtr.Zero || expected == IntPtr.Zero)
        {
            return false;
        }

        var ancestor = Win32.GetAncestor(hwnd, Win32.GA_PARENT);
        return ancestor == expected || Win32.GetParent(hwnd) == expected;
    }

    private static void ApplyRaisedZOrder(IntPtr hwnd, IntPtr defView)
    {
        if (defView != IntPtr.Zero)
        {
            // Keep icons above the calendar; place our window immediately below DefView.
            Win32.SetWindowPos(defView, Win32.HWND_TOP, 0, 0, 0, 0, Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
            Win32.SetWindowPos(hwnd, defView, 0, 0, 0, 0, Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
        }
        else
        {
            Win32.SetWindowPos(hwnd, Win32.HWND_BOTTOM, 0, 0, 0, 0, Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
        }
    }

    private static void ForceRecomposite(IntPtr hwnd)
    {
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
            /* best-effort repaint nudge */
        }
    }

    private static IntPtr FindProgman()
    {
        var hwnd = Win32.FindWindowW("Progman", "Program Manager");
        return hwnd != IntPtr.Zero ? hwnd : Win32.FindWindowW("Progman", null);
    }

    private static void SpawnWorkerW(IntPtr progman)
    {
        if (progman == IntPtr.Zero)
        {
            return;
        }

        // Classic raise-desktop message, plus the newer variants some shells (dynamic
        // wallpaper etc.) require to actually create/expose a WorkerW.
        Win32.SendMessageTimeoutW(progman, WM_SPAWN_WORKERW, IntPtr.Zero, IntPtr.Zero, Win32.SMTO_NORMAL, 1000, out _);
        Win32.SendMessageTimeoutW(progman, WM_SPAWN_WORKERW, new IntPtr(0xD), IntPtr.Zero, Win32.SMTO_NORMAL, 1000, out _);
        Win32.SendMessageTimeoutW(progman, WM_SPAWN_WORKERW, new IntPtr(0xD), new IntPtr(1), Win32.SMTO_NORMAL, 1000, out _);
    }

    /// <summary>
    /// Resolves SHELLDLL_DefView across both known shell layouts: modern (DefView directly
    /// under Progman, or under a WorkerW that is itself a child of Progman) and classic
    /// (DefView under a top-level WorkerW that is a sibling of Progman).
    /// </summary>
    private static IntPtr FindDefView(IntPtr progman)
    {
        var direct = Win32.FindWindowExW(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (direct != IntPtr.Zero)
        {
            return direct;
        }

        IntPtr child = IntPtr.Zero;
        while (true)
        {
            child = Win32.FindWindowExW(progman, child, "WorkerW", null);
            if (child == IntPtr.Zero)
            {
                break;
            }

            var underChild = Win32.FindWindowExW(child, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (underChild != IntPtr.Zero)
            {
                return underChild;
            }
        }

        IntPtr result = IntPtr.Zero;
        Win32.EnumWindows((top, _) =>
        {
            if (Win32.GetWindowClassName(top) != "WorkerW")
            {
                return true;
            }

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
}
