import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle'] });
const page = await b.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 140)));
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Demo model', exact: true }).click();
await page.waitForTimeout(2500);

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? ' - ' + d : '')); ok ? pass++ : fail++; };

// count non-background pixels in the framebuffer
const density = () => page.evaluate(async () => {
  // hide the plane WIDGET for the read: we are measuring the CUT, not the quad
  const scene3 = window.__r3fScene;
  let plane = null;
  if (scene3) scene3.traverse((o) => { if (o.name === '__sectionPlane') plane = o; });
  if (plane) plane.visible = false;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const c = document.querySelector('canvas');
  const gl2 = c.getContext('webgl2') || c.getContext('webgl');
  const w = 220, h = 220;
  const px = new Uint8Array(w * h * 4);
  // upper-middle band: the Z cut removes the gearbox TOP, and the plane quad
  // reads nearly edge-on there so it barely pollutes the sample
  gl2.readPixels((c.width - w) / 2 | 0, (c.height * 0.62) | 0, w, h, gl2.RGBA, gl2.UNSIGNED_BYTE, px);
  let lit = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (Math.abs(px[i] - 13) > 12 || Math.abs(px[i+1] - 16) > 12 || Math.abs(px[i+2] - 23) > 12) lit++;
  }
  if (plane) plane.visible = true;
  return lit;
});

await page.getByRole('button', { name: /\+ Step/i }).click();
await page.waitForTimeout(400);
const before = await density();

// whole-assembly Z cut at the model middle
await page.locator('.section', { hasText: 'Section' }).getByRole('button', { name: 'cut Z' }).click();
await page.waitForTimeout(300);
// demo gearbox sits above z=0; drop the plane low so the cut is dramatic
await page.evaluate(() => {
  const st = window.__store.getState();
  const op = st.sequence.operations[0];
  st.setSection(op.id, { ...op.section, offset: 25 });
});
await page.waitForTimeout(600);
const after = await density();
// The sampled band may sit on the KEPT side; the flip below covers both.

const stored = await page.evaluate(() => window.__store.getState().sequence.operations[0].section);
check('section stored on the operation', stored?.axis === 'Z' && stored?.offset === 25, JSON.stringify(stored));

// flip: the other side should now be missing -> pixel pattern changes
await page.locator('.section', { hasText: 'Section' }).getByRole('button', { name: /flip/i }).click();
await page.waitForTimeout(600);
const flipped = await density();
check('the cut removes one half (flip proves both sides)', Math.min(after, flipped) < before * 0.5 && Math.abs(flipped - after) > 200, 'lit base=' + before + ' sideA=' + after + ' sideB=' + flipped);
await page.locator('.section', { hasText: 'Section' }).getByRole('button', { name: /flip/i }).click();
await page.waitForTimeout(300);

// DRAG the plane in the viewport: grab the quad centre, pull along +Z screen dir
const probeBefore = await page.evaluate(() => window.__store.getState().sequence.operations[0].section.offset);
// plane centre in screen space ~ canvas middle; drag vertically
const cbox = await page.locator('canvas').boundingBox();
const cx = cbox.x + cbox.width / 2, cy = cbox.y + cbox.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 12; i++) await page.mouse.move(cx, cy - i * 8, { steps: 2 });
await page.mouse.up();
await page.waitForTimeout(500);
const probeAfter = await page.evaluate(() => window.__store.getState().sequence.operations[0].section.offset);
check('dragging the plane moves the cut', Math.abs(probeAfter - probeBefore) > 3, `${probeBefore} -> ${probeAfter.toFixed(1)}mm`);

// gesture = ONE undo entry; toolbar buttons are disabled, use store undo
const pastLen = await page.evaluate(() => window.__store.getState().past.length);
await page.evaluate(() => window.__store.getState().undo());
await page.waitForTimeout(300);
const offsetUndone = await page.evaluate(() => window.__store.getState().sequence.operations[0].section.offset);
check('plane drag is one undo step', Math.abs(offsetUndone - probeBefore) < 0.01, `undo -> ${offsetUndone}`);
void pastLen;

// selection-scoped: clear, select SUB_Cover, cut X -> parts list populated
await page.locator('.section', { hasText: 'Section' }).getByRole('button', { name: 'clear' }).click();
await page.locator('.tree-row', { hasText: 'SUB_Cover' }).first().click();
await page.waitForTimeout(300);
await page.locator('.section', { hasText: 'Section' }).getByRole('button', { name: 'cut X' }).click();
await page.waitForTimeout(300);
const scoped = await page.evaluate(() => window.__store.getState().sequence.operations[0].section);
check('selection-scoped cut lists the sub-assembly meshes', scoped?.parts?.length === 18 && scoped?.axis === 'X', (scoped?.parts?.length) + ' entries');

await page.screenshot({ path: '.smoke/section.png' });
check('no console errors', errors.length === 0, errors[0] ?? 'clean');
console.log(`\n${pass}/${pass + fail} section checks passed`);
await b.close();
process.exit(fail ? 1 : 0);
