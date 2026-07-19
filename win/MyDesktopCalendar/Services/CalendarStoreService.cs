using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Ports the Electron `calendarStore.js` on-disk format to Windows: one `data/settings.json`
/// file plus one `data/calendars/{dataKey}.json` file per calendar (calendar + its events).
/// Events use a flexible/dynamic schema, so the whole store is modeled with
/// <see cref="JsonObject"/>/<see cref="JsonArray"/> rather than fixed POCOs.
/// </summary>
internal sealed class CalendarStoreService
{
    private const int StoreFormatVersion = 2;
    private const int CalendarFileVersion = 1;
    private const string LegacyStoreFilename = "calendar-store.json";

    private static readonly JsonSerializerOptions WriteOptions = JsonUtil.Indented;

    private static readonly HashSet<string> BuiltinCalendarIds =
        new(DefaultCalendarsArray().Select(c => GetString((JsonObject)c!, "id")));

    private readonly string _dataRoot;
    private readonly object _writeLock = new();

    public CalendarStoreService(string dataRoot)
    {
        _dataRoot = dataRoot;
        Directory.CreateDirectory(_dataRoot);
        Directory.CreateDirectory(CalendarsDirPath);
        MigrateLegacyStoreIfNeeded();
        if (!File.Exists(SettingsPath))
        {
            WriteSettingsFile(CreateDefaultSettings());
        }

        ApplyHolidayKeyFromEnvIfNeeded();
        EnsureDefaultTags();
        ReadStore();
        EnsureBuiltinCalendars();
    }

    /// <summary>
    /// Assign <c>ownerLoginId</c> on legacy calendars/events (bootstrap admin) and ensure
    /// every active member has at least one personal calendar. Call after <see cref="AuthService"/> is ready.
    /// </summary>
    public void EnsureMemberOwnership(string bootstrapAdminId, IEnumerable<string>? memberLoginIds = null)
    {
        var adminId = (bootstrapAdminId ?? "").Trim();
        if (adminId.Length == 0) adminId = AppConstants.DefaultAdminId;

        var store = ReadStore();
        var calendars = GetArray(store, "calendars") ?? new JsonArray();
        var events = GetArray(store, "events") ?? new JsonArray();
        var changed = false;

        foreach (var node in calendars)
        {
            if (node is not JsonObject cal) continue;
            var id = GetString(cal, "id");
            if (string.Equals(id, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
            {
                if (cal.ContainsKey("ownerLoginId"))
                {
                    cal.Remove("ownerLoginId");
                    changed = true;
                }
                continue;
            }

            var owner = GetStringOrNull(cal, "ownerLoginId")?.Trim();
            if (string.IsNullOrEmpty(owner))
            {
                cal["ownerLoginId"] = adminId;
                changed = true;
            }
        }

        var calendarOwner = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var node in calendars)
        {
            if (node is not JsonObject cal) continue;
            var id = GetString(cal, "id");
            if (id.Length == 0) continue;
            if (string.Equals(id, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal)) continue;
            calendarOwner[id] = GetStringOrNull(cal, "ownerLoginId")?.Trim() ?? adminId;
        }

        foreach (var node in events)
        {
            if (node is not JsonObject ev) continue;
            var calId = GetString(ev, "calendarId");
            if (string.Equals(calId, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
            {
                if (ev.ContainsKey("ownerLoginId"))
                {
                    ev.Remove("ownerLoginId");
                    changed = true;
                }
                continue;
            }

            var owner = GetStringOrNull(ev, "ownerLoginId")?.Trim();
            if (string.IsNullOrEmpty(owner))
            {
                ev["ownerLoginId"] = calendarOwner.TryGetValue(calId, out var fromCal) ? fromCal : adminId;
                changed = true;
            }
        }

        if (GetObject(store, "settings") is JsonObject ownershipSettings)
        {
            var before = ownershipSettings.ToJsonString();
            EnsureDayColorsMigrated(ownershipSettings, adminId);
            EnsureHiddenCalendarsMigrated(ownershipSettings, calendars, adminId);
            if (!string.Equals(before, ownershipSettings.ToJsonString(), StringComparison.Ordinal))
            {
                store["settings"] = ownershipSettings;
                changed = true;
            }
        }

        // Canonical calendar.visible is always true on disk; personal hide lives in settings.
        foreach (var node in calendars)
        {
            if (node is not JsonObject cal) continue;
            if (!GetBool(cal, "visible", true))
            {
                cal["visible"] = true;
                changed = true;
            }
        }

        if (changed)
        {
            store["calendars"] = calendars;
            store["events"] = events;
            WriteStore(store);
        }

        EnsurePersonalCalendar(adminId, displayName: null, hideForAdminLoginId: adminId);

        if (memberLoginIds is not null)
        {
            foreach (var loginId in memberLoginIds)
            {
                var id = (loginId ?? "").Trim();
                if (id.Length > 0) EnsurePersonalCalendar(id, displayName: null, hideForAdminLoginId: adminId);
            }
        }
    }

    /// <summary>Idempotent: create a personal calendar for <paramref name="loginId"/> if none exists.</summary>
    /// <param name="hideForAdminLoginId">
    /// When creating a calendar owned by someone other than this admin, hide it for the admin by default
    /// (eye-toggle off in 회원 캘린더).
    /// </param>
    public JsonObject EnsurePersonalCalendar(string loginId, string? displayName, string? hideForAdminLoginId = null)
    {
        var owner = (loginId ?? "").Trim();
        if (owner.Length == 0) throw new InvalidOperationException("로그인 아이디가 필요합니다.");

        var store = ReadStore();
        var calendars = GetArray(store, "calendars") ?? new JsonArray();
        foreach (var node in calendars)
        {
            if (node is not JsonObject cal) continue;
            if (string.Equals(GetString(cal, "id"), AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
            {
                continue;
            }

            if (string.Equals(GetStringOrNull(cal, "ownerLoginId"), owner, StringComparison.OrdinalIgnoreCase))
            {
                return CloneDetached(cal);
            }
        }

        var label = (displayName ?? "").Trim();
        if (label.Length == 0) label = owner;
        var payload = new JsonObject
        {
            ["id"] = $"cal-{owner.ToLowerInvariant()}",
            ["name"] = $"{label}의 캘린더",
            ["color"] = AppConstants.PrimaryCalendarColor,
            ["visible"] = true,
            ["owner"] = "local",
            ["ownerLoginId"] = owner,
            ["custom"] = true,
        };
        // If id already taken by another owner, allocate a new id.
        if (FindById(calendars, GetString(payload, "id")) is not null)
        {
            payload["id"] = NewId();
        }

        var created = CreateCalendar(payload);
        HideNewMemberCalendarForAdmin(created, hideForAdminLoginId);
        return created;
    }

    /// <summary>
    /// New calendars owned by a member (not the bootstrap admin) stay hidden for the admin
    /// until the admin turns the eye icon on.
    /// </summary>
    public void HideNewMemberCalendarForAdmin(JsonObject? calendar, string? adminLoginId)
    {
        if (calendar is null) return;
        var admin = (adminLoginId ?? "").Trim();
        if (admin.Length == 0) return;

        var calId = GetString(calendar, "id");
        if (calId.Length == 0
            || string.Equals(calId, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
        {
            return;
        }

        if (string.Equals(GetStringOrNull(calendar, "owner"), "shared", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var owner = GetStringOrNull(calendar, "ownerLoginId")?.Trim() ?? "";
        if (owner.Length == 0
            || string.Equals(owner, admin, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        SetCalendarHiddenForLogin(admin, calId, hidden: true);
    }

    /// <summary>
    /// Delete every non-builtin calendar owned by <paramref name="loginId"/> (events + attachment
    /// folders go with the calendar file), then remove any remaining events still tagged with that owner.
    /// </summary>
    public int PurgeMemberOwnedData(string loginId)
    {
        var owner = (loginId ?? "").Trim();
        if (owner.Length == 0) return 0;

        var store = ReadStore();
        var calendars = GetArray(store, "calendars") ?? new JsonArray();
        var calendarIds = new List<string>();
        foreach (var node in calendars)
        {
            if (node is not JsonObject cal) continue;
            var id = GetString(cal, "id");
            if (id.Length == 0 || BuiltinCalendarIds.Contains(id)) continue;
            if (string.Equals(GetStringOrNull(cal, "ownerLoginId"), owner, StringComparison.OrdinalIgnoreCase))
            {
                calendarIds.Add(id);
            }
        }

        foreach (var id in calendarIds)
        {
            try
            {
                DeleteCalendar(id);
            }
            catch (InvalidOperationException)
            {
                /* already gone / protected */
            }
        }

        store = ReadStore();
        var events = GetArray(store, "events") ?? new JsonArray();
        var eventIds = events
            .OfType<JsonObject>()
            .Where(ev =>
                string.Equals(GetStringOrNull(ev, "ownerLoginId"), owner, StringComparison.OrdinalIgnoreCase))
            .Select(ev => GetString(ev, "id"))
            .Where(id => id.Length > 0)
            .ToList();

        foreach (var eventId in eventIds)
        {
            try
            {
                DeleteEvent(eventId);
            }
            catch (InvalidOperationException)
            {
                /* holidays / already gone */
            }
        }

        // Drop that member's personal day colors + eye-toggle prefs.
        store = ReadStore();
        if (GetObject(store, "settings") is JsonObject settings)
        {
            var settingsChanged = false;
            EnsureDayColorsMigrated(settings, fallbackOwner: AppConstants.DefaultAdminId);
            if (GetObject(settings, "dayColorsByLoginId") is JsonObject byLogin)
            {
                var key = FindDayColorsLoginKey(byLogin, owner);
                if (key is not null)
                {
                    byLogin.Remove(key);
                    settings["dayColorsByLoginId"] = byLogin;
                    settingsChanged = true;
                }
            }

            if (GetObject(settings, "hiddenCalendarIdsByLoginId") is JsonObject hiddenByLogin)
            {
                var key = FindDayColorsLoginKey(hiddenByLogin, owner);
                if (key is not null)
                {
                    hiddenByLogin.Remove(key);
                    settings["hiddenCalendarIdsByLoginId"] = hiddenByLogin;
                    settingsChanged = true;
                }
            }

            if (settingsChanged)
            {
                store["settings"] = settings;
                WriteStore(store);
            }
        }

        return calendarIds.Count;
    }

    /// <summary>
    /// Personal eye-toggle: hide/show a calendar for one login without changing the shared calendar record.
    /// </summary>
    public void SetCalendarHiddenForLogin(string loginId, string calendarId, bool hidden)
    {
        var owner = (loginId ?? "").Trim();
        var calId = (calendarId ?? "").Trim();
        if (owner.Length == 0 || calId.Length == 0) return;

        var store = ReadStore();
        var settings = GetObject(store, "settings") ?? CreateDefaultSettings();
        var byLogin = GetObject(settings, "hiddenCalendarIdsByLoginId") ?? new JsonObject();
        var key = FindDayColorsLoginKey(byLogin, owner) ?? owner;
        var list = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (byLogin[key] is JsonArray existing)
        {
            foreach (var node in existing)
            {
                var id = node?.GetValue<string>()?.Trim() ?? "";
                if (id.Length > 0) list.Add(id);
            }
        }

        if (hidden) list.Add(calId);
        else list.Remove(calId);

        var next = new JsonArray();
        foreach (var id in list.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
        {
            next.Add(id);
        }

        byLogin[key] = next;
        settings["hiddenCalendarIdsByLoginId"] = byLogin;
        store["settings"] = settings;
        WriteStore(store);
    }

    /// <summary>Overlay per-member eye-toggle onto <c>calendar.visible</c> for API clients.</summary>
    public static void ProjectCalendarVisibilityForClient(JsonObject store, string? loginId)
    {
        if (store["calendars"] is not JsonArray calendars) return;
        var hidden = GetHiddenCalendarIdSet(store["settings"] as JsonObject, loginId);
        foreach (var node in calendars)
        {
            if (node is not JsonObject cal) continue;
            var id = cal["id"]?.GetValue<string>() ?? "";
            cal["visible"] = id.Length == 0 || !hidden.Contains(id);
        }

        if (store["settings"] is JsonObject settings)
        {
            settings.Remove("hiddenCalendarIdsByLoginId");
        }
    }

    private static HashSet<string> GetHiddenCalendarIdSet(JsonObject? settings, string? loginId)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var owner = (loginId ?? "").Trim();
        if (owner.Length == 0 || settings is null) return result;

        var byLogin = settings["hiddenCalendarIdsByLoginId"] as JsonObject;
        if (byLogin is null) return result;
        var key = FindDayColorsLoginKey(byLogin, owner);
        if (key is null || byLogin[key] is not JsonArray arr) return result;
        foreach (var node in arr)
        {
            var id = node?.GetValue<string>()?.Trim() ?? "";
            if (id.Length > 0) result.Add(id);
        }

        return result;
    }

    /// <summary>
    /// Legacy global <c>calendar.visible=false</c> → bootstrap admin's personal hidden list.
    /// </summary>
    private static void EnsureHiddenCalendarsMigrated(JsonObject settings, JsonArray calendars, string adminId)
    {
        var owner = (adminId ?? "").Trim();
        if (owner.Length == 0) owner = AppConstants.DefaultAdminId;

        var byLogin = GetObject(settings, "hiddenCalendarIdsByLoginId") ?? new JsonObject();
        settings["hiddenCalendarIdsByLoginId"] = byLogin;

        var key = FindDayColorsLoginKey(byLogin, owner) ?? owner;
        var list = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (byLogin[key] is JsonArray existing)
        {
            foreach (var node in existing)
            {
                var id = node?.GetValue<string>()?.Trim() ?? "";
                if (id.Length > 0) list.Add(id);
            }
        }

        var migrated = false;
        foreach (var node in calendars)
        {
            if (node is not JsonObject cal) continue;
            if (GetBool(cal, "visible", true)) continue;
            var id = GetString(cal, "id");
            if (id.Length == 0) continue;
            if (list.Add(id)) migrated = true;
        }

        if (migrated || byLogin[key] is null)
        {
            var next = new JsonArray();
            foreach (var id in list.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                next.Add(id);
            }

            byLogin[key] = next;
        }
    }

    public JsonObject? FindCalendar(string id)
    {
        var store = ReadStore();
        var found = FindById(GetArray(store, "calendars"), id);
        return found is null ? null : CloneDetached(found);
    }

    public JsonObject? FindEvent(string id)
    {
        var store = ReadStore();
        var found = FindById(GetArray(store, "events"), id);
        return found is null ? null : CloneDetached(found);
    }

    /// <summary>
    /// MSI / portable builds ship DATA_GO_KR_SERVICE_KEY in .env next to the exe.
    /// Persist it into settings with rememberKey so Settings UI shows the key checked.
    /// </summary>
    private void ApplyHolidayKeyFromEnvIfNeeded()
    {
        try
        {
            var env = DotEnv.Load();
            if (!env.TryGetValue("DATA_GO_KR_SERVICE_KEY", out var key)
                && !env.TryGetValue("HOLIDAY_API_KEY", out key))
            {
                return;
            }

            key = (key ?? "").Trim();
            if (key.Length == 0)
            {
                return;
            }

            var settings = ReadSettingsFile();
            var holidaysKr = GetObject(settings, "holidaysKr") ?? new JsonObject();
            var existing = GetString(holidaysKr, "serviceKey", "").Trim();
            var remember = GetBool(holidaysKr, "rememberKey");
            if (remember && existing.Length > 0)
            {
                return;
            }

            holidaysKr["serviceKey"] = key;
            holidaysKr["rememberKey"] = true;
            settings["holidaysKr"] = holidaysKr;
            WriteSettingsFile(settings);
        }
        catch (Exception ex)
        {
            Trace.TraceWarning($"[CalendarStoreService] holiday key from .env not applied: {ex.Message}");
        }
    }

    /// <summary>Raised after every successful write with a payload like <c>{ type: "store-changed", updatedAt }</c>.</summary>
    public event Action<JsonObject>? StoreChanged;

    public string DataRoot => _dataRoot;

    private string SettingsPath => Path.Combine(_dataRoot, "settings.json");

    private string CalendarsDirPath => Path.Combine(_dataRoot, "calendars");

    private string LegacyStorePath => Path.Combine(_dataRoot, LegacyStoreFilename);

    // ---------------------------------------------------------------------
    // Read
    // ---------------------------------------------------------------------

    public JsonObject ReadStore()
    {
        MigrateLegacyStoreIfNeeded();

        var settings = ReadSettingsFile();
        var filePaths = ListCalendarFilePaths();

        var tags = ReadTagsArray();

        if (filePaths.Count == 0)
        {
            return EmptyStore(settings, tags);
        }

        var calendars = new List<JsonObject>();
        var events = new JsonArray();
        var usedDataKeys = new HashSet<string>();
        var latestUpdatedAt = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).ToString("o");
        var needsRewrite = false;

        foreach (var filePath in filePaths)
        {
            JsonObject calendar;
            JsonArray calendarEvents;
            try
            {
                (calendar, calendarEvents) = ReadCalendarFileAt(filePath);
            }
            catch (Exception ex) when (ex is JsonException or InvalidDataException)
            {
                Trace.TraceWarning($"[CalendarStoreService] skipping invalid calendar file: {Path.GetFileName(filePath)}");
                continue;
            }

            var originalDataKey = GetStringOrNull(calendar, "dataKey");
            var normalized = NormalizeCalendarRecord(calendar, usedDataKeys);
            if (string.IsNullOrEmpty(originalDataKey) || GetString(normalized, "dataKey") != originalDataKey)
            {
                needsRewrite = true;
            }
            if (!string.Equals(filePath, CalendarFilePath(normalized), StringComparison.OrdinalIgnoreCase))
            {
                needsRewrite = true;
            }

            calendars.Add(normalized);
            foreach (var ev in calendarEvents)
            {
                if (ev is not null) events.Add(ev.DeepClone());
            }
        }

        try
        {
            if (File.Exists(SettingsPath))
            {
                var raw = File.ReadAllText(SettingsPath, Encoding.UTF8).Trim();
                if (raw.Length > 0 && JsonNode.Parse(raw) is JsonObject settingsParsed)
                {
                    var updatedAt = GetStringOrNull(settingsParsed, "updatedAt");
                    if (!string.IsNullOrEmpty(updatedAt) && string.CompareOrdinal(updatedAt, latestUpdatedAt) > 0)
                    {
                        latestUpdatedAt = updatedAt;
                    }
                }
            }
        }
        catch (JsonException)
        {
            /* settings.json read above already fell back to defaults; ignore for updatedAt tracking */
        }

        var store = new JsonObject
        {
            ["version"] = StoreFormatVersion,
            ["settings"] = settings,
            ["calendars"] = ToJsonArray(SortCalendars(calendars)),
            ["events"] = events,
            ["tags"] = SortTagsArray(tags),
            ["updatedAt"] = latestUpdatedAt,
        };

        return needsRewrite ? WriteStore(store) : store;
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    public JsonObject CreateEvent(JsonObject payload)
    {
        var store = ReadStore();

        var allDay = true;
        if (payload.TryGetPropertyValue("allDay", out var allDayNode) &&
            allDayNode is JsonValue allDayValue &&
            allDayValue.TryGetValue<bool>(out var allDayBool))
        {
            allDay = allDayBool;
        }

        var calendarId = ResolveCalendarId(store, GetStringOrNull(payload, "calendarId"));
        RejectHolidaysKrEventMutation(calendarId);
        var repeat = GetString(payload, "repeat", "none");
        var title = GetString(payload, "title", "").Trim();

        var eventObject = new JsonObject
        {
            ["id"] = NewId(),
            ["calendarId"] = calendarId,
            ["title"] = title.Length > 0 ? title : "(제목 없음)",
            ["description"] = GetString(payload, "description", ""),
            ["link"] = GetString(payload, "link", ""),
            ["links"] = payload["links"] is JsonArray linksIn
                ? (JsonArray)linksIn.DeepClone()
                : new JsonArray(),
            ["location"] = GetString(payload, "location", ""),
            ["startDate"] = CloneOrNull(payload, "startDate"),
            ["endDate"] = CloneOrNull(payload, "endDate") ?? CloneOrNull(payload, "startDate"),
            ["allDay"] = allDay,
            ["startTime"] = allDay ? null : CloneOrNull(payload, "startTime"),
            ["endTime"] = allDay ? null : CloneOrNull(payload, "endTime"),
            ["repeat"] = repeat,
            ["repeatUntil"] = repeat != "none" ? GetStringOrNull(payload, "repeatUntil") : null,
            ["repeatCount"] = ComputeRepeatCount(payload, repeat),
            ["exdates"] = GetStringArray(payload, "exdates"),
            ["color"] = CloneOrNull(payload, "color"),
            ["guests"] = GetArrayClone(payload, "guests") ?? new JsonArray(),
            ["completed"] = GetBool(payload, "completed"),
            ["markerShape"] = GetStringOrNull(payload, "markerShape"),
            ["tagIds"] = NormalizeEventTagIds(store, GetStringArray(payload, "tagIds")),
            ["attachments"] = new JsonArray(),
            ["createdAt"] = NowIso(),
            ["updatedAt"] = NowIso(),
            ["createdBy"] = GetStringOrNull(payload, "createdBy") ?? "local",
            ["ownerLoginId"] = string.Equals(calendarId, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal)
                ? null
                : (GetStringOrNull(payload, "ownerLoginId")?.Trim() is { Length: > 0 } owner
                    ? owner
                    : null),
        };
        if (payload.TryGetPropertyValue("sortOrder", out var sortOrderNode)
            && sortOrderNode is JsonValue
            && sortOrderNode is not null)
        {
            eventObject["sortOrder"] = ClampInt(GetDouble(payload, "sortOrder", 0), 0, 1_000_000);
        }
        NormalizeEventLinks(eventObject);

        var createdId = GetString(eventObject, "id");
        var events = GetArray(store, "events") ?? new JsonArray();
        events.Add(eventObject);
        store["events"] = events;

        var written = WriteStore(store);
        var result = FindById(GetArray(written, "events"), createdId);
        return CloneDetached(result ?? eventObject);
    }

    public JsonObject UpdateEvent(string id, JsonObject payload)
    {
        var store = ReadStore();
        var events = GetArray(store, "events") ?? new JsonArray();

        var index = -1;
        JsonObject? current = null;
        for (var i = 0; i < events.Count; i++)
        {
            if (events[i] is JsonObject candidate && GetString(candidate, "id") == id)
            {
                current = candidate;
                index = i;
                break;
            }
        }
        if (current is null) throw new InvalidOperationException("Event not found");

        RejectHolidaysKrEventMutation(GetString(current, "calendarId"));
        if (GetStringOrNull(payload, "calendarId") is { Length: > 0 } nextCalendarId)
        {
            RejectHolidaysKrEventMutation(nextCalendarId);
        }

        // Attachments are owned by EventAttachmentService — never wipe via generic PATCH/PUT.
        var safePayload = (JsonObject)payload.DeepClone();
        safePayload.Remove("attachments");

        var merged = MergeObjects(current, safePayload);
        merged["id"] = id;
        merged["updatedAt"] = NowIso();
        if (current["attachments"] is JsonNode existingAttachments)
        {
            merged["attachments"] = existingAttachments.DeepClone();
        }

        var repeat = GetString(merged, "repeat", "none");
        merged["repeat"] = repeat;
        if (repeat == "none")
        {
            merged["repeatUntil"] = null;
            merged["repeatCount"] = null;
        }
        else
        {
            var repeatUntil = GetStringOrNull(merged, "repeatUntil");
            merged["repeatUntil"] = string.IsNullOrEmpty(repeatUntil) ? null : repeatUntil;
            merged["repeatCount"] = ComputeRepeatCount(merged, repeat);
        }
        merged["exdates"] = GetStringArray(merged, "exdates");
        if (safePayload.ContainsKey("tagIds"))
        {
            merged["tagIds"] = NormalizeEventTagIds(store, GetStringArray(merged, "tagIds"));
        }
        else if (GetArray(merged, "tagIds") is null)
        {
            merged["tagIds"] = new JsonArray();
        }
        if (safePayload.ContainsKey("links") || safePayload.ContainsKey("link"))
        {
            NormalizeEventLinks(merged);
        }

        events[index] = merged;
        store["events"] = events;

        var written = WriteStore(store);
        var result = FindById(GetArray(written, "events"), id);
        return CloneDetached(result ?? merged);
    }

    public void DeleteEvent(string id)
    {
        var store = ReadStore();
        var events = GetArray(store, "events") ?? new JsonArray();
        var target = events.FirstOrDefault(e => e is JsonObject eo && GetString(eo, "id") == id);
        if (target is null) throw new InvalidOperationException("Event not found");

        if (target is JsonObject targetObj)
        {
            RejectHolidaysKrEventMutation(GetString(targetObj, "calendarId"));
        }

        events.Remove(target);
        store["events"] = events;
        WriteStore(store);
        AttachmentFilesDeleted?.Invoke(new[] { id });
    }

    /// <summary>Raised after event rows are removed so attachment folders can be deleted.</summary>
    public event Action<IReadOnlyList<string>>? AttachmentFilesDeleted;

    /// <summary>Replace only the attachments array for an event (used by EventAttachmentService).</summary>
    public JsonObject SetEventAttachments(string id, JsonArray attachments)
    {
        var store = ReadStore();
        var events = GetArray(store, "events") ?? new JsonArray();

        var index = -1;
        JsonObject? current = null;
        for (var i = 0; i < events.Count; i++)
        {
            if (events[i] is JsonObject candidate && GetString(candidate, "id") == id)
            {
                current = candidate;
                index = i;
                break;
            }
        }
        if (current is null) throw new InvalidOperationException("Event not found");

        RejectHolidaysKrEventMutation(GetString(current, "calendarId"));

        var merged = (JsonObject)current.DeepClone();
        merged["id"] = id;
        merged["attachments"] = (JsonArray)attachments.DeepClone();
        merged["updatedAt"] = NowIso();
        events[index] = merged;
        store["events"] = events;

        var written = WriteStore(store);
        var result = FindById(GetArray(written, "events"), id);
        return CloneDetached(result ?? merged);
    }

    // ---------------------------------------------------------------------
    // Calendars
    // ---------------------------------------------------------------------

    public JsonObject UpsertCalendar(JsonObject payload)
    {
        var store = ReadStore();
        var calendars = GetArray(store, "calendars") ?? new JsonArray();
        var inputId = GetStringOrNull(payload, "id");
        var existing = !string.IsNullOrEmpty(inputId)
            ? calendars.FirstOrDefault(c => c is JsonObject co && GetString(co, "id") == inputId) as JsonObject
            : null;
        var isNew = existing is null;
        var settings = GetObject(store, "settings");
        var defaults = CreateDefaultSettings();

        var name = GetString(payload, "name", "").Trim();
        var calendar = new JsonObject
        {
            ["id"] = inputId ?? NewId(),
            ["dataKey"] = isNew
                ? (GetStringOrNull(payload, "dataKey")
                    ?? (string.Equals(inputId, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal)
                        ? AppConstants.HolidaysKrCalendarId
                        : null)
                    ?? NewId())
                : (GetStringOrNull(existing, "dataKey") ?? GetStringOrNull(existing, "id") ?? NewId()),
            ["name"] = name.Length > 0 ? name : "새 캘린더",
            ["description"] = GetString(payload, "description", ""),
            ["timezone"] = GetStringOrNull(payload, "timezone") ?? GetStringOrNull(settings, "timezone") ?? GetString(defaults, "timezone"),
            ["timezoneLabel"] = GetStringOrNull(payload, "timezoneLabel") ?? GetStringOrNull(settings, "timezoneLabel") ?? GetString(defaults, "timezoneLabel"),
            ["ownerName"] = GetStringOrNull(payload, "ownerName") ?? GetStringOrNull(settings, "ownerName") ?? GetString(defaults, "ownerName"),
            ["color"] = GetStringOrNull(payload, "color") ?? "#7986cb",
            // Shared record stays visible; per-member eye-toggle uses hiddenCalendarIdsByLoginId.
            ["visible"] = true,
            ["owner"] = GetStringOrNull(payload, "owner") ?? "local",
            ["custom"] = ComputeCustomFlag(payload, existing),
            ["password"] = payload.TryGetPropertyValue("password", out var pwNode) && pwNode is not null
                ? ToStringValue(pwNode)
                : (GetStringOrNull(existing, "password") ?? ""),
        };

        var isHolidays = string.Equals(
            GetString(calendar, "id"),
            AppConstants.HolidaysKrCalendarId,
            StringComparison.Ordinal);
        if (isHolidays)
        {
            calendar.Remove("ownerLoginId");
        }
        else if (GetStringOrNull(payload, "ownerLoginId")?.Trim() is { Length: > 0 } ownerFromPayload)
        {
            calendar["ownerLoginId"] = ownerFromPayload;
        }
        else if (existing is not null && GetStringOrNull(existing, "ownerLoginId")?.Trim() is { Length: > 0 } keepOwner)
        {
            calendar["ownerLoginId"] = keepOwner;
        }

        if (existing is not null)
        {
            var saved = MergeObjects(existing, calendar);
            saved["id"] = GetString(existing, "id");
            saved["dataKey"] = GetStringOrNull(existing, "dataKey") ?? GetString(existing, "id");
            if (isHolidays) saved.Remove("ownerLoginId");
            else if (calendar.ContainsKey("ownerLoginId"))
            {
                saved["ownerLoginId"] = calendar["ownerLoginId"]?.DeepClone();
            }

            var calendarId = GetString(saved, "id");
            var calendarEvents = CollectCalendarEvents(store, calendarId);
            return CloneDetached(WriteSingleCalendar(saved, calendarEvents));
        }

        return CloneDetached(WriteSingleCalendar(calendar, new JsonArray()));
    }

    public JsonObject CreateCalendar(JsonObject payload) => UpsertCalendar(payload);

    public JsonObject PatchCalendar(string id, JsonObject payload)
    {
        var store = ReadStore();
        var calendars = GetArray(store, "calendars") ?? new JsonArray();
        var existing = calendars.FirstOrDefault(c => c is JsonObject co && GetString(co, "id") == id) as JsonObject;
        if (existing is null) throw new InvalidOperationException("Calendar not found");

        var safePayload = (JsonObject)payload.DeepClone();
        // Eye-toggle is per-member (see SetCalendarHiddenForLogin); never persist onto the shared calendar.
        safePayload.Remove("visible");

        var saved = MergeObjects(existing, safePayload);
        saved["id"] = id;
        saved["visible"] = true;

        var calendarEvents = CollectCalendarEvents(store, id);
        return CloneDetached(WriteSingleCalendar(saved, calendarEvents));
    }

    public void DeleteCalendar(string id)
    {
        if (BuiltinCalendarIds.Contains(id))
        {
            throw new InvalidOperationException("기본 제공 캘린더는 삭제할 수 없습니다.");
        }

        foreach (var filePath in ListCalendarFilePaths())
        {
            JsonObject calendar;
            JsonArray calendarEvents;
            try
            {
                (calendar, calendarEvents) = ReadCalendarFileAt(filePath);
            }
            catch (Exception ex) when (ex is JsonException or InvalidDataException)
            {
                continue;
            }

            if (GetString(calendar, "id") != id) continue;

            var removedIds = calendarEvents
                .OfType<JsonObject>()
                .Select(eo => GetString(eo, "id"))
                .Where(eid => eid.Length > 0)
                .ToList();

            lock (_writeLock)
            {
                DeleteCalendarFileAt(filePath);
                BroadcastChanged();
            }

            if (removedIds.Count > 0)
            {
                AttachmentFilesDeleted?.Invoke(removedIds);
            }
            return;
        }

        throw new InvalidOperationException("캘린더를 찾을 수 없습니다.");
    }

    public void ClearCalendarEvents(string calendarId)
    {
        RejectHolidaysKrEventMutation(calendarId);
        ReplaceCalendarEvents(calendarId, new JsonArray());
    }

    // ---------------------------------------------------------------------
    // Tags
    // ---------------------------------------------------------------------

    public JsonObject CreateTag(JsonObject payload)
    {
        var store = ReadStore();
        var tags = GetArray(store, "tags") ?? new JsonArray();
        var name = GetString(payload, "name", "").Trim();
        if (name.Length == 0)
        {
            throw new InvalidOperationException("태그 이름을 입력해 주세요.");
        }

        foreach (var node in tags)
        {
            if (node is JsonObject existing
                && string.Equals(GetString(existing, "name"), name, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("같은 이름의 태그가 이미 있습니다.");
            }
        }

        var id = GetStringOrNull(payload, "id");
        if (string.IsNullOrEmpty(id) || FindById(tags, id) is not null)
        {
            id = NewId();
        }

        var maxOrder = -1;
        foreach (var node in tags)
        {
            if (node is JsonObject to)
            {
                maxOrder = Math.Max(maxOrder, (int)GetDouble(to, "sortOrder", 0));
            }
        }

        var tag = new JsonObject
        {
            ["id"] = id,
            ["name"] = name,
            ["color"] = GetStringOrNull(payload, "color"),
            ["sortOrder"] = ClampInt(GetDouble(payload, "sortOrder", maxOrder + 1), 0, 1_000_000),
        };
        tags.Add(tag);
        store["tags"] = SortTagsArray(tags);
        var written = WriteStore(store);
        var result = FindById(GetArray(written, "tags"), id);
        return CloneDetached(result ?? tag);
    }

    public JsonObject PatchTag(string id, JsonObject payload)
    {
        var store = ReadStore();
        var tags = GetArray(store, "tags") ?? new JsonArray();
        var index = -1;
        JsonObject? current = null;
        for (var i = 0; i < tags.Count; i++)
        {
            if (tags[i] is JsonObject candidate && GetString(candidate, "id") == id)
            {
                current = candidate;
                index = i;
                break;
            }
        }
        if (current is null) throw new InvalidOperationException("태그를 찾을 수 없습니다.");

        var nextName = GetStringOrNull(payload, "name")?.Trim();
        if (!string.IsNullOrEmpty(nextName))
        {
            foreach (var node in tags)
            {
                if (node is JsonObject other
                    && GetString(other, "id") != id
                    && string.Equals(GetString(other, "name"), nextName, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("같은 이름의 태그가 이미 있습니다.");
                }
            }
        }

        var merged = MergeObjects(current, payload);
        merged["id"] = id;
        if (!string.IsNullOrEmpty(nextName)) merged["name"] = nextName;
        if (payload.ContainsKey("color"))
        {
            var color = GetStringOrNull(payload, "color");
            merged["color"] = string.IsNullOrEmpty(color) ? null : color;
        }
        if (payload.ContainsKey("sortOrder"))
        {
            merged["sortOrder"] = ClampInt(GetDouble(payload, "sortOrder", 0), 0, 1_000_000);
        }

        tags[index] = merged;
        store["tags"] = SortTagsArray(tags);
        var written = WriteStore(store);
        var result = FindById(GetArray(written, "tags"), id);
        return CloneDetached(result ?? merged);
    }

    public void DeleteTag(string id)
    {
        var store = ReadStore();
        var tags = GetArray(store, "tags") ?? new JsonArray();
        var target = tags.FirstOrDefault(n => n is JsonObject o && GetString(o, "id") == id);
        if (target is null) throw new InvalidOperationException("태그를 찾을 수 없습니다.");

        tags.Remove(target);
        store["tags"] = SortTagsArray(tags);

        var events = GetArray(store, "events") ?? new JsonArray();
        for (var i = 0; i < events.Count; i++)
        {
            if (events[i] is not JsonObject eo) continue;
            var tagIds = GetStringArray(eo, "tagIds");
            var next = new JsonArray();
            var changed = false;
            foreach (var node in tagIds)
            {
                var value = ToStringValue(node);
                if (value == id)
                {
                    changed = true;
                    continue;
                }
                next.Add((JsonNode)value);
            }
            if (changed) eo["tagIds"] = next;
        }
        store["events"] = events;
        WriteStore(store);
    }

    public void EnsureDefaultTags()
    {
        // Seed only when settings.json has never stored a tags key (first run / upgrade).
        if (!SettingsFileHasTagsKey())
        {
            WriteSettingsFile(ReadSettingsFile(), DefaultTagsArray());
            return;
        }

        // One-time rename: built-in tag-duty "복무" → "회의" (skip if user already renamed it).
        var tags = ReadTagsArray();
        var changed = false;
        foreach (var node in tags)
        {
            if (node is not JsonObject tag) continue;
            if (!string.Equals(GetStringOrNull(tag, "id"), "tag-duty", StringComparison.Ordinal)) continue;
            if (!string.Equals(GetStringOrNull(tag, "name"), "복무", StringComparison.Ordinal)) break;
            tag["name"] = "회의";
            changed = true;
            break;
        }
        if (changed) WriteSettingsFile(ReadSettingsFile(), tags);
    }

    /// <summary>
    /// Privileged path: only holiday sync/seed may replace 대한민국의 휴일 events.
    /// </summary>
    public void ReplaceHolidaysKrEvents(IEnumerable<JsonObject> events)
    {
        EnsureHolidaysKrCalendar();
        var next = new JsonArray();
        foreach (var ev in events)
        {
            var clone = (JsonObject)ev.DeepClone();
            clone["calendarId"] = AppConstants.HolidaysKrCalendarId;
            if (string.IsNullOrEmpty(GetStringOrNull(clone, "id")))
            {
                clone["id"] = NewId();
            }

            next.Add(clone);
        }

        ReplaceCalendarEvents(AppConstants.HolidaysKrCalendarId, next);
    }

    private static void RejectHolidaysKrEventMutation(string? calendarId)
    {
        if (string.Equals(calendarId, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("대한민국의 휴일 캘린더는 동기화로만 갱신할 수 있습니다.");
        }
    }

    /// <summary>Ensure built-in primary + 대한민국의 휴일 calendars exist (and seed holidays if empty).</summary>
    public void EnsureBuiltinCalendars()
    {
        EnsurePrimaryCalendar();
        EnsureHolidaysKrCalendar();
        HolidaySyncService.SeedFromBundleIfEmpty(this);
    }

    /// <summary>Ensure the built-in yellow "기본 캘린더" exists (first install / empty store).</summary>
    public JsonObject? EnsurePrimaryCalendar()
    {
        var store = ReadStore();
        var calendars = GetArray(store, "calendars") ?? new JsonArray();
        var existing = calendars.FirstOrDefault(c => c is JsonObject co && GetString(co, "id") == AppConstants.PrimaryCalendarId) as JsonObject;
        if (existing is not null) return CloneDetached(existing);

        var def = DefaultCalendarsArray().FirstOrDefault(c => c is JsonObject co && GetString(co, "id") == AppConstants.PrimaryCalendarId) as JsonObject;
        if (def is null) return null;

        return UpsertCalendar(new JsonObject
        {
            ["id"] = AppConstants.PrimaryCalendarId,
            ["name"] = GetString(def, "name"),
            ["description"] = "",
            ["color"] = GetString(def, "color"),
            ["visible"] = GetBool(def, "visible", true),
            ["owner"] = GetStringOrNull(def, "owner") ?? "local",
            ["custom"] = false,
        });
    }

    /// <summary>Ensure the built-in shared "대한민국의 휴일" calendar exists.</summary>
    public JsonObject? EnsureHolidaysKrCalendar()
    {
        var store = ReadStore();
        var calendars = GetArray(store, "calendars") ?? new JsonArray();
        var existing = calendars.FirstOrDefault(
            c => c is JsonObject co && GetString(co, "id") == AppConstants.HolidaysKrCalendarId) as JsonObject;
        if (existing is not null)
        {
            return CloneDetached(existing);
        }

        var def = DefaultCalendarsArray().FirstOrDefault(
            c => c is JsonObject co && GetString(co, "id") == AppConstants.HolidaysKrCalendarId) as JsonObject;
        if (def is null)
        {
            return null;
        }

        return UpsertCalendar(new JsonObject
        {
            ["id"] = AppConstants.HolidaysKrCalendarId,
            ["dataKey"] = AppConstants.HolidaysKrCalendarId,
            ["name"] = GetString(def, "name"),
            ["description"] = "",
            ["color"] = GetString(def, "color"),
            ["visible"] = GetBool(def, "visible", true),
            ["owner"] = "shared",
            ["custom"] = false,
        });
    }

    private static bool IsHolidaysKrCalendar(JsonObject calendar) =>
        string.Equals(GetString(calendar, "id"), AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal)
        || string.Equals(GetStringOrNull(calendar, "dataKey"), AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal);

    /// <summary>
    /// Snapshot of the local holidays-kr calendar kept across import/replace.
    /// </summary>
    private JsonObject GetPreservedHolidaysKrCalendar(JsonObject currentStore)
    {
        var calendars = GetArray(currentStore, "calendars") ?? new JsonArray();
        if (calendars.FirstOrDefault(c => c is JsonObject co && IsHolidaysKrCalendar(co)) is JsonObject existing)
        {
            var clone = (JsonObject)existing.DeepClone();
            clone["id"] = AppConstants.HolidaysKrCalendarId;
            clone["dataKey"] = AppConstants.HolidaysKrCalendarId;
            return clone;
        }

        var def = DefaultCalendarsArray().FirstOrDefault(
            c => c is JsonObject co && GetString(co, "id") == AppConstants.HolidaysKrCalendarId) as JsonObject;
        return new JsonObject
        {
            ["id"] = AppConstants.HolidaysKrCalendarId,
            ["dataKey"] = AppConstants.HolidaysKrCalendarId,
            ["name"] = def is null ? "대한민국의 휴일" : GetString(def, "name"),
            ["description"] = "",
            ["color"] = def is null ? "#d50000" : GetString(def, "color"),
            ["visible"] = def is null || GetBool(def, "visible", true),
            ["owner"] = "shared",
            ["custom"] = false,
        };
    }

    private static JsonArray GetPreservedHolidaysKrEvents(JsonObject currentStore)
    {
        var result = new JsonArray();
        foreach (var e in GetArray(currentStore, "events") ?? new JsonArray())
        {
            if (e is JsonObject eo && GetString(eo, "calendarId") == AppConstants.HolidaysKrCalendarId)
            {
                result.Add((JsonObject)eo.DeepClone());
            }
        }

        return result;
    }

    // ---------------------------------------------------------------------
    // Settings
    // ---------------------------------------------------------------------

    /// <param name="dayColorsOwnerLoginId">
    /// When the client patches <c>dayColors</c>, store under this login in
    /// <c>dayColorsByLoginId</c> (per-member). Returned settings expose only that member's map as <c>dayColors</c>.
    /// </param>
    public JsonObject PatchSettings(JsonObject payload, string? dayColorsOwnerLoginId = null)
    {
        var store = ReadStore();
        var current = GetObject(store, "settings") ?? CreateDefaultSettings();
        var defaults = CreateDefaultSettings();

        var safePayload = (JsonObject)payload.DeepClone();
        JsonObject? dayColorsPatch = null;
        if (safePayload.ContainsKey("dayColors"))
        {
            dayColorsPatch = GetObject(safePayload, "dayColors")?.DeepClone() as JsonObject ?? new JsonObject();
            safePayload.Remove("dayColors");
        }

        // Per-member maps are server-owned; never shallow-merge from clients.
        safePayload.Remove("dayColorsByLoginId");
        safePayload.Remove("hiddenCalendarIdsByLoginId");

        var notifications = MergeObjects(MergeObjects(GetObject(defaults, "notifications"), GetObject(current, "notifications")), GetObject(safePayload, "notifications"));
        if (GetString(notifications, "enabled") == "email") notifications["enabled"] = "none";

        var holidaysKr = NormalizeHolidaysKr(MergeObjects(MergeObjects(GetObject(defaults, "holidaysKr"), GetObject(current, "holidaysKr")), GetObject(safePayload, "holidaysKr")));

        var viewOptions = MergeObjects(MergeObjects(GetObject(defaults, "viewOptions"), GetObject(current, "viewOptions")), GetObject(safePayload, "viewOptions"));

        var widgetInput = MergeObjects(GetObject(current, "widget"), GetObject(safePayload, "widget"));
        var widget = NormalizeWidget(GetObject(defaults, "widget"), widgetInput);

        var newSettings = MergeObjects(current, safePayload);
        newSettings["notifications"] = notifications;
        newSettings["viewOptions"] = viewOptions;
        newSettings["widget"] = widget;
        newSettings["holidaysKr"] = holidaysKr;

        var ownerKey = (dayColorsOwnerLoginId ?? "").Trim();
        var migrateOwner = ownerKey.Length > 0 ? ownerKey : AppConstants.DefaultAdminId;
        EnsureDayColorsMigrated(newSettings, migrateOwner);

        if (dayColorsPatch is not null && ownerKey.Length > 0)
        {
            SetDayColorsForLogin(newSettings, ownerKey, dayColorsPatch);
        }

        // Canonical storage is dayColorsByLoginId; flat dayColors is a client projection only.
        if (GetObject(newSettings, "dayColors") is null)
        {
            newSettings["dayColors"] = new JsonObject();
        }

        // Full replace for IP allowlist (same as dayColors — never shallow-merge array indices).
        if (safePayload.ContainsKey("allowedIpCidrs"))
        {
            newSettings["allowedIpCidrs"] = IpAccessGuard.NormalizeAllowedIpCidrs(safePayload["allowedIpCidrs"]);
        }
        else if (GetArray(newSettings, "allowedIpCidrs") is null)
        {
            newSettings["allowedIpCidrs"] = new JsonArray();
        }

        store["settings"] = newSettings;
        var written = WriteStore(store);
        var saved = CloneDetached(GetObject(written, "settings") ?? newSettings);
        return ProjectSettingsDayColorsForClient(saved, ownerKey.Length > 0 ? ownerKey : null);
    }

    /// <summary>
    /// Expose only <paramref name="loginId"/>'s day colors as <c>settings.dayColors</c>
    /// and hide the per-member map from API clients.
    /// </summary>
    public static JsonObject ProjectSettingsDayColorsForClient(JsonObject settings, string? loginId)
    {
        EnsureDayColorsMigrated(settings, fallbackOwner: (loginId ?? "").Trim().Length > 0
            ? loginId!.Trim()
            : AppConstants.DefaultAdminId);

        var personal = string.IsNullOrWhiteSpace(loginId)
            ? new JsonObject()
            : CloneDetached(GetDayColorsForLogin(settings, loginId.Trim()));
        settings["dayColors"] = personal;
        settings.Remove("dayColorsByLoginId");
        return settings;
    }

    // ---------------------------------------------------------------------
    // Import / export
    // ---------------------------------------------------------------------

    public JsonObject ImportStore(JsonObject payload)
    {
        var calendarsArr = GetArray(payload, "calendars");
        var eventsArr = GetArray(payload, "events");
        if (calendarsArr is not null && eventsArr is not null)
        {
            return ImportReplace(payload, calendarsArr, eventsArr);
        }

        var singleCalendar = GetObject(payload, "calendar");
        if (singleCalendar is not null && eventsArr is not null)
        {
            return ImportMergeCalendar(singleCalendar, eventsArr);
        }

        throw new InvalidOperationException("지원하지 않는 JSON 형식입니다. 전체 내보내기 또는 개별 캘린더 내보내기 파일을 사용해 주세요.");
    }

    private JsonObject ImportReplace(JsonObject payload, JsonArray calendarsArr, JsonArray eventsArr)
    {
        var current = ReadStore();
        var preservedHolidayCalendar = GetPreservedHolidaysKrCalendar(current);
        var preservedHolidayEvents = GetPreservedHolidaysKrEvents(current);

        // Never let import reuse/overwrite the holidays-kr dataKey.
        var usedDataKeys = new HashSet<string>(StringComparer.Ordinal)
        {
            AppConstants.HolidaysKrCalendarId,
        };
        var calendars = new JsonArray();
        foreach (var c in calendarsArr)
        {
            if (c is not JsonObject co || IsHolidaysKrCalendar(co)) continue;
            calendars.Add(NormalizeCalendarRecord(co, usedDataKeys));
        }
        calendars.Add(preservedHolidayCalendar);

        var events = new JsonArray();
        foreach (var e in eventsArr)
        {
            if (e is not JsonObject eo) continue;
            if (GetString(eo, "calendarId") == AppConstants.HolidaysKrCalendarId) continue;
            events.Add((JsonObject)eo.DeepClone());
        }
        foreach (var e in preservedHolidayEvents)
        {
            events.Add((JsonObject)e!.DeepClone());
        }

        var settings = GetObject(payload, "settings")?.DeepClone() as JsonObject ?? CreateDefaultSettings();
        if (GetObject(GetObject(current, "settings"), "holidaysKr") is JsonObject currentHolidaysKr)
        {
            settings["holidaysKr"] = currentHolidaysKr.DeepClone();
        }

        var importedTags = GetArray(payload, "tags");
        var tags = importedTags is not null && importedTags.Count > 0
            ? NormalizeTagsArray(importedTags)
            : GetArray(current, "tags") ?? DefaultTagsArray();

        var store = new JsonObject
        {
            ["version"] = GetInt(payload, "version", StoreFormatVersion),
            ["settings"] = settings,
            ["calendars"] = calendars,
            ["events"] = events,
            ["tags"] = tags,
            ["updatedAt"] = NowIso(),
        };

        return CloneDetached(WriteStore(store));
    }

    private JsonObject ImportMergeCalendar(JsonObject calendarInput, JsonArray eventsInput)
    {
        if (IsHolidaysKrCalendar(calendarInput)
            || string.Equals(GetStringOrNull(calendarInput, "id"), AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("대한민국의 휴일 캘린더는 가져오기로 변경할 수 없습니다.");
        }

        var store = ReadStore();
        var calendars = GetArray(store, "calendars") ?? new JsonArray();

        var usedDataKeys = new HashSet<string>();
        foreach (var c in calendars)
        {
            if (c is JsonObject co && GetStringOrNull(co, "dataKey") is { Length: > 0 } dk) usedDataKeys.Add(dk);
        }

        var inputId = GetStringOrNull(calendarInput, "id");
        if (string.Equals(inputId, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("대한민국의 휴일 캘린더는 가져오기로 변경할 수 없습니다.");
        }

        var existing = calendars.FirstOrDefault(c => c is JsonObject co && GetString(co, "id") == inputId) as JsonObject;
        if (existing is not null && GetStringOrNull(existing, "dataKey") is { Length: > 0 } existingDataKey)
        {
            usedDataKeys.Remove(existingDataKey);
        }

        var candidate = (JsonObject)calendarInput.DeepClone();
        candidate["id"] = inputId ?? NewId();
        var preservedDataKey = GetStringOrNull(existing, "dataKey");
        if (!string.IsNullOrEmpty(preservedDataKey)) candidate["dataKey"] = preservedDataKey;

        var calendar = NormalizeCalendarRecord(candidate, usedDataKeys);
        var calendarId = GetString(calendar, "id");

        var importedEvents = new JsonArray();
        foreach (var e in eventsInput)
        {
            if (e is not JsonObject eo) continue;
            var clone = (JsonObject)eo.DeepClone();
            clone["id"] = GetStringOrNull(clone, "id") ?? NewId();
            clone["calendarId"] = calendarId;
            importedEvents.Add(clone);
        }

        var nextCalendars = new JsonArray();
        foreach (var c in calendars)
        {
            if (c is JsonObject co && GetString(co, "id") != calendarId) nextCalendars.Add((JsonObject)co.DeepClone());
        }
        nextCalendars.Add(calendar);

        var existingEvents = GetArray(store, "events") ?? new JsonArray();
        var nextEvents = new JsonArray();
        foreach (var e in existingEvents)
        {
            if (e is JsonObject eo && GetString(eo, "calendarId") != calendarId) nextEvents.Add((JsonObject)eo.DeepClone());
        }
        foreach (var e in importedEvents)
        {
            nextEvents.Add((JsonObject)e!.DeepClone());
        }

        var nextStore = new JsonObject
        {
            ["version"] = GetInt(store, "version", StoreFormatVersion),
            ["settings"] = GetObject(store, "settings")?.DeepClone() ?? CreateDefaultSettings(),
            ["calendars"] = nextCalendars,
            ["events"] = nextEvents,
            ["tags"] = GetArray(store, "tags")?.DeepClone() as JsonArray ?? DefaultTagsArray(),
            ["updatedAt"] = NowIso(),
        };

        return CloneDetached(WriteStore(nextStore));
    }

    /// <summary>
    /// Import events into an existing calendar (append). Holidays calendar is rejected.
    /// </summary>
    public JsonObject ImportEventsIntoCalendar(string calendarId, JsonArray eventsInput, string ownerLoginId)
    {
        var id = (calendarId ?? "").Trim();
        if (id.Length == 0) throw new InvalidOperationException("캘린더를 찾을 수 없습니다.");
        if (string.Equals(id, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("대한민국의 휴일 캘린더에는 가져올 수 없습니다.");
        }

        var store = ReadStore();
        var calendars = GetArray(store, "calendars") ?? new JsonArray();
        var target = calendars.FirstOrDefault(c => c is JsonObject co && GetString(co, "id") == id) as JsonObject
            ?? throw new InvalidOperationException("캘린더를 찾을 수 없습니다.");

        var owner = (ownerLoginId ?? "").Trim();
        if (owner.Length == 0)
        {
            owner = GetStringOrNull(target, "ownerLoginId")?.Trim() ?? AppConstants.DefaultAdminId;
        }

        var existingEvents = GetArray(store, "events") ?? new JsonArray();
        var nextEvents = new JsonArray();
        foreach (var e in existingEvents)
        {
            if (e is JsonObject eo) nextEvents.Add((JsonObject)eo.DeepClone());
        }

        var imported = 0;
        foreach (var e in eventsInput)
        {
            if (e is not JsonObject eo) continue;
            if (string.Equals(GetString(eo, "calendarId"), AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
            {
                continue;
            }

            var clone = (JsonObject)eo.DeepClone();
            clone["id"] = NewId();
            clone["calendarId"] = id;
            clone["ownerLoginId"] = owner;
            clone.Remove("contentLocked");
            nextEvents.Add(clone);
            imported += 1;
        }

        if (imported == 0)
        {
            throw new InvalidOperationException("가져올 일정이 없습니다.");
        }

        var nextStore = new JsonObject
        {
            ["version"] = GetInt(store, "version", StoreFormatVersion),
            ["settings"] = GetObject(store, "settings")?.DeepClone() ?? CreateDefaultSettings(),
            ["calendars"] = calendars.DeepClone(),
            ["events"] = nextEvents,
            ["tags"] = GetArray(store, "tags")?.DeepClone() as JsonArray ?? DefaultTagsArray(),
            ["updatedAt"] = NowIso(),
        };

        WriteStore(nextStore);
        return new JsonObject
        {
            ["ok"] = true,
            ["importedCount"] = imported,
            ["calendarId"] = id,
        };
    }

    // ---------------------------------------------------------------------
    // Store persistence
    // ---------------------------------------------------------------------

    private JsonObject WriteStore(JsonObject store)
    {
        lock (_writeLock)
        {
            Directory.CreateDirectory(CalendarsDirPath);
            var settingsNode = GetObject(store, "settings");
            var tagsNode = NormalizeTagsArray(GetArray(store, "tags") ?? ReadTagsArray());
            WriteSettingsFile(settingsNode, tagsNode);

            var calendarsInput = GetArray(store, "calendars") ?? new JsonArray();
            var eventsInput = GetArray(store, "events") ?? new JsonArray();

            var usedDataKeys = new HashSet<string>();
            var calendars = new List<JsonObject>();
            foreach (var c in calendarsInput)
            {
                if (c is JsonObject co) calendars.Add(NormalizeCalendarRecord(co, usedDataKeys));
            }

            var activePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var calendar in calendars)
            {
                var calendarId = GetString(calendar, "id");
                var calendarEvents = new JsonArray();
                foreach (var e in eventsInput)
                {
                    if (e is JsonObject eo && GetString(eo, "calendarId") == calendarId) calendarEvents.Add((JsonObject)eo.DeepClone());
                }

                var targetPath = CalendarFilePath(calendar);
                activePaths.Add(targetPath);
                WriteCalendarFile(calendar, calendarEvents);
            }

            foreach (var filePath in ListCalendarFilePaths())
            {
                if (!activePaths.Contains(filePath)) DeleteCalendarFileAt(filePath);
            }

            var updatedAt = NowIso();
            var result = new JsonObject
            {
                ["version"] = GetInt(store, "version", StoreFormatVersion),
                ["settings"] = NormalizeSettings(settingsNode),
                ["calendars"] = ToJsonArray(calendars),
                ["events"] = (JsonArray)eventsInput.DeepClone(),
                ["tags"] = tagsNode,
                ["updatedAt"] = updatedAt,
            };

            BroadcastChanged(updatedAt);
            return result;
        }
    }

    private JsonObject WriteSingleCalendar(JsonObject calendar, JsonArray events)
    {
        lock (_writeLock)
        {
            WriteCalendarFile(calendar, events);
            BroadcastChanged();
            return calendar;
        }
    }

    private void ReplaceCalendarEvents(string calendarId, JsonArray events)
    {
        foreach (var filePath in ListCalendarFilePaths())
        {
            JsonObject calendar;
            JsonArray previousEvents;
            try
            {
                (calendar, previousEvents) = ReadCalendarFileAt(filePath);
            }
            catch (Exception ex) when (ex is JsonException or InvalidDataException)
            {
                continue;
            }

            if (GetString(calendar, "id") != calendarId) continue;

            var nextIds = new HashSet<string>(StringComparer.Ordinal);
            var nextEvents = new JsonArray();
            foreach (var e in events)
            {
                if (e is not JsonObject eo) continue;
                var clone = (JsonObject)eo.DeepClone();
                clone["calendarId"] = calendarId;
                var eid = GetString(clone, "id");
                if (eid.Length > 0) nextIds.Add(eid);
                nextEvents.Add(clone);
            }

            var removedIds = new List<string>();
            foreach (var e in previousEvents)
            {
                if (e is JsonObject eo && GetString(eo, "id") is { Length: > 0 } eid && !nextIds.Contains(eid))
                {
                    removedIds.Add(eid);
                }
            }

            lock (_writeLock)
            {
                WriteCalendarFile(calendar, nextEvents);
                BroadcastChanged();
            }

            if (removedIds.Count > 0)
            {
                AttachmentFilesDeleted?.Invoke(removedIds);
            }
            return;
        }

        throw new InvalidOperationException("캘린더를 찾을 수 없습니다.");
    }

    private void BroadcastChanged(string? updatedAt = null)
    {
        StoreChanged?.Invoke(new JsonObject
        {
            ["type"] = "store-changed",
            ["updatedAt"] = updatedAt ?? NowIso(),
        });
    }

    private JsonArray CollectCalendarEvents(JsonObject store, string calendarId)
    {
        var events = GetArray(store, "events") ?? new JsonArray();
        var result = new JsonArray();
        foreach (var e in events)
        {
            if (e is JsonObject eo && GetString(eo, "calendarId") == calendarId) result.Add((JsonObject)eo.DeepClone());
        }
        return result;
    }

    private void MigrateLegacyStoreIfNeeded()
    {
        var hasCalendarFiles = Directory.Exists(CalendarsDirPath) && Directory.GetFiles(CalendarsDirPath, "*.json").Length > 0;
        if (hasCalendarFiles)
        {
            if (File.Exists(LegacyStorePath))
            {
                try { File.Delete(LegacyStorePath); } catch (IOException) { /* ignore */ }
            }
            return;
        }

        if (!File.Exists(LegacyStorePath)) return;

        try
        {
            var raw = File.ReadAllText(LegacyStorePath, Encoding.UTF8);
            if (JsonNode.Parse(raw) is not JsonObject parsed) return;

            var calendars = GetArray(parsed, "calendars") ?? new JsonArray();
            var events = GetArray(parsed, "events") ?? new JsonArray();

            WriteSettingsFile(GetObject(parsed, "settings"));
            Directory.CreateDirectory(CalendarsDirPath);

            foreach (var c in calendars)
            {
                if (c is not JsonObject calendar) continue;
                var calendarId = GetString(calendar, "id");
                var calendarEvents = new JsonArray();
                foreach (var e in events)
                {
                    if (e is JsonObject eo && GetString(eo, "calendarId") == calendarId) calendarEvents.Add((JsonObject)eo.DeepClone());
                }

                var withKey = (JsonObject)calendar.DeepClone();
                if (string.IsNullOrEmpty(GetStringOrNull(withKey, "dataKey")))
                {
                    withKey["dataKey"] = GetStringOrNull(withKey, "id") ?? NewId();
                }
                WriteCalendarFile(withKey, calendarEvents);
            }

            var backupPath = $"{LegacyStorePath}.bak";
            if (File.Exists(backupPath)) File.Delete(backupPath);
            File.Move(LegacyStorePath, backupPath);
        }
        catch (JsonException)
        {
            /* corrupt legacy store; leave it in place rather than losing data */
        }
    }

    // ---------------------------------------------------------------------
    // Calendar file I/O
    // ---------------------------------------------------------------------

    private string CalendarFilePath(JsonObject calendar)
    {
        var dataKey = Regex.Replace(GetDataKey(calendar), "[^a-zA-Z0-9-]", "");
        return Path.Combine(CalendarsDirPath, $"{dataKey}.json");
    }

    private static string GetDataKey(JsonObject calendar) =>
        GetStringOrNull(calendar, "dataKey") is { Length: > 0 } dataKey ? dataKey : GetString(calendar, "id", "");

    private static (JsonObject Calendar, JsonArray Events) ReadCalendarFileAt(string filePath)
    {
        var raw = File.ReadAllText(filePath, Encoding.UTF8).Trim();
        if (raw.Length == 0)
        {
            throw new InvalidDataException($"Empty calendar file: {Path.GetFileName(filePath)}");
        }

        var parsed = JsonNode.Parse(raw) as JsonObject
            ?? throw new InvalidDataException($"Invalid calendar file: {Path.GetFileName(filePath)}");
        var calendar = GetObject(parsed, "calendar") ?? parsed;
        var events = GetArray(parsed, "events") ?? new JsonArray();
        return (calendar, events);
    }

    private void WriteCalendarFile(JsonObject calendar, JsonArray events)
    {
        Directory.CreateDirectory(CalendarsDirPath);
        var payload = new JsonObject
        {
            ["version"] = CalendarFileVersion,
            ["calendar"] = NormalizeCalendarCustomFlag(calendar),
            ["events"] = (JsonArray)events.DeepClone(),
            ["updatedAt"] = NowIso(),
        };
        WriteFileAtomic(CalendarFilePath(calendar), payload.ToJsonString(WriteOptions));
    }

    private static void DeleteCalendarFileAt(string filePath)
    {
        if (File.Exists(filePath)) File.Delete(filePath);
    }

    private List<string> ListCalendarFilePaths()
    {
        if (!Directory.Exists(CalendarsDirPath)) return [];
        return Directory.GetFiles(CalendarsDirPath, "*.json").ToList();
    }

    // ---------------------------------------------------------------------
    // Settings file I/O
    // ---------------------------------------------------------------------

    private JsonObject ReadSettingsFile()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return CreateDefaultSettings();
            var raw = File.ReadAllText(SettingsPath, Encoding.UTF8).Trim();
            if (raw.Length == 0) return CreateDefaultSettings();
            var parsed = JsonNode.Parse(raw) as JsonObject;
            return NormalizeSettings(GetObject(parsed, "settings"));
        }
        catch (JsonException)
        {
            Trace.TraceWarning("[CalendarStoreService] settings.json is invalid JSON; using defaults until next save.");
            return CreateDefaultSettings();
        }
    }

    private bool SettingsFileHasTagsKey()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return false;
            var raw = File.ReadAllText(SettingsPath, Encoding.UTF8).Trim();
            if (raw.Length == 0) return false;
            return JsonNode.Parse(raw) is JsonObject parsed && parsed.ContainsKey("tags");
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private JsonArray ReadTagsArray()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return new JsonArray();
            var raw = File.ReadAllText(SettingsPath, Encoding.UTF8).Trim();
            if (raw.Length == 0) return new JsonArray();
            var parsed = JsonNode.Parse(raw) as JsonObject;
            if (parsed is null || !parsed.ContainsKey("tags")) return new JsonArray();
            return NormalizeTagsArray(GetArray(parsed, "tags"));
        }
        catch (JsonException)
        {
            Trace.TraceWarning("[CalendarStoreService] settings.json tags unreadable; using empty list.");
            return new JsonArray();
        }
    }

    private void WriteSettingsFile(JsonObject? settings, JsonArray? tags = null)
    {
        Directory.CreateDirectory(_dataRoot);
        var tagsToWrite = tags is not null
            ? NormalizeTagsArray(tags)
            : (SettingsFileHasTagsKey() ? ReadTagsArray() : DefaultTagsArray());
        var payload = new JsonObject
        {
            ["version"] = StoreFormatVersion,
            ["settings"] = NormalizeSettings(settings),
            ["tags"] = tagsToWrite,
            ["updatedAt"] = NowIso(),
        };
        WriteFileAtomic(SettingsPath, payload.ToJsonString(WriteOptions));
    }

    private static void WriteFileAtomic(string filePath, string contents)
    {
        var dir = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var tempPath = Path.Combine(
            dir ?? "",
            $".{Path.GetFileName(filePath)}.{Environment.ProcessId}.{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.tmp");
        try
        {
            File.WriteAllText(tempPath, contents, Encoding.UTF8);
            TryClearReadOnly(filePath);
            try
            {
                File.Move(tempPath, filePath, overwrite: true);
            }
            catch (UnauthorizedAccessException)
            {
                // MSI-seeded or locked files: clear + replace via delete when Move overwrite fails.
                TryClearReadOnly(filePath);
                if (File.Exists(filePath))
                {
                    File.Delete(filePath);
                }

                File.Move(tempPath, filePath);
            }
        }
        catch
        {
            try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch (IOException) { /* ignore */ }
            throw;
        }
    }

    private static void TryClearReadOnly(string filePath)
    {
        try
        {
            if (!File.Exists(filePath))
            {
                return;
            }

            var attrs = File.GetAttributes(filePath);
            if ((attrs & FileAttributes.ReadOnly) != 0)
            {
                File.SetAttributes(filePath, attrs & ~FileAttributes.ReadOnly);
            }
        }
        catch (Exception)
        {
            /* best-effort */
        }
    }

    private JsonObject EmptyStore(JsonObject? settings = null, JsonArray? tags = null)
    {
        return new JsonObject
        {
            ["version"] = StoreFormatVersion,
            ["settings"] = NormalizeSettings(settings ?? CreateDefaultSettings()),
            ["calendars"] = new JsonArray(),
            ["events"] = new JsonArray(),
            ["tags"] = tags is not null ? NormalizeTagsArray(tags) : DefaultTagsArray(),
            ["updatedAt"] = NowIso(),
        };
    }

    // ---------------------------------------------------------------------
    // Normalization
    // ---------------------------------------------------------------------

    private JsonObject NormalizeSettings(JsonObject? settings)
    {
        var defaults = CreateDefaultSettings();
        if (settings is null) return defaults;

        var notifications = MergeObjects(GetObject(defaults, "notifications"), GetObject(settings, "notifications"));
        if (GetString(notifications, "enabled") == "email") notifications["enabled"] = "none";

        var holidaysKr = NormalizeHolidaysKr(MergeObjects(GetObject(defaults, "holidaysKr"), GetObject(settings, "holidaysKr")));

        var result = MergeObjects(defaults, settings);
        result["notifications"] = notifications;
        result["viewOptions"] = MergeObjects(GetObject(defaults, "viewOptions"), GetObject(settings, "viewOptions"));
        result["holidaysKr"] = holidaysKr;
        result["widget"] = NormalizeWidget(GetObject(defaults, "widget"), GetObject(settings, "widget"));
        // Must DeepClone — nested maps are still parented under `settings`.
        result["dayColors"] = GetObject(settings, "dayColors")?.DeepClone() as JsonObject ?? new JsonObject();
        result["dayColorsByLoginId"] = GetObject(settings, "dayColorsByLoginId")?.DeepClone() as JsonObject
            ?? new JsonObject();
        result["hiddenCalendarIdsByLoginId"] = GetObject(settings, "hiddenCalendarIdsByLoginId")?.DeepClone() as JsonObject
            ?? new JsonObject();
        EnsureDayColorsMigrated(result, AppConstants.DefaultAdminId);
        result["allowedIpCidrs"] = IpAccessGuard.NormalizeAllowedIpCidrs(settings["allowedIpCidrs"]);
        return result;
    }

    private static JsonObject NormalizeHolidaysKr(JsonObject holidaysKr)
    {
        holidaysKr["serviceKey"] = GetString(holidaysKr, "serviceKey", "").Trim();
        var rememberKey = GetBool(holidaysKr, "rememberKey") && GetString(holidaysKr, "serviceKey", "").Length > 0;
        holidaysKr["rememberKey"] = rememberKey;
        if (!rememberKey) holidaysKr["serviceKey"] = "";
        return holidaysKr;
    }

    private static JsonObject NormalizeWidget(JsonObject? defaultsWidget, JsonObject? inputWidget)
    {
        var merged = MergeObjects(defaultsWidget, inputWidget);
        merged["launchMode"] = NormalizeWidgetLaunchMode(inputWidget);
        var launchMode = GetString(merged, "launchMode", "window");
        merged["enabled"] = launchMode == "desktop";
        merged["embedStrategy"] = NormalizeEmbedStrategy(
            GetStringOrNull(inputWidget, "embedStrategy") ?? GetStringOrNull(merged, "embedStrategy"));
        merged["inputForward"] = NormalizeInputForwardMode(
            GetStringOrNull(inputWidget, "inputForward") ?? GetStringOrNull(merged, "inputForward"));
        merged["opacity"] = Math.Clamp(GetDouble(merged, "opacity", AppConstants.DefaultOpacity), AppConstants.MinOpacity, 1.0);
        merged["chromeTopInset"] = ClampInt(GetDouble(inputWidget, "chromeTopInset", 0), 0, 200);
        merged["chromeLeftInset"] = ClampInt(GetDouble(inputWidget, "chromeLeftInset", 0), 0, 80);
        merged["chromeRightInset"] = ClampInt(GetDouble(inputWidget, "chromeRightInset", 0), 0, 80);
        merged["chromeBottomInset"] = ClampInt(GetDouble(inputWidget, "chromeBottomInset", 0), 0, 80);
        merged["bounds"] = MergeObjects(GetObject(defaultsWidget, "bounds"), GetObject(inputWidget, "bounds"));
        merged["margins"] = MergeObjects(GetObject(defaultsWidget, "margins"), GetObject(inputWidget, "margins"));
        return merged;
    }

    private static string NormalizeWidgetLaunchMode(JsonObject? widget)
    {
        var launchMode = GetStringOrNull(widget, "launchMode");
        if (launchMode == "desktop") return "desktop";
        if (launchMode == "window") return "window";
        return GetBool(widget, "enabled", false) ? "desktop" : "window";
    }

    private static readonly string[] EmbedStrategyOptions = ["auto", "raised", "workerw", "progman", "zorder"];

    private static string NormalizeEmbedStrategy(string? value)
    {
        var key = (value ?? "").Trim().ToLowerInvariant();
        return Array.IndexOf(EmbedStrategyOptions, key) >= 0 ? key : "auto";
    }

    private static readonly string[] InputForwardOptions = ["auto", "on", "off"];

    private static string NormalizeInputForwardMode(string? value)
    {
        var key = (value ?? "").Trim().ToLowerInvariant();
        return Array.IndexOf(InputForwardOptions, key) >= 0 ? key : "auto";
    }

    private static JsonObject NormalizeCalendarCustomFlag(JsonObject calendar)
    {
        var clone = (JsonObject)calendar.DeepClone();
        if (clone.TryGetPropertyValue("custom", out var customNode) &&
            customNode is JsonValue customValue &&
            customValue.TryGetValue<bool>(out _))
        {
            return clone;
        }

        var owner = GetStringOrNull(clone, "owner");
        var id = GetString(clone, "id", "");
        clone["custom"] = !(owner == "shared" || BuiltinCalendarIds.Contains(id));
        return clone;
    }

    private static JsonObject NormalizeCalendarRecord(JsonObject calendar, HashSet<string> usedDataKeys)
    {
        var normalized = NormalizeCalendarCustomFlag(calendar);
        var dataKey = GetStringOrNull(normalized, "dataKey") ?? GetStringOrNull(normalized, "id") ?? "";
        if (dataKey.Length == 0 || usedDataKeys.Contains(dataKey))
        {
            dataKey = NewId();
        }
        usedDataKeys.Add(dataKey);
        normalized["dataKey"] = dataKey;
        return normalized;
    }

    private static JsonNode ComputeCustomFlag(JsonObject payload, JsonObject? existing)
    {
        if (payload.TryGetPropertyValue("custom", out var customNode) &&
            customNode is JsonValue customValue &&
            customValue.TryGetValue<bool>(out var customBool))
        {
            return customBool;
        }

        if (existing is not null)
        {
            if (existing.TryGetPropertyValue("custom", out var existingCustom) &&
                existingCustom is JsonValue existingValue &&
                existingValue.TryGetValue<bool>(out var existingBool))
            {
                return existingBool;
            }
            return !BuiltinCalendarIds.Contains(GetString(existing, "id"));
        }

        return true;
    }

    private static string ResolveCalendarId(JsonObject store, string? calendarId)
    {
        var calendars = GetArray(store, "calendars") ?? new JsonArray();
        if (!string.IsNullOrEmpty(calendarId) && calendars.Any(c => c is JsonObject co && GetString(co, "id") == calendarId))
        {
            return calendarId;
        }

        var preferred = calendars.FirstOrDefault(c => c is JsonObject co && GetBool(co, "visible", true)) as JsonObject;
        var preferredId = preferred is not null ? GetStringOrNull(preferred, "id") : null;
        if (preferredId is not null) return preferredId;

        var firstId = calendars.Count > 0 && calendars[0] is JsonObject first ? GetStringOrNull(first, "id") : null;
        return firstId ?? calendarId ?? AppConstants.PrimaryCalendarId;
    }

    private static List<JsonObject> SortCalendars(List<JsonObject> calendars)
    {
        var order = new Dictionary<string, int>();
        var defaults = DefaultCalendarsArray();
        for (var i = 0; i < defaults.Count; i++)
        {
            order[GetString((JsonObject)defaults[i]!, "id")] = i;
        }

        var koreanComparer = StringComparer.Create(CultureInfo.GetCultureInfo("ko-KR"), ignoreCase: false);
        return calendars
            .OrderBy(c => order.TryGetValue(GetString(c, "id"), out var idx) ? idx : int.MaxValue)
            .ThenBy(c => GetString(c, "name"), koreanComparer)
            .ToList();
    }

    private static JsonNode? ComputeRepeatCount(JsonObject payload, string repeat)
    {
        if (repeat == "none") return null;
        var count = GetDouble(payload, "repeatCount", double.NaN);
        return !double.IsNaN(count) && count > 0 ? (int)Math.Floor(count) : null;
    }

    // ---------------------------------------------------------------------
    // Defaults (mirrors shared/constants.js)
    // ---------------------------------------------------------------------

    private static JsonArray DefaultCalendarsArray()
    {
        return new JsonArray
        {
            new JsonObject
            {
                ["id"] = AppConstants.PrimaryCalendarId,
                ["name"] = "기본 캘린더",
                ["color"] = AppConstants.PrimaryCalendarColor,
                ["visible"] = true,
                ["owner"] = "local",
            },
            new JsonObject
            {
                ["id"] = AppConstants.HolidaysKrCalendarId,
                ["name"] = "대한민국의 휴일",
                ["color"] = "#d50000",
                ["visible"] = true,
                ["owner"] = "shared",
            },
        };
    }

    /// <summary>Mirrors shared/constants.js DEFAULT_TAGS.</summary>
    private static JsonArray DefaultTagsArray()
    {
        return new JsonArray
        {
            new JsonObject { ["id"] = "tag-admin", ["name"] = "행정", ["color"] = "#039be5", ["sortOrder"] = 0 },
            new JsonObject { ["id"] = "tag-work", ["name"] = "작업", ["color"] = "#ffe252", ["sortOrder"] = 1 },
            new JsonObject { ["id"] = "tag-duty", ["name"] = "회의", ["color"] = "#8e24aa", ["sortOrder"] = 2 },
            new JsonObject { ["id"] = "tag-trip", ["name"] = "출장", ["color"] = "#f4511e", ["sortOrder"] = 3 },
            new JsonObject { ["id"] = "tag-personal", ["name"] = "개인", ["color"] = "#33b679", ["sortOrder"] = 4 },
        };
    }

    private static JsonArray NormalizeTagsArray(JsonArray? tags)
    {
        var list = new List<JsonObject>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        if (tags is null) return new JsonArray();

        var index = 0;
        foreach (var node in tags)
        {
            if (node is not JsonObject tag) continue;
            var id = GetString(tag, "id").Trim();
            var name = GetString(tag, "name").Trim();
            if (id.Length == 0 || name.Length == 0 || !seen.Add(id)) continue;
            list.Add(new JsonObject
            {
                ["id"] = id,
                ["name"] = name,
                ["color"] = GetStringOrNull(tag, "color"),
                ["sortOrder"] = ClampInt(GetDouble(tag, "sortOrder", index), 0, 1_000_000),
            });
            index++;
        }

        return SortTagsList(list);
    }

    private static JsonArray SortTagsArray(JsonArray tags)
    {
        // Detach clones — JsonNode cannot be re-parented into a new array.
        var list = tags.OfType<JsonObject>().Select(t => (JsonObject)t.DeepClone()).ToList();
        return SortTagsList(list);
    }

    private static JsonArray SortTagsList(List<JsonObject> list)
    {
        var koreanComparer = StringComparer.Create(CultureInfo.GetCultureInfo("ko-KR"), ignoreCase: false);
        list.Sort((a, b) =>
        {
            var ao = (int)GetDouble(a, "sortOrder", int.MaxValue);
            var bo = (int)GetDouble(b, "sortOrder", int.MaxValue);
            if (ao != bo) return ao.CompareTo(bo);
            return koreanComparer.Compare(GetString(a, "name"), GetString(b, "name"));
        });
        return ToJsonArray(list);
    }

    private static JsonArray NormalizeEventTagIds(JsonObject store, JsonArray tagIds)
    {
        var known = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in GetArray(store, "tags") ?? new JsonArray())
        {
            if (node is JsonObject tag)
            {
                var id = GetString(tag, "id");
                if (id.Length > 0) known.Add(id);
            }
        }

        var result = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in tagIds)
        {
            var id = ToStringValue(node);
            if (id.Length == 0 || !seen.Add(id)) continue;
            if (known.Count > 0 && !known.Contains(id)) continue;
            result.Add((JsonNode)id);
        }
        return result;
    }

    private static JsonObject CreateDefaultSettings()
    {
        return new JsonObject
        {
            ["ownerName"] = "박순표",
            ["timezone"] = "Asia/Seoul",
            ["timezoneLabel"] = "(GMT+09:00) 한국 표준시 - 서울",
            ["notifications"] = new JsonObject
            {
                ["enabled"] = "none",
                ["reminderTiming"] = "1min",
                ["playSound"] = true,
                ["onlyYesOrMaybe"] = false,
            },
            ["viewOptions"] = new JsonObject
            {
                ["showWeekNumbers"] = true,
                ["weekStartsOnSunday"] = true,
                    ["colorScheme"] = "light",
                ["accentColor"] = "#1976d2",
                ["runAtStartup"] = true,
                ["eventsHidden"] = false,
                ["completedHidden"] = false,
            },
            ["holidaysKr"] = new JsonObject
            {
                ["serviceKey"] = "",
                ["rememberKey"] = false,
                ["ok"] = null,
                ["skipped"] = false,
                ["reason"] = null,
                ["message"] = null,
                ["years"] = new JsonArray(),
                ["count"] = 0,
                ["lastSyncedAt"] = null,
            },
            ["widget"] = new JsonObject
            {
                ["launchMode"] = "window",
                ["enabled"] = false,
                ["alwaysOnTop"] = false,
                ["opacity"] = AppConstants.DefaultOpacity,
                ["chromeTopInset"] = 0,
                ["chromeLeftInset"] = 0,
                ["chromeRightInset"] = 0,
                ["chromeBottomInset"] = 0,
                ["embedStrategy"] = "auto",
                ["inputForward"] = "auto",
                ["bounds"] = new JsonObject { ["x"] = 400, ["y"] = 60, ["width"] = 1480, ["height"] = 950 },
                ["margins"] = new JsonObject { ["left"] = 0.2, ["top"] = 0.05, ["right"] = 0.05, ["bottom"] = 0.05 },
            },
            ["dayColors"] = new JsonObject(),
            ["dayColorsByLoginId"] = new JsonObject(),
            ["hiddenCalendarIdsByLoginId"] = new JsonObject(),
            ["allowedIpCidrs"] = new JsonArray(),
        };
    }

    /// <summary>
    /// Move legacy flat <c>dayColors</c> (date → color) into <c>dayColorsByLoginId[fallbackOwner]</c>.
    /// </summary>
    private static void EnsureDayColorsMigrated(JsonObject settings, string fallbackOwner)
    {
        var owner = (fallbackOwner ?? "").Trim();
        if (owner.Length == 0) owner = AppConstants.DefaultAdminId;

        var byLogin = GetObject(settings, "dayColorsByLoginId");
        if (byLogin is null)
        {
            byLogin = new JsonObject();
            settings["dayColorsByLoginId"] = byLogin;
        }

        var flat = GetObject(settings, "dayColors");
        if (flat is not null && LooksLikeFlatDayColorMap(flat))
        {
            var existingKey = FindDayColorsLoginKey(byLogin, owner);
            var existingMap = existingKey is null ? null : GetObject(byLogin, existingKey);
            if (existingMap is null || existingMap.Count == 0)
            {
                byLogin[owner] = flat.DeepClone();
            }

            settings["dayColors"] = new JsonObject();
        }
        else if (flat is null)
        {
            settings["dayColors"] = new JsonObject();
        }
    }

    private static bool LooksLikeFlatDayColorMap(JsonObject obj)
    {
        if (obj.Count == 0) return false;
        foreach (var prop in obj)
        {
            // Nested object ⇒ already per-member shaped (should not live under dayColors).
            if (prop.Value is JsonObject) return false;
            if (prop.Key.Length == 10 && prop.Key[4] == '-' && prop.Key[7] == '-') return true;
        }

        // Non-date string keys with string colors — treat as legacy flat map.
        return obj.All(p => p.Value is JsonValue);
    }

    private static string? FindDayColorsLoginKey(JsonObject byLogin, string loginId)
    {
        foreach (var prop in byLogin)
        {
            if (string.Equals(prop.Key, loginId, StringComparison.OrdinalIgnoreCase))
            {
                return prop.Key;
            }
        }

        return null;
    }

    private static JsonObject GetDayColorsForLogin(JsonObject settings, string loginId)
    {
        var byLogin = GetObject(settings, "dayColorsByLoginId") ?? new JsonObject();
        var key = FindDayColorsLoginKey(byLogin, loginId);
        if (key is null) return new JsonObject();
        return GetObject(byLogin, key) ?? new JsonObject();
    }

    private static void SetDayColorsForLogin(JsonObject settings, string loginId, JsonObject dayColors)
    {
        var byLogin = GetObject(settings, "dayColorsByLoginId") ?? new JsonObject();
        var key = FindDayColorsLoginKey(byLogin, loginId) ?? loginId;
        byLogin[key] = dayColors.DeepClone();
        settings["dayColorsByLoginId"] = byLogin;
        settings["dayColors"] = new JsonObject();
    }

    // ---------------------------------------------------------------------
    // JsonNode helpers
    // ---------------------------------------------------------------------

    private static JsonObject? GetObject(JsonObject? obj, string key) =>
        obj is not null && obj.TryGetPropertyValue(key, out var node) && node is JsonObject jo ? jo : null;

    private static JsonArray? GetArray(JsonObject? obj, string key) =>
        obj is not null && obj.TryGetPropertyValue(key, out var node) && node is JsonArray ja ? ja : null;

    private static string? GetStringOrNull(JsonObject? obj, string key)
    {
        if (obj is null || !obj.TryGetPropertyValue(key, out var node) || node is null) return null;
        return node is JsonValue value ? ToStringValue(value) : null;
    }

    private static string GetString(JsonObject? obj, string key, string fallback = "") =>
        GetStringOrNull(obj, key) ?? fallback;

    private static bool GetBool(JsonObject? obj, string key, bool fallback = false)
    {
        if (obj is null || !obj.TryGetPropertyValue(key, out var node) || node is null) return fallback;
        return node is JsonValue value && value.TryGetValue<bool>(out var b) ? b : fallback;
    }

    private static double GetDouble(JsonObject? obj, string key, double fallback = 0)
    {
        if (obj is null || !obj.TryGetPropertyValue(key, out var node) || node is null) return fallback;
        if (node is not JsonValue value) return fallback;
        if (value.TryGetValue<double>(out var d)) return d;
        if (value.TryGetValue<int>(out var i)) return i;
        if (value.TryGetValue<long>(out var l)) return l;
        if (value.TryGetValue<string>(out var s) && double.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed)) return parsed;
        return fallback;
    }

    private static int GetInt(JsonObject? obj, string key, int fallback = 0)
    {
        if (obj is null || !obj.TryGetPropertyValue(key, out var node) || node is null) return fallback;
        if (node is not JsonValue value) return fallback;
        if (value.TryGetValue<int>(out var i)) return i;
        if (value.TryGetValue<double>(out var d)) return (int)d;
        return fallback;
    }

    private static string ToStringValue(JsonNode? node)
    {
        if (node is not JsonValue value) return "";
        return value.TryGetValue<string>(out var s) ? s : value.ToJsonString();
    }

    private static JsonNode? CloneOrNull(JsonObject obj, string key) =>
        obj.TryGetPropertyValue(key, out var node) ? node?.DeepClone() : null;

    private static JsonArray? GetArrayClone(JsonObject obj, string key) =>
        GetArray(obj, key) is { } array ? (JsonArray)array.DeepClone() : null;

    private static JsonArray GetStringArray(JsonObject? obj, string key)
    {
        var result = new JsonArray();
        var array = GetArray(obj, key);
        if (array is null) return result;
        foreach (var item in array)
        {
            // Cast avoids JsonArray.Add(string) overloads that break ToJsonString on .NET 8+.
            result.Add((JsonNode)ToStringValue(item));
        }
        return result;
    }

    private static JsonObject MergeObjects(JsonObject? a, JsonObject? b)
    {
        var result = new JsonObject();
        if (a is not null) foreach (var kv in a) result[kv.Key] = kv.Value?.DeepClone();
        if (b is not null) foreach (var kv in b) result[kv.Key] = kv.Value?.DeepClone();
        return result;
    }

    private static JsonArray ToJsonArray(IEnumerable<JsonObject> items)
    {
        var array = new JsonArray();
        foreach (var item in items) array.Add(item);
        return array;
    }

    private static JsonObject? FindById(JsonArray? array, string id) =>
        array?.FirstOrDefault(n => n is JsonObject o && GetString(o, "id") == id) as JsonObject;

    private static JsonObject CloneDetached(JsonObject obj) => (JsonObject)obj.DeepClone();

    private static int ClampInt(double value, int min, int max) => (int)Math.Clamp(Math.Round(value), min, max);

    private static string NewId() => Guid.NewGuid().ToString();

    private static string NowIso() => DateTime.UtcNow.ToString("o");

    /// <summary>
    /// Prefer <c>links[]</c>; migrate legacy <c>link</c> string; keep <c>link</c> as first URL for older clients.
    /// </summary>
    private static void NormalizeEventLinks(JsonObject evt)
    {
        var linksArr = new JsonArray();
        if (evt["links"] is JsonArray existing)
        {
            foreach (var node in existing)
            {
                if (node is JsonObject o)
                {
                    var url = NormalizeLinkUrl(o["url"]?.GetValue<string>() ?? o["href"]?.GetValue<string>() ?? "");
                    if (string.IsNullOrEmpty(url)) continue;
                    var id = o["id"]?.GetValue<string>()?.Trim();
                    if (string.IsNullOrWhiteSpace(id)) id = Guid.NewGuid().ToString("N");
                    var title = o["title"]?.GetValue<string>()?.Trim() ?? "";
                    linksArr.Add(new JsonObject
                    {
                        ["id"] = id,
                        ["url"] = url,
                        ["title"] = title,
                    });
                }
                else if (node is JsonValue jv && jv.TryGetValue<string>(out var s))
                {
                    var url = NormalizeLinkUrl(s);
                    if (string.IsNullOrEmpty(url)) continue;
                    linksArr.Add(new JsonObject
                    {
                        ["id"] = Guid.NewGuid().ToString("N"),
                        ["url"] = url,
                        ["title"] = "",
                    });
                }
            }
        }

        if (linksArr.Count == 0)
        {
            var legacy = NormalizeLinkUrl(evt["link"]?.GetValue<string>() ?? "");
            if (!string.IsNullOrEmpty(legacy))
            {
                linksArr.Add(new JsonObject
                {
                    ["id"] = Guid.NewGuid().ToString("N"),
                    ["url"] = legacy,
                    ["title"] = "",
                });
            }
        }

        evt["links"] = linksArr;
        evt["link"] = linksArr.Count > 0
            ? (linksArr[0] as JsonObject)?["url"]?.GetValue<string>() ?? ""
            : "";
    }

    private static string NormalizeLinkUrl(string? raw)
    {
        var t = (raw ?? "").Trim();
        if (string.IsNullOrEmpty(t)) return "";
        if (t.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || t.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return t;
        return "https://" + t;
    }
}
