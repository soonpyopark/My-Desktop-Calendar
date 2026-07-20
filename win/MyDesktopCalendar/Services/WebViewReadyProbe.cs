using Microsoft.Web.WebView2.Core;

namespace MyDesktopCalendar.Services;

/// <summary>
/// "Has React painted the calendar UI yet" probe for <see cref="MainWindow"/> boot.
/// Used so freeze-frame covers wait for a real UI signal instead of a fixed delay
/// (cold WebView2 profiles often need longer than ~120ms).
/// </summary>
internal static class WebViewReadyProbe
{
    private const string ProbeScript = """
        (function () {
          var root = document.getElementById('root');
          if (!root) return JSON.stringify({ ok: false, reason: 'no-root' });
          var text = (root.innerText || '').trim();
          var hasUi = !!root.querySelector('.month-view, .year-view, header, [data-shell-chrome]');
          var hasBoot = !!document.getElementById('boot-splash');
          return JSON.stringify({
            ok: hasUi || (text.length > 0 && !hasBoot),
            hasUi: hasUi,
            hasBoot: hasBoot,
            textLen: text.length,
            text: text.slice(0, 120)
          });
        })()
        """;

    /// <summary>Runs the probe script once. Never throws.</summary>
    public static async Task<bool> CheckOnceAsync(CoreWebView2? core)
    {
        if (core is null)
        {
            return false;
        }

        try
        {
            var raw = await core.ExecuteScriptAsync(ProbeScript);
            var payload = raw ?? "";
            try
            {
                // ExecuteScriptAsync JSON-encodes the JS string return value.
                var inner = System.Text.Json.JsonSerializer.Deserialize<string>(raw ?? "\"\"");
                payload = inner ?? payload;
                using var doc = System.Text.Json.JsonDocument.Parse(payload);
                return doc.RootElement.TryGetProperty("ok", out var okProp) && okProp.GetBoolean();
            }
            catch
            {
                return payload.Contains("\"ok\":true", StringComparison.Ordinal);
            }
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Polls until ready or the attempt budget is exhausted (never throws).</summary>
    public static async Task<bool> WaitUntilReadyAsync(CoreWebView2? core, int maxAttempts, int intervalMs)
    {
        for (var attempt = 0; attempt < maxAttempts; attempt++)
        {
            if (await CheckOnceAsync(core))
            {
                return true;
            }

            await Task.Delay(intervalMs);
        }

        return false;
    }
}
