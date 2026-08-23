/**
 * Focused verification for the two reported drag bugs.
 *
 *   node scripts/_verify.mjs
 *
 * Drives the store the way the gizmo does on mouse-up, then checks the
 * VIEWPORT actually changed. That is the reported symptom: the gizmo moved
 * but the part stayed at rest until you pressed play.
 *
 * Deliberately not pixel-hunting for gizmo arrow handles — those coordinates
 * are camera-dependent and make the check flaky. TransformControls' own mouse
 * handling is drei's code and was never the broken part.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('.smoke', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Demo model', exact: true }).click();
await page.waitForTimeout(2500);

const canvas = page.locator('canvas').first();

/** Fraction of pixels that differ between two screenshots of the canvas. */
async function canvasSignature() {
  return page.evaluate(() => {
    const c = document.querySelector('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const w = c.width, h = c.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // Cheap perceptual hash: bucket luminance over a coarse grid.
    const grid = 24, cell = [];
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        let sum = 0, n = 0;
        const x0 = Math.floor((gx * w) / grid), x1 = Math.floor(((gx + 1) * w) / grid);
        const y0 = Math.floor((gy * h) / grid), y1 = Math.floor(((gy + 1) * h) / grid);
        for (let y = y0; y < y1; y += 3) {
          for (let x = x0; x < x1; x += 3) {
            const i = (y * w + x) * 4;
            sum += px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
            n++;
          }
        }
        cell.push(n ? Math.round(sum / n) : 0);
      }
    }
    return cell;
  });
}

const differing = (a, b) =>
  a.reduce((acc, v, i) => acc + (Math.abs(v - b[i]) > 6 ? 1 : 0), 0);

// ---------------------------------------------------------------- BUG 1
// Select a part, then commit a translate the way the gizmo does on mouse-up.
await page.evaluate(() => {
  const st = window.__store.getState();
  const part = Object.values(st.sequence.assembly.parts).find(
    (p) => p.name === 'Cover_Plate',
  );
  st.pickPart(part.id, {});
});
await page.waitForTimeout(600);

const beforeSig = await canvasSignature();
await page.screenshot({ path: '.smoke/fix-01-before.png' });
await page.locator('.vp-toolbar, .viewport-toolbar').first().screenshot({ path: '.smoke/fix-00-toolbar.png' }).catch(() => {});

const dragInfo = await page.evaluate(() => {
  const st = window.__store.getState();
  const part = Object.values(st.sequence.assembly.parts).find(
    (p) => p.name === 'Cover_Plate',
  );
  const r = part.restTranslate;
  // Exactly what Manipulation.tsx does on mouse-up after a +120mm Z drag.
  st.commitDrag(part.id, [r[0], r[1], r[2] + 120], part.restRotate);
  const s2 = window.__store.getState();
  return {
    time: s2.time,
    ops: s2.sequence.operations.length,
    to: s2.sequence.operations[0]?.tracks[0]?.to?.translate,
  };
});
await page.waitForTimeout(900);

const afterSig = await canvasSignature();
await page.screenshot({ path: '.smoke/fix-02-after-translate.png' });

const moved = differing(beforeSig, afterSig);
check('translate: a step is created', dragInfo.ops === 1, `${dragInfo.ops} op(s)`);
check('translate: playhead parks past t=0', dragInfo.time > 0, `t=${dragInfo.time?.toFixed(2)}s`);
check('translate: authored delta is 120mm on Z',
  Math.abs((dragInfo.to?.[2] ?? 0) - 120) < 0.001, JSON.stringify(dragInfo.to));
check('translate: THE PART VISIBLY MOVED without pressing play',
  moved > 8, `${moved} grid cells changed`);

// ---------------------------------------------------------------- BUG 2
// Title now carries a description, so match on the prefix.
await page.locator('button[title^="Gizmo: rotate"]').click();
await page.waitForTimeout(400);
const mode = await page.evaluate(() => window.__store.getState().gizmo);
check('rotate: toolbar switches the gizmo to rotate', mode === 'rotate', mode);

const beforeRot = await canvasSignature();

const rotInfo = await page.evaluate(() => {
  const st = window.__store.getState();
  const part = Object.values(st.sequence.assembly.parts).find(
    (p) => p.name === 'Main_Shaft',
  );
  st.pickPart(part.id, {});

  // A rotate-only gizmo drag: 45 deg about Z, handle stays put.
  const a = Math.PI / 4, s = Math.sin(a / 2);
  const spin = [0, 0, s, Math.cos(a / 2)];
  const r = part.restTranslate;
  window.__store.getState().commitDrag(part.id, r, spin);

  const s2 = window.__store.getState();
  const tracks = s2.sequence.operations.flatMap((o) => o.tracks);
  const t = tracks.find((x) => x.parts.includes(part.id));
  return { rotate: t?.to?.rotate, translate: t?.to?.translate, rest: r };
});
await page.waitForTimeout(900);

const afterRot = await canvasSignature();
await page.screenshot({ path: '.smoke/fix-03-after-rotate.png' });

check('rotate: a rotation was recorded', Boolean(rotInfo.rotate),
  JSON.stringify(rotInfo.rotate?.map((n) => +n.toFixed(3))));

// The old bug: an origin pivot turned a pure spin into a huge translate,
// which axis lock then flattened and snap quantized.
const tmag = Math.hypot(...(rotInfo.translate ?? [0, 0, 0]));
check('rotate: does NOT fling the part across the scene', tmag < 1,
  `|translate| = ${tmag.toFixed(3)}mm`);

check('rotate: the part visibly rotated', differing(beforeRot, afterRot) > 4,
  `${differing(beforeRot, afterRot)} grid cells changed`);

check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');

// ---------------------------------------------------------------- BUG 3
// Reported: after a commit the gizmo sat in empty space while the part was
// elsewhere. The handle was positioned once on selection change, but
// SceneBinder rewrites part transforms every frame, so any pose change
// stranded it. Measures the gap between the handle and the part it controls.
const handleGap = () => page.evaluate(() => {
  const p = window.__gizmoProbe;
  if (!p?.handle || !p?.target) return null;
  return Math.hypot(
    p.handle[0] - p.target[0],
    p.handle[1] - p.target[1],
    p.handle[2] - p.target[2],
  );
});

// Drive the exact sequence from the report: select, commit, measure the gap.
await page.evaluate(() => {
  const st = window.__store.getState();
  const p = Object.values(st.sequence.assembly.parts).find((x) => x.name === 'Main_Shaft');
  st.pickPart(p.id, {});
});
await page.waitForTimeout(600);
const gapBefore = await handleGap();

await page.evaluate(() => {
  const st = window.__store.getState();
  const p = Object.values(st.sequence.assembly.parts).find((x) => x.name === 'Main_Shaft');
  const r = p.restTranslate;
  st.commitDrag(p.id, [r[0] + 200, r[1], r[2]], p.restRotate);
});
await page.waitForTimeout(900);
await page.screenshot({ path: '.smoke/fix-04-handle-tracks.png' });
const gapAfter = await handleGap();

check('gizmo probe is reachable', gapBefore !== null && gapAfter !== null,
  `before=${gapBefore} after=${gapAfter}`);
check('GIZMO HANDLE STAYS ON THE PART after a commit',
  gapAfter !== null && gapAfter < 5,
  `gap ${gapBefore?.toFixed(2)}mm -> ${gapAfter?.toFixed(2)}mm`);

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
