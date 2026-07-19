import { APP_NAME, APP_TITLE, SITE_URL } from '../../shared/constants.js';
import { isNativeHost, nativeRequest } from './nativeHost.js';

async function resolveAppTitle() {
  try {
    if (isNativeHost()) {
      const data = await nativeRequest('GET', '/api/health');
      if (data?.name && data?.version) {
        return `${data.name} v${data.version}`;
      }
      if (data?.app && data?.version) {
        return `${data.app} v${data.version}`;
      }
      return APP_TITLE;
    }
    const res = await fetch('/api/health');
    if (!res.ok) {
      return APP_TITLE;
    }
    const data = await res.json();
    if (data.app && data.version) {
      return `${data.app} v${data.version}`;
    }
  } catch {
    /* use default */
  }
  return APP_TITLE;
}

/** Show About via OS message box or alert fallback. */
export async function showAbout() {
  if (window.myCalendar?.showAbout) {
    await window.myCalendar.showAbout();
    return;
  }

  const appTitle = await resolveAppTitle();
  const appName = appTitle.replace(/\s+v[\d.]+$/, '') || APP_NAME;
  const content = `${appTitle}\n${SITE_URL}`;

  if (window.Neutralino?.os?.showMessageBox) {
    await Neutralino.os.showMessageBox(appName, content, 'OK', 'INFO');
    return;
  }

  window.alert(content);
}
