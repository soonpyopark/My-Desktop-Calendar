using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MyDesktopCalendar.Services;

/// <summary>
/// Admin/member session store: in-memory tokens with optional persistence (로그인 유지)
/// to <c>admin-sessions.json</c>. Bootstrap admin from env/.env; additional accounts via
/// <see cref="MembersService"/> (settings → 회원관리).
/// </summary>
internal sealed class AuthService
{
    private const string SessionsFileName = "admin-sessions.json";

    private readonly object _gate = new();
    private readonly Dictionary<string, AuthSession> _sessions = new(StringComparer.Ordinal);
    private readonly HashSet<string> _persistentTokens = new(StringComparer.Ordinal);
    private readonly string _sessionsFilePath;
    private readonly MembersService _members;

    public AuthService(string dataRoot)
    {
        _sessionsFilePath = Path.Combine(dataRoot, SessionsFileName);
        _members = new MembersService(dataRoot);
        var (id, pw) = ResolveCredentials();
        AdminId = id;
        AdminPw = pw;
        try
        {
            // Seed admin into members.json so 회원관리 can list/change its password.
            _members.EnsureBootstrapAdmin(AdminId, AdminPw);
        }
        catch
        {
            /* seed best-effort */
        }
        LoadPersistentSessions();
    }

    public string AdminId { get; }

    public string AdminPw { get; }

    public MembersService Members => _members;

    /// <summary>
    /// Resolve credentials to a session identity, or null if invalid.
    /// Prefers members.json (including the seeded admin row). When that admin row exists,
    /// its password hash overrides the plaintext .env password.
    /// </summary>
    public AuthSession? TryAuthenticate(string? id, string? password)
    {
        var loginId = (id ?? "").Trim();
        var pw = password ?? "";
        if (loginId.Length == 0 || pw.Length == 0) return null;

        var isAdminLogin = string.Equals(loginId, AdminId, StringComparison.OrdinalIgnoreCase);

        var member = _members.FindActiveMemberByCredentials(loginId, pw);
        if (member is not null)
        {
            var memberLogin = member["loginId"]?.GetValue<string>()?.Trim() ?? loginId;
            var role = member["role"]?.GetValue<string>() ?? "member";
            if (isAdminLogin || string.Equals(role, "super_admin", StringComparison.Ordinal))
            {
                role = "super_admin";
            }
            else
            {
                role = "member";
            }

            return new AuthSession
            {
                LoginId = isAdminLogin ? AdminId : memberLogin,
                Role = role,
                IsBootstrapAdmin = isAdminLogin,
            };
        }

        // .env plaintext only when no members.json admin row exists yet (seed failed / legacy).
        if (isAdminLogin
            && !_members.HasMemberLoginId(AdminId)
            && string.Equals(pw, AdminPw, StringComparison.Ordinal))
        {
            return new AuthSession
            {
                LoginId = AdminId,
                Role = "super_admin",
                IsBootstrapAdmin = true,
            };
        }

        return null;
    }

    public bool ValidateCredentials(string? id, string? password) =>
        TryAuthenticate(id, password) is not null;

    public string CreateSession(bool persistent, AuthSession session)
    {
        ArgumentNullException.ThrowIfNull(session);
        var token = Guid.NewGuid().ToString();
        lock (_gate)
        {
            _sessions[token] = session;
            if (persistent)
            {
                _persistentTokens.Add(token);
                SavePersistentSessions();
            }
        }
        return token;
    }

    /// <summary>Legacy helper — bootstrap admin session (tests / callers without AuthSession).</summary>
    public string CreateSession(bool persistent = false) =>
        CreateSession(persistent, new AuthSession
        {
            LoginId = AdminId,
            Role = "super_admin",
            IsBootstrapAdmin = true,
        });

    public AuthSession? GetSession(string? token)
    {
        if (string.IsNullOrEmpty(token)) return null;
        lock (_gate)
        {
            return _sessions.TryGetValue(token, out var session) ? session : null;
        }
    }

    public bool IsValid(string? token) => GetSession(token) is not null;

    public bool IsSuperAdmin(string? token) => GetSession(token)?.IsSuperAdmin == true;

    public bool IsPersistent(string? token)
    {
        if (string.IsNullOrEmpty(token)) return false;
        lock (_gate)
        {
            return _persistentTokens.Contains(token);
        }
    }

    public void Revoke(string? token)
    {
        if (string.IsNullOrEmpty(token)) return;
        lock (_gate)
        {
            _sessions.Remove(token);
            if (_persistentTokens.Remove(token))
            {
                SavePersistentSessions();
            }
        }
    }

    /// <summary>Drop all in-memory / persistent sessions for a member loginId (case-insensitive).</summary>
    public void RevokeSessionsForLoginId(string? loginId)
    {
        var target = (loginId ?? "").Trim();
        if (target.Length == 0) return;

        lock (_gate)
        {
            var tokens = _sessions
                .Where(kv => string.Equals(kv.Value.LoginId, target, StringComparison.OrdinalIgnoreCase))
                .Select(kv => kv.Key)
                .ToList();
            if (tokens.Count == 0) return;

            var persistentChanged = false;
            foreach (var token in tokens)
            {
                _sessions.Remove(token);
                if (_persistentTokens.Remove(token)) persistentChanged = true;
            }

            if (persistentChanged) SavePersistentSessions();
        }
    }

    public static string? ExtractToken(string? authorizationHeader, string? adminTokenHeader = null)
    {
        if (!string.IsNullOrEmpty(authorizationHeader) &&
            authorizationHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            return authorizationHeader["Bearer ".Length..].Trim();
        }
        return string.IsNullOrEmpty(adminTokenHeader) ? null : adminTokenHeader.Trim();
    }

    private void LoadPersistentSessions()
    {
        try
        {
            if (!File.Exists(_sessionsFilePath)) return;
            var raw = File.ReadAllText(_sessionsFilePath, Encoding.UTF8);
            if (JsonNode.Parse(raw) is not JsonObject obj) return;

            // New format: { sessions: [ { token, loginId, role, isBootstrapAdmin } ] }
            if (obj["sessions"] is JsonArray sessions)
            {
                foreach (var node in sessions)
                {
                    if (node is not JsonObject entry) continue;
                    var token = entry["token"]?.GetValue<string>()?.Trim() ?? "";
                    var loginId = entry["loginId"]?.GetValue<string>()?.Trim() ?? "";
                    if (token.Length == 0 || loginId.Length == 0) continue;
                    var role = entry["role"]?.GetValue<string>() ?? "member";
                    if (!string.Equals(role, "super_admin", StringComparison.Ordinal))
                    {
                        role = "member";
                    }

                    var isBootstrap = entry["isBootstrapAdmin"]?.GetValue<bool>() == true
                        || string.Equals(loginId, AdminId, StringComparison.Ordinal);
                    _sessions[token] = new AuthSession
                    {
                        LoginId = loginId,
                        Role = isBootstrap ? "super_admin" : role,
                        IsBootstrapAdmin = isBootstrap,
                    };
                    _persistentTokens.Add(token);
                }
                return;
            }

            // Legacy: { tokens: ["..."] } — treat as bootstrap admin.
            if (obj["tokens"] is not JsonArray tokens) return;
            foreach (var tokenNode in tokens)
            {
                if (tokenNode is not JsonValue value || !value.TryGetValue<string>(out var token)) continue;
                token = token.Trim();
                if (token.Length == 0) continue;
                _sessions[token] = new AuthSession
                {
                    LoginId = AdminId,
                    Role = "super_admin",
                    IsBootstrapAdmin = true,
                };
                _persistentTokens.Add(token);
            }
        }
        catch (JsonException)
        {
            /* ignore corrupt session file */
        }
    }

    private void SavePersistentSessions()
    {
        try
        {
            var dir = Path.GetDirectoryName(_sessionsFilePath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            var sessions = new JsonArray();
            foreach (var token in _persistentTokens)
            {
                if (!_sessions.TryGetValue(token, out var session)) continue;
                sessions.Add(new JsonObject
                {
                    ["token"] = token,
                    ["loginId"] = session.LoginId,
                    ["role"] = session.Role,
                    ["isBootstrapAdmin"] = session.IsBootstrapAdmin,
                });
            }

            var payload = new JsonObject { ["sessions"] = sessions };
            var tempPath = $"{_sessionsFilePath}.{Environment.ProcessId}.tmp";
            File.WriteAllText(tempPath, payload.ToJsonString(JsonUtil.Indented) + "\n", Encoding.UTF8);
            try
            {
                if (File.Exists(_sessionsFilePath))
                {
                    var attrs = File.GetAttributes(_sessionsFilePath);
                    if ((attrs & FileAttributes.ReadOnly) != 0)
                    {
                        File.SetAttributes(_sessionsFilePath, attrs & ~FileAttributes.ReadOnly);
                    }
                }

                File.Move(tempPath, _sessionsFilePath, overwrite: true);
            }
            catch (UnauthorizedAccessException)
            {
                if (File.Exists(_sessionsFilePath))
                {
                    File.Delete(_sessionsFilePath);
                }

                File.Move(tempPath, _sessionsFilePath);
            }
        }
        catch (Exception)
        {
            /* ignore persistence failures */
        }
    }

    private static (string Id, string Pw) ResolveCredentials()
    {
        var dotEnv = LoadDotEnvFiles();

        static string? Pick(Dictionary<string, string> map, params string[] keys)
        {
            foreach (var key in keys)
            {
                var fromEnv = Environment.GetEnvironmentVariable(key);
                if (!string.IsNullOrEmpty(fromEnv))
                {
                    return fromEnv;
                }

                if (map.TryGetValue(key, out var fromFile) && !string.IsNullOrEmpty(fromFile))
                {
                    return fromFile;
                }
            }

            return null;
        }

        var resolvedId = Pick(dotEnv, "MYCALENDAR_ADMIN_ID", "NEOCALENDAR_ADMIN_ID", "ADMIN_ID")
            ?? AppConstants.DefaultAdminId;
        var resolvedPw = Pick(dotEnv, "MYCALENDAR_ADMIN_PW", "NEOCALENDAR_ADMIN_PW", "ADMIN_PW", "ADMIN_PASSWORD")
            ?? AppConstants.DefaultAdminPw;

        return (resolvedId, resolvedPw);
    }

    private static Dictionary<string, string> LoadDotEnvFiles()
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var path in EnumerateDotEnvPaths())
        {
            MergeDotEnvFile(path, result);
        }

        return result;
    }

    private static IEnumerable<string> EnumerateDotEnvPaths()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var dir = AppContext.BaseDirectory;
        for (var i = 0; i < 8 && !string.IsNullOrEmpty(dir); i++)
        {
            var candidate = Path.Combine(dir, ".env");
            if (seen.Add(candidate) && File.Exists(candidate))
            {
                yield return candidate;
            }

            if (File.Exists(Path.Combine(dir, "package.json")))
            {
                yield break;
            }

            dir = Directory.GetParent(dir)?.FullName ?? "";
        }
    }

    private static void MergeDotEnvFile(string envPath, Dictionary<string, string> result)
    {
        try
        {
            foreach (var line in File.ReadAllLines(envPath, Encoding.UTF8))
            {
                var trimmed = line.Trim();
                if (trimmed.Length == 0 || trimmed.StartsWith('#')) continue;

                var separatorIndex = trimmed.IndexOf('=');
                if (separatorIndex <= 0) continue;

                var key = trimmed[..separatorIndex].Trim();
                var value = trimmed[(separatorIndex + 1)..].Trim();
                if (value.Length >= 2 &&
                    ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\'')))
                {
                    value = value[1..^1];
                }

                if (!result.ContainsKey(key))
                {
                    result[key] = value;
                }
            }
        }
        catch (IOException)
        {
            /* ignore */
        }
    }
}
