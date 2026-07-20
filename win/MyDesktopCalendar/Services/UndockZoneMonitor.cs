using System.Text.Json.Nodes;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Legacy zone-registration API kept for the JS bridge. Wallpaper-embed click synthesis
/// is retired — desktop mode is a locked top-level window and native clicks reach WebView2.
/// </summary>
internal sealed class UndockZoneMonitor
{
    public UndockZoneMonitor(
        DesktopEmbedService embed,
        Func<IntPtr> getHwnd,
        Action showWindow,
        Action<string> onCreateDoubleClick,
        Action<string, string> onEditDoubleClick,
        Action<string> onUiActionClick)
    {
        _ = embed;
        _ = getHwnd;
        _ = showWindow;
        _ = onCreateDoubleClick;
        _ = onEditDoubleClick;
        _ = onUiActionClick;
    }

    public void SetZones(JsonObject? body) => _ = body;

    public void Clear()
    {
    }

    public void SetUiActionZones(JsonObject? body) => _ = body;

    public void ClearUiActionZones()
    {
    }

    public void SetCreateZones(JsonObject? body) => _ = body;

    public void ClearCreateZones()
    {
    }

    public void SetEditZones(JsonObject? body) => _ = body;

    public void ClearEditZones()
    {
    }
}
