#!/usr/bin/env node
/**
 * My Desktop Calendar — update deps (and optionally rebuild MSI).
 * Mirrors NAS4USB scripts/update-all.mjs (without editor-core stacks).
 *
 * Options:
 *   --skip-git
 *   --skip-npm
 *   --skip-dotnet
 *   --build          run npm run build:dist:msi
 *   --force          npm install --force; clear vite/dist caches
 *   --skip-cores     accepted for NAS4USB bat compatibility (no-op)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  return {
    skipGit: argv.includes('--skip-git'),
    skipNpm: argv.includes('--skip-npm'),
    skipDotnet: argv.includes('--skip-dotnet'),
    skipCores: argv.includes('--skip-cores'),
    build: argv.includes('--build'),
    force: argv.includes('--force'),
  };
}

/**
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 */
function run(label, command, args) {
  console.log(`[update-all] ${label}…`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? 1})`);
  }
}

async function clearForcedCaches() {
  const targets = [
    path.join(root, 'dist'),
    path.join(root, 'node_modules', '.vite'),
    path.join(root, '.cache', 'vite'),
  ];
  for (const target of targets) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      console.log(`[update-all] cleared ${path.relative(root, target)} (force)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[update-all] could not clear ${target}: ${message}`);
    }
  }
}

async function gitPull() {
  try {
    await fs.access(path.join(root, '.git'));
  } catch {
    console.log('[update-all] Not a git repo; skip git pull');
    return;
  }

  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (status.stdout?.trim()) {
    console.log('[update-all] Git working tree has local changes; skip git pull');
    return;
  }

  run('git pull', 'git', ['pull', '--ff-only']);
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 */
async function updateNpmStack(opts) {
  if (opts.force) {
    await clearForcedCaches();
    run('npm install --force', 'npm', ['install', '--force']);
  } else {
    run('npm install', 'npm', ['install']);
  }
  run('npm update', 'npm', ['update']);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log('[update-all] ===== started =====');
  console.log(`[update-all] Project root: ${root}`);

  try {
    run('stop native app', 'npm', ['run', 'win:stop']);
  } catch {
    console.warn('[update-all] win:stop failed or unavailable; continuing');
  }

  if (!opts.skipGit) {
    await gitPull();
  }

  if (!opts.skipNpm) {
    await updateNpmStack(opts);
  }

  if (opts.skipCores) {
    console.log('[update-all] --skip-cores: no editor cores in this project (ignored)');
  }

  run('sync-version', 'npm', ['run', 'sync-version']);

  if (!opts.skipDotnet) {
    run(
      'dotnet restore',
      'dotnet',
      ['restore', 'win/MyDesktopCalendar/MyDesktopCalendar.csproj'],
    );
  }

  if (opts.build) {
    run('build dist msi', 'npm', ['run', 'build:dist:msi']);
  }

  console.log('[update-all] ===== finished =====');
}

main().catch((error) => {
  console.error('[update-all] ERROR:', error instanceof Error ? error.message : error);
  process.exit(1);
});
