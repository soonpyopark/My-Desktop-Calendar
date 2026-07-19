#!/usr/bin/env node
/**
 * Build per-user Windows MSI for My Desktop Calendar (WPF native).
 * Requires WiX CLI 7+ (winget install WiXToolset.WiXCLI) and: wix eula accept wix7
 *
 * Flow:
 * 1) sync-version
 * 2) npm run win:publish → dist-win/
 * 3) stage dist-win → msi/My Desktop Calendar/
 *    (+ .env with DATA_GO_KR_SERVICE_KEY, data/settings.json with rememberKey)
 * 4) wix build Product.wxs → msi/My Desktop Calendar v{version}_YYMMDD_HHMMSS.msi
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, APP_VERSION, SITE_URL } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLISH_DIR = path.join(ROOT, 'dist-win');
const STAGE_NAME = APP_NAME;
const STAGE_DIR = path.join(ROOT, 'msi', STAGE_NAME);
const MSI_DIR = path.join(ROOT, 'msi');
const PRODUCT_WXS = path.join(MSI_DIR, 'Product.wxs');
const PUBLISH_EXE = 'MyDesktopCalendar.exe';
const STAGE_EXE = `${APP_NAME}.exe`;
let wixCmd = 'wix';

function log(msg) {
  console.log(`[msi] ${msg}`);
}

function run(cmd, options = {}) {
  log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, shell: true, ...options });
}

function readVersion() {
  const constants = fs.readFileSync(path.join(ROOT, 'shared', 'constants.js'), 'utf8');
  const match = constants.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  return match?.[1] ?? APP_VERSION;
}

function toMsiVersion(version, buildStamp = new Date()) {
  const parts = String(version).split('.').map((p) => Number.parseInt(p, 10) || 0);
  while (parts.length < 3) {
    parts.push(0);
  }
  // 4th part must change every MSI build so Windows Installer treats it as an upgrade
  // even when APP_VERSION (x.y.z) is unchanged. Each MSI version field max is 65535.
  const revision = Math.floor(buildStamp.getTime() / 60_000) % 65535;
  return `${parts[0]}.${parts[1]}.${parts[2]}.${revision || 1}`;
}

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(2);
  return `${yy}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function resolveWixCmd() {
  try {
    execSync('wix --version', { stdio: 'pipe' });
    return 'wix';
  } catch {
    /* look under Program Files */
  }

  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const candidates = [
    path.join(programFiles, 'WiX Toolset v7.0', 'bin', 'wix.exe'),
    path.join(programFiles, 'WiX Toolset v6.0', 'bin', 'wix.exe'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return `"${candidate}"`;
    }
  }

  throw new Error(
    'WiX CLI not found. Install: winget install WiXToolset.WiXCLI\nThen run: wix eula accept wix7',
  );
}

function ensureWix() {
  wixCmd = resolveWixCmd();
  execSync(`${wixCmd} --version`, { stdio: 'pipe', shell: true });
}

function resolveAppIcon() {
  const candidates = [
    path.join(ROOT, 'win', 'MyDesktopCalendar', 'Assets', 'app.ico'),
    path.join(ROOT, 'icon.ico'),
    path.join(ROOT, 'public', 'icons', 'appIcon.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && candidate.endsWith('.ico')) {
      return candidate;
    }
  }
  throw new Error('App icon (.ico) not found (expected win/MyDesktopCalendar/Assets/app.ico)');
}

function readEnvFile(dir) {
  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }

  /** @type {Record<string, string>} */
  const result = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in result)) {
      result[key] = value;
    }
  }
  return result;
}

function readHolidayKeyFromSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return '';
  }
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    const holidaysKr = parsed?.settings?.holidaysKr ?? parsed?.holidaysKr;
    if (holidaysKr?.rememberKey && String(holidaysKr?.serviceKey ?? '').trim()) {
      return String(holidaysKr.serviceKey).trim();
    }
    if (String(holidaysKr?.serviceKey ?? '').trim()) {
      return String(holidaysKr.serviceKey).trim();
    }
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * MSI 번들용 공휴일 API 키: `.env` → 로컬 settings.json (rememberKey) 순.
 */
function resolveBuildHolidayServiceKey() {
  const fileEnv = readEnvFile(ROOT);
  const fromEnv = fileEnv.DATA_GO_KR_SERVICE_KEY ?? fileEnv.HOLIDAY_API_KEY;
  if (String(fromEnv ?? '').trim()) {
    return { key: String(fromEnv).trim(), source: '.env' };
  }

  const candidates = [
    path.join(ROOT, 'data', 'settings.json'),
    path.join(ROOT, 'win', 'MyDesktopCalendar', 'bin', 'Release', 'net8.0-windows', 'data', 'settings.json'),
    path.join(ROOT, 'win', 'MyDesktopCalendar', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'data', 'settings.json'),
    path.join(ROOT, 'dist-win', 'data', 'settings.json'),
  ];

  for (const settingsPath of candidates) {
    const key = readHolidayKeyFromSettings(settingsPath);
    if (key) {
      return { key, source: path.relative(ROOT, settingsPath) };
    }
  }

  return { key: '', source: '' };
}

function upsertEnvLine(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  const insertBlock = `\n# 공공데이터포털 특일 정보 API (대한민국 공휴일)\n${line}\n`;
  const markers = [
    '\n# 공공데이터포털',
    '\n# 데이터 폴더',
    '\n# ---------------------------------------------------------------------------\n# HTTP',
  ];
  for (const marker of markers) {
    const markerIndex = content.indexOf(marker);
    if (markerIndex >= 0) {
      return `${content.slice(0, markerIndex)}${insertBlock}${content.slice(markerIndex)}`;
    }
  }

  return `${content.trimEnd()}\n${insertBlock}`;
}

function writeStagedEnv(holidayKey) {
  const rootEnvPath = path.join(ROOT, '.env');
  const examplePath = path.join(ROOT, '.env.example');
  const targetPath = path.join(STAGE_DIR, '.env');

  let content = '';
  if (fs.existsSync(rootEnvPath)) {
    content = fs.readFileSync(rootEnvPath, 'utf8');
  } else if (fs.existsSync(examplePath)) {
    content = fs.readFileSync(examplePath, 'utf8');
  }

  if (holidayKey) {
    content = upsertEnvLine(content, 'DATA_GO_KR_SERVICE_KEY', holidayKey);
  }

  fs.writeFileSync(targetPath, content.replace(/\r?\n/g, '\r\n'), 'utf8');
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, path.join(STAGE_DIR, '.env.example'));
  }
}

function publishPortable() {
  run('npm run win:publish');
  const builtExe = path.join(PUBLISH_DIR, PUBLISH_EXE);
  if (!fs.existsSync(builtExe)) {
    throw new Error(`Publish output not found: ${builtExe}`);
  }
}

function stageForMsi() {
  const builtExe = path.join(PUBLISH_DIR, PUBLISH_EXE);
  if (!fs.existsSync(builtExe)) {
    throw new Error(`Publish output not found: ${builtExe}`);
  }

  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(STAGE_DIR), { recursive: true });
  fs.cpSync(PUBLISH_DIR, STAGE_DIR, { recursive: true });

  const stagedPublishExe = path.join(STAGE_DIR, PUBLISH_EXE);
  const stagedFriendlyExe = path.join(STAGE_DIR, STAGE_EXE);
  if (fs.existsSync(stagedPublishExe)) {
    fs.renameSync(stagedPublishExe, stagedFriendlyExe);
  }

  fs.copyFileSync(resolveAppIcon(), path.join(STAGE_DIR, 'app-icon.ico'));

  for (const name of ['LICENSE', 'README.md']) {
    const src = path.join(ROOT, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(STAGE_DIR, name));
    }
  }

  const { key: holidayKey, source } = resolveBuildHolidayServiceKey();
  writeStagedEnv(holidayKey);
  if (!holidayKey) {
    throw new Error(
      '대한민국 휴일 API 키가 없습니다. 프로젝트 루트 .env에 DATA_GO_KR_SERVICE_KEY를 넣거나 data/settings.json에 rememberKey+serviceKey를 저장한 뒤 다시 빌드하세요.',
    );
  }
  // Do not ship data/ inside the MSI — Windows Installer can lock harvested files and
  // first-launch writes then fail with "Access to the path is denied."
  // Holiday key is applied from .env on first run (ApplyHolidayKeyFromEnvIfNeeded).
  fs.rmSync(path.join(STAGE_DIR, 'data'), { recursive: true, force: true });
  log(`included holiday API key in .env (first-run seed) from ${source}`);

  log(`staged: ${STAGE_DIR}`);
}

function buildMsi() {
  const version = readVersion();
  const productVersion = toMsiVersion(version);
  // New ProductCode every build + MajorUpgrade AllowSameVersionUpgrades removes prior ARP entries.
  const productCode = randomUUID().toUpperCase();
  const timestamp = formatTimestamp();
  const outputName = `${APP_NAME} v${version}_${timestamp}.msi`;
  const outputPath = path.join(MSI_DIR, outputName);

  fs.mkdirSync(MSI_DIR, { recursive: true });
  fs.rmSync(outputPath, { force: true });

  run(
    `${wixCmd} build "${PRODUCT_WXS}" -d ProductVersion=${productVersion} -d ProductCode=${productCode} -d MsiDir="${MSI_DIR}" -bindpath "${MSI_DIR}" -ext WixToolset.UI.wixext -o "${outputPath}"`,
  );

  const sizeMb = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
  log(`output: ${outputPath} (${sizeMb} MB)`);
  log(`ProductVersion=${productVersion} ProductCode={${productCode}}`);
  log(`site: ${SITE_URL}`);
}

function cleanupStage() {
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  log('removed staging folder');
}

function main() {
  ensureWix();
  run('node scripts/sync-version.mjs');
  publishPortable();
  stageForMsi();

  try {
    buildMsi();
  } finally {
    cleanupStage();
  }

  log('설치: msi 폴더의 .msi 파일을 더블 클릭하세요 (관리자 권한 불필요).');
  log('done');
}

try {
  main();
} catch (error) {
  console.error('[msi] failed:', error.message ?? error);
  process.exit(1);
}
