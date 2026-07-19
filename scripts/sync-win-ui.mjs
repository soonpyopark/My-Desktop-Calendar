import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const wwwroot = path.join(root, 'win', 'MyDesktopCalendar', 'wwwroot');
const seedSrc = path.join(root, 'shared', 'seed');
const seedDst = path.join(root, 'win', 'MyDesktopCalendar', 'seed');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html missing — run npm run build first');
  process.exit(1);
}

fs.rmSync(wwwroot, { recursive: true, force: true });
copyDir(dist, wwwroot);

// WebView2 virtual-host module loads can fail with crossorigin=anonymous (no CORS headers).
const indexPath = path.join(wwwroot, 'index.html');
if (fs.existsSync(indexPath)) {
  const html = fs.readFileSync(indexPath, 'utf8').replace(/\s+crossorigin(?:="[^"]*")?/g, '');
  fs.writeFileSync(indexPath, html);
}

// Ensure desktop-bridge and public assets are present (vite copies public/)
if (fs.existsSync(seedSrc)) {
  fs.rmSync(seedDst, { recursive: true, force: true });
  copyDir(seedSrc, seedDst);
}

console.log(`Synced UI → ${wwwroot}`);
if (fs.existsSync(seedDst)) {
  console.log(`Synced seed → ${seedDst}`);
}
