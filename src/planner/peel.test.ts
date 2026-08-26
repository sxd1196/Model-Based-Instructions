/**
 * SPIKE VALIDATION for the feasibility kernel + peel loop.
 *
 * Runs the real planner on the demo gearbox (28 meshes, nested subassemblies)
 * headless — three + three-mesh-bvh are pure math here, no WebGL required.
 * These tests assert the STRUCTURAL properties a trustworthy draft needs,
 * not one blessed sequence: complete coverage, no duplicates, physically
 * sensible ordering (bolts before the cover they retain).
 */
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

// The v2 kernel does real edge-sampled penetration math — the gearbox plan
// takes ~5-8s. Worth it: these are the tests that keep the planner honest.
vi.setConfig({ testTimeout: 120_000 });
import * as THREE from 'three';
import { buildAssemblyFromScene, indexScene } from '@/cad/loadGltf';
import { makeDemoAssembly } from '@/cad/demo';
import { planSequence } from './peel';
import { canSweepOut, collectPartGeoms, feasibleDirections, rankedDirections } from './feasibility';

const { root, name } = makeDemoAssembly();
const { assembly, scene } = buildAssemblyFromScene(root as THREE.Group, 'demo://x', { name });
const index = indexScene(scene, assembly);

const nameOf = (id: string) => assembly.parts[id]?.name ?? id;

describe('feasibility kernel on the demo gearbox', () => {
  it('the cover plate cannot lift off past the bolt heads', () => {
    const geoms = collectPartGeoms(index);
    const remaining = new Map(geoms);
    const plate = Object.values(assembly.parts).find((p) => p.name === 'Cover_Plate')!;
    const dirs = feasibleDirections([plate.id], remaining, geoms);
    // +Z (lift) must be blocked by the bolt heads; -Z by the housing. The
    // demo plate has NO modelled holes, so its shanks interpenetrate at rest
    // and rest-contact pairs are ignored (Wilson blocking-graph rule) —
    // lateral slide is therefore geometrically legal HERE. Real STEP files
    // model true holes, so lateral would be blocked by shank walls there.
    const free = dirs.map((d) => d.dir);
    expect(free).not.toContain('+Z');
    expect(free).not.toContain('-Z');
  });

  it('bolts ARE free at the start, and contact normals rank +Z first', () => {
    const geoms = collectPartGeoms(index);
    const remaining = new Map(geoms);
    const bolt = Object.values(assembly.parts).find((p) => p.name === 'Bolt_M8_01_Head')!;
    const shank = Object.values(assembly.parts).find((p) => p.name === 'Bolt_M8_01_Shank')!;
    const dirs = feasibleDirections([bolt.id, shank.id], remaining, geoms);
    expect(dirs.length).toBeGreaterThan(0);
    // v2: the ranking must come from the bolt's own contacts (seated head
    // pushes +Z), not from a lucky fixed order.
    expect(rankedDirections([bolt.id, shank.id], remaining, geoms)[0]).toBe('+Z');
    expect(dirs[0].dir).toBe('+Z');
  });

  it('REGRESSION v1: a part canNOT deepen contact with a touching neighbour', () => {
    // v1 made rest-touching pairs invisible in every direction forever —
    // touching parts could plow straight through each other. v2 penetration
    // budget: pushing the plate UP crushes it into the seated bolt heads
    // (blocked), pushing DOWN crushes into the gasket/housing (blocked).
    // NOTE: LATERAL slide is legal on this vanity model because the plate
    // has no modelled holes (shanks sit in solid material, rest budget
    // covers it) — real CAD models true holes and blocks lateral too.
    const geoms = collectPartGeoms(index);
    const remaining = new Map(geoms);
    const plate = Object.values(assembly.parts).find((p) => p.name === 'Cover_Plate')!;
    expect(canSweepOut([plate.id], '+Z', remaining, geoms).ok).toBe(false);
    expect(canSweepOut([plate.id], '-Z', remaining, geoms).ok).toBe(false);
  });
});

describe('peel loop on the demo gearbox', () => {
  const steps = planSequence(assembly, index);

  it('covers every mesh exactly once', () => {
    const all = steps.flatMap((s) => s.parts);
    expect(new Set(all).size).toBe(all.length); // no duplicates
    // index holds meshes AND groups; the planner plans meshes.
    const meshCount = [...index.values()].filter(
      (o) => (o as THREE.Mesh).isMesh).length;
    expect(all.length).toBe(meshCount);
  });

  it('SUB_Cover leaves WHOLE as one hierarchical unit (largest-first)', () => {
    // v2 hierarchy: the whole cover subassembly (plate+gasket+8 bolts) is
    // free along +Z as a rigid unit, so it goes as ONE step — bolts never
    // separate from the plate. (v1 tore heads from shanks.)
    const coverStep = steps.find((s) => s.label === 'SUB_Cover');
    expect(coverStep).toBeDefined();
    expect(coverStep!.parts.length).toBe(18);
    expect(coverStep!.dir).toBe('+Z');
    // Round number deliberately NOT pinned: outboard singles (the flange)
    // may legally peel first. What matters is the cover leaves WHOLE.
  });

  it('flags the press-fit internals honestly instead of guessing', () => {
    // Shaft/gears/key/bearings are press-fitted or keyed — no straight-line
    // extraction exists. v1 'planned' them by cheating through ghost pairs;
    // v2 must refuse and flag.
    const unplanned = steps.find((s) => s.unplanned);
    expect(unplanned).toBeDefined();
    const names = unplanned!.parts.map(nameOf);
    expect(names).toContain('Main_Shaft');
    expect(names).toContain('Key_6x4x30');
  });

  it('identical-sibling batching is feasibility-partitioned (10-bolts rule)', () => {
    // Bolts inside SUB_Cover leave with their parent here, so assert the
    // mechanism directly: batch = only siblings THEMSELVES free same-dir.
    // The two bearings are identical siblings in SUB_ShaftAssembly but only
    // Bearing_1 is ever free (-Z) — they must NOT batch together.
    const bearingSteps = steps.filter((s) => s.parts.some((p) => nameOf(p).startsWith('Bearing')));
    for (const s of bearingSteps.filter((x) => !x.unplanned)) {
      expect(s.parts.length).toBe(1);
    }
  });

  it('every planned step has a feasible direction and a reason', () => {
    for (const s of steps.filter((x) => !x.unplanned)) {
      expect(s.dir).not.toBeNull();
      expect(s.distance).toBeGreaterThan(0);
      expect(s.reason.length).toBeGreaterThan(5);
    }
  });

  it('prints the plan for human review (spike report)', () => {
    const lines = steps.map(
      (s, i) =>
        `${i + 1}. ${s.label} — ${s.dir ?? 'UNPLANNED'} ${s.distance.toFixed(0)}mm (${s.reason})`,
    );
    // Not an assertion — the console output IS the spike deliverable.
    console.log('\nPLANNED SEQUENCE (demo gearbox):\n' + lines.join('\n'));
    expect(lines.length).toBeGreaterThan(0);
  });
});
