using System.Diagnostics;
using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using Win32OpenFileDialog = Microsoft.Win32.OpenFileDialog;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Event file attachments live under <c>data/attachments/{eventId}/</c>.
/// Metadata is stored on the event as <c>attachments[]</c>.
/// </summary>
internal sealed class EventAttachmentService
{
    public const int MaxAttachmentsPerEvent = 10;
    public const long MaxFileBytes = 20L * 1024 * 1024;

    private static readonly HashSet<string> BlockedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".bat", ".cmd", ".com", ".msi", ".scr", ".ps1", ".vbs", ".js", ".jse",
        ".wsf", ".wsh", ".reg", ".dll", ".sys",
    };

    private readonly CalendarStoreService _store;
    private readonly string _attachmentsRoot;

    public EventAttachmentService(CalendarStoreService store)
    {
        _store = store;
        _attachmentsRoot = Path.Combine(store.DataRoot, "attachments");
    }

    public string EventDir(string eventId) => Path.Combine(_attachmentsRoot, SanitizeId(eventId));

    /// <summary>Open a multi-select file dialog, copy into the event folder, patch metadata.</summary>
    public JsonObject AddFromPicker(Window owner, string eventId)
    {
        var current = RequireEditableEvent(eventId);
        var attachments = GetAttachments(current);
        if (attachments.Count >= MaxAttachmentsPerEvent)
        {
            throw new InvalidOperationException($"첨부 파일은 일정당 최대 {MaxAttachmentsPerEvent}개까지 가능합니다.");
        }

        // OpenFileDialog must be created and shown on the WPF UI thread —
        // NativeBridge Dispatch runs on a worker thread via Task.Run.
        string[] selected = Array.Empty<string>();
        var ok = owner.Dispatcher.Invoke(() =>
        {
            var dialog = new Win32OpenFileDialog
            {
                Title = "일정에 첨부할 파일 선택",
                Multiselect = true,
                CheckFileExists = true,
                CheckPathExists = true,
            };
            if (dialog.ShowDialog(owner) != true) return false;
            selected = dialog.FileNames ?? Array.Empty<string>();
            return selected.Length > 0;
        });
        if (!ok)
        {
            return CloneEvent(current);
        }

        var dir = EventDir(eventId);
        Directory.CreateDirectory(dir);

        var remaining = MaxAttachmentsPerEvent - attachments.Count;
        foreach (var sourcePath in selected.Take(remaining))
        {
            AddOneFile(attachments, dir, sourcePath);
        }

        return SaveAttachments(eventId, attachments);
    }

    public JsonObject Remove(string eventId, string attachmentId)
    {
        var current = RequireEditableEvent(eventId);
        var attachments = GetAttachments(current);
        var index = attachments.FindIndex(a =>
            string.Equals(a["id"]?.GetValue<string>(), attachmentId, StringComparison.Ordinal));
        if (index < 0)
        {
            throw new InvalidOperationException("첨부 파일을 찾을 수 없습니다.");
        }

        var removed = attachments[index];
        attachments.RemoveAt(index);
        TryDeleteStoredFile(eventId, removed);
        var updated = SaveAttachments(eventId, attachments);
        TryDeleteEmptyEventDir(eventId);
        return updated;
    }

    public void Open(string eventId, string attachmentId)
    {
        var current = RequireEditableEvent(eventId, allowHolidays: false);
        var attachments = GetAttachments(current);
        var meta = attachments.FirstOrDefault(a =>
            string.Equals(a["id"]?.GetValue<string>(), attachmentId, StringComparison.Ordinal));
        if (meta is null)
        {
            throw new InvalidOperationException("첨부 파일을 찾을 수 없습니다.");
        }

        var storedName = meta["storedName"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(storedName))
        {
            throw new InvalidOperationException("첨부 파일 경로가 올바르지 않습니다.");
        }

        var path = Path.Combine(EventDir(eventId), Path.GetFileName(storedName));
        if (!File.Exists(path))
        {
            throw new InvalidOperationException("첨부 파일이 디스크에서 찾을 수 없습니다.");
        }

        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }

    public void DeleteAllForEvent(string eventId)
    {
        if (string.IsNullOrWhiteSpace(eventId)) return;
        var dir = EventDir(eventId);
        try
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[attachments] delete folder failed for {eventId}: {ex.Message}");
        }
    }

    public void DeleteAllForEvents(IEnumerable<string> eventIds)
    {
        foreach (var id in eventIds)
        {
            DeleteAllForEvent(id);
        }
    }

    private void AddOneFile(List<JsonObject> attachments, string dir, string sourcePath)
    {
        if (!File.Exists(sourcePath)) return;

        var originalName = Path.GetFileName(sourcePath);
        var ext = Path.GetExtension(originalName);
        if (BlockedExtensions.Contains(ext))
        {
            throw new InvalidOperationException($"보안상 첨부할 수 없는 파일 형식입니다: {ext}");
        }

        var info = new FileInfo(sourcePath);
        if (info.Length > MaxFileBytes)
        {
            throw new InvalidOperationException(
                $"파일 크기는 {MaxFileBytes / (1024 * 1024)}MB 이하여야 합니다: {originalName}");
        }

        var id = Guid.NewGuid().ToString("N");
        var storedName = id + (string.IsNullOrEmpty(ext) ? "" : ext.ToLowerInvariant());
        var dest = Path.Combine(dir, storedName);
        File.Copy(sourcePath, dest, overwrite: false);

        attachments.Add(new JsonObject
        {
            ["id"] = id,
            ["name"] = originalName,
            ["storedName"] = storedName,
            ["mime"] = GuessMime(ext),
            ["size"] = info.Length,
            ["addedAt"] = DateTime.UtcNow.ToString("o"),
        });
    }

    private JsonObject SaveAttachments(string eventId, List<JsonObject> attachments)
    {
        var array = new JsonArray();
        foreach (var item in attachments)
        {
            array.Add(item.DeepClone());
        }

        return _store.SetEventAttachments(eventId, array);
    }

    private JsonObject RequireEditableEvent(string eventId, bool allowHolidays = false)
    {
        var store = _store.ReadStore();
        var events = store["events"] as JsonArray ?? new JsonArray();
        var found = events.FirstOrDefault(e =>
            e is JsonObject eo
            && string.Equals(eo["id"]?.GetValue<string>(), eventId, StringComparison.Ordinal)) as JsonObject;
        if (found is null)
        {
            throw new InvalidOperationException("일정을 찾을 수 없습니다.");
        }

        var calendarId = found["calendarId"]?.GetValue<string>();
        if (!allowHolidays
            && string.Equals(calendarId, AppConstants.HolidaysKrCalendarId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("대한민국의 휴일 일정에는 파일을 첨부할 수 없습니다.");
        }

        return found;
    }

    private static List<JsonObject> GetAttachments(JsonObject eventObject)
    {
        var list = new List<JsonObject>();
        if (eventObject["attachments"] is not JsonArray array) return list;
        foreach (var node in array)
        {
            if (node is JsonObject obj) list.Add((JsonObject)obj.DeepClone());
        }
        return list;
    }

    private static JsonObject CloneEvent(JsonObject eventObject) => (JsonObject)eventObject.DeepClone();

    private void TryDeleteStoredFile(string eventId, JsonObject meta)
    {
        try
        {
            var storedName = meta["storedName"]?.GetValue<string>();
            if (string.IsNullOrWhiteSpace(storedName)) return;
            var path = Path.Combine(EventDir(eventId), Path.GetFileName(storedName));
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[attachments] file delete failed: {ex.Message}");
        }
    }

    private void TryDeleteEmptyEventDir(string eventId)
    {
        try
        {
            var dir = EventDir(eventId);
            if (Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any())
            {
                Directory.Delete(dir);
            }
        }
        catch
        {
            /* ignore */
        }
    }

    private static string SanitizeId(string id)
    {
        var trimmed = (id ?? "").Trim();
        if (trimmed.Length == 0 || trimmed.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0
            || trimmed.Contains("..", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("잘못된 일정 ID입니다.");
        }

        return trimmed;
    }

    private static string GuessMime(string ext) => ext.ToLowerInvariant() switch
    {
        ".pdf" => "application/pdf",
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".txt" => "text/plain",
        ".md" => "text/markdown",
        ".csv" => "text/csv",
        ".json" => "application/json",
        ".doc" or ".docx" => "application/msword",
        ".xls" or ".xlsx" => "application/vnd.ms-excel",
        ".ppt" or ".pptx" => "application/vnd.ms-powerpoint",
        ".zip" => "application/zip",
        _ => "application/octet-stream",
    };
}
