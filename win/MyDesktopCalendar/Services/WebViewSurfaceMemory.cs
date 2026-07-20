using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Memory throttle for the single WebView2 on <see cref="MainWindow"/>.
/// Keeps the control <see cref="Visibility.Visible"/> and drops idle usage to Low
/// (Visible+Low is safer than Collapsed+Low on some Evergreen/GPU setups).
/// </summary>
internal static class WebViewSurfaceMemory
{
    public static void SetActive(WebView2? webView, bool active)
    {
        if (webView is null)
        {
            return;
        }

        try
        {
            if (webView.Visibility != Visibility.Visible)
            {
                webView.Visibility = Visibility.Visible;
            }

            if (WebView2Safe.TryGetCore(webView) is { } core)
            {
                core.MemoryUsageTargetLevel = active
                    ? CoreWebView2MemoryUsageTargetLevel.Normal
                    : CoreWebView2MemoryUsageTargetLevel.Low;
            }

            if (active)
            {
                webView.InvalidateVisual();
                webView.UpdateLayout();
            }
        }
        catch
        {
            /* older runtime / early init */
        }
    }
}
