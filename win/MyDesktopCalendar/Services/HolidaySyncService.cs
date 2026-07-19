using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace MyDesktopCalendar.Services;

internal static class HolidaySyncService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

    /// <summary>
    /// On startup: if holidays-kr has no events, load bundled seed only (never call the network).
    /// Preserves holidaysKr.serviceKey / rememberKey from MSI-seeded settings.json / .env.
    /// </summary>
    public static void SeedFromBundleIfEmpty(CalendarStoreService store)
    {
        try
        {
            var data = store.ReadStore();
            var hasEvents = data["events"] is JsonArray events
                && events.Any(e => e is JsonObject ev
                    && string.Equals(
                        ev["calendarId"]?.GetValue<string>(),
                        AppConstants.HolidaysKrCalendarId,
                        StringComparison.Ordinal));

            if (hasEvents)
            {
                return;
            }

            var seedEvents = TryLoadSeedEvents();
            store.EnsureHolidaysKrCalendar();
            if (seedEvents.Count == 0)
            {
                return;
            }

            var year = DateTime.Now.Year;
            var years = new HashSet<int> { year - 1, year, year + 1 };
            var filtered = seedEvents
                .Where(e => YearOf(e) is int yy && years.Contains(yy))
                .ToList();
            if (filtered.Count == 0)
            {
                filtered = seedEvents;
            }

            store.ReplaceHolidaysKrEvents(filtered);

            // Patch status only — do not touch serviceKey / rememberKey.
            store.PatchSettings(new JsonObject
            {
                ["holidaysKr"] = new JsonObject
                {
                    ["ok"] = true,
                    ["skipped"] = false,
                    ["reason"] = null,
                    ["message"] = "번들 시드에서 불러옴",
                    ["years"] = new JsonArray(years.Select(y => (JsonNode)y).ToArray()),
                    ["count"] = filtered.Count,
                    ["lastSyncedAt"] = DateTime.UtcNow.ToString("o"),
                    ["source"] = "seed",
                },
            });
        }
        catch (Exception ex)
        {
            System.Diagnostics.Trace.TraceWarning($"[holidays-kr] startup seed failed: {ex.Message}");
            try
            {
                store.EnsureHolidaysKrCalendar();
            }
            catch
            {
                /* ignore */
            }
        }
    }

    public static JsonObject Sync(CalendarStoreService store, JsonObject body)
    {
        var settings = store.ReadStore()["settings"] as JsonObject ?? new JsonObject();
        var holidaysKr = settings["holidaysKr"] as JsonObject ?? new JsonObject();
        var serviceKey = body["serviceKey"]?.GetValue<string>()?.Trim()
            ?? (holidaysKr["rememberKey"]?.GetValue<bool>() == true
                ? holidaysKr["serviceKey"]?.GetValue<string>()?.Trim()
                : null)
            ?? "";

        var years = new List<int>();
        if (body["years"] is JsonArray arr)
        {
            foreach (var n in arr)
            {
                if (n is JsonValue v && v.TryGetValue<int>(out var y))
                {
                    years.Add(y);
                }
            }
        }

        if (years.Count == 0)
        {
            var y = DateTime.Now.Year;
            years.AddRange([y - 1, y, y + 1]);
        }

        // Prefer seed file bundled next to app / shared seed.
        var seedEvents = TryLoadSeedEvents();
        List<JsonObject> events;
        string source;

        if (!string.IsNullOrEmpty(serviceKey))
        {
            try
            {
                events = FetchFromApi(serviceKey, years);
                source = "api";
            }
            catch (Exception ex)
            {
                if (seedEvents.Count > 0)
                {
                    events = seedEvents.Where(e => YearOf(e) is int yy && years.Contains(yy)).ToList();
                    source = "seed-fallback";
                    holidaysKr["message"] = $"API 실패({ex.Message}) — 시드 데이터 사용";
                }
                else
                {
                    throw;
                }
            }
        }
        else if (seedEvents.Count > 0)
        {
            events = seedEvents.Where(e => YearOf(e) is int yy && years.Contains(yy)).ToList();
            source = "seed";
        }
        else
        {
            throw new InvalidOperationException("공공데이터포털 API 키가 없고 시드 데이터도 없습니다.");
        }

        var calendar = new JsonObject
        {
            ["id"] = AppConstants.HolidaysKrCalendarId,
            ["name"] = "대한민국의 휴일",
            ["color"] = "#d50000",
            ["visible"] = true,
            ["owner"] = "shared",
            ["custom"] = false,
            ["dataKey"] = AppConstants.HolidaysKrCalendarId,
        };

        store.UpsertCalendar(calendar);
        store.ReplaceHolidaysKrEvents(events);

        var rememberExplicit = body.ContainsKey("rememberKey");
        var remember = rememberExplicit
            ? body["rememberKey"]?.GetValue<bool>() == true
            : holidaysKr["rememberKey"]?.GetValue<bool>() == true;
        var keyToStore = remember
            ? (!string.IsNullOrEmpty(serviceKey)
                ? serviceKey
                : holidaysKr["serviceKey"]?.GetValue<string>()?.Trim() ?? "")
            : "";
        var patch = new JsonObject
        {
            ["holidaysKr"] = new JsonObject
            {
                ["serviceKey"] = keyToStore,
                ["rememberKey"] = remember && !string.IsNullOrEmpty(keyToStore),
                ["ok"] = true,
                ["skipped"] = false,
                ["reason"] = null,
                ["message"] = holidaysKr["message"]?.GetValue<string>(),
                ["years"] = new JsonArray(years.Select(y => (JsonNode)y).ToArray()),
                ["count"] = events.Count,
                ["lastSyncedAt"] = DateTime.UtcNow.ToString("o"),
                ["source"] = source,
            },
        };
        store.PatchSettings(patch);

        return new JsonObject
        {
            ["ok"] = true,
            ["count"] = events.Count,
            ["years"] = new JsonArray(years.Select(y => (JsonNode)y).ToArray()),
            ["source"] = source,
        };
    }

    private static int? YearOf(JsonObject ev)
    {
        var start = ev["startDate"]?.GetValue<string>() ?? ev["date"]?.GetValue<string>();
        if (start is null || start.Length < 4)
        {
            return null;
        }

        return int.TryParse(start[..4], out var y) ? y : null;
    }

    private static List<JsonObject> TryLoadSeedEvents()
    {
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "seed", "holidays-kr.json"),
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "shared", "seed", "holidays-kr.json"),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "shared", "seed", "holidays-kr.json")),
        };

        foreach (var path in candidates)
        {
            try
            {
                if (!File.Exists(path))
                {
                    continue;
                }

                var root = JsonNode.Parse(File.ReadAllText(path));
                var events = root?["events"] as JsonArray ?? root as JsonArray;
                if (events is null)
                {
                    continue;
                }

                return events.OfType<JsonObject>().Select(e => e.DeepClone()!.AsObject()).ToList();
            }
            catch
            {
                /* try next */
            }
        }

        return [];
    }

    private static List<JsonObject> FetchFromApi(string serviceKey, List<int> years)
    {
        var encoded = System.Text.RegularExpressions.Regex.IsMatch(serviceKey, "%[0-9A-Fa-f]{2}")
            ? serviceKey
            : Uri.EscapeDataString(serviceKey);

        var list = new List<JsonObject>();
        foreach (var year in years)
        {
            for (var month = 1; month <= 12; month++)
            {
                var url =
                    $"https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo?serviceKey={encoded}&solYear={year}&solMonth={month:D2}&numOfRows=100&_type=json";
                var json = Http.GetStringAsync(url).GetAwaiter().GetResult();
                using var doc = JsonDocument.Parse(json);
                if (!doc.RootElement.TryGetProperty("response", out var response))
                {
                    // try XML
                    list.AddRange(ParseXmlHolidays(json, year));
                    continue;
                }

                if (!response.TryGetProperty("body", out var bodyEl)
                    || !bodyEl.TryGetProperty("items", out var itemsEl))
                {
                    continue;
                }

                JsonElement itemEl;
                if (itemsEl.ValueKind == JsonValueKind.String)
                {
                    continue;
                }

                if (!itemsEl.TryGetProperty("item", out itemEl))
                {
                    continue;
                }

                IEnumerable<JsonElement> items = itemEl.ValueKind == JsonValueKind.Array
                    ? itemEl.EnumerateArray()
                    : [itemEl];

                foreach (var item in items)
                {
                    var locdate = item.TryGetProperty("locdate", out var ld) ? ld.ToString() : "";
                    var dateName = item.TryGetProperty("dateName", out var dn) ? dn.GetString() ?? "휴일" : "휴일";
                    var digits = new string(locdate.Where(char.IsDigit).ToArray());
                    if (digits.Length != 8)
                    {
                        continue;
                    }

                    var dateKey = $"{digits[..4]}-{digits[4..6]}-{digits[6..8]}";
                    list.Add(new JsonObject
                    {
                        ["id"] = $"kr-holiday-{digits}",
                        ["title"] = dateName,
                        ["allDay"] = true,
                        ["startDate"] = dateKey,
                        ["endDate"] = dateKey,
                        ["calendarId"] = AppConstants.HolidaysKrCalendarId,
                    });
                }
            }
        }

        return list;
    }

    private static List<JsonObject> ParseXmlHolidays(string xml, int year)
    {
        try
        {
            var doc = XDocument.Parse(xml);
            return doc.Descendants("item").Select(item =>
            {
                var locdate = (string?)item.Element("locdate") ?? "";
                var dateName = (string?)item.Element("dateName") ?? "휴일";
                var digits = new string(locdate.Where(char.IsDigit).ToArray());
                if (digits.Length != 8)
                {
                    return null;
                }

                var dateKey = $"{digits[..4]}-{digits[4..6]}-{digits[6..8]}";
                return new JsonObject
                {
                    ["id"] = $"kr-holiday-{digits}",
                    ["title"] = dateName,
                    ["allDay"] = true,
                    ["startDate"] = dateKey,
                    ["endDate"] = dateKey,
                    ["calendarId"] = AppConstants.HolidaysKrCalendarId,
                };
            }).Where(x => x is not null).Cast<JsonObject>().ToList();
        }
        catch
        {
            return [];
        }
    }
}
