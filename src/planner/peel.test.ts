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
import * as THREE from 'three';
import { buildAssemblyFromScene, indexScene } from '@/cad/loadGltf';
import { makeDemoAssembly } from '@/cad/demo';
import { planSequence } from './peel';
import { collectPartGeoms, feasibleDirections } from './feasibility';

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

  it('bolts ARE free at the start (they are the outermost layer)', () => {
    const geoms = collectPartGeoms(index);
    const remaining = new Map(geoms);
    const bolt = Object.values(assembly.parts).find((p) => p.name === 'Bolt_M8_01_Head')!;
    const shank = Object.values(assembly.parts).find((p) => p.name === 'Bolt_M8_01_Shank')!;
    const dirs = feasibleDirections([bolt.id, shank.id], remaining, geoms);
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs[0].dir).toBe('+Z');
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

  it('sequences bolts before the cover plate they retain', () => {
    const boltStep = steps.findIndex((s) =>
      s.parts.some((p) => nameOf(p).startsWith('Bolt_M8')));
    const plateStep = steps.findIndex((s) =>
      s.parts.some((p) => nameOf(p) === 'Cover_Plate'));
    expect(boltStep).toBeGreaterThanOrEqual(0);
    expect(plateStep).toBeGreaterThanOrEqual(0);
    expect(boltStep).toBeLessThan(plateStep);
  });

  it('batches the 8 identical bolt groups into few steps, not 8 singles', () => {
    const boltSteps = steps.filter((s) =>
      s.parts.every((p) => nameOf(p).startsWith('Bolt_M8')));
    expect(boltSteps.length).toBeLessThanOrEqual(2);
    const total = boltSteps.reduce((n, s) => n + s.parts.length, 0);
    expect(total).toBe(16);
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
