# My Desktop Calendar — desktop embed experiment

This is a minimal, standalone C# WPF + WebView2 app. Its only job right now is to
validate a new desktop-embedding technique before any calendar UI or features get
ported over from [My Desktop Calendar](../My%20Desktop%20Calendar%20v1.1.5).

## Why this exists

The current My Desktop Calendar app embeds its WebView2 surface as a **sibling**
of `Progman`/`WorkerW` on the desktop. Because of that, real mouse clicks never
reach it — `SHELLDLL_DefView` intercepts them regardless of z-order — so the app
has to run a whole click-zone-polling subsystem (`UndockZoneMonitor`) that polls
cursor position/button state on a timer and fakes click handling.

Live inspection of a competing app (xdiary / `desktopcal.exe`) showed it parents
its main window **inside** `SysListView32` (the desktop icon ListView itself, a
child of `SHELLDLL_DefView`) rather than as a `Progman`/`WorkerW` sibling. This
project tests whether that one change in *where* we attach lets real mouse input
route to the embedded WebView2 surface natively — which would let a large chunk
of click-zone-polling go away entirely in a future port.

```
Progman
 └─ SHELLDLL_DefView
     └─ SysListView32          <- My Desktop Calendar's DesktopHost is parented HERE
Progman / WorkerW (sibling)    <- My Desktop Calendar today parents HERE
```

## Scope of this phase

This phase deliberately contains **no calendar UI, no data/store layer, no auth,
no MSI packaging** — just:

- `DesktopEmbedService` — finds `Progman` → `SHELLDLL_DefView` → `SysListView32`
  and `SetParent`s the host window into it, with a fallback to the proven
  Progman-raised strategy if `SysListView32` isn't found or the attach fails.
- A dual-HWND skeleton mirroring the production app's rule ("`MainWindow` is
  always top-level; `DesktopHostWindow` is `SetParent`'d exactly once"):
  - `MainWindow` — a plain control panel (Embed / Undock / Open log / Exit).
  - `DesktopHostWindow` — the borderless WebView2 host that gets embedded.
- A minimal test page (`wwwroot/index.html`) with a live clock (flicker smoke
  test) and a click counter button with **no native click-zone-polling behind
  it** — if the counter increments on a real click while embedded, the
  `SysListView32` parenting is delivering real mouse input.
- A tray icon (WinForms `NotifyIcon`) with the same actions as the control panel.
- Every embed attempt is logged step-by-step to `neo-embed-diag.log` next to the
  exe, so the outcome is visible without attaching a debugger.

## Running it

```
cd src
dotnet run
```

The app starts in window mode. Use the tray icon or the control panel's
"Embed to Desktop" button to attach it to the wallpaper. Things to check once
embedded:

1. Does it land in the right place and stay there through icon refreshes /
   resolution changes?
2. Does the clock stay smooth for a few minutes with no gray flashes?
3. **Does the click counter increment when you click it directly on the
   desktop?** This is the core question this phase exists to answer.

Check `neo-embed-diag.log` (next to the built exe) to see which strategy engaged
(`SysListView32` vs. the Progman-raised fallback) and why.

## Next phase (not yet started)

Once the embed technique is confirmed solid, the plan is to port over the React
UI, native bridge, store/auth, and packaging from My Desktop Calendar on top of
whichever embed strategy proves out here.
