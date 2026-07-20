using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Idle-surface memory policy for the dual WebView2 architecture (App + DesktopHost).
///
/// Both Chromium instances used to stay at <see cref="CoreWebView2MemoryUsageTargetLevel.Normal"/>
/// forever so mode switches never rematerialized blank. That kept ~2× RAM warm even when one
/// HWND was cloaked or SW_HIDE'd. We now drop the idle surface to Low while keeping
/// <see cref="Visibility.Visible"/> — Collapsed+Low was the combo that blanked on wake on
/// some Evergreen/GPU setups; Visible+Low is the safer throttle.
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
            // Never Collapsed — that path rematerialized blank after Low on older runtimes.
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
