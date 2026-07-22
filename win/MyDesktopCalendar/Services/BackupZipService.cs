using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;
using System.Windows;
using Win32OpenFileDialog = Microsoft.Win32.OpenFileDialog;
using Win32SaveFileDialog = Microsoft.Win32.SaveFileDialog;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Full backup ZIP: <c>store.json</c> + <c>attachments/{eventId}/…</c>
/// (same layout as <see cref="EventAttachmentService"/> on disk).
/// </summary>
internal sealed class BackupZipService
{
    private readonly CalendarStoreService _store;
    private readonly string _attachmentsRoot;

    public BackupZipService(CalendarStoreService store)
    {
        _store = store;
        _attachmentsRoot = Path.Combine(store.DataRoot, "attachments");
    }

    /// <summary>SaveFileDialog → write ZIP. Returns cancelled / path / counts.</summary>
    public JsonObject ExportWithDialog(Window owner)
    {
        string? savePath = null;
        var ok = owner.Dispatcher.Invoke(() =>
        {
            var stamp = DateTime.Now.ToString("yyMMdd_HHmmss");
            var dialog = new Win32SaveFileDialog
            {
                Title = "일정 + 첨부 백업 저장",
                Filter = "ZIP 백업 (*.zip)|*.zip",
                DefaultExt = ".zip",
                AddExtension = true,
                FileName = $"my-calendar-backup-{stamp}.zip",
                OverwritePrompt = true,
            };
            if (dialog.ShowDialog(owner) != true) return false;
            savePath = dialog.FileName;
            return !string.IsNullOrWhiteSpace(savePath);
        });

        if (!ok || string.IsNullOrWhiteSpace(savePath))
        {
            return new JsonObject { ["ok"] = true, ["cancelled"] = true };
        }

        var (fileCount, eventCount) = WriteBackupZip(savePath);
        return new JsonObject
        {
            ["ok"] = true,
            ["cancelled"] = false,
            ["path"] = savePath,
            ["attachmentFiles"] = fileCount,
            ["eventsWithAttachments"] = eventCount,
        };
    }

    /// <summary>OpenFileDialog → import store.json + restore attachment files.</summary>
    public JsonObject ImportWithDialog(Window owner)
    {
        string? openPath = null;
        var ok = owner.Dispatcher.Invoke(() =>
        {
            var dialog = new Win32OpenFileDialog
            {
                Title = "일정 + 첨부 백업 가져오기",
                Filter = "ZIP 백업 (*.zip)|*.zip",
                DefaultExt = ".zip",
                CheckFileExists = true,
                Multiselect = false,
            };
            if (dialog.ShowDialog(owner) != true) return false;
            openPath = dialog.FileName;
            return !string.IsNullOrWhiteSpace(openPath);
        });

        if (!ok || string.IsNullOrWhiteSpace(openPath))
        {
            return new JsonObject { ["ok"] = true, ["cancelled"] = true };
        }

        var (store, fileCount) = ImportBackupZip(openPath);
        return new JsonObject
        {
            ["ok"] = true,
            ["cancelled"] = false,
            ["path"] = openPath,
            ["attachmentFiles"] = fileCount,
            ["store"] = store,
        };
    }

    private (int fileCount, int eventCount) WriteBackupZip(string zipPath)
    {
        var staging = Path.Combine(Path.GetTempPath(), "mdc-backup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            var store = (JsonObject)_store.ReadStore().DeepClone()!;
            var storePath = Path.Combine(staging, "store.json");
            File.WriteAllText(storePath, store.ToJsonString(JsonUtil.Indented) + "\n", Encoding.UTF8);

            var attachStaging = Path.Combine(staging, "attachments");
            Directory.CreateDirectory(attachStaging);

            var fileCount = 0;
            var eventCount = 0;
            if (store["events"] is JsonArray events)
            {
                foreach (var node in events)
                {
                    if (node is not JsonObject evt) continue;
                    var eventId = evt["id"]?.GetValue<string>();
                    if (string.IsNullOrWhiteSpace(eventId) || !TrySanitizeId(eventId, out var safeId))
                    {
                        continue;
                    }

                    if (evt["attachments"] is not JsonArray attachments || attachments.Count == 0)
                    {
                        continue;
                    }

                    var copiedForEvent = 0;
                    var eventDir = Path.Combine(attachStaging, safeId);
                    foreach (var attNode in attachments)
                    {
                        if (attNode is not JsonObject att) continue;
                        var storedName = att["storedName"]?.GetValue<string>();
                        if (string.IsNullOrWhiteSpace(storedName)) continue;
                        var fileName = Path.GetFileName(storedName);
                        if (string.IsNullOrWhiteSpace(fileName)) continue;

                        var source = Path.Combine(_attachmentsRoot, safeId, fileName);
                        if (!File.Exists(source)) continue;

                        Directory.CreateDirectory(eventDir);
                        File.Copy(source, Path.Combine(eventDir, fileName), overwrite: true);
                        fileCount += 1;
                        copiedForEvent += 1;
                    }

                    if (copiedForEvent > 0) eventCount += 1;
                }
            }

            if (File.Exists(zipPath)) File.Delete(zipPath);
            ZipFile.CreateFromDirectory(staging, zipPath, CompressionLevel.Optimal, includeBaseDirectory: false);
            return (fileCount, eventCount);
        }
        finally
        {
            TryDeleteDir(staging);
        }
    }

    private (JsonObject store, int fileCount) ImportBackupZip(string zipPath)
    {
        var extractDir = Path.Combine(Path.GetTempPath(), "mdc-restore-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(extractDir);
        try
        {
            ExtractZipSafe(zipPath, extractDir);

            var storePath = FindStoreJson(extractDir)
                ?? throw new InvalidOperationException("ZIP에 store.json이 없습니다. 이 앱의 백업 ZIP인지 확인해 주세요.");

            JsonObject payload;
            try
            {
                var text = File.ReadAllText(storePath, Encoding.UTF8);
                payload = JsonNode.Parse(text) as JsonObject
                    ?? throw new InvalidOperationException("store.json 형식이 올바르지 않습니다.");
            }
            catch (Exception ex) when (ex is not InvalidOperationException)
            {
                throw new InvalidOperationException("store.json을 읽지 못했습니다: " + ex.Message);
            }

            var imported = _store.ImportStore(payload);

            var zipAttachments = Path.Combine(Path.GetDirectoryName(storePath) ?? extractDir, "attachments");
            var fileCount = ReplaceAttachmentsFrom(zipAttachments);

            return (imported, fileCount);
        }
        finally
        {
            TryDeleteDir(extractDir);
        }
    }

    /// <summary>Wipe local attachments root, then copy from extracted backup folder.</summary>
    private int ReplaceAttachmentsFrom(string sourceAttachmentsDir)
    {
        try
        {
            if (Directory.Exists(_attachmentsRoot))
            {
                Directory.Delete(_attachmentsRoot, recursive: true);
            }
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[backup] clear attachments failed: {ex.Message}");
            throw new InvalidOperationException("기존 첨부 폴더를 비우지 못했습니다: " + ex.Message);
        }

        Directory.CreateDirectory(_attachmentsRoot);
        if (!Directory.Exists(sourceAttachmentsDir))
        {
            return 0;
        }

        var fileCount = 0;
        foreach (var eventDir in Directory.EnumerateDirectories(sourceAttachmentsDir))
        {
            var eventId = Path.GetFileName(eventDir);
            if (!TrySanitizeId(eventId, out var safeId)) continue;

            var destDir = Path.Combine(_attachmentsRoot, safeId);
            Directory.CreateDirectory(destDir);
            foreach (var file in Directory.EnumerateFiles(eventDir))
            {
                var name = Path.GetFileName(file);
                if (string.IsNullOrWhiteSpace(name)) continue;
                if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) continue;
                File.Copy(file, Path.Combine(destDir, name), overwrite: true);
                fileCount += 1;
            }
        }

        return fileCount;
    }

    private static void ExtractZipSafe(string zipPath, string destDir)
    {
        var destFull = Path.GetFullPath(destDir)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;

        using var archive = ZipFile.OpenRead(zipPath);
        foreach (var entry in archive.Entries)
        {
            if (string.IsNullOrEmpty(entry.FullName) || entry.FullName.EndsWith('/') || entry.FullName.EndsWith('\\'))
            {
                continue;
            }

            var relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
            var target = Path.GetFullPath(Path.Combine(destDir, relative));
            if (!target.StartsWith(destFull, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("ZIP에 허용되지 않은 경로가 포함되어 있습니다.");
            }

            var parent = Path.GetDirectoryName(target);
            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            entry.ExtractToFile(target, overwrite: true);
        }
    }

    private static string? FindStoreJson(string extractDir)
    {
        var root = Path.Combine(extractDir, "store.json");
        if (File.Exists(root)) return root;

        // Allow a single top-level folder wrapper.
        foreach (var dir in Directory.EnumerateDirectories(extractDir))
        {
            var nested = Path.Combine(dir, "store.json");
            if (File.Exists(nested)) return nested;
        }

        return null;
    }

    private static bool TrySanitizeId(string id, out string safeId)
    {
        safeId = (id ?? "").Trim();
        if (safeId.Length == 0) return false;
        if (safeId.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return false;
        if (safeId.Contains("..", StringComparison.Ordinal)) return false;
        return true;
    }

    private static void TryDeleteDir(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[backup] temp cleanup failed: {ex.Message}");
        }
    }
}
