using System.Linq;
using System.Text.Json.Nodes;
using System.Windows.Threading;
using MyDesktopCalendar.Native;

namespace MyDesktopCalendar.Services;

/// <summary>
/// While embedded, DefView steals clicks. Poll cursor + LMB for:
/// - undock zones (single click → window mode)
/// - UI action zones (single click → temp unlock, or full unlock for search)
/// - day cells (double-click → create event)
/// - event bars (double-click → edit event)
/// </summary>
internal sealed class UndockZoneMonitor
{
    private const int DoubleClickMs = 500;

    private readonly DesktopEmbedService _embed;
    private readonly Action _showWindow;
    private readonly Action<string> _onCreateDoubleClick;
    private readonly Action<string, string> _onEditDoubleClick;
    private readonly Action<string> _onUiActionClick;
    private readonly Func<IntPtr> _getHwnd;
    private readonly DispatcherTimer _timer;
    private readonly object _gate = new();

    private List<ClientRect> _undockZones = [];
    private List<UiActionZone> _uiActionZones = [];
    private List<CreateZone> _createZones = [];
    private List<EditZone> _editZones = [];
    private bool _wasDown;
    private ZoneClick? _lastZoneClick;

    // Overlays that Header.jsx deliberately no-ops on its own onClick while embedded
    // (see OVERLAY_UI_ACTIONS in Header.jsx) — these still need this poll to reach
    // SuspendForUi even under the SysListView32/WS_POPUP path. Every other UI action
    // (chrome nav: prev/next/today/view-mode/etc.) always runs its React onClick
    // handler locally *and* calls suspendDesktopEmbedForUi itself — under native click
    // passthrough that already fires once from the real click, so leaving those zones
    // active here too double-applies the action (e.g. "next" advancing two months).
    // "settings", "search", "auth", "export-excel", and "export-pdf" are exceptions:
    // under popup-style embed, Header.jsx's own onClick now opens/runs each of them in
    // place directly (see withUiSuspend's IN_PLACE_UI_ACTIONS branch), so all five are
    // excluded from the popup-style-embed filter below — leaving any of them here too
    // made this same real click *also* reach SuspendForUi, which unlocks a second,
    // independent overlay on the App window in parallel (visible as the window briefly
    // "shrinking", and needing two X-clicks to fully close since DesktopHost's own
    // panel state was never told to close).
    private static readonly HashSet<string> NativeOnlyUiActions = new(StringComparer.OrdinalIgnoreCase)
    {
        "settings", "search", "auth", "export-excel", "export-pdf",
    };

    // Every popup-style-embed overlay is now handled in place by Header.jsx's own
    // onClick (see IN_PLACE_UI_ACTIONS there) — nothing left needs this native-only
    // fallback under that path. Kept as an explicit (currently empty) allow-list rather
    // than deleting the filter outright, so a future overlay that still needs it has an
    // obvious place to be added back.
    private static readonly HashSet<string> PopupStyleEmbedNativeOnlyUiActions = new(StringComparer.OrdinalIgnoreCase);

    private readonly record struct ClientRect(int X, int Y, int Width, int Height);
    private readonly record struct UiActionZone(int X, int Y, int Width, int Height, string Action);
    private readonly record struct CreateZone(int X, int Y, int Width, int Height, string DateKey);
    private readonly record struct EditZone(int X, int Y, int Width, int Height, string EventId, string DayKey);
    private readonly record struct ZoneClick(string Key, long AtMs);

    public UndockZoneMonitor(
        DesktopEmbedService embed,
        Func<IntPtr> getHwnd,
        Action showWindow,
        Action<string> onCreateDoubleClick,
        Action<string, string> onEditDoubleClick,
        Action<string> onUiActionClick)
    {
        _embed = embed;
        _getHwnd = getHwnd;
        _showWindow = showWindow;
        _onCreateDoubleClick = onCreateDoubleClick;
        _onEditDoubleClick = onEditDoubleClick;
        _onUiActionClick = onUiActionClick;
        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(32) };
        _timer.Tick += OnTick;
        _timer.Start();
    }

    public void SetZones(JsonObject? body)
    {
        lock (_gate)
        {
            _undockZones = ParseUndockZones(body);
        }
    }

    public void Clear()
    {
        lock (_gate)
        {
            _undockZones = [];
        }
    }

    public void SetUiActionZones(JsonObject? body)
    {
        lock (_gate)
        {
            _uiActionZones = ParseUiActionZones(body);
            DebugLog($"SetUiActionZones: count={_uiActionZones.Count} embedded={_embed.IsEmbedded}");
        }
    }

    public void ClearUiActionZones()
    {
        lock (_gate)
        {
            _uiActionZones = [];
        }
    }

    public void SetCreateZones(JsonObject? body)
    {
        lock (_gate)
        {
            _createZones = ParseCreateZones(body);
        }
    }

    public void ClearCreateZones()
    {
        lock (_gate)
        {
            _createZones = [];
        }
    }

    public void SetEditZones(JsonObject? body)
    {
        lock (_gate)
        {
            _editZones = ParseEditZones(body);
        }
    }

    public void ClearEditZones()
    {
        lock (_gate)
        {
            _editZones = [];
        }
    }

    private void OnTick(object? sender, EventArgs e)
    {
        List<ClientRect> undock;
        List<UiActionZone> uiActions;
        List<CreateZone> create;
        List<EditZone> edit;
        lock (_gate)
        {
            undock = _undockZones;
            uiActions = _uiActionZones;
            // SysListView32/WS_POPUP embed (see DesktopEmbedService.IsPopupStyleEmbed):
            // real native double-clicks already reach the day cell / event bar directly
            // through React's own onDoubleClick, unlike the WS_CHILD Progman/WorkerW
            // paths this polling loop was built for. Leaving these zones active here too
            // would double-fire create/edit on every double-click. Undock/UI-action zones
            // are left untouched — those aren't otherwise reachable natively yet.
            create = _embed.IsPopupStyleEmbed ? [] : _createZones;
            edit = _embed.IsPopupStyleEmbed ? [] : _editZones;
        }

        var embedded = _embed.IsEmbedded;
        // Undock + header UI zones only while embedded (DefView steals those clicks).
        // Create/edit zones still apply during temporary unlock so double-click works.
        // In window mode, React onClick handles header buttons — firing UI zones too
        // would double-advance month/year navigation.
        // SysListView32/WS_POPUP embed: real clicks reach React directly, so drop every
        // zone except the deliberately-no-op overlay actions (see NativeOnlyUiActions) —
        // otherwise this poll double-applies chrome-nav clicks (prev/next skipping a
        // month/week) the same way it used to double-apply create/edit above. "settings"
        // is further excluded here (see PopupStyleEmbedNativeOnlyUiActions) since
        // Header.jsx already opens it in place from the real click under this mode.
        List<UiActionZone> activeUiActions = embedded
            ? (_embed.IsPopupStyleEmbed ? uiActions.Where(z => PopupStyleEmbedNativeOnlyUiActions.Contains(z.Action)).ToList() : uiActions)
            : [];
        if (!embedded)
        {
            undock = [];
            if (activeUiActions.Count == 0 && create.Count == 0 && edit.Count == 0)
            {
                _wasDown = false;
                _lastZoneClick = null;
                // Idle window mode: don't burn UI thread at ~30Hz while the user resizes.
                SetPollingInterval(250);
                return;
            }
        }

        if (undock.Count == 0 && activeUiActions.Count == 0 && create.Count == 0 && edit.Count == 0)
        {
            SetPollingInterval(250);
            return;
        }

        SetPollingInterval(32);

        var hwnd = _getHwnd();
        if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd))
        {
            return;
        }

        if (!Win32.GetCursorPos(out var cursor))
        {
            return;
        }

        var down = (Win32.GetAsyncKeyState(0x01) & 0x8000) != 0;
        var clicked = down && !_wasDown;
        _wasDown = down;
        if (!clicked)
        {
            return;
        }

        // Global mouse polling still fires when Explorer/other apps cover the calendar.
        // Only honor clicks when the calendar surface is actually exposed.
        var exposed = IsCalendarSurfaceExposed(hwnd, cursor, embedded);
        DebugLog($"click cursor=({cursor.X},{cursor.Y}) embedded={embedded} exposed={exposed} undock={undock.Count} ui={activeUiActions.Count} create={create.Count} edit={edit.Count}");
        if (!exposed)
        {
            _lastZoneClick = null;
            return;
        }

        if (!Win32.GetWindowRect(hwnd, out var windowRect))
        {
            DebugLog("click: GetWindowRect failed");
            return;
        }

        var origin = new Win32.POINT { X = 0, Y = 0 };
        if (!Win32.ClientToScreen(hwnd, ref origin))
        {
            origin.X = windowRect.Left;
            origin.Y = windowRect.Top;
        }

        var localX = cursor.X - origin.X;
        var localY = cursor.Y - origin.Y;
        DebugLog($"click local=({localX},{localY}) origin=({origin.X},{origin.Y}) uiZones=[{string.Join(", ", activeUiActions.Select(z => $"{z.Action}:({z.X},{z.Y},{z.Width},{z.Height})"))}]");

        foreach (var zone in undock)
        {
            if (!Contains(zone.X, zone.Y, zone.Width, zone.Height, localX, localY))
            {
                continue;
            }

            _lastZoneClick = null;
            _showWindow();
            return;
        }

        foreach (var zone in activeUiActions)
        {
            if (!Contains(zone.X, zone.Y, zone.Width, zone.Height, localX, localY))
            {
                continue;
            }

            _lastZoneClick = null;
            _onUiActionClick(zone.Action);
            return;
        }

        // Event bars sit on top of day cells — prefer edit over create.
        foreach (var zone in edit)
        {
            if (!Contains(zone.X, zone.Y, zone.Width, zone.Height, localX, localY))
            {
                continue;
            }

            HandleDoubleClick($"edit:{zone.EventId}:{zone.DayKey}", () =>
            {
                _onEditDoubleClick(zone.EventId, zone.DayKey);
            });
            return;
        }

        foreach (var zone in create)
        {
            if (!Contains(zone.X, zone.Y, zone.Width, zone.Height, localX, localY))
            {
                continue;
            }

            HandleDoubleClick($"create:{zone.DateKey}", () =>
            {
                _onCreateDoubleClick(zone.DateKey);
            });
            return;
        }

        DebugLog("click: no zone matched");
        _lastZoneClick = null;
    }

    private static void DebugLog(string message)
    {
        try
        {
            var path = System.IO.Path.Combine(AppContext.BaseDirectory, "zone-diag.txt");
            System.IO.File.AppendAllText(path, $"[{DateTime.Now:HH:mm:ss.fff}] {message}\r\n");
        }
        catch
        {
            /* ignore */
        }
    }

    /// <summary>
    /// Embedded calendar sits under SHELLDLL_DefView, so hit-tests go to the desktop shell
    /// even when the widget is painted. Accept those only while embedded and the top-level
    /// window under the cursor is Progman/WorkerW. Any other top-level window (Explorer,
    /// browsers, …) means the calendar is covered — ignore the click.
    /// </summary>
    private static bool IsCalendarSurfaceExposed(IntPtr ourHwnd, Win32.POINT screenPoint, bool embedded)
    {
        var hit = Win32.WindowFromPoint(screenPoint);
        if (hit == IntPtr.Zero)
        {
            return false;
        }

        // Window mode / temporary unlock: only our HWND (or WebView children).
        if (hit == ourHwnd || Win32.IsChild(ourHwnd, hit))
        {
            return true;
        }

        // DesktopTransitionCover's freeze-frame overlay is purely cosmetic and only ever
        // placed exactly over DesktopHost's own bounds — treat a hit on it the same as a hit
        // on the calendar itself, otherwise a click landing during its brief ~320ms hold
        // (e.g. the first shell-embed transition) gets silently dropped as "covered" even
        // though nothing actually obstructs the calendar underneath it.
        if (hit == DesktopTransitionCover.CurrentCoverHwnd)
        {
            return true;
        }

        if (!embedded)
        {
            return false;
        }

        // Desktop mode: DefView steals hit-testing. Allow only when the top-level
        // surface under the cursor is the desktop shell (not Explorer/other apps).
        var root = Win32.GetAncestor(hit, Win32.GA_ROOT);
        if (root == IntPtr.Zero)
        {
            root = hit;
        }

        var rootClass = Win32.GetWindowClassName(root);
        var ok = rootClass is "Progman" or "WorkerW";
        if (!ok)
        {
            DebugLog($"exposed-check: hit={hit} root={root} rootClass='{rootClass}' -> rejected");
        }

        return ok;
    }

    private void HandleDoubleClick(string key, Action onDouble)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (_lastZoneClick is { } prev
            && prev.Key == key
            && now - prev.AtMs <= DoubleClickMs)
        {
            _lastZoneClick = null;
            onDouble();
            return;
        }

        _lastZoneClick = new ZoneClick(key, now);
    }

    private void SetPollingInterval(int milliseconds)
    {
        var next = TimeSpan.FromMilliseconds(milliseconds);
        if (_timer.Interval == next)
        {
            return;
        }

        _timer.Interval = next;
    }

    private static bool Contains(int x, int y, int w, int h, int px, int py) =>
        px >= x && px < x + w && py >= y && py < y + h;

    private static List<ClientRect> ParseUndockZones(JsonObject? body)
    {
        if (!TryGetRectObjects(body, out var objs))
        {
            return [];
        }

        var list = new List<ClientRect>();
        foreach (var obj in objs)
        {
            if (TryReadRect(obj, out var x, out var y, out var w, out var h))
            {
                list.Add(new ClientRect(x, y, w, h));
            }
        }

        return list;
    }

    private static List<UiActionZone> ParseUiActionZones(JsonObject? body)
    {
        if (!TryGetRectObjects(body, out var objs))
        {
            return [];
        }

        var list = new List<UiActionZone>();
        foreach (var obj in objs)
        {
            if (!TryReadRect(obj, out var x, out var y, out var w, out var h))
            {
                continue;
            }

            var action = obj["action"]?.GetValue<string>()?.Trim().ToLowerInvariant() ?? "";
            if (action.Length == 0 || action.Length > 64)
            {
                continue;
            }

            var valid = true;
            foreach (var ch in action)
            {
                if (ch is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-')
                {
                    continue;
                }

                valid = false;
                break;
            }

            if (!valid)
            {
                continue;
            }

            list.Add(new UiActionZone(x, y, w, h, action));
        }

        return list;
    }

    private static List<CreateZone> ParseCreateZones(JsonObject? body)
    {
        if (!TryGetRectObjects(body, out var objs))
        {
            return [];
        }

        var list = new List<CreateZone>();
        foreach (var obj in objs)
        {
            if (!TryReadRect(obj, out var x, out var y, out var w, out var h))
            {
                continue;
            }

            var dateKey = obj["dateKey"]?.GetValue<string>()?.Trim() ?? "";
            if (!IsDateKey(dateKey))
            {
                continue;
            }

            list.Add(new CreateZone(x, y, w, h, dateKey));
        }

        return list;
    }

    private static List<EditZone> ParseEditZones(JsonObject? body)
    {
        if (!TryGetRectObjects(body, out var objs))
        {
            return [];
        }

        var list = new List<EditZone>();
        foreach (var obj in objs)
        {
            if (!TryReadRect(obj, out var x, out var y, out var w, out var h))
            {
                continue;
            }

            var eventId = obj["eventId"]?.GetValue<string>()?.Trim() ?? "";
            var dayKey = obj["dayKey"]?.GetValue<string>()?.Trim() ?? "";
            if (eventId.Length == 0 || !IsDateKey(dayKey))
            {
                continue;
            }

            list.Add(new EditZone(x, y, w, h, eventId, dayKey));
        }

        return list;
    }

    private static bool TryGetRectObjects(JsonObject? body, out List<JsonObject> objs)
    {
        objs = [];
        if (body is null || body.Count == 0)
        {
            return false;
        }

        if (body["clientRect"] is null && body["clientRects"] is null && body["zones"] is null)
        {
            return false;
        }

        if (body["clientRects"] is JsonArray arr)
        {
            foreach (var node in arr)
            {
                if (node is JsonObject obj)
                {
                    objs.Add(obj);
                }
            }
        }
        else if (body["zones"] is JsonArray zones)
        {
            foreach (var node in zones)
            {
                if (node is JsonObject obj)
                {
                    objs.Add(obj);
                }
            }
        }
        else if (body["clientRect"] is JsonObject single)
        {
            objs.Add(single);
        }

        return objs.Count > 0;
    }

    private static bool TryReadRect(JsonObject obj, out int x, out int y, out int w, out int h)
    {
        x = ReadInt(obj, "left", ReadInt(obj, "x", int.MinValue));
        y = ReadInt(obj, "top", ReadInt(obj, "y", int.MinValue));
        w = ReadInt(obj, "width", 0);
        h = ReadInt(obj, "height", 0);
        return x != int.MinValue && y != int.MinValue && w > 0 && h > 0;
    }

    private static int ReadInt(JsonObject obj, string key, int fallback)
    {
        if (obj[key] is JsonValue value)
        {
            if (value.TryGetValue<int>(out var i))
            {
                return i;
            }

            if (value.TryGetValue<double>(out var d))
            {
                return (int)Math.Round(d);
            }
        }

        return fallback;
    }

    private static bool IsDateKey(string key) =>
        key.Length == 10
        && key[4] == '-'
        && key[7] == '-'
        && int.TryParse(key.AsSpan(0, 4), out _)
        && int.TryParse(key.AsSpan(5, 2), out _)
        && int.TryParse(key.AsSpan(8, 2), out _);
}
