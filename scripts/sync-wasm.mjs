/**
 * Copy the occt-import-js WASM binary into public/wasm/.
 *
 *   node scripts/sync-wasm.mjs
 *
 * Runs automatically on `npm install` (postinstall) and before a build.
 *
 * Why this exists: the Emscripten glue resolves its .wasm relative to the
 * page, which under Vite hits the SPA HTML fallback and fails with
 * "WebAssembly.instantiate(): expected magic word 00 61 73 6d, found
 * 3c 21 64 6f" — that being `<!do`. Serving the binary from public/ and
 * pointing locateFile at it is the fix. A stale copy here silently ships the
 * wrong OCCT version, so this keeps them in step.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/occt-import-js/dist/occt-import-js.wasm');
const destDir = join(root, 'public/wasm');
const dest = join(destDir, 'occt-import-js.wasm');

if (!existsSync(src)) {
  console.error('occt-import-js wasm not found — run npm install first.');
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

const kb = (statSync(dest).size / 1024).toFixed(0);
console.log(`synced occt-import-js.wasm -> public/wasm (${kb} KB)`);
