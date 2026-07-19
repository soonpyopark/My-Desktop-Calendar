using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Ports NAS4USB <c>electron/membersService.js</c>: members.json under the data root,
/// SHA-256 salted password hashes, list/save CRUD used by settings → 회원관리.
/// </summary>
internal sealed class MembersService
{
    private const string MembersFileName = "members.json";
    private const string DefaultPasswordSalt = "mycalendar-member-v1";
    private const int MinPasswordLength = 6;

    /// <summary>Fixed id for the seeded .env bootstrap admin row in members.json.</summary>
    public const string BootstrapAdminMemberId = "member-bootstrap-admin";

    private readonly object _gate = new();
    private readonly string _membersFilePath;
    private readonly string _passwordSalt;

    public MembersService(string dataRoot)
    {
        _membersFilePath = Path.Combine(dataRoot, MembersFileName);
        _passwordSalt = ResolvePasswordSalt();
    }

    public static bool IsBootstrapAdminMemberId(string? id) =>
        string.Equals(id, BootstrapAdminMemberId, StringComparison.Ordinal);

    /// <summary>
    /// Ensure the bootstrap admin appears in the member list. Seeds with a hash of the
    /// .env password when missing; never resets an existing password hash (UI override).
    /// </summary>
    public void EnsureBootstrapAdmin(string adminLoginId, string adminPassword)
    {
        var loginId = (adminLoginId ?? "").Trim();
        if (loginId.Length == 0) loginId = AppConstants.DefaultAdminId;
        var seedPassword = adminPassword ?? "";

        lock (_gate)
        {
            var members = LoadMembers();
            var bootstrap = members.Find(m => IsBootstrapAdminMemberId(GetString(m, "id")));
            if (bootstrap is null)
            {
                // Adopt a pre-existing row that already uses the admin login id.
                var byLogin = members.Find(m =>
                    string.Equals(GetString(m, "loginId"), loginId, StringComparison.OrdinalIgnoreCase));
                if (byLogin is not null)
                {
                    byLogin["id"] = BootstrapAdminMemberId;
                    byLogin["loginId"] = loginId;
                    byLogin["role"] = "super_admin";
                    byLogin["active"] = true;
                    if (GetString(byLogin, "displayName").Trim().Length == 0)
                    {
                        byLogin["displayName"] = loginId;
                    }
                    WriteMembers(members);
                    return;
                }

                members.Insert(0, new JsonObject
                {
                    ["id"] = BootstrapAdminMemberId,
                    ["loginId"] = loginId,
                    ["displayName"] = loginId,
                    ["passwordHash"] = HashPassword(seedPassword),
                    ["role"] = "super_admin",
                    ["active"] = true,
                });
                WriteMembers(members);
                return;
            }

            var dirty = false;
            if (!string.Equals(GetString(bootstrap, "loginId"), loginId, StringComparison.Ordinal))
            {
                bootstrap["loginId"] = loginId;
                dirty = true;
            }
            if (GetString(bootstrap, "role") != "super_admin")
            {
                bootstrap["role"] = "super_admin";
                dirty = true;
            }
            if (!GetBool(bootstrap, "active", true))
            {
                bootstrap["active"] = true;
                dirty = true;
            }
            if (dirty) WriteMembers(members);
        }
    }

    public bool HasMemberLoginId(string? loginId)
    {
        var key = (loginId ?? "").Trim();
        if (key.Length == 0) return false;
        lock (_gate)
        {
            return LoadMembers().Any(m =>
                string.Equals(GetString(m, "loginId"), key, StringComparison.OrdinalIgnoreCase));
        }
    }

    public JsonArray ListPublicMembers()
    {
        lock (_gate)
        {
            var members = LoadMembers()
                .OrderBy(m => IsBootstrapAdminMemberId(GetString(m, "id")) ? 0 : 1)
                .ThenBy(m => GetString(m, "loginId"), StringComparer.OrdinalIgnoreCase)
                .ToList();
            var list = new JsonArray();
            foreach (var member in members)
            {
                list.Add(ToPublicMember(member));
            }
            return list;
        }
    }

    /// <summary>Returns the matching active member, or null.</summary>
    public JsonObject? FindActiveMemberByCredentials(string? loginId, string? password)
    {
        var providedId = (loginId ?? "").Trim();
        var providedPassword = password ?? "";
        if (providedId.Length == 0 || providedPassword.Length == 0) return null;

        lock (_gate)
        {
            foreach (var member in LoadMembers())
            {
                if (!GetBool(member, "active", true)) continue;
                if (!string.Equals(GetString(member, "loginId"), providedId, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                if (!VerifyPassword(providedPassword, GetString(member, "passwordHash"))) continue;
                return (JsonObject)member.DeepClone();
            }
        }
        return null;
    }

    /// <summary>
    /// Apply a batch save payload (create / update / delete). Returns public members and the
    /// loginIds removed in this save (for cascading calendar cleanup).
    /// Throws <see cref="InvalidOperationException"/> with a Korean message on validation failure.
    /// </summary>
    public (JsonArray Members, IReadOnlyList<string> DeletedLoginIds) SaveMembersPayload(JsonObject? payload)
    {
        var memberPayload = payload?["members"] as JsonArray
            ?? throw new InvalidOperationException("회원 목록이 올바르지 않습니다.");

        lock (_gate)
        {
            var existing = LoadMembers();
            var deleteIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var node in memberPayload)
            {
                if (node is not JsonObject item) continue;
                if (item["_delete"]?.GetValue<bool>() != true) continue;
                var id = GetString(item, "id");
                if (id.Length > 0) deleteIds.Add(id);
            }

            if (deleteIds.Contains(BootstrapAdminMemberId))
            {
                throw new InvalidOperationException("기본 관리자(admin) 계정은 삭제할 수 없습니다.");
            }

            var deletedLoginIds = existing
                .Where(m => deleteIds.Contains(GetString(m, "id")))
                .Select(m => GetString(m, "loginId").Trim())
                .Where(loginId => loginId.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            var next = existing.Where(m => !deleteIds.Contains(GetString(m, "id"))).ToList();
            var loginIds = new HashSet<string>(
                next.Select(m => GetString(m, "loginId").ToLowerInvariant()),
                StringComparer.Ordinal);

            foreach (var node in memberPayload)
            {
                if (node is not JsonObject patch) continue;
                if (patch["_delete"]?.GetValue<bool>() == true) continue;
                var id = GetString(patch, "id");
                if (id.Length == 0) continue;

                var existingIndex = next.FindIndex(m => GetString(m, "id") == id);
                if (existingIndex < 0)
                {
                    throw new InvalidOperationException("수정할 회원을 찾을 수 없습니다.");
                }

                var current = next[existingIndex];
                var isBootstrap = IsBootstrapAdminMemberId(id);
                var loginId = GetString(patch, "loginId").Trim();
                if (isBootstrap)
                {
                    // Keep the seeded admin login id / role / active; password may change.
                    loginId = GetString(current, "loginId").Trim();
                }
                if (loginId.Length == 0)
                {
                    throw new InvalidOperationException("로그인 아이디를 입력해 주세요.");
                }

                var loginKey = loginId.ToLowerInvariant();
                if (next.Any(m =>
                        GetString(m, "id") != id
                        && GetString(m, "loginId").ToLowerInvariant() == loginKey))
                {
                    throw new InvalidOperationException($"아이디 「{loginId}」가 이미 사용 중입니다.");
                }

                loginIds.Remove(GetString(current, "loginId").ToLowerInvariant());

                var passwordHash = GetString(current, "passwordHash");
                var password = GetString(patch, "password").Trim();
                if (password.Length > 0)
                {
                    if (password.Length < MinPasswordLength)
                    {
                        throw new InvalidOperationException("비밀번호는 6자 이상이어야 합니다.");
                    }
                    passwordHash = HashPassword(password);
                }

                var displayName = GetString(patch, "displayName").Trim();
                if (displayName.Length == 0) displayName = loginId;

                next[existingIndex] = new JsonObject
                {
                    ["id"] = id,
                    ["loginId"] = loginId,
                    ["displayName"] = displayName,
                    ["passwordHash"] = passwordHash,
                    ["role"] = isBootstrap
                        ? "super_admin"
                        : NormalizeRole(GetString(patch, "role", GetString(current, "role"))),
                    ["active"] = isBootstrap
                        ? true
                        : patch.ContainsKey("active")
                            ? GetBool(patch, "active", true)
                            : GetBool(current, "active", true),
                };
                loginIds.Add(loginKey);
            }

            foreach (var node in memberPayload)
            {
                if (node is not JsonObject patch) continue;
                if (patch["_delete"]?.GetValue<bool>() == true) continue;
                if (GetString(patch, "id").Length > 0) continue;

                var loginId = GetString(patch, "loginId").Trim();
                var password = GetString(patch, "password").Trim();
                if (loginId.Length == 0)
                {
                    throw new InvalidOperationException("새 회원의 로그인 아이디를 입력해 주세요.");
                }
                if (password.Length < MinPasswordLength)
                {
                    throw new InvalidOperationException("새 회원 비밀번호는 6자 이상이어야 합니다.");
                }
                if (loginIds.Contains(loginId.ToLowerInvariant()))
                {
                    throw new InvalidOperationException($"아이디 「{loginId}」가 이미 사용 중입니다.");
                }

                var displayName = GetString(patch, "displayName").Trim();
                if (displayName.Length == 0) displayName = loginId;

                next.Add(new JsonObject
                {
                    ["id"] = $"member-{Guid.NewGuid().ToString("N")[..8]}",
                    ["loginId"] = loginId,
                    ["displayName"] = displayName,
                    ["passwordHash"] = HashPassword(password),
                    ["role"] = NormalizeRole(GetString(patch, "role")),
                    ["active"] = GetBool(patch, "active", true),
                });
                loginIds.Add(loginId.ToLowerInvariant());
            }

            WriteMembers(next);

            var list = new JsonArray();
            foreach (var member in next)
            {
                list.Add(ToPublicMember(member));
            }
            return (list, deletedLoginIds);
        }
    }

    private List<JsonObject> LoadMembers()
    {
        try
        {
            if (!File.Exists(_membersFilePath)) return new List<JsonObject>();
            var raw = File.ReadAllText(_membersFilePath, Encoding.UTF8).Trim();
            if (raw.Length == 0) return new List<JsonObject>();
            if (raw.Length > 0 && raw[0] == '\uFEFF') raw = raw[1..];

            var parsed = JsonNode.Parse(raw);
            JsonArray? items = parsed switch
            {
                JsonArray arr => arr,
                JsonObject obj => obj["members"] as JsonArray,
                _ => null,
            };
            if (items is null) return new List<JsonObject>();

            var result = new List<JsonObject>();
            foreach (var node in items)
            {
                var normalized = NormalizeStoredMember(node as JsonObject);
                if (normalized is not null) result.Add(normalized);
            }
            return result;
        }
        catch (JsonException)
        {
            return new List<JsonObject>();
        }
    }

    private void WriteMembers(List<JsonObject> members)
    {
        var dir = Path.GetDirectoryName(_membersFilePath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var array = new JsonArray();
        foreach (var member in members)
        {
            array.Add(member.DeepClone());
        }

        var payload = new JsonObject { ["members"] = array };
        var tempPath = $"{_membersFilePath}.{Environment.ProcessId}.tmp";
        File.WriteAllText(tempPath, payload.ToJsonString(JsonUtil.Indented) + "\n", Encoding.UTF8);
        try
        {
            if (File.Exists(_membersFilePath))
            {
                var attrs = File.GetAttributes(_membersFilePath);
                if ((attrs & FileAttributes.ReadOnly) != 0)
                {
                    File.SetAttributes(_membersFilePath, attrs & ~FileAttributes.ReadOnly);
                }
            }
            File.Move(tempPath, _membersFilePath, overwrite: true);
        }
        catch (UnauthorizedAccessException)
        {
            if (File.Exists(_membersFilePath)) File.Delete(_membersFilePath);
            File.Move(tempPath, _membersFilePath);
        }
    }

    private static JsonObject? NormalizeStoredMember(JsonObject? record)
    {
        if (record is null) return null;
        var id = GetString(record, "id").Trim();
        var loginId = GetString(record, "loginId").Trim();
        var passwordHash = GetString(record, "passwordHash").Trim();
        if (id.Length == 0 || loginId.Length == 0 || passwordHash.Length == 0) return null;

        var displayName = GetString(record, "displayName").Trim();
        if (displayName.Length == 0) displayName = loginId;

        return new JsonObject
        {
            ["id"] = id,
            ["loginId"] = loginId,
            ["displayName"] = displayName,
            ["passwordHash"] = passwordHash,
            ["role"] = NormalizeRole(GetString(record, "role")),
            ["active"] = GetBool(record, "active", true),
        };
    }

    private static JsonObject ToPublicMember(JsonObject member) => new()
    {
        ["id"] = GetString(member, "id"),
        ["loginId"] = GetString(member, "loginId"),
        ["displayName"] = GetString(member, "displayName"),
        ["role"] = NormalizeRole(GetString(member, "role")),
        ["active"] = GetBool(member, "active", true),
        ["isBootstrapAdmin"] = IsBootstrapAdminMemberId(GetString(member, "id")),
    };

    private string HashPassword(string password)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"{_passwordSalt}:{password}"));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private bool VerifyPassword(string password, string expectedHash)
    {
        var actual = HashPassword(password);
        try
        {
            var a = Convert.FromHexString(actual);
            var b = Convert.FromHexString(expectedHash.Trim());
            return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static string ResolvePasswordSalt()
    {
        var fromEnv = Environment.GetEnvironmentVariable("MYCALENDAR_MEMBER_PASSWORD_SALT")
            ?? Environment.GetEnvironmentVariable("NAS4USB_MEMBER_PASSWORD_SALT");
        var trimmed = (fromEnv ?? "").Trim();
        return trimmed.Length > 0 ? trimmed : DefaultPasswordSalt;
    }

    private static string NormalizeRole(string? role) =>
        string.Equals(role, "super_admin", StringComparison.Ordinal) ? "super_admin" : "member";

    private static string GetString(JsonObject obj, string key, string fallback = "")
    {
        if (obj[key] is JsonValue value && value.TryGetValue<string>(out var s)) return s ?? fallback;
        return fallback;
    }

    private static bool GetBool(JsonObject obj, string key, bool fallback)
    {
        if (obj[key] is JsonValue value)
        {
            if (value.TryGetValue<bool>(out var b)) return b;
            if (value.TryGetValue<string>(out var s)
                && bool.TryParse(s, out var parsed))
            {
                return parsed;
            }
        }
        return fallback;
    }
}
