using System.IO;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using MyDesktopCalendar.Services;

namespace MyDesktopCalendar;

/// <summary>
/// The embedded surface. SetParent happens at most once, via <see cref="DesktopEmbedService"/>;
/// this window is otherwise only Show/Hide'd — same dual-HWND rule the production app follows
/// (see My Desktop Calendar's DesktopHostWindow), so the later UI port keeps the same shape.
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

    /// <summary>
    /// WPF-side half of undocking: the actual title bar/resize-border/parent change happens
    /// via raw Win32 calls in <see cref="DesktopEmbedService.Undock"/>; this makes the window
    /// discoverable/usable as a normal window (taskbar entry, a real title, focus) and tells the
    /// page it may enable its "app-region: drag" zone (see wwwroot/index.html) — the window
    /// itself has no native caption (see <see cref="DesktopEmbedService"/>) and no WPF-level
    /// drag bar, so that in-page region is the only way to move it. Nothing here changes what's
    /// rendered, so embedded and floating stay pixel-identical.
    /// </summary>
    public void PrepareForFloating()
    {
        Title = "My Desktop Calendar";
        ShowInTaskbar = true;
        Activate();
        PostPageState("floating");
    }

    /// <summary>Inverse of <see cref="PrepareForFloating"/>, called before re-embedding.</summary>
    public void PrepareForEmbedding()
    {
        ShowInTaskbar = false;
        PostPageState("embedded");
    }

    private void PostPageState(string state)
    {
        try
        {
            WebView.CoreWebView2?.PostWebMessageAsString(state);
        }
        catch (InvalidOperationException)
        {
            // CoreWebView2 not ready yet (e.g. called before InitWebViewAsync finished) — the
            // page defaults to non-draggable, and MainWindow only calls this after init anyway.
        }
    }

    public async Task InitWebViewAsync()
    {
        var userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MyDesktopCalendar",
            "webview2-data-desktop");
        Directory.CreateDirectory(userData);

        var env = await CoreWebView2Environment.CreateAsync(browserExecutableFolder: null, userDataFolder: userData);
        await WebView.EnsureCoreWebView2Async(env);

        WebView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0xFF, 0x20, 0x21, 0x24);
        WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        WebView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        // Lets the page mark elements "app-region: drag" (see wwwroot/index.html) so the window
        // can be moved by dragging its own content — no WPF-added title bar/overlay needed, so
        // embedded and floating render identically. Must be set before Navigate.
        WebView.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = true;

        var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (!Directory.Exists(wwwroot))
        {
            DiagLog.Write($"InitWebViewAsync: wwwroot not found at {wwwroot}");
            return;
        }

        WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "app.mydesktopcalendar.local",
            wwwroot,
            CoreWebView2HostResourceAccessKind.Allow);
        WebView.CoreWebView2.Navigate("https://app.mydesktopcalendar.local/index.html");
    }
}
