using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using MyDesktopCalendar.Native;
using MediaBrush = System.Windows.Media.Brush;

namespace MyDesktopCalendar.Services;

/// <summary>
/// TOPMOST freeze-frame cover outside the calendar HWND.
/// Positioned in physical pixels (PerMonitorV2-safe) and filled from
/// PrintWindow(PW_RENDERFULLCONTENT) so WebView2 content is captured.
/// </summary>
internal static class DesktopTransitionCover
{
    /// <summary>
    /// WebView2 needs far longer than a few composition frames after Show/Hide.
    /// Dropping the cover at ~50ms caused a visible double flash (freeze → blank → paint).
    /// </summary>
    public const int DefaultHoldMs = 320;

    private static Window? _cover;
    private static DispatcherTimer? _hideTimer;

    /// <summary>
    /// HWND of the currently-shown freeze-frame cover, or Zero when none is up. The cover is
    /// purely cosmetic and always placed exactly over DesktopHost's own bounds, so
    /// UndockZoneMonitor's IsCalendarSurfaceExposed hit-test treats it the same as the desktop
    /// shell itself (WindowFromPoint does not honor WS_EX_TRANSPARENT — see remarks on
    /// TryShow — so that alone can't make the exposed-check see through it).
    /// </summary>
    public static IntPtr CurrentCoverHwnd { get; private set; }

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    /// <summary>
    /// Show a freeze-frame cover only when we captured real pixels.
    /// Solid-color fallbacks blinked worse than no cover at all.
    /// </summary>
    public static bool TryShow(Window? host, IntPtr sourceHwnd, DesktopEmbedService.Bounds physicalBounds)
    {
        CancelHide();
        HideImmediate();

        var w = Math.Max(1, physicalBounds.Width);
        var h = Math.Max(1, physicalBounds.Height);
        var background = TryCaptureWindow(sourceHwnd, w, h)
            ?? TryCaptureScreen(physicalBounds.X, physicalBounds.Y, w, h);
        if (background is null)
        {
            return false;
        }

        _cover = new Window
        {
            Title = string.Empty,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            ShowInTaskbar = false,
            ShowActivated = false,
            Topmost = true,
            AllowsTransparency = false,
            Background = background,
            BorderThickness = new Thickness(0),
            Left = 0,
            Top = 0,
            Width = 16,
            Height = 16,
            IsHitTestVisible = false,
            Focusable = false,
        };

        try
        {
            _cover.Show();
            var helper = new WindowInteropHelper(_cover);
            helper.EnsureHandle();
            var hwnd = helper.Handle;
            _ = Win32.SetWindowPos(
                hwnd,
                Win32.HWND_TOPMOST,
                physicalBounds.X,
                physicalBounds.Y,
                w,
                h,
                Win32.SWP_NOACTIVATE | Win32.SWP_SHOWWINDOW);
            // Click-through (xdiary-style layered overlay): the cover only ever needs to be
            // *seen*, never clicked. Without WS_EX_TRANSPARENT, UndockZoneMonitor's
            // IsCalendarSurfaceExposed hit-test (WindowFromPoint) would land on this cover
            // instead of Progman/WorkerW/DesktopHost while it's up and reject a click landing
            // during its brief hold as "covered" — turning a purely cosmetic freeze-frame into
            // a dropped click.
            //
            // WS_EX_TRANSPARENT only — no WS_EX_LAYERED. This is a normal DWM-composited WPF
            // window (AllowsTransparency=false); layering it would require an explicit
            // UpdateLayeredWindow/SetLayeredWindowAttributes call WPF never makes for its own
            // D3D-rendered content, which would make the whole cover render blank/invisible.
            // (WS_EX_TRANSPARENT itself only affects real WM_LBUTTONDOWN routing, not
            // WindowFromPoint — see CurrentCoverHwnd doc — so it's a courtesy, not the fix.)
            var ex = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE).ToInt64();
            Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE, new IntPtr(ex | Win32.WS_EX_TRANSPARENT));
            _cover.Dispatcher.Invoke(DispatcherPriority.Render, static () => { });
            CurrentCoverHwnd = hwnd;
            return true;
        }
        catch
        {
            HideImmediate();
            return false;
        }
    }

    /// <summary>Legacy entry — only places a cover when a real capture succeeds.</summary>
    public static void Show(Window? host, IntPtr sourceHwnd, DesktopEmbedService.Bounds physicalBounds) =>
        _ = TryShow(host, sourceHwnd, physicalBounds);

    /// <summary>
    /// Hold the freeze frame long enough for the destination WebView2 to present.
    /// </summary>
    public static void HideAfterComposition(Window? host, int fallbackDelayMs = DefaultHoldMs)
    {
        _ = host;
        HideDeferred(fallbackDelayMs);
    }

    public static void HideDeferred(int delayMs = DefaultHoldMs)
    {
        CancelHide();
        if (_cover is null)
        {
            return;
        }

        var dispatcher = _cover.Dispatcher;
        _hideTimer = new DispatcherTimer(DispatcherPriority.Background, dispatcher)
        {
            Interval = TimeSpan.FromMilliseconds(Math.Max(80, delayMs)),
        };
        _hideTimer.Tick += (_, _) =>
        {
            CancelHide();
            HideImmediate();
        };
        _hideTimer.Start();
    }

    public static void HideImmediate()
    {
        CancelHide();
        CurrentCoverHwnd = IntPtr.Zero;
        if (_cover is null)
        {
            return;
        }

        var cover = _cover;
        _cover = null;
        try
        {
            cover.Close();
        }
        catch
        {
            /* ignore */
        }
    }

    private static void CancelHide()
    {
        if (_hideTimer is null)
        {
            return;
        }

        _hideTimer.Stop();
        _hideTimer = null;
    }

    private static ImageBrush? TryCaptureWindow(IntPtr hwnd, int width, int height)
    {
        if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd))
        {
            return null;
        }

        try
        {
            using var bmp = new Bitmap(width, height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                var hdc = g.GetHdc();
                try
                {
                    if (!Win32.PrintWindow(hwnd, hdc, Win32.PW_RENDERFULLCONTENT))
                    {
                        _ = Win32.PrintWindow(hwnd, hdc, 0);
                    }
                }
                finally
                {
                    g.ReleaseHdc(hdc);
                }
            }

            if (IsMostlyBlack(bmp))
            {
                return null;
            }

            return ToImageBrush(bmp, width, height);
        }
        catch
        {
            return null;
        }
    }

    private static ImageBrush? TryCaptureScreen(int x, int y, int width, int height)
    {
        try
        {
            using var bmp = new Bitmap(width, height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(x, y, 0, 0, new System.Drawing.Size(width, height), CopyPixelOperation.SourceCopy);
            }

            if (IsMostlyBlack(bmp))
            {
                return null;
            }

            return ToImageBrush(bmp, width, height);
        }
        catch
        {
            return null;
        }
    }

    private static ImageBrush ToImageBrush(Bitmap bmp, int width, int height)
    {
        var hBitmap = bmp.GetHbitmap();
        try
        {
            var source = Imaging.CreateBitmapSourceFromHBitmap(
                hBitmap,
                IntPtr.Zero,
                Int32Rect.Empty,
                BitmapSizeOptions.FromWidthAndHeight(width, height));
            source.Freeze();
            return new ImageBrush(source)
            {
                Stretch = Stretch.Fill,
                AlignmentX = AlignmentX.Left,
                AlignmentY = AlignmentY.Top,
            };
        }
        finally
        {
            _ = DeleteObject(hBitmap);
        }
    }

    private static bool IsMostlyBlack(Bitmap bmp)
    {
        try
        {
            var stepX = Math.Max(1, bmp.Width / 8);
            var stepY = Math.Max(1, bmp.Height / 8);
            var dark = 0;
            var total = 0;
            for (var y = stepY / 2; y < bmp.Height; y += stepY)
            {
                for (var x = stepX / 2; x < bmp.Width; x += stepX)
                {
                    var p = bmp.GetPixel(x, y);
                    total++;
                    if (p.R < 18 && p.G < 18 && p.B < 18)
                    {
                        dark++;
                    }
                }
            }

            return total > 0 && dark * 100 / total >= 92;
        }
        catch
        {
            return false;
        }
    }
}
