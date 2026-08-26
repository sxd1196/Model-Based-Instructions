import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 120)));
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? ' - ' + d : '')); ok ? pass++ : fail++; };

await page.getByRole('button', { name: /demo models/i }).click();
await page.getByRole('button', { name: /clamp \(5 parts\)/i }).click();
await page.waitForTimeout(3000);
check('ATA model loads through picker', (await page.locator('.import-dialog').count()) === 1);

await page.locator('.import-opt input[type=checkbox]').check();
await page.getByRole('button', { name: /run planner/i }).click();
let bannerUp = false;
for (let i = 0; i < 150; i++) {
  await page.waitForTimeout(2000);
  if (await page.locator('.draft-banner').count()) { bannerUp = true; break; }
}
check('draft banner appears (planner completed)', bannerUp);

const ops = await page.evaluate(() =>
  window.__store.getState().sequence.operations.map((o) => ({
    title: o.title, unplanned: !!o.meta.planUnplanned, reason: o.meta.planReason,
  })));
console.log('PLAN:', JSON.stringify(ops, null, 1));
const planned = ops.filter((o) => !o.unplanned);
check('planner sequenced at least half the clamp', planned.length >= 2, `${planned.length} steps`);

// v2 acceptance: scrub 60 frames; NEW deep AABB interpenetration (>3mm on
// every axis, absent at rest) = plowing. Rest-contact pairs are exempt.
const interpen = await page.evaluate(async () => {
  const st = window.__store.getState();
  const { totalDuration } = await import('/src/domain/evaluate.ts');
  const total = totalDuration(st.sequence);
  const scene = window.__r3fScene;
  const out = [];
  for (let f = 0; f <= 60; f++) {
    st.setTime((total * f) / 60);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const boxes = [];
    scene.traverse((o) => {
      if (o.isMesh && o.visible && o.name.startsWith('Part_')) {
        o.updateWorldMatrix(true, false);
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
        boxes.push({ name: o.name, bb });
      }
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].bb, c = boxes[j].bb;
        const ox = Math.min(a.max.x, c.max.x) - Math.max(a.min.x, c.min.x);
        const oy = Math.min(a.max.y, c.max.y) - Math.max(a.min.y, c.min.y);
        const oz = Math.min(a.max.z, c.max.z) - Math.max(a.min.z, c.min.z);
        const depth = Math.min(ox, oy, oz);
        if (depth > 3) out.push({ f, a: boxes[i].name, b: boxes[j].name, depth: +depth.toFixed(1) });
      }
    }
  }
  return out;
});
const restPairs = new Set(interpen.filter((x) => x.f === 0).map((x) => x.a + '|' + x.b));
const violations = interpen.filter((x) => x.f > 2 && !restPairs.has(x.a + '|' + x.b));
check('no NEW deep interpenetration during the draft animation',
  violations.length === 0,
  violations.length ? JSON.stringify(violations.slice(0, 4)) : 'clean across 60 frames');

await page.screenshot({ path: '.smoke/v2-ata.png' });
check('no console errors', errors.length === 0, errors[0] ?? 'clean');
console.log(`\n${pass}/${pass + fail} v2 checks passed`);
await b.close();
process.exit(fail ? 1 : 0);
