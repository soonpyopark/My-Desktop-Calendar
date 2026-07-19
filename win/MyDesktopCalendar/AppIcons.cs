using System.Drawing;
using System.IO;
using System.Windows.Forms;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace MyDesktopCalendar;

internal static class AppIcons
{
    private static Icon? _trayIcon;
    private static Icon? _smallIcon;
    private static Icon? _largeIcon;

    public static string AssetsDir => Path.Combine(AppContext.BaseDirectory, "Assets");

    public static Icon GetTrayIcon()
    {
        _trayIcon ??= LoadIconFile("tray.ico", SystemInformation.SmallIconSize)
            ?? LoadIconFile("app.ico", SystemInformation.SmallIconSize)
            ?? SystemIcons.Application;
        return _trayIcon;
    }

    public static Icon GetSmallWindowIcon()
    {
        _smallIcon ??= LoadIconFile("app.ico", SystemInformation.SmallIconSize)
            ?? LoadIconFile("tray.ico", SystemInformation.SmallIconSize)
            ?? SystemIcons.Application;
        return _smallIcon;
    }

    public static Icon GetLargeWindowIcon()
    {
        _largeIcon ??= LoadIconFile("app.ico", SystemInformation.IconSize)
            ?? LoadIconFile("tray.ico", SystemInformation.IconSize)
            ?? SystemIcons.Application;
        return _largeIcon;
    }

    public static Icon GetAppIcon() => GetLargeWindowIcon();

    public static ImageSource? GetWindowImageSource()
    {
        var icoPath = Path.Combine(AssetsDir, "app.ico");
        if (!File.Exists(icoPath))
        {
            icoPath = Path.Combine(AssetsDir, "tray.ico");
        }

        if (!File.Exists(icoPath))
        {
            return null;
        }

        return BitmapFrame.Create(
            new Uri(icoPath, UriKind.Absolute),
            BitmapCreateOptions.None,
            BitmapCacheOption.OnLoad);
    }

    private static Icon? LoadIconFile(string fileName, Size preferredSize)
    {
        var path = Path.Combine(AssetsDir, fileName);
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            return new Icon(path, preferredSize);
        }
        catch
        {
            try
            {
                using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                using var temp = new Icon(fs);
                return (Icon)temp.Clone();
            }
            catch
            {
                return null;
            }
        }
    }
}
