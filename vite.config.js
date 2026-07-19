import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isServerBindHostname, resolveAllowedHosts } from './shared/viteHosts.js';
import { DEFAULT_PORT } from './shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const port = Number(env.PORT) || DEFAULT_PORT;
  const hostname =
    (env.HOSTNAME?.trim() && isServerBindHostname(env.HOSTNAME.trim())
      ? env.HOSTNAME.trim()
      : null) ?? '127.0.0.1';
  const allowedHosts = resolveAllowedHosts(hostname, env.ALLOWED_HOSTS);

  return {
    root: path.resolve(__dirname, 'src'),
    publicDir: path.resolve(__dirname, 'public'),
    base: './',
    plugins: [
      react(),
      // exceljs / pdfkit need Node builtins (util.inherits, stream, zlib, …) in WebView.
      nodePolyfills({
        include: [
          'assert',
          'buffer',
          'events',
          'path',
          'process',
          'stream',
          'string_decoder',
          'util',
          'zlib',
        ],
        globals: {
          Buffer: true,
          global: true,
          process: true,
        },
        protocolImports: true,
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        // Real filesystem APIs are unavailable in WebView — stub only these.
        fs: path.resolve(__dirname, 'src/lib/empty-module.js'),
        // Prefer fontkit's browser build (no Node fs/__dirname trie loads).
        fontkit: path.resolve(__dirname, 'node_modules/fontkit/dist/browser-module.mjs'),
      },
    },
    optimizeDeps: {
      include: ['exceljs', 'pdfkit', 'buffer', 'process'],
      esbuildOptions: {
        define: {
          global: 'globalThis',
        },
      },
    },
    build: {
      outDir: path.resolve(__dirname, 'dist'),
      emptyOutDir: true,
      commonjsOptions: {
        include: [/exceljs/, /pdfkit/, /node_modules/],
        transformMixedEsModules: true,
      },
    },
    define: {
      'process.env': '{}',
      global: 'globalThis',
      // pdfkit/virtual-fs may still reference these; browsers have neither.
      __dirname: JSON.stringify('/'),
      __filename: JSON.stringify('/index.js'),
    },
    server: {
      port,
      strictPort: true,
      allowedHosts,
    },
    preview: {
      port,
      strictPort: true,
      allowedHosts,
    },
  };
});
