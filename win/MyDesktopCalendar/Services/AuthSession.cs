namespace MyDesktopCalendar.Services;

/// <summary>Per-token identity for membership scoping (personal calendars).</summary>
internal sealed class AuthSession
{
    public required string LoginId { get; init; }

    /// <summary><c>super_admin</c> or <c>member</c>.</summary>
    public required string Role { get; init; }

    /// <summary>True when authenticated via env/.env bootstrap admin.</summary>
    public bool IsBootstrapAdmin { get; init; }

    public bool IsSuperAdmin =>
        IsBootstrapAdmin
        || string.Equals(Role, "super_admin", StringComparison.Ordinal);
}
