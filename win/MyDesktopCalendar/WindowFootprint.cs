using System.Windows;
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
        var source = PresentationSource.FromVisual(window);
        if (source?.CompositionTarget is null)
        {
            window.Left = physical.X;
            window.Top = physical.Y;
            window.Width = physical.Width;
            window.Height = physical.Height;
            return;
        }

        var toDip = source.CompositionTarget.TransformFromDevice;
        var topLeft = toDip.Transform(new System.Windows.Point(physical.X, physical.Y));
        var bottomRight = toDip.Transform(new System.Windows.Point(physical.X + physical.Width, physical.Y + physical.Height));
        window.Left = topLeft.X;
        window.Top = topLeft.Y;
        window.Width = Math.Max(window.MinWidth, bottomRight.X - topLeft.X);
        window.Height = Math.Max(window.MinHeight, bottomRight.Y - topLeft.Y);
    }
}
