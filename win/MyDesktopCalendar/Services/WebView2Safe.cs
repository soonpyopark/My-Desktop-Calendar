using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace MyDesktopCalendar.Services;

/// <summary>
/// <see cref="WebView2.CoreWebView2"/> throws if the control was disposed — null-conditional
/// does not help. Use this helper anywhere a surface may have been parked/torn down.
/// </summary>
internal static class WebView2Safe
{
    public static CoreWebView2? TryGetCore(WebView2? webView)
    {
        if (webView is null)
        {
            return null;
        }

        try
        {
            return webView.CoreWebView2;
        }
        catch
        {
            return null;
        }
    }

    public static void TryPostJson(WebView2? webView, string json)
    {
        var core = TryGetCore(webView);
        if (core is null)
        {
            return;
        }

        try
        {
            core.PostWebMessageAsJson(json);
        }
        catch
        {
            /* disposed / closing */
        }
    }
}
