using MyDesktopCalendar.Native;
using MediaColor = System.Windows.Media.Color;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Matches custom title bar colors so the OS resize/border strip is not white in dark mode.
/// </summary>
internal static class WindowFrameTheme
{
    // COLORREF is 0x00BBGGRR
    private const int FrameColorDark = 0x00242120; // #202124
    private const int FrameColorLight = 0x00EFEFEF; // #efefef
    /// <summary>Win11+: do not draw the system window border.</summary>
    private const int DwmwaColorNone = unchecked((int)0xFFFFFFFE);

    public static readonly MediaColor PageDark = MediaColor.FromRgb(0x20, 0x21, 0x24);
    public static readonly MediaColor PageLight = MediaColor.FromRgb(0xEF, 0xEF, 0xEF);

    private static IntPtr _hwnd;
    private static bool _dark;

    public static void Apply(IntPtr hwnd, bool dark)
    {
        _hwnd = hwnd;
        _dark = dark;
        ApplyCore();
    }

    /// <summary>Re-apply after DWM frame extend / style changes (those reset border color).</summary>
    public static void Reapply()
    {
        if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
        {
            return;
        }

        ApplyCore();
    }

    private static void ApplyCore()
    {
        if (_hwnd == IntPtr.Zero || !Win32.IsWindow(_hwnd))
        {
            return;
        }

        var immersive = _dark ? 1 : 0;
        _ = Win32.DwmSetWindowAttribute(_hwnd, Win32.DWMWA_USE_IMMERSIVE_DARK_MODE, ref immersive, sizeof(int));

        if (_dark)
        {
            // Never allow the default light/white DWM border in dark mode.
            var none = DwmwaColorNone;
            var dark = FrameColorDark;
            _ = Win32.DwmSetWindowAttribute(_hwnd, Win32.DWMWA_BORDER_COLOR, ref none, sizeof(int));
            _ = Win32.DwmSetWindowAttribute(_hwnd, Win32.DWMWA_CAPTION_COLOR, ref dark, sizeof(int));
        }
        else
        {
            var light = FrameColorLight;
            _ = Win32.DwmSetWindowAttribute(_hwnd, Win32.DWMWA_BORDER_COLOR, ref light, sizeof(int));
            _ = Win32.DwmSetWindowAttribute(_hwnd, Win32.DWMWA_CAPTION_COLOR, ref light, sizeof(int));
        }
    }
}
