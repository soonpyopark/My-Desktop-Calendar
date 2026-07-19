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
/// A second live capture of xdiary (watching its window styles/rects while its own
/// position/size-adjustment buttons were clicked) showed it never switches to
/// <c>WS_CHILD</c> even while <c>SetParent</c>'d into <c>SysListView32</c> — it stays
/// <c>WS_POPUP</c> throughout, embedded or not, and just calls plain <c>SetWindowPos</c> with
/// absolute screen coordinates to move/resize in place. This mirrors that: the host is
/// <c>WS_POPUP</c> in every state (see <see cref="PrepareEmbeddedStyle"/>), so
/// <see cref="Reposition"/> can move/resize it live while embedded — no undock round-trip
/// needed just to change position or size.
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
    /// The host's current on-screen bounds, in terms of its <em>content</em> (client) area —
    /// deliberately <c>GetClientRect</c> + <c>ClientToScreen</c> rather than
    /// <c>GetWindowRect</c>, so this means the same thing whether the window is currently
    /// embedded (no border, client == window rect) or floating (has the <c>WS_THICKFRAME</c>
    /// resize border added by <see cref="RestoreTopLevelStyle"/>, so the window rect is bigger
    /// than the client rect). Used so re-embedding after an unlock+resize lands exactly where
    /// the user left it, at the same content size, instead of snapping back to
    /// <see cref="GetDefaultBounds"/> or shrinking/growing by the border thickness. Also the
    /// basis <see cref="Reposition"/> nudges from, so the position/size stepper buttons always
    /// read back the true current content bounds regardless of embed state.
    /// </summary>
    public Bounds? GetCurrentBounds()
    {
        if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
        {
            return null;
        }

        Win32.GetClientRect(_hwnd, out var client);
        var origin = new Win32.POINT { X = 0, Y = 0 };
        Win32.ClientToScreen(_hwnd, ref origin);
        return new Bounds(origin.X, origin.Y, client.Right - client.Left, client.Bottom - client.Top);
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
                ShowAt(bounds);
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
    /// DefWindowProc), no custom hit-testing needed. Returns the on-screen bounds the window
    /// ends up at, or null if there was nothing to undock.
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

            // Captured while still embedded (headless, no border), so this is exactly the
            // content size the user had on the desktop — the size Undock must preserve.
            Win32.GetWindowRect(_hwnd, out var rect);
            var contentBounds = new Bounds(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);

            Win32.SetParent(_hwnd, IntPtr.Zero);
            RestoreTopLevelStyle(_hwnd);

            // RestoreTopLevelStyle just added WS_THICKFRAME, which (unlike the borderless
            // embedded state) eats into the window rect to make room for the resize border —
            // if we positioned the window at contentBounds directly, the visible content would
            // shrink by the border thickness. Growing the window rect outward (via
            // AdjustWindowRectExForDpi, so the *content* stays contentBounds and the border is
            // added on top of that) is what "unlock adds a border without shrinking" means.
            var windowRect = ContentToWindowRect(_hwnd, contentBounds);

            Win32.SetWindowPos(
                _hwnd,
                Win32.HWND_TOP,
                windowRect.X,
                windowRect.Y,
                windowRect.Width,
                windowRect.Height,
                Win32.SWP_FRAMECHANGED | Win32.SWP_SHOWWINDOW);
            Win32.ShowWindow(_hwnd, Win32.SW_SHOW);
            Win32.SetForegroundWindow(_hwnd);
            ForceRecomposite(_hwnd);

            DiagLog.Write(
                $"Undock: SetParent(null) — content preserved at {contentBounds.Width}x{contentBounds.Height}, " +
                $"window grown to ({windowRect.X},{windowRect.Y}) {windowRect.Width}x{windowRect.Height} for the border");

            IsEmbedded = false;
            ActiveStrategy = null;
            _embedParent = IntPtr.Zero;
            return windowRect;
        }
    }

    /// <summary>Grows <paramref name="content"/> outward to the window rect needed so that,
    /// once positioned there, <c>hwnd</c>'s client area ends up exactly matching
    /// <paramref name="content"/> under its *current* style/DPI (call after any style change,
    /// e.g. after <see cref="RestoreTopLevelStyle"/>). When the window has no non-client area
    /// (the normal headless-embedded style from <see cref="PrepareEmbeddedStyle"/> — no
    /// caption, no thick frame), <c>AdjustWindowRectEx</c> has nothing to add and this is a
    /// no-op, so <see cref="Reposition"/> can call it unconditionally in either state.</summary>
    private static Bounds ContentToWindowRect(IntPtr hwnd, Bounds content)
    {
        // Style/ex-style are DWORDs with the high bit potentially set (e.g. WS_POPUP =
        // 0x80000000) — IntPtr.ToInt32() throws OverflowException on those, since it checks
        // signed Int32 range. unchecked((int)...ToInt64()) just reinterprets the same 32 bits
        // (same trick PrepareEmbeddedStyle/RestoreTopLevelStyle use via long, just cast one
        // step further down to the int AdjustWindowRectEx's signature expects).
        var style = unchecked((int)Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE).ToInt64());
        var exStyle = unchecked((int)Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE).ToInt64());
        var rect = new Win32.RECT
        {
            Left = content.X,
            Top = content.Y,
            Right = content.X + content.Width,
            Bottom = content.Y + content.Height,
        };

        var dpi = Win32.GetDpiForWindow(hwnd);
        var adjusted = dpi > 0
            ? Win32.AdjustWindowRectExForDpi(ref rect, style, false, exStyle, dpi)
            : Win32.AdjustWindowRectEx(ref rect, style, false, exStyle);

        if (!adjusted)
        {
            return content;
        }

        return new Bounds(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }

    private bool AttachTo(IntPtr parent, Bounds bounds, bool raisedZOrder, IntPtr defView)
    {
        PrepareEmbeddedStyle(_hwnd);

        Win32.SetParent(_hwnd, parent);
        // Still WS_POPUP (never WS_CHILD) even after SetParent — confirmed by live-capturing
        // xdiary's own embedded window, which stays WS_POPUP the whole time it's parented into
        // SysListView32. A WS_POPUP window keeps interpreting SetWindowPos coordinates as
        // absolute screen coordinates regardless of its parent, so bounds needs no
        // parent-relative conversion here (and, more importantly, none later either — see
        // Reposition — which is what lets position/size change while staying embedded).
        Win32.SetWindowPos(
            _hwnd,
            IntPtr.Zero,
            bounds.X,
            bounds.Y,
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

    private void ShowAt(Bounds bounds)
    {
        Win32.SetWindowPos(_hwnd, IntPtr.Zero, bounds.X, bounds.Y, bounds.Width, bounds.Height, Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE);
        Win32.ShowWindow(_hwnd, Win32.SW_SHOW);
        ForceRecomposite(_hwnd);
    }

    /// <summary>
    /// Moves/resizes the host in place to <paramref name="contentBounds"/> — the same
    /// technique live-captured from xdiary's own position/size stepper buttons: plain
    /// <c>SetWindowPos</c> with absolute screen coordinates, called directly on the
    /// still-<c>WS_POPUP</c> host with no <c>SetParent</c>/style dance beforehand. Works
    /// whether currently embedded or floating — no <see cref="Undock"/> round-trip required
    /// just to change position or size. Goes through <see cref="ContentToWindowRect"/> so
    /// <paramref name="contentBounds"/> always means the visible content size (matching
    /// <see cref="GetCurrentBounds"/>), border or not.
    /// </summary>
    public bool Reposition(Bounds contentBounds)
    {
        lock (_gate)
        {
            if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
            {
                return false;
            }

            var windowRect = ContentToWindowRect(_hwnd, contentBounds);
            Win32.SetWindowPos(
                _hwnd,
                IntPtr.Zero,
                windowRect.X,
                windowRect.Y,
                windowRect.Width,
                windowRect.Height,
                Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE);
            ForceRecomposite(_hwnd);
            DiagLog.Write(
                $"Reposition: content -> ({contentBounds.X},{contentBounds.Y}) " +
                $"{contentBounds.Width}x{contentBounds.Height} (embedded={IsEmbedded})");
            return true;
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

    /// <summary>
    /// Headless embedded look — no caption/sysmenu/min-max box/thick frame — but deliberately
    /// keeps <c>WS_POPUP</c> rather than switching to <c>WS_CHILD</c>. Live-capturing xdiary's
    /// own embedded window showed it does the same: stays <c>WS_POPUP</c> the whole time it's
    /// <c>SetParent</c>'d into <c>SysListView32</c>, which is what lets <see cref="Reposition"/>
    /// move/resize it later using plain absolute screen coordinates, embedded or not.
    /// </summary>
    private static void PrepareEmbeddedStyle(IntPtr hwnd)
    {
        var style = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE).ToInt64();
        style |= Win32.WS_POPUP | Win32.WS_VISIBLE;
        style &= ~unchecked((long)Win32.WS_CHILD);
        style &= ~(Win32.WS_CAPTION | Win32.WS_SYSMENU | Win32.WS_MINIMIZEBOX | Win32.WS_MAXIMIZEBOX | Win32.WS_THICKFRAME);
        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE, new IntPtr(style));
    }

    /// <summary>
    /// Same headless look as <see cref="PrepareEmbeddedStyle"/>, plus <c>WS_THICKFRAME</c> so
    /// the native sizing border works on all 4 edges/corners once floating (no title bar,
    /// system menu, or min/max box — <see cref="DesktopHostWindow"/> stays chromeless either
    /// way).
    /// </summary>
    private static void RestoreTopLevelStyle(IntPtr hwnd)
    {
        var style = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE).ToInt64();
        style &= ~unchecked((long)Win32.WS_CHILD);
        style &= ~(Win32.WS_CAPTION | Win32.WS_SYSMENU | Win32.WS_MINIMIZEBOX | Win32.WS_MAXIMIZEBOX);
        style |= Win32.WS_POPUP | Win32.WS_VISIBLE | Win32.WS_THICKFRAME;
        Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_STYLE, new IntPtr(style));
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
