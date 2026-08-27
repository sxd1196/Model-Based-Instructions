/**
 * THE BAKE-OFF: race every planner variant across the benchmark set and
 * write bakeoff-results.json.
 *
 * Run inside vitest (node): real planner, real evaluator, INDEPENDENT
 * collision oracle (src/planner/oracle.ts shares no code with the planner
 * and measures the final authored animation on full-resolution meshes).
 * Screenshots of violations are added afterwards by scripts/
 * bakeoff-evidence.mjs (real browser), and scripts/bakeoff-report.mjs
 * builds the HTML the user reviews.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 3_600_000 });
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildAssemblyFromScene, indexScene } from '@/cad/loadGltf';
import { makeDemoAssembly } from '@/cad/demo';
import { planSequence } from './peel';
import { draftOperations } from './draft';
import { collectPartGeoms } from './feasibility';
import { VARIANTS, setPlannerConfig } from './config';
import { evaluateSequenceCollisions } from './oracle';
import { SCHEMA_VERSION, type Sequence } from '@/domain/schema';

interface ModelEntry {
  id: string;
  name: string;
  file?: string; // GLB under public/models; absent = built-in demo
}

const MODELS: ModelEntry[] = [
  { id: 'gearbox', name: 'Gearbox (built-in, 28 parts)' },
  { id: 'ata-00031', name: 'ATA Beam Joint (3 parts)', file: 'public/models/ata-00031.glb' },
  { id: 'ata-00026', name: 'ATA Latch Block (4 parts)', file: 'public/models/ata-00026.glb' },
  { id: 'ata-00014', name: 'ATA Clamp (5 parts)', file: 'public/models/ata-00014.glb' },
  { id: 'ata-00057', name: 'ATA Housing Stack (7 parts)', file: 'public/models/ata-00057.glb' },
  { id: 'ata-00024', name: 'ATA Bracket Set (10 parts)', file: 'public/models/ata-00024.glb' },
];

async function loadModel(entry: ModelEntry): Promise<{ assembly: Sequence['assembly']; scene: THREE.Object3D }> {
  if (!entry.file) {
    const { root, name } = makeDemoAssembly();
    const r = buildAssemblyFromScene(root as THREE.Group, 'demo://gearbox', { name });
    return { assembly: r.assembly, scene: r.scene };
  }
  const buf = fs.readFileSync(path.resolve(entry.file));
  // Hand GLTFLoader a clean ArrayBuffer copy — Buffer views over the Node
  // buffer pool confuse its header sniffing (reads the wrong offset and
  // reports 'unsupported asset').
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(ab, '');
  const r = buildAssemblyFromScene(gltf.scene as unknown as THREE.Group, `file://${entry.id}`, { name: entry.name });
  return { assembly: r.assembly, scene: r.scene };
}

describe('planner bake-off', () => {
  it('races all variants across the benchmark set', async () => {
    const results: unknown[] = [];

    for (const model of MODELS) {
      const loaded = await loadModel(model);
      const meshCount = Object.values(loaded.assembly.parts).filter((p) => !p.isGroup).length;

      for (const [variantId, cfg] of Object.entries(VARIANTS)) {
        setPlannerConfig(cfg);
        // Fresh index per run (planner mutates nothing, but BVH caches key
        // off geometry — fine to share; contact cache resets inside).
        const index = indexScene(loaded.scene, loaded.assembly);

        const t0 = Date.now();
        let steps;
        let planMs = 0;
        let error: string | null = null;
        try {
          steps = planSequence(loaded.assembly, index);
          planMs = Date.now() - t0;
        } catch (err) {
          error = (err as Error).message;
        }

        if (error || !steps) {
          results.push({ model: model.id, modelName: model.name, variant: variantId, error });
          continue;
        }

        const geoms = collectPartGeoms(index);
        const { operations } = draftOperations(steps, loaded.assembly, geoms);
        const sequence = {
          schemaVersion: SCHEMA_VERSION,
          id: `bake-${model.id}-${variantId}`,
          name: model.name,
          intent: 'disassembly',
          assembly: loaded.assembly,
          operations,
          homeCamera: null,
          units: 'mm',
        } as unknown as Sequence;

        // INDEPENDENT oracle on the final animation.
        const oracle = evaluateSequenceCollisions(sequence, index, { frames: 60, tolerance: 1.0 });

        const planned = steps.filter((s) => !s.unplanned);
        const plannedParts = planned.reduce((n, s) => n + s.parts.length, 0);
        const shearSteps = planned.filter((s) => s.audit?.shear).length;
        const aligns = planned
          .map((s) => s.audit)
          .filter((a) => a && a.pushMag > 1e-6)
          .map((a) => a!.align);

        results.push({
          model: model.id,
          modelName: model.name,
          meshCount,
          variant: variantId,
          variantLabel: cfg.label,
          planMs,
          steps: planned.length,
          unplannedParts: meshCount - plannedParts,
          coverage: +(plannedParts / meshCount).toFixed(3),
          collisions: oracle.violations.length,
          worstPenetrationMm: oracle.violations[0]?.depthMm ?? 0,
          violations: oracle.violations,
          shearSteps,
          meanAlign: aligns.length ? +(aligns.reduce((a, b) => a + b, 0) / aligns.length).toFixed(3) : null,
          stepList: steps.map((s, i) => ({
            n: i + 1,
            label: s.label,
            dir: s.dirLabel ?? s.dir,
            source: s.dirSource,
            parts: s.parts.length,
            unplanned: !!s.unplanned,
            shear: !!s.audit?.shear,
            align: s.audit ? +s.audit.align.toFixed(2) : null,
          })),
        });
        console.log(`${model.id} / ${variantId}: ${planned.length} steps, cov ${(plannedParts / meshCount * 100).toFixed(0)}%, ${oracle.violations.length} collisions, ${planMs}ms`);
      }
    }

    fs.mkdirSync('.smoke', { recursive: true });
    fs.writeFileSync('.smoke/bakeoff-results.json', JSON.stringify({ generated: new Date().toISOString(), results }, null, 1));
    expect(results.length).toBeGreaterThan(0);
  });
});
