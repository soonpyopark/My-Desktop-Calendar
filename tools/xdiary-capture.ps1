param(
    [string]$ProcessName = "desktopcal",
    [string]$LogPath = "$PSScriptRoot\xdiary-capture.log",
    [int]$PollMs = 120
)

Add-Type -Namespace Native -Name Capture -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")]
public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
[DllImport("user32.dll")]
public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
[DllImport("user32.dll", CharSet=CharSet.Unicode)]
public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[DllImport("user32.dll", CharSet=CharSet.Unicode)]
public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[DllImport("user32.dll")]
public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")]
public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern IntPtr GetParent(IntPtr hWnd);
[DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")]
public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);
[DllImport("user32.dll", EntryPoint="GetWindowLongW")]
public static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")]
public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
[DllImport("user32.dll", CharSet=CharSet.Unicode)]
public static extern IntPtr FindWindowExW(IntPtr hWndParent, IntPtr hWndChildAfter, string lpszClass, string lpszWindow);
public struct RECT { public int Left, Top, Right, Bottom; }
'@

function Get-WinLong($hwnd, $index) {
    if ([IntPtr]::Size -eq 8) { return [Native.Capture]::GetWindowLongPtr64($hwnd, $index).ToInt64() }
    return [int64][Native.Capture]::GetWindowLong32($hwnd, $index)
}

$GWL_STYLE = -16
$GWL_EXSTYLE = -20

function Snapshot-Window($hwnd) {
    $sbTitle = New-Object System.Text.StringBuilder 512
    [Native.Capture]::GetWindowTextW($hwnd, $sbTitle, 512) | Out-Null
    $sbClass = New-Object System.Text.StringBuilder 256
    [Native.Capture]::GetClassNameW($hwnd, $sbClass, 256) | Out-Null
    $wr = New-Object Native.Capture+RECT
    [Native.Capture]::GetWindowRect($hwnd, [ref]$wr) | Out-Null
    $cr = New-Object Native.Capture+RECT
    [Native.Capture]::GetClientRect($hwnd, [ref]$cr) | Out-Null
    $style = Get-WinLong $hwnd $GWL_STYLE
    $exStyle = Get-WinLong $hwnd $GWL_EXSTYLE
    $parent = [Native.Capture]::GetParent($hwnd)
    $vis = [Native.Capture]::IsWindowVisible($hwnd)

    [PSCustomObject]@{
        Hwnd = $hwnd
        Title = $sbTitle.ToString()
        Class = $sbClass.ToString()
        Style = $style
        ExStyle = $exStyle
        Parent = $parent
        Visible = $vis
        WX = $wr.Left; WY = $wr.Top; WW = ($wr.Right - $wr.Left); WH = ($wr.Bottom - $wr.Top)
        CW = ($cr.Right - $cr.Left); CH = ($cr.Bottom - $cr.Top)
    }
}

function Format-Snap($s) {
    "class='$($s.Class)' title='$($s.Title)' style=0x$($s.Style.ToString('X8')) exstyle=0x$($s.ExStyle.ToString('X8')) parent=0x$($s.Parent.ToString('X')) visible=$($s.Visible) winRect=($($s.WX),$($s.WY),$($s.WW)x$($s.WH)) clientSize=$($s.CW)x$($s.CH)"
}

function Log($msg) {
    $line = "[$((Get-Date).ToString('HH:mm:ss.fff'))] $msg"
    Add-Content -Path $LogPath -Value $line -Encoding utf8
}

"=== capture started $(Get-Date -Format o) — watching process '$ProcessName' ===" | Out-File -FilePath $LogPath -Encoding utf8

$snapshots = @{}

function Collect-TargetWindows($targetPid) {
    $found = New-Object System.Collections.Generic.List[IntPtr]

    $cbTop = {
        param($hWnd, $lParam)
        $pid2 = 0
        [Native.Capture]::GetWindowThreadProcessId($hWnd, [ref]$pid2) | Out-Null
        if ($pid2 -eq $targetPid) { $found.Add($hWnd) }
        return $true
    }
    [Native.Capture]::EnumWindows($cbTop, [IntPtr]::Zero) | Out-Null

    # Embedded children live under Progman's whole subtree (Progman -> [WorkerW] -> SHELLDLL_DefView -> SysListView32 -> our hwnd).
    $progman = [Native.Capture]::FindWindow("Progman", $null)
    if ($progman -ne [IntPtr]::Zero) {
        $cbChild = {
            param($hWnd, $lParam)
            $pid2 = 0
            [Native.Capture]::GetWindowThreadProcessId($hWnd, [ref]$pid2) | Out-Null
            if ($pid2 -eq $targetPid) { $found.Add($hWnd) }
            return $true
        }
        [Native.Capture]::EnumChildWindows($progman, $cbChild, [IntPtr]::Zero) | Out-Null
    }

    return $found | Select-Object -Unique
}

while ($true) {
    $procs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if (-not $procs) {
        Start-Sleep -Milliseconds 500
        continue
    }

    $pids = $procs | Select-Object -ExpandProperty Id
    $liveHwnds = New-Object System.Collections.Generic.HashSet[string]

    foreach ($targetPid in $pids) {
        $hwnds = Collect-TargetWindows $targetPid
        foreach ($hwnd in $hwnds) {
            $key = $hwnd.ToString()
            $liveHwnds.Add($key) | Out-Null
            $snap = Snapshot-Window $hwnd
            if (-not $snapshots.ContainsKey($key)) {
                Log "NEW WINDOW  0x$($hwnd.ToString('X'))  $(Format-Snap $snap)"
            } else {
                $prev = $snapshots[$key]
                $diffs = @()
                if ($prev.Style -ne $snap.Style) { $diffs += "style 0x$($prev.Style.ToString('X8'))->0x$($snap.Style.ToString('X8'))" }
                if ($prev.ExStyle -ne $snap.ExStyle) { $diffs += "exstyle 0x$($prev.ExStyle.ToString('X8'))->0x$($snap.ExStyle.ToString('X8'))" }
                if ($prev.Parent -ne $snap.Parent) { $diffs += "parent 0x$($prev.Parent.ToString('X'))->0x$($snap.Parent.ToString('X'))" }
                if ($prev.Visible -ne $snap.Visible) { $diffs += "visible $($prev.Visible)->$($snap.Visible)" }
                if ($prev.WX -ne $snap.WX -or $prev.WY -ne $snap.WY -or $prev.WW -ne $snap.WW -or $prev.WH -ne $snap.WH) {
                    $diffs += "windowRect ($($prev.WX),$($prev.WY),$($prev.WW)x$($prev.WH))->($($snap.WX),$($snap.WY),$($snap.WW)x$($snap.WH))"
                }
                if ($prev.CW -ne $snap.CW -or $prev.CH -ne $snap.CH) {
                    $diffs += "clientSize $($prev.CW)x$($prev.CH)->$($snap.CW)x$($snap.CH)"
                }
                if ($prev.Title -ne $snap.Title) { $diffs += "title '$($prev.Title)'->'$($snap.Title)'" }
                if ($diffs.Count -gt 0) {
                    Log "CHANGE 0x$($hwnd.ToString('X')) [$($snap.Class)]  $($diffs -join '; ')"
                }
            }
            $snapshots[$key] = $snap
        }
    }

    # Detect destroyed windows
    $deadKeys = $snapshots.Keys | Where-Object { -not $liveHwnds.Contains($_) }
    foreach ($key in $deadKeys) {
        $prev = $snapshots[$key]
        Log "DESTROYED   $key  (was: $(Format-Snap $prev))"
        $snapshots.Remove($key)
    }

    Start-Sleep -Milliseconds $PollMs
}
