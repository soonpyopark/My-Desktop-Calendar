import { execSync } from 'node:child_process';

const isWin = process.platform === 'win32';
if (!isWin) {
  console.log('win:stop is only supported on Windows.');
  process.exit(0);
}

function tryKill(imageName) {
  try {
    execSync(`taskkill /IM ${imageName} /F`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch (error) {
    const stderr = String(error?.stderr ?? error?.message ?? '');
    if (/not found|없습니다|no running/i.test(stderr) || error?.status === 128) {
      return false;
    }
    console.error(stderr.trim() || `Failed to stop ${imageName}.`);
    process.exit(1);
  }
  return false;
}

// Prefer new name; also clear legacy NeoDesktopCalendar.exe if still running.
const stopped = tryKill('MyDesktopCalendar.exe') || tryKill('NeoDesktopCalendar.exe');
console.log(stopped ? 'Stopped MyDesktopCalendar.' : 'MyDesktopCalendar is not running.');
process.exit(0);
