namespace MyDesktopCalendar.Services;

/// <summary>What the App-side overlay is waiting to reopen once it becomes the visible surface.</summary>
internal enum PendingActionKind
{
    None,
    Create,
    Edit,
    Ui,
}

/// <summary>
/// A single reopen-intent for the App overlay — replaces the old set of five independent,
/// individually-nullable fields (pendingCreateDate / pendingEditEventId / pendingEditDayKey /
/// pendingUiAction / pendingUiActionSurface) that <c>NativeBridge</c> used to juggle by hand.
/// Only one kind of pending action can ever be meaningful at a time, so modeling it as a
/// single tagged value makes that invariant structural instead of "remember to null out the
/// other four fields every time you set one".
/// </summary>
internal sealed record PendingAction(
    PendingActionKind Kind,
    string? DateKey = null,
    string? EventId = null,
    string? DayKey = null,
    string? UiAction = null,
    string? UiActionSurface = null)
{
    public static readonly PendingAction None = new(PendingActionKind.None);

    public static PendingAction Create(string dateKey) => new(PendingActionKind.Create, DateKey: dateKey);

    public static PendingAction Edit(string eventId, string dayKey) =>
        new(PendingActionKind.Edit, EventId: eventId, DayKey: dayKey);

    public static PendingAction Ui(string action, string? surface) =>
        new(PendingActionKind.Ui, UiAction: action, UiActionSurface: surface);
}

/// <summary>
/// Single authoritative home for "is the App overlay temporarily covering the desktop
/// surface, and what should it reopen once it does" — previously six independent fields
/// on <c>NativeBridge</c> (_embedSuspended, _pendingCreateDate, _pendingEditEventId,
/// _pendingEditDayKey, _pendingUiAction, _pendingUiActionSurface, _suspendToken) that every
/// caller had to remember to set/clear together and in the right order. Every claim/clear
/// path funnels through <see cref="Suspend"/>/<see cref="Resume"/>/<see cref="ClearPending"/>
/// here instead, so "suspended but pending is stale" or "pending set but suspend flag never
/// claimed" can no longer happen by construction.
/// Purely a state container — never touches DesktopEmbedService/DesktopSurfaceController
/// itself; callers still own sequencing the actual Show/Hide/Cloak calls around it.
/// </summary>
internal sealed class DesktopSurfaceState
{
    public bool Suspended { get; private set; }
    public long SuspendToken { get; private set; }
    public PendingAction Pending { get; private set; } = PendingAction.None;

    /// <summary>Claim the suspend flag and record what the overlay should reopen. Idempotent —
    /// safe to call again while already suspended to just refresh the pending action.</summary>
    public void Suspend(PendingAction pending)
    {
        Suspended = true;
        Pending = pending;
        Touch();
    }

    /// <summary>Refresh the pending action/token without changing the suspend flag itself —
    /// used when a second caller raises a new action while an overlay is already open.</summary>
    public void UpdatePending(PendingAction pending)
    {
        Pending = pending;
        Touch();
    }

    /// <summary>Clear the suspend flag but keep <see cref="Pending"/> until the caller
    /// explicitly acks it (App-side reopen needs to read it once more after resume).</summary>
    public void MarkResumed()
    {
        Suspended = false;
    }

    /// <summary>Full reset — suspend flag, pending action, and token all cleared together.</summary>
    public void Reset()
    {
        Suspended = false;
        SuspendToken = 0;
        Pending = PendingAction.None;
    }

    public void ClearPending()
    {
        Pending = PendingAction.None;
    }

    private void Touch()
    {
        SuspendToken = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
