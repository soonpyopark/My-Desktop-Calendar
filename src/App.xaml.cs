using System.IO;
using System.Windows;
using System.Windows.Threading;
using MessageBox = System.Windows.MessageBox;

namespace MyDesktopCalendar;

public partial class App : System.Windows.Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) => LogError(args.ExceptionObject as Exception);

        // Opaque dark clear color — transparent/dark CSS can otherwise paint as a blank
        // black surface before WebView2's first real frame.
        Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0xFF202124");

        base.OnStartup(e);
    }

    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        LogError(e.Exception);
        MessageBox.Show(e.Exception.Message, "My Desktop Calendar", MessageBoxButton.OK, MessageBoxImage.Error);
        e.Handled = true;
    }

    private static void LogError(Exception? ex)
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "crash.log");
            File.AppendAllText(path, $"[{DateTime.Now:o}] {ex}\n");
        }
        catch
        {
            /* ignore */
        }
    }
}
