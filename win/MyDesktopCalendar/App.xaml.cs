using System.IO;
using System.Windows;
using System.Windows.Threading;
using MessageBox = System.Windows.MessageBox;

namespace MyDesktopCalendar;

public partial class App : System.Windows.Application
{
    private static readonly string MutexName = @"Local\MyDesktopCalendar_SingleInstance";
    private static readonly string ShowEventName = @"Local\MyDesktopCalendar_ShowExisting";

    private Mutex? _mutex;
    private EventWaitHandle? _showEvent;
    private CancellationTokenSource? _showListenCts;

    protected override void OnStartup(StartupEventArgs e)
    {
        _mutex = new Mutex(true, MutexName, out var created);
        if (!created)
        {
            try
            {
                using var show = EventWaitHandle.OpenExisting(ShowEventName);
                show.Set();
            }
            catch
            {
                MessageBox.Show(
                    "이미 실행 중입니다.\n트레이 아이콘을 더블클릭하거나 ‘창 모드’로 열어 보세요.",
                    AppConstants.AppTitle,
                    MessageBoxButton.OK,
                    MessageBoxImage.Information);
            }

            Shutdown();
            return;
        }

        try
        {
            _showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
            _showListenCts = new CancellationTokenSource();
            _ = Task.Run(() => ListenForShowRequests(_showListenCts.Token));
        }
        catch
        {
            /* ignore — activation from second instance unavailable */
        }

        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            LogError(args.ExceptionObject as Exception);
        };

        // Opaque light page tint (0xAARRGGBB). Transparent clear painted black gaps / white flashes.
        Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0xFFEEF0F2");

        base.OnStartup(e);
    }

    private void ListenForShowRequests(CancellationToken token)
    {
        var showEvent = _showEvent;
        if (showEvent is null)
        {
            return;
        }

        while (!token.IsCancellationRequested)
        {
            try
            {
                if (!showEvent.WaitOne(500))
                {
                    continue;
                }

                Dispatcher.Invoke(() =>
                {
                    if (MainWindow is MainWindow window)
                    {
                        window.BringToForegroundFromSecondInstance();
                    }
                });
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (Exception ex)
            {
                LogError(ex);
            }
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try
        {
            _showListenCts?.Cancel();
            _showListenCts?.Dispose();
            _showEvent?.Dispose();
            _mutex?.ReleaseMutex();
            _mutex?.Dispose();
        }
        catch
        {
            /* ignore */
        }

        base.OnExit(e);
    }

    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        LogError(e.Exception);
        MessageBox.Show(e.Exception.Message, AppConstants.AppTitle, MessageBoxButton.OK, MessageBoxImage.Error);
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
