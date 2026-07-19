using System.Diagnostics;
using System.Windows;
using MyDesktopCalendar.Services;

namespace MyDesktopCalendar;

/// <summary>
/// Control panel — always top-level, never SetParent'd (mirrors My Desktop Calendar's rule
/// #1 for its AppWindow). Stands in for the future full app UI during this embed-only phase.
/// </summary>
public partial class MainWindow : Window
{
    private readonly DesktopEmbedService _embed = new();
    private DesktopHostWindow? _host;
    private System.Windows.Forms.NotifyIcon? _tray;
    private bool _reallyClosing;
    private bool _isFloating;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += (_, _) => SetupTray();
        Closing += OnClosing;
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_reallyClosing)
        {
            return;
        }

        // Close hides to tray instead of exiting — the desktop-embedded surface (if any)
        // keeps running. Use the tray menu's Exit (or the panel's Exit button) to quit.
        e.Cancel = true;
        Hide();
    }

    private async Task<IntPtr> EnsureHostAsync()
    {
        if (_host is null)
        {
            _host = new DesktopHostWindow();
            _host.Show();
            var hwnd = _host.EnsureHwnd();
            _embed.Attach(hwnd);
            await _host.InitWebViewAsync();
            return hwnd;
        }

        return _host.EnsureHwnd();
    }

    private async void EmbedButton_Click(object sender, RoutedEventArgs e)
    {
        EmbedButton.IsEnabled = false;
        try
        {
            var isFirstHost = _host is null;
            await EnsureHostAsync();
            _host?.PrepareForEmbedding();

            // After an unlock (Undock) + manual resize/move, embed at wherever the user left
            // the window instead of snapping back to the centered default — only a brand-new
            // host (never shown/positioned yet) falls back to GetDefaultBounds().
            var bounds = (isFirstHost ? null : _embed.GetCurrentBounds()) ?? DesktopEmbedService.GetDefaultBounds();
            var ok = _embed.EmbedToDesktop(bounds);
            _isFloating = false;
            RefreshStatus();
            if (!ok)
            {
                System.Windows.MessageBox.Show(
                    "Embed failed on both strategies. Check neo-embed-diag.log for details.",
                    "My Desktop Calendar",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
            }
        }
        finally
        {
            EmbedButton.IsEnabled = true;
        }
    }

    private void UndockButton_Click(object sender, RoutedEventArgs e)
    {
        var bounds = _embed.Undock();
        _isFloating = bounds != null;
        if (_isFloating)
        {
            _host?.PrepareForFloating();
        }

        RefreshStatus();
    }

    private void OpenLogButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var path = System.IO.Path.Combine(AppContext.BaseDirectory, "neo-embed-diag.log");
            if (!System.IO.File.Exists(path))
            {
                System.IO.File.WriteAllText(path, string.Empty);
            }

            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            System.Windows.MessageBox.Show(ex.Message, "My Desktop Calendar", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void ExitButton_Click(object sender, RoutedEventArgs e) => ExitApp();

    private void ExitApp()
    {
        _reallyClosing = true;
        _tray?.Dispose();
        System.Windows.Application.Current.Shutdown();
    }

    private void RefreshStatus()
    {
        StatusText.Text = _embed.IsEmbedded
            ? $"Status: embedded via {_embed.ActiveStrategy}"
            : _isFloating
                ? "Status: undocked — floating window (drag the surface to move, border to resize)"
                : "Status: not embedded";
    }

    private void SetupTray()
    {
        var menu = new System.Windows.Forms.ContextMenuStrip();
        menu.Items.Add("Show Control Panel", null, (_, _) => ShowPanel());
        menu.Items.Add("Embed to Desktop", null, (_, _) => EmbedButton_Click(this, new RoutedEventArgs()));
        menu.Items.Add("Undock to Window", null, (_, _) => UndockButton_Click(this, new RoutedEventArgs()));
        menu.Items.Add("Open Diagnostics Log", null, (_, _) => OpenLogButton_Click(this, new RoutedEventArgs()));
        menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitApp());

        _tray = new System.Windows.Forms.NotifyIcon
        {
            Visible = true,
            Text = "My Desktop Calendar (embed experiment)",
            Icon = System.Drawing.SystemIcons.Application,
            ContextMenuStrip = menu,
        };
        _tray.DoubleClick += (_, _) => ShowPanel();
    }

    private void ShowPanel()
    {
        Show();
        WindowState = WindowState.Normal;
        Activate();
    }
}
