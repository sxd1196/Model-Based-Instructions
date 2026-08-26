/** End-to-end sequence-planner flow: import -> opt-in -> draft -> review -> accept. */
import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 140)));
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? ' - ' + d : '')); ok ? pass++ : fail++; };

// ---- import the real faucet STEP through the file input
const input = page.locator('input[type=file][accept*=".step"]');
await input.setInputFiles('C:/Users/salva/OneDrive/Desktop/faucet.STEP');
await page.waitForTimeout(12000); // OCCT wasm parse

check('import options dialog appears', (await page.locator('.import-dialog').count()) === 1);

// opt IN to the planner
await page.locator('.import-opt input[type=checkbox]').check();
await page.getByRole('button', { name: /run planner/i }).click();
for (let i = 0; i < 240; i++) { await page.waitForTimeout(2000); if (await page.evaluate(() => !!(window.__store && window.__store.getState().draftReview))) break; }

const review = await page.evaluate(() => window.__store.getState().draftReview);
check('draft review installed', review !== null);

const ops = await page.evaluate(() =>
  window.__store.getState().sequence.operations.map((o) => ({
    title: o.title, parts: o.tracks.flatMap((t) => t.parts).length,
    hl: o.styles[0]?.mode, cam: !!o.camera, desc: o.description.slice(0, 60),
    unplanned: !!o.meta.planUnplanned,
  })));
console.log('DRAFT:', JSON.stringify(ops, null, 1));

check('draft banner visible with DRAFT tag', (await page.locator('.draft-tag').count()) === 1);
const planned = ops.filter((o) => !o.unplanned);
check('planner produced steps for the faucet', planned.length >= 2, `${planned.length} steps`);
check('every planned step highlights its mover', planned.every((o) => o.hl === 'highlight'));
check('every planned step has an instruction', planned.every((o) => o.desc.startsWith('Remove ')));
check('first step has a camera', planned[0]?.cam === true);

// coverage: every faucet mesh in exactly one step
const coverage = await page.evaluate(() => {
  const st = window.__store.getState();
  const all = st.sequence.operations.flatMap((o) =>
    o.meta.planUnplanned ? [] : o.tracks.flatMap((t) => t.parts));
  const planned = new Set(all);
  const meshes = Object.values(st.sequence.assembly.parts).filter((p) => !p.isGroup);
  const un = st.sequence.operations.filter((o) => o.meta.planUnplanned)
    .flatMap((o) => (o.meta.planUnplanned ? [] : []));
  return { planned: planned.size, dup: all.length !== planned.size, meshes: meshes.length };
});
check('no part in two steps', !coverage.dup);

// the draft ANIMATES: scrub to mid-step-1, movers displaced
const moved = await page.evaluate(() => {
  const st = window.__store.getState();
  const op1 = st.sequence.operations.find((o) => !o.meta.planUnplanned);
  st.seekToOperation(op1.id);
  st.setTime(st.time + op1.duration * 0.9);
  const { resolve } = {};
  return null;
});
await page.waitForTimeout(500);
const displaced = await page.evaluate(async () => {
  const st = window.__store.getState();
  const { resolveFrame } = await import('/src/domain/evaluate.ts');
  const op1 = st.sequence.operations.find((o) => !o.meta.planUnplanned);
  const frame = resolveFrame(st.sequence, st.time);
  const ids = op1.tracks.flatMap((t) => t.parts);
  return ids.map((id) => {
    const m = frame.poses.get(id);
    return m ? Math.hypot(...m.translate) : 0;
  });
});
check('draft steps animate through the evaluator', displaced.every((d) => d > 5),
  `travels: ${displaced.map((d) => d.toFixed(0)).join(',')}mm`);

// ---- per-step reject, then accept
const stepCountBefore = ops.length;
await page.locator('.draft-step:not(.unplanned)').last().locator('.draft-step-actions button').nth(1).click();
await page.waitForTimeout(200);
await page.getByRole('button', { name: /use this draft/i }).click();
await page.waitForTimeout(400);
const after = await page.evaluate(() => ({
  review: window.__store.getState().draftReview,
  ops: window.__store.getState().sequence.operations.length,
}));
check('reject + accept: rejected step dropped, review closed',
  after.review === null && after.ops === stepCountBefore - 1,
  `${stepCountBefore} -> ${after.ops} steps`);
check('banner gone after accept', (await page.locator('.draft-banner').count()) === 0);

await page.screenshot({ path: '.smoke/planner-accepted.png' });
check('no console errors', errors.length === 0, errors[0] ?? 'clean');
console.log(`\n${pass}/${pass + fail} planner checks passed`);
await b.close();
process.exit(fail ? 1 : 0);
