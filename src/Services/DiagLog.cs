using System.IO;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Plain-text, append-only log next to the exe — same spirit as My Desktop Calendar's
/// zone-diag.txt. Every embed attempt writes its steps here so the outcome (which
/// strategy engaged, why a fallback triggered) is visible without a debugger attached.
/// </summary>
internal static class DiagLog
{
    private static readonly object Gate = new();
    private static readonly string Path = System.IO.Path.Combine(AppContext.BaseDirectory, "neo-embed-diag.log");

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                File.AppendAllText(Path, $"[{DateTime.Now:HH:mm:ss.fff}] {message}{Environment.NewLine}");
            }
        }
        catch
        {
            /* best-effort diagnostics only */
        }
    }
}
