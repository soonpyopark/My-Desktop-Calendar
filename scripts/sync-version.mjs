#!/usr/bin/env node
/**
 * Sync display version into package.json / LICENSE / README / MSI License.rtf /
 * AppConstants.cs / csproj / .env.example / desktop-bridge.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP_NAME = 'My Desktop Calendar';
const SITE_URL = 'https://note4all.tistory.com';

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const constants = fs.readFileSync(path.join(ROOT, 'shared', 'constants.js'), 'utf8');
  const match = constants.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  const version = match?.[1] ?? pkg.version;
  if (!version) throw new Error('Could not resolve app version');
  return version;
}

function writeIfChanged(filePath, next) {
  const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  if (prev === next) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, 'utf8');
  return true;
}

function syncLicense(version) {
  const filePath = path.join(ROOT, 'LICENSE');
  if (!fs.existsSync(filePath)) return;
  let text = fs.readFileSync(filePath, 'utf8');
  text = text.replace(
    /My Desktop Calendar v[0-9][^\n]*/m,
    `My Desktop Calendar v${version}`,
  );
  if (writeIfChanged(filePath, text)) {
    console.log(`[sync-version] LICENSE -> ${APP_NAME} v${version}`);
  }
}

function syncReadme(version) {
  const filePath = path.join(ROOT, 'README.md');
  if (!fs.existsSync(filePath)) return;
  let text = fs.readFileSync(filePath, 'utf8');
  text = text.replace(
    /^# My Desktop Calendar v[^\n]+/m,
    `# My Desktop Calendar v${version}`,
  );
  if (writeIfChanged(filePath, text)) {
    console.log(`[sync-version] README.md -> ${APP_NAME} v${version}`);
  }
}

function syncPackageJson(version) {
  const filePath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (pkg.version !== version) {
    pkg.version = version;
    fs.writeFileSync(filePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    console.log(`[sync-version] package.json -> ${version}`);
  }
}

function syncMsiLicenseRtf(version) {
  const filePath = path.join(ROOT, 'msi', 'License.rtf');
  const body =
    '{\\rtf1\\ansi\\ansicpg65001\\deff0{\\fonttbl{\\f0\\fnil\\fcharset0 Segoe UI;}}\n'
    + '\\viewkind4\\uc1\\pard\\sa200\\sl276\\slmult1\\f0\\fs22 '
    + `${APP_NAME} v${version}\\par\n`
    + `${SITE_URL}\\par\n`
    + '}\n';
  if (writeIfChanged(filePath, body)) {
    console.log(`[sync-version] msi/License.rtf -> ${APP_NAME} v${version}`);
  }
}

function syncAppConstants(version) {
  const filePath = path.join(ROOT, 'win', 'MyDesktopCalendar', 'AppConstants.cs');
  if (!fs.existsSync(filePath)) return;
  let text = fs.readFileSync(filePath, 'utf8');
  text = text.replace(
    /public const string AppVersion = "[^"]+";/,
    `public const string AppVersion = "${version}";`,
  );
  if (writeIfChanged(filePath, text)) {
    console.log(`[sync-version] AppConstants.cs -> ${version}`);
  }
}

function syncCsproj(version) {
  const filePath = path.join(ROOT, 'win', 'MyDesktopCalendar', 'MyDesktopCalendar.csproj');
  if (!fs.existsSync(filePath)) return;
  let text = fs.readFileSync(filePath, 'utf8');
  text = text.replace(/<Version>[^<]+<\/Version>/, `<Version>${version}</Version>`);
  if (writeIfChanged(filePath, text)) {
    console.log(`[sync-version] MyDesktopCalendar.csproj -> ${version}`);
  }
}

function syncEnvExample(version) {
  const filePath = path.join(ROOT, '.env.example');
  if (!fs.existsSync(filePath)) return;
  let text = fs.readFileSync(filePath, 'utf8');
  text = text.replace(
    /^# My Desktop Calendar v[^\n]*/m,
    `# My Desktop Calendar v${version} — WPF 네이티브 셸`,
  );
  if (writeIfChanged(filePath, text)) {
    console.log(`[sync-version] .env.example -> ${version}`);
  }
}

function syncDesktopBridge(version) {
  const filePath = path.join(ROOT, 'public', 'desktop-bridge.js');
  if (!fs.existsSync(filePath)) return;
  let text = fs.readFileSync(filePath, 'utf8');
  text = text.replace(/My Desktop Calendar v[0-9][^'"`]*/g, `My Desktop Calendar v${version}`);
  if (writeIfChanged(filePath, text)) {
    console.log(`[sync-version] public/desktop-bridge.js -> ${version}`);
  }
}

const version = readVersion();
syncPackageJson(version);
syncLicense(version);
syncReadme(version);
syncMsiLicenseRtf(version);
syncAppConstants(version);
syncCsproj(version);
syncEnvExample(version);
syncDesktopBridge(version);
console.log(`[sync-version] done (${APP_NAME} v${version})`);
