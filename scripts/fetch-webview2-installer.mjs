#!/usr/bin/env node
/**
 * Download prerequisite installers into program/ (gitignored).
 * - WebView2 Evergreen Standalone Installer (x64) — offline Runtime
 * - .NET 8 Windows Desktop Runtime (x64) — if not using self-contained publish
 *
 * Overrides: WEBVIEW2_STANDALONE_URL, DOTNET_DESKTOP_RUNTIME_URL
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEST_DIR = path.join(ROOT, 'program');

const DOWNLOADS = [
  {
    name: 'WebView2 Standalone (x64)',
    fileName: 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe',
    url:
      process.env.WEBVIEW2_STANDALONE_URL
      || 'https://go.microsoft.com/fwlink/?linkid=2124701',
    minBytes: 1_000_000,
  },
  {
    name: '.NET 8 Desktop Runtime (x64)',
    fileName: 'windowsdesktop-runtime-8.0-win-x64.exe',
    url:
      process.env.DOTNET_DESKTOP_RUNTIME_URL
      || 'https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe',
    minBytes: 1_000_000,
  },
];

function log(msg) {
  console.log(`[prereq-installer] ${msg}`);
}

function download(url, destFile) {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl, redirectsLeft) => {
      const client = currentUrl.startsWith('https:') ? https : http;
      const req = client.get(currentUrl, (res) => {
        if (
          res.statusCode
          && res.statusCode >= 300
          && res.statusCode < 400
          && res.headers.location
          && redirectsLeft > 0
        ) {
          res.resume();
          follow(new URL(res.headers.location, currentUrl).href, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed HTTP ${res.statusCode} for ${currentUrl}`));
          return;
        }
        const out = fs.createWriteStream(destFile);
        let received = 0;
        const total = Number(res.headers['content-length'] || 0);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0 && received % (5 * 1024 * 1024) < chunk.length) {
            const pct = ((received / total) * 100).toFixed(0);
            process.stdout.write(
              `\r[prereq-installer] ${pct}% (${(received / (1024 * 1024)).toFixed(1)} MB)`,
            );
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          if (total > 0) process.stdout.write('\n');
          out.close(() => resolve());
        });
        out.on('error', reject);
      });
      req.on('error', reject);
    };
    follow(url, 10);
  });
}

async function fetchOne({ name, fileName, url, minBytes }) {
  const destFile = path.join(DEST_DIR, fileName);
  const partial = `${destFile}.partial`;

  log(`${name}: ${url}`);
  fs.rmSync(partial, { force: true });
  await download(url, partial);

  const size = fs.statSync(partial).size;
  if (size < minBytes) {
    fs.rmSync(partial, { force: true });
    throw new Error(`${name}: file too small (${size} bytes)`);
  }

  fs.rmSync(destFile, { force: true });
  fs.renameSync(partial, destFile);
  log(`saved ${(size / (1024 * 1024)).toFixed(1)} MB → ${destFile}`);
}

async function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  for (const item of DOWNLOADS) {
    await fetchOne(item);
  }
  log('done. Distribute program/ separately from the MSI for offline PCs.');
}

try {
  await main();
} catch (error) {
  console.error('[prereq-installer] failed:', error.message ?? error);
  process.exit(1);
}
