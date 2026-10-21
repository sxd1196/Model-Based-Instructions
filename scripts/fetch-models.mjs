#!/usr/bin/env node
/**
 * Download the demo CAD assemblies named in public/models/index.json.
 *
 * WHY FETCH INSTEAD OF COMMIT:
 *  - The arm assemblies are ~36MB each. Vendoring them would bloat every
 *    clone forever, and git stores binaries badly.
 *  - The upstream files are CERN-OHL-W-2.0. That licence's reciprocity
 *    obligations attach to DISTRIBUTION. We don't redistribute: each user
 *    pulls from the original repo, so this project carries no obligation
 *    and the attribution stays pointed at the people who did the work.
 *  - Pinning a commit + sha256 makes the fetch reproducible: you get the
 *    exact bytes the part counts in index.json were measured against.
 *
 * Usage:
 *   node scripts/fetch-models.mjs            # light models only (~2MB)
 *   node scripts/fetch-models.mjs --all      # everything (~77MB)
 *   node scripts/fetch-models.mjs camera-mount arm-dm
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = join(root, 'public', 'models');
const manifestPath = join(modelsDir, 'index.json');

const argv = process.argv.slice(2);
const wantAll = argv.includes('--all');
const explicit = argv.filter((a) => !a.startsWith('--'));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
await mkdir(modelsDir, { recursive: true });

const selected = manifest.models.filter((m) =>
  explicit.length ? explicit.includes(m.id) : wantAll || m.weight === 'light',
);

if (!selected.length) {
  console.error(`No models matched. Available ids: ${manifest.models.map((m) => m.id).join(', ')}`);
  process.exit(1);
}

const skippedHeavy = !wantAll && !explicit.length
  ? manifest.models.filter((m) => m.weight !== 'light')
  : [];

let failed = 0;

for (const model of selected) {
  const src = manifest.sources[model.source];
  const dest = join(modelsDir, model.file);
  const url = src.rawBase + model.remotePath;

  // Already present and correct? Don't re-download 36MB.
  if (existsSync(dest) && statSync(dest).size === model.bytes) {
    const have = sha256(await readFile(dest));
    if (have === model.sha256) {
      console.log(`= ${model.file} already present and verified`);
      continue;
    }
  }

  process.stdout.write(`↓ ${model.file} (${mb(model.bytes)}) from ${src.name} … `);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());

    const got = sha256(buf);
    if (got !== model.sha256) {
      // Upstream moved the file or the pin is stale. Never silently accept
      // different bytes — the measured part counts would stop matching.
      throw new Error(
        `checksum mismatch\n    expected ${model.sha256}\n    got      ${got}\n` +
        `    The pinned commit may have been rewritten. Verify upstream before updating index.json.`,
      );
    }

    await writeFile(dest, buf);
    console.log(`ok (${model.stats.solids} solids, ${model.stats.assemblyLinks} assembly links)`);
  } catch (err) {
    console.log('FAILED');
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('');
for (const m of skippedHeavy) {
  console.log(`· skipped ${m.file} (${mb(m.bytes)}) — run with --all or \`${m.id}\` to fetch it`);
}

const src = manifest.sources.rebot;
console.log(
  `\nDemo CAD is from ${src.name} (${src.repo}), licensed ${src.license}.\n` +
  `It is NOT part of this project's source and is not redistributed here.`,
);

process.exit(failed ? 1 : 0);
