using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace MyDesktopCalendar.Services;

internal static class JsonUtil
{
    /// <summary>
    /// .NET 8+: JsonNode.ToJsonString(options) requires a TypeInfoResolver or it throws
    /// when options are implicitly made read-only.
    /// </summary>
    public static JsonSerializerOptions Indented { get; } = Create(writeIndented: true);

    public static JsonSerializerOptions Compact { get; } = Create(writeIndented: false);

    private static JsonSerializerOptions Create(bool writeIndented) => new()
    {
        WriteIndented = writeIndented,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
    };
}
