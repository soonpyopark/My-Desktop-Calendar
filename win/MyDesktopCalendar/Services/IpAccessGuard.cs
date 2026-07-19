using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MyDesktopCalendar.Services;

/// <summary>
/// IPv4 / CIDR / range allowlist (same rules as NAS4USB <c>shared/ipCidrCore.js</c>).
/// Empty list = allow all. Loopback is always allowed.
/// </summary>
internal static class IpAccessGuard
{
    private static readonly Regex Ipv4Re = new(
        @"^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public static bool IsClientAllowed(string? remoteAddress, JsonNode? allowedIpCidrsNode)
    {
        var rules = GetCidrStrings(allowedIpCidrsNode);
        if (rules.Count == 0)
        {
            return true;
        }

        var ip = NormalizeClientIp(remoteAddress);
        if (ip is null)
        {
            return false;
        }

        if (ip == "127.0.0.1")
        {
            return true;
        }

        return rules.Any(rule => IpMatchesRule(ip, rule));
    }

    public static string? NormalizeClientIp(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var trimmed = raw.Trim();
        if (trimmed.StartsWith("::ffff:", StringComparison.OrdinalIgnoreCase))
        {
            trimmed = trimmed["::ffff:".Length..];
        }

        if (trimmed is "::1")
        {
            return "127.0.0.1";
        }

        // Strip optional port from IPv4 endpoint strings like "192.168.0.1:52341"
        if (trimmed.Contains(':') && !trimmed.Contains('.'))
        {
            return null;
        }

        var host = trimmed;
        var colon = trimmed.LastIndexOf(':');
        if (colon > 0 && trimmed.Count(c => c == '.') == 3)
        {
            host = trimmed[..colon];
        }

        return ParseIPv4(host) is null ? null : host;
    }

    public static string BlockedHtml()
    {
        return """
               <!DOCTYPE html>
               <html lang="ko"><head><meta charset="utf-8"/><title>접속 제한</title>
               <style>body{font-family:"Malgun Gothic",system-ui,sans-serif;margin:2rem;background:#eef2f7;color:#0f172a}
               .box{max-width:28rem;margin:4rem auto;background:#fff;padding:1.75rem 2rem;border-radius:12px;box-shadow:0 8px 24px rgba(15,23,42,.08)}
               h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:.5rem 0;line-height:1.55;color:#475569}</style></head>
               <body><div class="box"><h1>접속이 허용되지 않은 IP입니다</h1>
               <p>관리자에게 접근 가능 IP 대역 등록을 요청하세요.</p>
               <p>서버 PC에서는 <code>127.0.0.1</code> 로 접속할 수 있습니다.</p></div></body></html>
               """;
    }

    public static JsonArray NormalizeAllowedIpCidrs(JsonNode? node)
    {
        var result = new JsonArray();
        if (node is not JsonArray arr)
        {
            return result;
        }

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in arr)
        {
            string? cidr = null;
            string? description = null;
            if (item is JsonValue jv && jv.TryGetValue<string>(out var s))
            {
                cidr = s?.Trim();
            }
            else if (item is JsonObject jo)
            {
                cidr = jo["cidr"]?.GetValue<string>()?.Trim();
                description = jo["description"]?.GetValue<string>()?.Trim();
            }

            if (string.IsNullOrEmpty(cidr) || !IsValidIpOrCidr(cidr) || !seen.Add(cidr))
            {
                continue;
            }

            var entry = new JsonObject { ["cidr"] = cidr };
            if (!string.IsNullOrEmpty(description))
            {
                entry["description"] = description;
            }

            result.Add(entry);
        }

        return result;
    }

    private static List<string> GetCidrStrings(JsonNode? node)
    {
        return NormalizeAllowedIpCidrs(node)
            .Select(item => item is JsonObject jo ? jo["cidr"]?.GetValue<string>() ?? "" : "")
            .Where(s => s.Length > 0)
            .ToList();
    }

    private static bool IsValidIpOrCidr(string value) => ParseIpRule(value) is not null;

    private static uint? ParseIPv4(string ip)
    {
        if (!Ipv4Re.IsMatch(ip))
        {
            return null;
        }

        var parts = ip.Split('.');
        if (parts.Length != 4)
        {
            return null;
        }

        uint n = 0;
        foreach (var part in parts)
        {
            if (!byte.TryParse(part, out var b))
            {
                return null;
            }

            n = (n << 8) | b;
        }

        return n;
    }

    private sealed record CidrRule(uint Network, uint Mask);
    private sealed record RangeRule(uint Start, uint End);

    private static object? ParseIpRule(string entry)
    {
        var trimmed = entry.Trim();
        if (trimmed.Length == 0)
        {
            return null;
        }

        if (trimmed.Contains('/'))
        {
            var slash = trimmed.LastIndexOf('/');
            var ipPart = trimmed[..slash].Trim();
            var prefixPart = trimmed[(slash + 1)..].Trim();
            if (!int.TryParse(prefixPart, out var prefix) || prefix is < 0 or > 32)
            {
                return null;
            }

            var ip = ParseIPv4(ipPart);
            if (ip is null)
            {
                return null;
            }

            var mask = prefix == 0 ? 0u : 0xffffffffu << (32 - prefix);
            return new CidrRule((ip.Value & mask), mask);
        }

        if (trimmed.Contains('-'))
        {
            var dash = trimmed.IndexOf('-');
            var startPart = trimmed[..dash].Trim();
            var endPart = trimmed[(dash + 1)..].Trim();
            if (endPart.Contains('-'))
            {
                return null;
            }

            var start = ParseIPv4(startPart);
            var end = ParseIPv4(endPart);
            if (start is null || end is null || start > end)
            {
                return null;
            }

            return new RangeRule(start.Value, end.Value);
        }

        var single = ParseIPv4(trimmed);
        return single is null ? null : new CidrRule(single.Value, 0xffffffffu);
    }

    private static bool IpMatchesRule(string ipString, string ruleText)
    {
        var ipNum = ParseIPv4(ipString);
        if (ipNum is null)
        {
            return false;
        }

        var rule = ParseIpRule(ruleText);
        return rule switch
        {
            RangeRule r => ipNum.Value >= r.Start && ipNum.Value <= r.End,
            CidrRule c => (ipNum.Value & c.Mask) == c.Network,
            _ => false,
        };
    }

    /// <summary>Prefer X-Forwarded-For / X-Real-IP when present, else remote endpoint.</summary>
    public static string? GetClientIp(HttpListenerRequest req)
    {
        var forwarded = req.Headers["X-Forwarded-For"];
        if (!string.IsNullOrWhiteSpace(forwarded))
        {
            var first = forwarded.Split(',')[0].Trim();
            if (first.Length > 0)
            {
                return first;
            }
        }

        var realIp = req.Headers["X-Real-IP"];
        if (!string.IsNullOrWhiteSpace(realIp))
        {
            return realIp.Trim();
        }

        return req.RemoteEndPoint?.Address?.ToString();
    }
}
