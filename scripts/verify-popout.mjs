import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 150)));
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Demo model', exact: true }).click();
await page.waitForTimeout(2500);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// ---- lane membership ----
await page.locator('.tree-row', { hasText: 'SUB_Cover' }).first().click();
await page.getByRole('button', { name: /\+ Step/i }).click();
await page.waitForTimeout(200);
await page.getByRole('button', { name: /\+ Motion/i }).click();
await page.waitForTimeout(400);
await page.locator('.lane-line').first().click();
await page.waitForTimeout(300);

const chips = await page.locator('.lane-part-chip').count();
check('lane lists every member part by name', chips === 18, `${chips} chips`);

// click a part name -> it becomes the viewport selection
await page.locator('.lane-part-name', { hasText: 'Bolt_M8_05_Head' }).click();
await page.waitForTimeout(400);
const sel = await page.evaluate(() => {
  const st = window.__store.getState();
  return st.selection.map((id) => st.sequence.assembly.parts[id]?.name);
});
check('clicking a part name selects it in the viewport', sel.length === 1 && sel[0] === 'Bolt_M8_05_Head', JSON.stringify(sel));

// remove one part
await page.locator('.lane-part-chip', { hasText: 'Bolt_M8_03_Head' }).locator('.lane-part-x').click();
await page.waitForTimeout(400);
const chipsAfter = await page.locator('.lane-part-chip').count();
check('✕ removes the part from the motion', chipsAfter === 17, `${chipsAfter} chips`);

// move again for the same parts
await page.locator('.lane-again').click();
await page.waitForTimeout(400);
const laneCount = await page.locator('.lane').count();
check('move again adds a chained lane for the same parts', laneCount === 2, `${laneCount} lanes`);

// ---- pop-out ----
const popupPromise = ctx.waitForEvent('page');
await page.getByRole('button', { name: /pop out 3d/i }).click();
const popup = await popupPromise;
await popup.waitForTimeout(1500);

const canvasInPopup = await popup.locator('canvas').count();
check('3D canvas lives in the popped window', canvasInPopup >= 1, `${canvasInPopup} canvas`);

const canvasInMain = await page.locator('.body canvas').count();
check('main window no longer holds the viewport', canvasInMain === 0);

const expanded = await page.locator('.bottom.expanded').count();
check('timeline panel expands in the main window', expanded === 1);

// WebGL still ALIVE in the popup (not a dead reparented context)?
const px = await popup.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  return gl ? !gl.isContextLost() : null;
});
check('WebGL context survives the reparent', px === true, String(px));

// authoring still works while popped: type a motion value from the main window
const zField = page.locator('.lane.open .lane-num input').nth(2);
if (await zField.count()) {
  await zField.fill('77');
  await zField.blur();
  await page.waitForTimeout(500);
  const stored = await page.evaluate(() => {
    const t = window.__store.getState().sequence.operations[0].tracks[0];
    return t.to.translate[2];
  });
  check('editing lanes still drives the popped viewport', stored === 77, `z=${stored}`);
}

// pop back in
await popup.getByRole('button', { name: /pop back in/i }).click();
await page.waitForTimeout(1000);
const canvasBack = await page.locator('.body canvas').count();
check('pop back in restores the docked viewport', canvasBack >= 1, `${canvasBack} canvas`);

await page.screenshot({ path: '.smoke/popout-main.png' });
check('no console errors', errors.length === 0, errors[0] ?? 'clean');
console.log(`\n${pass}/${pass + fail} popout checks passed`);
await b.close();
process.exit(fail ? 1 : 0);
