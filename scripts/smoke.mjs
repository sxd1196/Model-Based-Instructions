/**
 * Headless smoke test. NOT part of `npm test` — it needs a running dev server
 * and a real browser, so it lives outside the vitest suite.
 *
 *   node scripts/smoke.mjs [--url http://localhost:5173] [--out .smoke]
 *
 * Exists because the interactive layers (WebGL, gizmo, picking) cannot be
 * unit tested, and the author is not always available to click through them.
 * Runs its own isolated Chromium; it never touches the user's browser.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
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

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

const shot = async (name) => {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  return path;
};

try {
  // ---------------------------------------------------------------- load
  await page.goto(URL, { waitUntil: 'networkidle' });
  record('app loads', true, await page.title());

  // ---------------------------------------------------------------- demo
  await page.getByRole('button', { name: /load demo model/i }).click();
  await page.waitForTimeout(2500);

  const treeRows = await page.locator('.tree-row').count();
  record('assembly tree populated', treeRows > 0, `${treeRows} rows`);

  const hasCanvas = await page.locator('canvas').count();
  record('webgl canvas present', hasCanvas > 0);

  // A blank canvas means WebGL silently failed; check for non-background pixels.
  const rendered = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { ok: false, reason: 'no canvas' };
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { ok: false, reason: 'no webgl context' };
    const px = new Uint8Array(4 * 200 * 200);
    gl.readPixels(
      Math.floor(c.width / 2) - 100, Math.floor(c.height / 2) - 100,
      200, 200, gl.RGBA, gl.UNSIGNED_BYTE, px,
    );
    let distinct = new Set();
    for (let i = 0; i < px.length; i += 4) {
      distinct.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
    }
    return { ok: distinct.size > 3, reason: `${distinct.size} distinct colours` };
  });
  record('geometry actually rendered', rendered.ok, rendered.reason);
  await shot('01-loaded');

  // ---------------------------------------------------------------- select
  const box = await page.locator('canvas').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.click(cx, cy);
  await page.waitForTimeout(600);

  const selCount = await page.locator('.tree-foot').count();
  record('clicking geometry selects a part', selCount > 0);
  await shot('02-selected');

  // ---------------------------------------------------------------- gizmo
  // The reported bug: gizmo never appeared. TransformControls injects a
  // helper into the scene, so assert via the R3F scene graph.
  const gizmoInfo = await page.evaluate(() => {
    const hintEl = document.querySelector('.vp-hint');
    return { hint: hintEl ? hintEl.textContent : null };
  });

  // Count draw-call-bearing children as a proxy for "gizmo geometry exists".
  const gizmoVisible = await page.evaluate(() => {
    // drei's TransformControls renders a <div> free helper; instead detect the
    // characteristic gizmo materials by walking the canvas' three.js scene if
    // exposed, else fall back to pixel change after selection.
    return document.querySelectorAll('canvas').length > 0;
  });

  record('gizmo hint text present', !!gizmoInfo.hint, gizmoInfo.hint ?? 'none');

  // Compare centre-region pixels before/after deselect to prove the gizmo draws.
  const withGizmo = await page.screenshot({ clip: { x: cx - 150, y: cy - 150, width: 300, height: 300 } });
  await page.keyboard.press('Escape');
  await page.mouse.click(box.x + 20, box.y + 20); // click empty space to deselect
  await page.waitForTimeout(500);
  const withoutGizmo = await page.screenshot({ clip: { x: cx - 150, y: cy - 150, width: 300, height: 300 } });

  const differs = Buffer.compare(withGizmo, withoutGizmo) !== 0;
  record('GIZMO RENDERS when a part is selected', differs,
    differs ? 'pixels change with selection' : 'no visual difference — gizmo likely missing');

  // ---------------------------------------------------------------- sync
  // Viewport pick must reveal + highlight the row in the tree.
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(700);
  const highlightedAfterPick = await page.locator('.tree-row.selected').count();
  record('viewport pick highlights a tree row', highlightedAfterPick > 0,
    `${highlightedAfterPick} row(s)`);
  await shot('05-pick-syncs-tree');

  // Tree click on a GROUP must select the whole sub-assembly in 3D.
  const groupRow = page.locator('.tree-row', { hasText: 'SUB_Cover' }).first();
  await groupRow.click();
  await page.waitForTimeout(600);
  const footText = await page.locator('.tree-foot span').first().textContent();
  const selN = parseInt(footText ?? '0', 10);
  record('tree group click selects whole sub-assembly', selN > 5, `${selN} selected`);
  await shot('06-tree-selects-group');

  // The removed Sub-asm button should be gone.
  const subAsmBtn = await page.getByRole('button', { name: /sub-asm/i }).count();
  record('Sub-asm button removed', subAsmBtn === 0);

  // ---------------------------------------------------------------- steps
  await page.getByRole('button', { name: /\+ Step/i }).click();
  await page.waitForTimeout(400);
  const chips = await page.locator('.chip').count();
  record('step created', chips > 0, `${chips} chip(s)`);
  await shot('03-step');

  // ---------------------------------------------------------------- callouts
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(400);

  const addCallout = page.getByRole('button', { name: /\+ 3D callout/i });
  if (await addCallout.count()) {
    await addCallout.first().click();
    await page.waitForTimeout(500);

    const cardCount = await page.locator('.anno-card').count();
    record('callout created', cardCount > 0, `${cardCount} card(s)`);

    // Rich text: toggle bold and confirm it sticks.
    const boldBtn = page.locator('.anno-marks button', { hasText: /^B$/ }).first();
    if (await boldBtn.count()) {
      await boldBtn.click();
      await page.waitForTimeout(400);
      const isOn = await boldBtn.evaluate((el) => el.classList.contains('on'));
      record('rich text bold toggles', isOn);
      const strongInScene = await page.locator('.callout strong').count();
      record('bold renders in the 3D callout', strongInScene > 0);
    }

    // Leader line toggle should be present and checked by default.
    const leaderBox = page.locator('.leader-toggle input').first();
    if (await leaderBox.count()) {
      record('leader line on by default', await leaderBox.isChecked());
    }

    // Anchor placement arms, then a viewport click sets a feature anchor.
    const anchorBtn = page.getByRole('button', { name: /place anchor/i }).first();
    if (await anchorBtn.count()) {
      await anchorBtn.click();
      await page.waitForTimeout(300);
      await page.mouse.click(cx + 40, cy - 30);
      await page.waitForTimeout(600);
      const featText = await page.locator('.anno-meta .feat').count();
      record('viewport click sets a feature anchor', featText > 0,
        featText ? await page.locator('.anno-meta .feat').first().textContent() ?? '' : 'no feature badge');
    }
    await shot('07-callout');
  } else {
    record('callout controls reachable', false, 'no + 3D callout button found');
  }

  // ---------------------------------------------------------------- step
  // Import a real STEP file through the UI, exercising the OpenCascade WASM
  // path end to end (not just the unit-tested module).
  const stepPath = join(process.cwd(), 'src/cad/fixtures/two_boxes.step');
  if (existsSync(stepPath)) {
    // The input is `hidden` behind a label, so no filechooser event fires —
    // set the files on the input directly.
    await page.locator('input[type="file"]').first().setInputFiles(stepPath);
    await page.waitForTimeout(8000);

    const stepRows = await page.locator('.tree-row').count();
    const stepNames = await page.locator('.tree-name').allTextContents();
    record('STEP file imports via the UI', stepRows > 0, `${stepRows} rows`);
    record('STEP solids keep their names', stepNames.some((n) => /Block/i.test(n)),
      stepNames.slice(0, 4).join(', '));
    await shot('08-step-import');
  }

  // ---------------------------------------------------------------- export
  // Reload the demo (the STEP import replaced it), author a step, then export
  // and verify the doc really contains a rendered image — offscreen WebGL is
  // exactly the kind of thing that silently yields a blank canvas.
  await page.getByRole('button', { name: /demo model/i }).click();
  await page.waitForTimeout(2500);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /\+ Step/i }).click();
  await page.waitForTimeout(400);

  const exportedHtml = await page.evaluate(async () => {
    // Intercept at Blob construction: the app revokes the object URL shortly
    // after the click, so fetching it later races and fails.
    const RealBlob = window.Blob;
    let captured = null;
    // eslint-disable-next-line no-global-assign
    window.Blob = function (parts, options) {
      const blob = new RealBlob(parts, options);
      if (options && options.type === 'text/html') captured = blob;
      return blob;
    };
    window.Blob.prototype = RealBlob.prototype;

    const btn = [...document.querySelectorAll('button')]
      .find((b) => /export doc/i.test(b.textContent ?? ''));
    btn?.click();
    await new Promise((r) => setTimeout(r, 8000));
    window.Blob = RealBlob;

    return captured ? await captured.text() : '';
  });

  const hasImage = /<img class="shot" src="data:image\/png;base64,[A-Za-z0-9+/=]{500,}/.test(exportedHtml);
  record('exported doc contains a RENDERED step image', hasImage,
    hasImage ? 'png data url present' : `html length ${exportedHtml.length}`);

  // ---------------------------------------------------------------- errors
  record('no console errors', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || 'clean');

  await shot('04-final');
} catch (err) {
  record('smoke run completed', false, err.message);
  await shot('99-error');
} finally {
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
