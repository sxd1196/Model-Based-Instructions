/**
 * Bake-off evidence pass: for every collision the oracle reported, capture a
 * REAL RENDERER screenshot at the moment of worst penetration with the two
 * violating parts highlighted.
 *
 * Trust chain (user: "there have been collisions you didn't report — why
 * believe you now?"): the numbers come from the independent oracle; the
 * pictures come from the actual WebGL renderer the user looks at every day;
 * the HTML report embeds both. If the numbers and the pixels disagree, the
 * pixels win and the oracle is wrong — either way it is checkable.
 *
 * Usage: node scripts/bakeoff-evidence.mjs   (dev server must be running)
 */
import { chromium } from 'playwright';
import * as fs from 'node:fs';

const results = JSON.parse(fs.readFileSync('.smoke/bakeoff-results.json', 'utf8'));
const jobs = [];
for (const r of results.results) {
  if (!r.violations?.length) continue;
  // Evidence for the top 3 deepest violations per run (report links the rest).
  for (const v of r.violations.slice(0, 3)) {
    jobs.push({ model: r.model, variant: r.variant, v });
  }
}
console.log(`evidence jobs: ${jobs.length}`);
fs.mkdirSync('.smoke/bakeoff-evidence', { recursive: true });

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

// Group jobs by model+variant so each replan happens once.
const groups = new Map();
for (const j of jobs) {
  const k = `${j.model}|${j.variant}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(j);
}

for (const [key, groupJobs] of groups) {
  const [model, variant] = key.split('|');

  // Load the model through the real UI.
  if (model === 'gearbox') {
    await page.getByRole('button', { name: /demo models/i }).click();
    await page.getByRole('button', { name: /gearbox/i }).click();
    await page.waitForTimeout(1500);
  } else {
    await page.getByRole('button', { name: /demo models/i }).click();
    const label = {
      'ata-00031': /beam joint/i, 'ata-00026': /latch block/i, 'ata-00014': /clamp/i,
      'ata-00057': /housing stack/i, 'ata-00024': /bracket set/i,
    }[model];
    await page.getByRole('button', { name: label }).click();
    await page.waitForTimeout(2500);
    // Dismiss the import dialog WITHOUT the planner (we replan with the
    // exact variant below).
    const dlg = page.locator('.import-dialog');
    if (await dlg.count()) await page.getByRole('button', { name: /start from scratch/i }).click();
    await page.waitForTimeout(400);
  }

  // Re-plan in-page with the SAME variant and install as the sequence.
  await page.evaluate(async (variantId) => {
    const { setPlannerConfig, VARIANTS } = await import('/src/planner/config.ts');
    const { planSequence } = await import('/src/planner/peel.ts');
    const { draftOperations } = await import('/src/planner/draft.ts');
    const { collectPartGeoms } = await import('/src/planner/feasibility.ts');
    const { indexScene } = await import('/src/cad/loadGltf.ts');
    setPlannerConfig(VARIANTS[variantId]);
    const st = window.__store.getState();
    const scene = window.__r3fScene;
    // Find the model root: SceneBinder mounts the loaded scene.
    const index = indexScene(scene, st.sequence.assembly);
    const steps = planSequence(st.sequence.assembly, index);
    const geoms = collectPartGeoms(index);
    const { operations } = draftOperations(steps, st.sequence.assembly, geoms);
    window.__store.setState((s) => {
      s.sequence.operations = operations;
    });
  }, variant);
  await page.waitForTimeout(400);

  for (const job of groupJobs) {
    const { v } = job;
    // Scrub to the violation moment, select the two parts (amber tint),
    // let the renderer draw, shoot.
    await page.evaluate(async ({ tNorm, a, b: bId }) => {
      const st = window.__store.getState();
      const { totalDuration } = await import('/src/domain/evaluate.ts');
      st.setTime(totalDuration(st.sequence) * tNorm);
      window.__store.setState((s) => { s.selection = [a, bId]; });
    }, { tNorm: v.t, a: v.a, b: v.b });
    await page.waitForTimeout(500);
    const file = `.smoke/bakeoff-evidence/${job.model}-${job.variant}-${v.a.replace(/[^\w]/g, '_')}-${v.b.replace(/[^\w]/g, '_')}.png`;
    await page.screenshot({ path: file });
    console.log(`shot: ${file} (depth ${v.depthMm}mm at t=${v.seconds.toFixed(1)}s)`);
  }
}

await b.close();
console.log('evidence complete');
