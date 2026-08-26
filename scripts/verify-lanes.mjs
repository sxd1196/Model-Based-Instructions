import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /demo models/i }).click();
await page.getByRole('button', { name: /gearbox/i }).click();
await page.waitForTimeout(2500);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// Select the cover plate, add a step, then a typed motion via + Motion.
await page.evaluate(() => {
  const st = window.__store.getState();
  const p = Object.values(st.sequence.assembly.parts).find(x => x.name === 'Cover_Plate');
  st.pickPart(p.id, {});
});
await page.getByRole('button', { name: /\+ Step/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /\+ Motion/i }).click();
await page.waitForTimeout(400);

const laneCount = await page.locator('.lane').count();
check('typed path: + Motion creates a lane', laneCount === 1, `${laneCount} lane(s)`);

// Expand it and type Z = 120.
await page.locator('.lane-line').first().click();
await page.waitForTimeout(200);
const zInput = page.locator('.lane-editor .lane-num input').nth(2);
await zInput.fill('120');
await zInput.blur();
await page.waitForTimeout(400);

const desc1 = await page.locator('.lane-desc').first().textContent();
check('typed Z 120 reads back in the lane sentence', desc1?.includes('Z 120mm') === true, desc1 ?? '');

const pose1 = await page.evaluate(() => {
  const st = window.__store.getState();
  const p = Object.values(st.sequence.assembly.parts).find(x => x.name === 'Cover_Plate');
  const { resolveFrame } = window.__domain ?? {};
  return st.sequence.operations[0].tracks.map(t => t.to.translate);
});
check('store holds the typed translate', JSON.stringify(pose1).includes('120'), JSON.stringify(pose1));

// Add a SECOND motion on the same part (the chain case) and type X = 80.
await page.getByRole('button', { name: /\+ Motion/i }).click();
await page.waitForTimeout(400);
const lanes2 = await page.locator('.lane').count();
check('second motion on the same part = second lane', lanes2 === 2, `${lanes2} lanes`);

const winds = await page.evaluate(() =>
  window.__store.getState().sequence.operations[0].tracks.map(t => [t.start, t.end]));
check('second motion SPLITS the step (0-.5, .5-1)',
  Math.abs(winds[0][1] - 0.5) < 0.01 && Math.abs(winds[1][0] - 0.5) < 0.01,
  JSON.stringify(winds));

// Lane 1's editor is already open from the earlier click (clicking again
// would TOGGLE it closed). Tighten lane 1 to 0..0.5 via its typed timing.
const openEditor = page.locator('.lane.open .lane-editor');
const startTInput = openEditor.locator('.lane-num input').nth(4);
await startTInput.fill('0.2');
await startTInput.blur();
await page.waitForTimeout(300);
const dur = await page.evaluate(() => window.__store.getState().sequence.operations[0].duration);
const t1 = await page.evaluate(() =>
  window.__store.getState().sequence.operations[0].tracks.map(t => [t.start, t.end]));
check('typed seconds updated the fraction', Math.abs(t1[0][0] - 0.2 / dur) < 0.02,
  JSON.stringify({ dur, t1 }));

// Rotation entry: set lane 2 to rotate 90 about Z.
await page.locator('.lane-line').nth(1).click();
await page.waitForTimeout(200);
const editor2 = page.locator('.lane.open .lane-editor');
await editor2.locator('select').selectOption('Z');
await page.waitForTimeout(200);
const angleInput = editor2.locator('.lane-num input').nth(3);
await angleInput.fill('90');
await angleInput.blur();
await page.waitForTimeout(300);

const rot = await page.evaluate(() => {
  const t = window.__store.getState().sequence.operations[0].tracks[1];
  return t.to.rotate;
});
const angle = 2 * Math.acos(Math.abs(rot[3])) * 180 / Math.PI;
check('typed rotation stored as quaternion (90° about Z)',
  Math.abs(angle - 90) < 0.5 && Math.abs(rot[2]) > 0.7, `angle=${angle.toFixed(1)}`);

const desc2 = await page.locator('.lane-desc').nth(1).textContent();
check('rotation reads in the lane sentence', desc2?.includes('90') === true, desc2 ?? '');

// Inspector: motions gone, title/instruction still there.
const motionsInPanel = await page.locator('.inspector .section-head span', { hasText: 'Motions' }).count();
const cameraInPanel = await page.locator('.inspector .section-head span', { hasText: 'Camera' }).count();
check('Motions section REMOVED from the right panel', motionsInPanel === 0);
check('Camera stays in the right panel', cameraInPanel === 1);

// Duration control now lives in the lanes header.
const durInBar = await page.locator('.lanes-head label', { hasText: 'duration' }).count();
check('duration moved to the bottom bar', durInBar === 1);

check('no console errors', errors.length === 0, errors[0] ?? 'clean');
await page.screenshot({ path: '.smoke/lanes.png' });
console.log(`\n${pass}/${pass + fail} lane checks passed`);
await b.close();
process.exit(fail ? 1 : 0);
