namespace MyDesktopCalendar;

internal static class AppConstants
{
    public const string AppName = "My Desktop Calendar";
    public const string AppVersion = "1.1.7";
    public const string AppTitle = $"{AppName} v{AppVersion}";
    public const string SiteUrl = "https://note4all.tistory.com";
    public const string DefaultDataDir = "data";
    public const string DefaultAdminId = "admin";
    public const string DefaultAdminPw = "admin1234";
    public const string HolidaysKrCalendarId = "holidays-kr";
    public const string PrimaryCalendarId = "primary";
    public const string PrimaryCalendarColor = "#f6bf26";
    public const string VirtualHost = "app.mydesktopcalendar.local";
    public const string WebView2DownloadPage = "https://developer.microsoft.com/microsoft-edge/webview2/";
    /// <summary>Evergreen Bootstrapper (tiny; downloads matching Runtime when online).</summary>
    public const string WebView2BootstrapperUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

    public static readonly string[] CalendarColors =
    [
        "#7986cb", "#33b679", "#8e24aa", "#e67c73", "#f6bf26",
        "#f4511e", "#039be5", "#616161", "#3f51b5", "#0b8043", "#d50000",
    ];

    public const double DefaultOpacity = 1.0;
    public const double MinOpacity = 0.05;
}
