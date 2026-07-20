using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using MyDesktopCalendar;
using MyDesktopCalendar.Native;
using MediaBrush = System.Windows.Media.Brush;
using MediaColor = System.Windows.Media.Color;

namespace MyDesktopCalendar.Services;

/// <summary>
/// TOPMOST freeze-frame cover outside the calendar HWND.
/// Positioned in physical pixels (PerMonitorV2-safe) and filled from
/// PrintWindow(PW_RENDERFULLCONTENT) so WebView2 content is captured.
/// WPF DIP footprint is synced via <see cref="WindowFootprint"/> so the
/// ImageBrush is not letterboxed (black side bars) on scaled DPI.
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
    /// HWND of the currently-shown freeze-frame cover, or Zero when none is up.
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
        // Minimal pad — larger pads read as the window growing during mode switch.
        const int pad = 1;
        var coverBounds = new DesktopEmbedService.Bounds(
            physicalBounds.X - pad,
            physicalBounds.Y - pad,
            w + pad * 2,
            h + pad * 2);
        var background = TryCaptureWindow(sourceHwnd, w, h)
            ?? TryCaptureScreen(physicalBounds.X, physicalBounds.Y, w, h);
        if (background is null)
        {
            return false;
        }

        // Opaque page-tint behind the freeze frame — never Transparent (shows as black bars).
        var pageTint = ResolvePageTintBrush(host);
        _cover = new Window
        {
            Title = string.Empty,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            ShowInTaskbar = false,
            ShowActivated = false,
            Topmost = true,
            AllowsTransparency = false,
            Background = pageTint,
            BorderThickness = new Thickness(0),
            Left = 0,
            Top = 0,
            Width = 16,
            Height = 16,
            IsHitTestVisible = false,
            Focusable = false,
            Content = new System.Windows.Controls.Border
            {
                Background = background,
                BorderThickness = new Thickness(0),
            },
        };

        try
        {
            _cover.Show();
            var helper = new WindowInteropHelper(_cover);
            helper.EnsureHandle();
            var hwnd = helper.Handle;

            // Critical: sync WPF DIP size to the physical cover rect before paint.
            // SetWindowPos alone left Width/Height at 16 DIP → ImageBrush letterboxed black.
            WindowFootprint.Sync(_cover, coverBounds);
            _cover.UpdateLayout();

            _ = Win32.SetWindowPos(
                hwnd,
                Win32.HWND_TOPMOST,
                coverBounds.X,
                coverBounds.Y,
                coverBounds.Width,
                coverBounds.Height,
                Win32.SWP_NOACTIVATE | Win32.SWP_SHOWWINDOW);

            var ex = Win32.GetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE).ToInt64();
            Win32.SetWindowLongPtrCompat(hwnd, Win32.GWL_EXSTYLE, new IntPtr(ex | Win32.WS_EX_TRANSPARENT));

            // Windows 11 draws a 1px accent-color border + rounded corners on every
            // top-level window by default. That hairline (often near-black) is what
            // read as "black lines on both sides" flashing in during the mode switch —
            // the cover never had DWM told to skip it.
            var none = Win32.DWMWA_COLOR_NONE;
            _ = Win32.DwmSetWindowAttribute(hwnd, Win32.DWMWA_BORDER_COLOR, ref none, sizeof(int));
            var noRound = Win32.DWMWCP_DONOTROUND;
            _ = Win32.DwmSetWindowAttribute(hwnd, Win32.DWMWA_WINDOW_CORNER_PREFERENCE, ref noRound, sizeof(int));

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

    private static MediaBrush ResolvePageTintBrush(Window? host)
    {
        try
        {
            if (host?.Background is SolidColorBrush solid
                && solid.Color.A > 0
                && (solid.Color.R > 8 || solid.Color.G > 8 || solid.Color.B > 8))
            {
                return solid.Clone();
            }
        }
        catch
        {
            /* ignore */
        }

        // Light calendar page — matches default theme; avoids black gutters.
        return new SolidColorBrush(MediaColor.FromRgb(0xEE, 0xF0, 0xF2));
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
