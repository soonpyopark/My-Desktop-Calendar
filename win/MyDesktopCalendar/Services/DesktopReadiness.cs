using System.Text.Json.Nodes;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Preflight checks before desktop (locked) mode. Shell/Progman embed checks removed —
/// desktop mode is a locked top-level window, not a wallpaper embed.
/// </summary>
internal static class DesktopReadiness
{
    /// <summary>Windows 10 1809 — practical floor for WebView2 + WPF shell.</summary>
    private const int MinWindowsBuild = 17763;

    public static JsonObject Evaluate(DesktopEmbedService embed)
    {
        var caps = embed.GetCapabilitySnapshot();
        var build = caps["build"]?.GetValue<int>() ?? 0;
        var webView2 = WebView2RuntimeGuide.IsRuntimeAvailable();
        var webView2Version = WebView2RuntimeGuide.TryGetRuntimeVersion();

        var checks = new JsonArray
        {
            Check(
                "os",
                build >= MinWindowsBuild,
                "Windows 10 이상",
                build >= MinWindowsBuild
                    ? $"현재 빌드 {build}"
                    : $"Windows 10 이상이 필요합니다 (현재 빌드 {build})"),
            Check(
                "webview2",
                webView2,
                "WebView2 Runtime",
                webView2
                    ? (string.IsNullOrWhiteSpace(webView2Version) ? "설치됨" : webView2Version)
                    : "Microsoft Edge WebView2 Runtime이 없습니다"),
        };

        var ready = true;
        foreach (var node in checks)
        {
            if (node is JsonObject item && item["ok"]?.GetValue<bool>() != true)
            {
                ready = false;
                break;
            }
        }

        return new JsonObject
        {
            ["ready"] = ready,
            ["checks"] = checks,
        };
    }

    public static string FormatMissingMessage(JsonObject readiness)
    {
        var lines = new List<string>
        {
            "바탕화면 모드에 필요한 조건이 부족합니다.",
            "",
        };

        if (readiness["checks"] is JsonArray checks)
        {
            foreach (var node in checks)
            {
                if (node is not JsonObject item) continue;
                if (item["ok"]?.GetValue<bool>() == true) continue;
                var detail = item["detail"]?.GetValue<string>()
                    ?? item["label"]?.GetValue<string>()
                    ?? "알 수 없는 조건";
                lines.Add($"• {detail}");
            }
        }

        lines.Add("");
        lines.Add("창 모드에서는 계속 사용할 수 있습니다.");
        return string.Join("\n", lines);
    }

    private static JsonObject Check(string id, bool ok, string label, string detail)
        => new()
        {
            ["id"] = id,
            ["ok"] = ok,
            ["label"] = label,
            ["detail"] = detail,
        };
}
