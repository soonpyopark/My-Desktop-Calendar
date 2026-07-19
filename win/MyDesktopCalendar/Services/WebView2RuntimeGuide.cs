using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using MessageBox = System.Windows.MessageBox;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Detect system Evergreen WebView2 Runtime and install/guide when missing:
/// online → download + run Bootstrapper (with confirm);
/// offline → show that a separately distributed program/ installer is required.
/// </summary>
internal static class WebView2RuntimeGuide
{
    private const string BootstrapperFileName = "MicrosoftEdgeWebview2Setup.exe";

    public static bool IsRuntimeAvailable()
    {
        try
        {
            var version = CoreWebView2Environment.GetAvailableBrowserVersionString();
            return !string.IsNullOrWhiteSpace(version);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Evergreen Runtime version string, or null when missing/unreadable.</summary>
    public static string? TryGetRuntimeVersion()
    {
        try
        {
            var version = CoreWebView2Environment.GetAvailableBrowserVersionString();
            return string.IsNullOrWhiteSpace(version) ? null : version.Trim();
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Coarse “any network up” check (may be true on intranet-only).</summary>
    public static bool AppearsOnline()
    {
        try
        {
            return NetworkInterface.GetIsNetworkAvailable();
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// If Runtime is missing, guide/install and return whether it is available afterwards.
    /// Safe to call from the UI thread (async MessageBox + download).
    /// </summary>
    public static async Task<bool> EnsureRuntimeOrGuideAsync(Window owner, Exception? cause = null)
    {
        if (IsRuntimeAvailable())
        {
            return true;
        }

        var detail = string.IsNullOrWhiteSpace(cause?.Message)
            ? ""
            : $"\n\n상세: {cause!.Message}";

        var online = AppearsOnline() && await CanReachMicrosoftDownloadAsync().ConfigureAwait(true);

        if (online)
        {
            var result = MessageBox.Show(
                owner,
                "Microsoft Edge WebView2 Runtime이 필요합니다." + detail +
                "\n\n인터넷이 연결된 것으로 보입니다." +
                "\n이 프로그램 실행에 필수로, 설치 프로그램을 받아 바로 설치할 수 있습니다." +
                "\n(설치 중 관리자 권한 확인 창이 뜰 수 있습니다.)" +
                "\n\n「예」 — 지금 설치" +
                "\n「아니요」 — Microsoft 안내 페이지 열기" +
                "\n「취소」 — 종료",
                AppConstants.AppTitle,
                MessageBoxButton.YesNoCancel,
                MessageBoxImage.Warning);

            if (result == MessageBoxResult.Yes)
            {
                var installed = await TryInstallViaBootstrapperAsync(owner).ConfigureAwait(true);
                if (installed || IsRuntimeAvailable())
                {
                    MessageBox.Show(
                        owner,
                        "WebView2 Runtime 설치가 완료되었습니다.\n확인을 누르면 앱을 계속합니다.",
                        AppConstants.AppTitle,
                        MessageBoxButton.OK,
                        MessageBoxImage.Information);
                    return true;
                }

                MessageBox.Show(
                    owner,
                    "자동 설치에 실패했거나 아직 Runtime을 찾지 못했습니다.\n오프라인 설치 안내로 전환합니다.",
                    AppConstants.AppTitle,
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
                return await GuideOfflineAsync(owner, detail).ConfigureAwait(true);
            }

            if (result == MessageBoxResult.No)
            {
                OpenDownloadPage();
            }

            return IsRuntimeAvailable();
        }

        return await GuideOfflineAsync(owner, detail).ConfigureAwait(true);
    }

    /// <summary>Prefer <see cref="EnsureRuntimeOrGuideAsync"/> from async UI startup.</summary>
    public static void ShowInstallGuidance(Window owner, Exception? cause = null)
    {
        owner.Dispatcher.InvokeAsync(async () =>
        {
            await EnsureRuntimeOrGuideAsync(owner, cause);
        });
    }

    public static void OpenBootstrapperDownload()
    {
        OpenUrl(AppConstants.WebView2BootstrapperUrl);
    }

    public static void OpenDownloadPage()
    {
        OpenUrl(AppConstants.WebView2DownloadPage);
    }

    private static Task<bool> GuideOfflineAsync(Window owner, string detail)
    {
        MessageBox.Show(
            owner,
            "Microsoft Edge WebView2 Runtime이 필요합니다." +
            "\n현재 PC는 오프라인이거나 Microsoft 설치 서버에 연결할 수 없습니다." + detail +
            "\n\n이 앱(MSI)에는 Runtime이 포함되어 있지 않습니다." +
            "\n오프라인 PC에서는 별도로 배포하는 program 폴더의 설치 파일을 먼저 실행해 주세요." +
            "\n\n• MicrosoftEdgeWebView2RuntimeInstallerX64.exe" +
            "\n  (필요 시 .NET Desktop Runtime도 program 폴더에 함께 제공)" +
            "\n\n설치가 끝난 뒤 My Desktop Calendar를 다시 실행하세요.",
            AppConstants.AppTitle,
            MessageBoxButton.OK,
            MessageBoxImage.Warning);
        return Task.FromResult(false);
    }

    private static async Task<bool> TryInstallViaBootstrapperAsync(Window owner)
    {
        string? tempSetup = null;
        try
        {
            System.Windows.Input.Mouse.OverrideCursor = System.Windows.Input.Cursors.Wait;
            try
            {
                tempSetup = Path.Combine(Path.GetTempPath(), BootstrapperFileName);
                using var http = CreateHttpClient(TimeSpan.FromMinutes(5));
                await using (var network = await http.GetStreamAsync(AppConstants.WebView2BootstrapperUrl)
                                 .ConfigureAwait(true))
                await using (var file = new FileStream(
                                 tempSetup,
                                 FileMode.Create,
                                 FileAccess.Write,
                                 FileShare.None,
                                 81920,
                                 useAsync: true))
                {
                    await network.CopyToAsync(file).ConfigureAwait(true);
                }

                var info = new FileInfo(tempSetup);
                if (!info.Exists || info.Length < 50_000)
                {
                    return false;
                }
            }
            finally
            {
                System.Windows.Input.Mouse.OverrideCursor = null;
            }

            // Interactive install — Bootstrapper downloads matching Runtime (needs internet)
            // and prompts for elevation when required. Prefer UI over /silent for intranet.
            return await RunInstallerAndWaitAsync(tempSetup, owner).ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            System.Windows.Input.Mouse.OverrideCursor = null;
            MessageBox.Show(
                owner,
                $"Bootstrapper 다운로드/실행에 실패했습니다.\n{ex.Message}",
                AppConstants.AppTitle,
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            return false;
        }
        finally
        {
            try
            {
                if (tempSetup is not null && File.Exists(tempSetup))
                {
                    // Leave file if installer child still holds it; ignore delete errors.
                    File.Delete(tempSetup);
                }
            }
            catch
            {
                /* ignore */
            }
        }
    }

    private static async Task<bool> RunInstallerAndWaitAsync(string exePath, Window owner)
    {
        try
        {
            var start = new ProcessStartInfo
            {
                FileName = exePath,
                UseShellExecute = true,
                // Let the installer elevate itself when needed.
            };

            using var process = Process.Start(start);
            if (process is null)
            {
                return false;
            }

            await process.WaitForExitAsync().ConfigureAwait(true);

            // Registry/catalog can lag briefly after setup returns.
            for (var i = 0; i < 10; i++)
            {
                if (IsRuntimeAvailable())
                {
                    return true;
                }

                await Task.Delay(400).ConfigureAwait(true);
            }

            return IsRuntimeAvailable();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                owner,
                $"설치 프로그램을 실행하지 못했습니다.\n{ex.Message}",
                AppConstants.AppTitle,
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            return false;
        }
    }

    private static async Task<bool> CanReachMicrosoftDownloadAsync()
    {
        try
        {
            using var http = CreateHttpClient(TimeSpan.FromSeconds(4));
            using var req = new HttpRequestMessage(HttpMethod.Get, AppConstants.WebView2BootstrapperUrl);
            using var res = await http.SendAsync(
                    req,
                    HttpCompletionOption.ResponseHeadersRead)
                .ConfigureAwait(true);
            // Redirects / 200 / even some errors still mean “route exists”; treat success + redirects as online CDN.
            return (int)res.StatusCode is >= 200 and < 500;
        }
        catch
        {
            return false;
        }
    }

    private static HttpClient CreateHttpClient(TimeSpan timeout)
    {
        return new HttpClient
        {
            Timeout = timeout,
        };
    }

    private static void OpenUrl(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            /* ignore */
        }
    }
}
