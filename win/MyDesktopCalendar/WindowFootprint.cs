using System.Windows;
using System.Windows.Media;
using MyDesktopCalendar.Services;

namespace MyDesktopCalendar;

internal static class WindowFootprint
{
    /// <summary>
    /// Keep WPF Left/Top/Width/Height in sync with Win32 physical-pixel bounds (DPI-aware).
    /// Prevents WPF layout from nudging the HWND after SetParent/SetWindowPos.
    /// </summary>
    public static void Sync(Window window, DesktopEmbedService.Bounds physical)
    {
        var (scaleX, scaleY) = GetDipScale(window);
        window.Left = physical.X / scaleX;
        window.Top = physical.Y / scaleY;
        window.Width = Math.Max(window.MinWidth, physical.Width / scaleX);
        window.Height = Math.Max(window.MinHeight, physical.Height / scaleY);
    }

    /// <summary>
    /// Never treat physical pixels as DIP — that oversized the window on &gt;100% DPI
    /// (CompositionTarget briefly null / wrong after SetParent).
    /// </summary>
    private static (double scaleX, double scaleY) GetDipScale(Window window)
    {
        try
        {
            var source = PresentationSource.FromVisual(window);
            if (source?.CompositionTarget is { } target)
            {
                var m = target.TransformFromDevice;
                // TransformFromDevice maps physical → DIP; M11/M22 are 1/scale.
                var sx = m.M11;
                var sy = m.M22;
                if (sx > 0.01 && sy > 0.01)
                {
                    return (1.0 / sx, 1.0 / sy);
                }
            }
        }
        catch
        {
            /* fall through */
        }

        try
        {
            var dpi = VisualTreeHelper.GetDpi(window);
            if (dpi.DpiScaleX > 0.01 && dpi.DpiScaleY > 0.01)
            {
                return (dpi.DpiScaleX, dpi.DpiScaleY);
            }
        }
        catch
        {
            /* fall through */
        }

        return (1.0, 1.0);
    }
}
