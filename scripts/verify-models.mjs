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

  /**
   * 3. The not-yet-fetched path.
   *
   * Only meaningful when the model really is absent, so ask the server first
   * instead of assuming. An earlier version hard-coded "the arms aren't
   * downloaded" and started failing the moment someone ran
   * `fetch:models --all` — a state-dependent test that reported an app bug
   * when the app was fine.
   *
   * Note a missing file under public/ answers 200 + index.html (SPA
   * fallback), so presence means 200 AND the STEP magic — the same check the
   * app itself makes.
   */
  const armPresent = await page.evaluate(async () => {
    try {
      const r = await fetch('models/rebot-arm-dm.step', { headers: { Range: 'bytes=0-63' } });
      if (!r.ok) return false;
      return (await r.text()).includes('ISO-10303-21');
    } catch {
      return false;
    }
  });

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /demo model/i }).first().click();
  await page.getByRole('button', { name: /reBot B601 Arm — DM/i }).click();

  if (armPresent) {
    // Present: it must actually parse, and must NOT claim to be missing.
    const loaded = await page
      .waitForFunction(
        () => {
          const s = window.__store?.getState?.();
          const n = s?.sequence?.assembly?.parts;
          return n ? Object.keys(n).length > 50 : false;
        },
        // Poll on a timer, NOT the default requestAnimationFrame: parsing a
        // 36MB STEP blocks the main thread for ~30s, RAF callbacks are
        // starved, and the wait reported failure while the model had in fact
        // loaded (367 meshes read immediately afterwards).
        { timeout: 600_000, polling: 1000 },
      )
      .then(() => true)
      .catch(() => false);
    const count = await page.evaluate(() => {
      const p = window.__store?.getState?.()?.sequence?.assembly?.parts;
      return p ? Object.values(p).filter((x) => !x.isGroup).length : 0;
    });
    // index.json records 133 solids for arm-dm.
    record('heavy arm assembly parses (present on disk)', loaded && count > 100, `${count} meshes`);
    await page.screenshot({ path: join(OUT, 'models-arm-loaded.png') });
  } else {
    const warned = await page
      .getByText(/fetch:models/i)
      .first()
      .waitFor({ timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    record('missing model reports fetch:models instead of a parse error', warned);
  }

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
