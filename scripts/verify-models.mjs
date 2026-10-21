/**
 * Verifies the demo-model picker end to end: manifest loads, the real STEP
 * assembly parses in-browser, and a missing model produces the "run
 * fetch:models" message instead of an opaque parse error.
 *
 *   node scripts/verify-models.mjs [--url http://localhost:5173]
 *
 * Needs a running dev server. Runs its own isolated Chromium — it never
 * touches the user's browser.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const URL = arg('url', 'http://localhost:5173');
const OUT = arg('out', '.smoke');
mkdirSync(OUT, { recursive: true });

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  await page.goto(URL, { waitUntil: 'networkidle' });

  // 1. Manifest reaches the UI.
  await page.getByRole('button', { name: /load a demo model/i }).click();
  const stepBtn = page.getByRole('button', { name: /Camera Mount/i });
  await stepBtn.waitFor({ timeout: 10_000 });
  record('manifest renders STEP entries in picker', true);

  const heavy = await page.getByRole('button', { name: /reBot B601 Arm/i }).count();
  record('both arm variants listed', heavy === 2, `${heavy} found`);

  // 2. The real STEP assembly parses and produces a part tree.
  await stepBtn.click();
  await page.waitForFunction(
    () => {
      const s = window.__store?.getState?.();
      return !!s?.sequence?.assembly?.parts;
    },
    { timeout: 180_000 },
  );

  const info = await page.evaluate(() => {
    const a = window.__store.getState().sequence.assembly;
    const parts = Object.values(a.parts);
    return {
      name: a.name,
      total: parts.length,
      meshes: parts.filter((p) => !p.isGroup).length,
      groups: parts.filter((p) => p.isGroup).length,
    };
  });

  // index.json records 9 solids / 9 nodes / 8 links for the camera mount.
  record(
    'STEP parsed into separate named parts',
    info.meshes >= 8,
    `${info.meshes} meshes, ${info.groups} groups ("${info.name}")`,
  );
  record('assembly hierarchy preserved (not one merged mesh)', info.meshes > 1);

  await page.screenshot({ path: join(OUT, 'models-step-loaded.png') });

  // 3. A model that was never fetched must explain itself.
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /demo model/i }).first().click();
  await page.getByRole('button', { name: /reBot B601 Arm — DM/i }).click();
  const warned = await page
    .getByText(/fetch:models/i)
    .first()
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  record('missing model reports fetch:models instead of a parse error', warned);

  record('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (err) {
  record('run completed', false, err.message);
} finally {
  writeFileSync(join(OUT, 'verify-models.json'), JSON.stringify(results, null, 2));
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
