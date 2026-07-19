using System.IO;
using System.Text;

namespace MyDesktopCalendar.Services;

/// <summary>Load key=value pairs from .env next to exe and up to project root.</summary>
internal static class DotEnv
{
    public static Dictionary<string, string> Load()
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var path in EnumeratePaths())
        {
            MergeFile(path, result);
        }

        return result;
    }

    private static IEnumerable<string> EnumeratePaths()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var dir = AppContext.BaseDirectory;
        for (var i = 0; i < 8 && !string.IsNullOrEmpty(dir); i++)
        {
            var candidate = Path.Combine(dir, ".env");
            if (seen.Add(candidate) && File.Exists(candidate))
            {
                yield return candidate;
            }

            if (File.Exists(Path.Combine(dir, "package.json")))
            {
                yield break;
            }

            dir = Directory.GetParent(dir)?.FullName ?? "";
        }
    }

    private static void MergeFile(string envPath, Dictionary<string, string> result)
    {
        try
        {
            foreach (var line in File.ReadAllLines(envPath, Encoding.UTF8))
            {
                var trimmed = line.Trim();
                if (trimmed.Length == 0 || trimmed.StartsWith('#'))
                {
                    continue;
                }

                var separatorIndex = trimmed.IndexOf('=');
                if (separatorIndex <= 0)
                {
                    continue;
                }

                var key = trimmed[..separatorIndex].Trim();
                var value = trimmed[(separatorIndex + 1)..].Trim();
                if (value.Length >= 2 &&
                    ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\'')))
                {
                    value = value[1..^1];
                }

                if (!result.ContainsKey(key))
                {
                    result[key] = value;
                }
            }
        }
        catch (IOException)
        {
            /* ignore */
        }
    }
}
