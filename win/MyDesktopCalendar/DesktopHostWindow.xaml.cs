using System.IO;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using MyDesktopCalendar.Services;

namespace MyDesktopCalendar;

/// <summary>
/// Long-lived desktop surface. Parenting to the shell happens at most once via
/// <see cref="DesktopEmbedService"/>; mode switches only Show/Hide this window.
/// </summary>
public partial class DesktopHostWindow : Window
{
    public WebView2 HostWebView => WebView;

    public DesktopHostWindow()
    {
        InitializeComponent();
        ShowInTaskbar = false;
    }

    public IntPtr EnsureHwnd()
    {
        var helper = new WindowInteropHelper(this);
        helper.EnsureHandle();
        return helper.Handle;
    }

    internal async Task InitWebViewAsync(NativeBridge bridge)
    {
        Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0xFF202124");

        if (!WebView2RuntimeGuide.IsRuntimeAvailable())
        {
            return;
        }

        var userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            AppConstants.AppName,
            "webview2-data-desktop");
        Directory.CreateDirectory(userData);

        var options = new CoreWebView2EnvironmentOptions(
            additionalBrowserArguments: string.Join(' ',
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-features=msSmartScreenProtection,CalculateNativeWinOcclusion"));
        var env = await CoreWebView2Environment.CreateAsync(
            browserExecutableFolder: null,
            userDataFolder: userData,
            options: options);
        await WebView.EnsureCoreWebView2Async(env);

        WebView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0xFF, 0x20, 0x21, 0x24);
        WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        WebView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        WebView.CoreWebView2.Settings.AreDevToolsEnabled = false;

        var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (!Directory.Exists(wwwroot) || !File.Exists(Path.Combine(wwwroot, "index.html")))
        {
            var dist = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "dist"));
            if (Directory.Exists(dist))
            {
                wwwroot = dist;
            }
        }

        if (!Directory.Exists(wwwroot))
        {
            return;
        }

        WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            AppConstants.VirtualHost,
            wwwroot,
            CoreWebView2HostResourceAccessKind.Allow);

        try
        {
            var fontsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Fonts");
            if (Directory.Exists(fontsDir))
            {
                WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "winfonts.local",
                    fontsDir,
                    CoreWebView2HostResourceAccessKind.Allow);
            }
        }
        catch
        {
            /* optional */
        }

        bridge.AttachSecondary(WebView);
        // surface=desktop: calendar wallpaper only — ignore overlay pending UI (settings/search/edit).
        WebView.CoreWebView2.Navigate($"https://{AppConstants.VirtualHost}/index.html?surface=desktop");
    }

    /// <summary>
    /// Waits for the desktop-surface React UI to actually render (same readiness signal
    /// as the App WebView's own boot-splash probe) instead of assuming a fixed delay is
    /// enough — a cold WebView2 profile can take well over 120ms to first-paint the
    /// calendar, and embedding/uncovering before that shows a startup flicker/pop-in.
    /// Never throws; returns false (caller proceeds anyway) if the budget runs out.
    /// </summary>
    internal Task<bool> WaitForUiReadyAsync(int maxAttempts = 50, int intervalMs = 100) =>
        WebViewReadyProbe.WaitUntilReadyAsync(WebView.CoreWebView2, maxAttempts, intervalMs);

    /// <summary>
    /// Wake (Normal) or rest (Low) Host Chromium. HWND may already be SW_HIDE'd —
    /// visibility of the WPF control stays Visible; see <see cref="WebViewSurfaceMemory"/>.
    /// </summary>
    public void SetSurfaceActive(bool active) => WebViewSurfaceMemory.SetActive(WebView, active);

    /// <summary>Dispose the Host WebView2 so its Chromium process tree can exit.</summary>
    public void TearDownWebView()
    {
        try
        {
            WebView.Visibility = Visibility.Collapsed;
        }
        catch
        {
            /* ignore */
        }

        try
        {
            WebView.Dispose();
        }
        catch
        {
            /* already disposed / early init */
        }
    }
}
