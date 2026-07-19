using System.Diagnostics;
using Microsoft.Win32;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Registers/unregisters the app under the per-user "Run at Windows startup" registry key,
/// mirroring settings.viewOptions.runAtStartup (Settings → 일반 → 컴퓨터 시작시 자동 실행).
/// </summary>
internal static class StartupRegistrationService
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    // Fixed identifier (not the versioned AppTitle) so upgrades don't leave stale/duplicate entries.
    private const string ValueName = "MyDesktopCalendar";

    /// <summary>Adds or removes the Run key entry to match <paramref name="enabled"/>.</summary>
    public static void Apply(bool enabled)
    {
        try
        {
            // Dev/build-output launches (dotnet run / npm run win:run, invoked from the repo's
            // bin\Debug|Release\... folder) must never hijack the real per-user startup entry —
            // otherwise every test run silently repoints Windows' auto-launch at a throwaway dev
            // exe, so the *next* login (or the very next launch attempt, via the single-instance
            // mutex's "bring existing to front" handoff in App.xaml.cs) silently resurrects that
            // stale build instead of whatever the user actually meant to run/install. Only the
            // installed exe (under LocalAppDataFolder\My Desktop Calendar, per msi/Product.wxs)
            // is allowed to register itself.
            if (IsDevBuildOutputPath())
            {
                return;
            }

            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
            if (key is null) return;

            if (!enabled)
            {
                key.DeleteValue(ValueName, throwOnMissingValue: false);
                return;
            }

            var exePath = GetExecutablePath();
            if (string.IsNullOrEmpty(exePath)) return;
            key.SetValue(ValueName, $"\"{exePath}\"", RegistryValueKind.String);
        }
        catch
        {
            // Registry access can fail in locked-down environments — never crash the UI for this.
        }
    }

    /// <summary>Reconciles the registry with the stored setting; call once on app launch.</summary>
    public static void Sync(bool enabled)
    {
        try
        {
            if (IsDevBuildOutputPath())
            {
                return;
            }

            if (!enabled)
            {
                Apply(false);
                return;
            }

            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
            var current = key?.GetValue(ValueName) as string;
            var exePath = GetExecutablePath();
            var expected = string.IsNullOrEmpty(exePath) ? null : $"\"{exePath}\"";

            // Re-write when missing or stale (e.g. app moved/updated to a new install path).
            if (expected is not null && !string.Equals(current, expected, StringComparison.OrdinalIgnoreCase))
            {
                Apply(true);
            }
        }
        catch
        {
            /* ignore */
        }
    }

    private static string? GetExecutablePath()
    {
        return Environment.ProcessPath
            ?? Process.GetCurrentProcess().MainModule?.FileName;
    }

    /// <summary>
    /// True when running straight out of a dotnet build output folder (bin\Debug\... or
    /// bin\Release\...), as opposed to the MSI-installed copy under LocalAppDataFolder.
    /// </summary>
    private static bool IsDevBuildOutputPath()
    {
        var exePath = GetExecutablePath();
        if (string.IsNullOrEmpty(exePath)) return false;

        return exePath.Contains(@"\bin\Debug\", StringComparison.OrdinalIgnoreCase)
            || exePath.Contains(@"\bin\Release\", StringComparison.OrdinalIgnoreCase);
    }
}
