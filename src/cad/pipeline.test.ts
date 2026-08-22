/**
 * End-to-end pipeline test WITHOUT a browser or WebGL context.
 *
 * Proves: demo assembly -> tree extraction -> merged-mesh detection ->
 * authoring operations -> deterministic frame resolution.
 *
 * This is the test that actually protects the app. The evaluator being pure
 * (no three.js) is what lets this run in plain node.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { makeDemoAssembly } from './demo';
import { buildAssemblyFromScene } from './loadGltf';
import { emptySequence } from '@/state/store';
import { poseFor, resolveFrame, totalDuration } from '@/domain/evaluate';
import { IDENTITY_QUAT, type Operation } from '@/domain/schema';

describe('demo assembly extraction', () => {
  const { root, name } = makeDemoAssembly();
  const result = buildAssemblyFromScene(root, 'demo://x', { name });

  it('extracts a multi-level tree', () => {
    expect(result.stats.meshCount).toBeGreaterThan(20);
    const nodes = Object.values(result.assembly.parts);
    expect(nodes.some((p) => p.isGroup)).toBe(true);
    // Nested: bolts live under SUB_Cover, not at the root.
    expect(nodes.some((p) => p.parentId !== null)).toBe(true);
  });

  it('keeps every part separately named and addressable', () => {
    const names = Object.values(result.assembly.parts).map((p) => p.name);
    expect(names).toContain('Housing_Body');
    expect(names).toContain('Main_Shaft');
    expect(names).toContain('Gear_Driven_48T');
    expect(names.filter((n) => n.startsWith('Bolt_M8_')).length).toBeGreaterThanOrEqual(8);
  });

  it('produces unique ids even for repeated CAD names', () => {
    const ids = Object.keys(result.assembly.parts);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('computes a usable bounding box for camera framing', () => {
    expect(result.stats.diagonal).toBeGreaterThan(0);
    expect(Number.isFinite(result.stats.diagonal)).toBe(true);
  });

  it('does NOT flag a properly-separated assembly as merged', () => {
    expect(result.warnings.some((w) => w.startsWith('CRITICAL'))).toBe(false);
  });
});

describe('merged-mesh detection (the load-bearing guard)', () => {
  it('flags a single high-poly mesh as a bad export', () => {
    const g = new THREE.Group();
    g.name = 'Flattened';
    const blob = new THREE.Mesh(new THREE.SphereGeometry(50, 128, 128));
    blob.name = 'merged';
    g.add(blob);

    const r = buildAssemblyFromScene(g, 'x://y');
    expect(r.stats.meshCount).toBe(1);
    expect(r.warnings.some((w) => w.includes('ONE merged mesh'))).toBe(true);
  });

  it('flags a file with no meshes at all', () => {
    const g = new THREE.Group();
    g.add(new THREE.Group());
    const r = buildAssemblyFromScene(g, 'x://y');
    expect(r.warnings.some((w) => w.includes('no meshes'))).toBe(true);
  });
});

describe('authoring a real disassembly sequence', () => {
  const { root, name } = makeDemoAssembly();
  const { assembly } = buildAssemblyFromScene(root, 'demo://x', { name });

  const idOf = (partName: string) =>
    Object.values(assembly.parts).find((p) => p.name === partName)!.id;

  const step = (id: string, parts: string[], z: number): Operation => ({
    id,
    title: id,
    description: '',
    duration: 1,
    dwell: 0.5,
    tracks: [
      {
        id: `${id}-t`,
        parts,
        from: { translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
        to: { translate: [0, 0, z], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
        start: 0,
        end: 1,
        easing: 'easeInOut',
      },
    ],
    camera: null,
    annotations: [],
    styles: [],
    meta: {},
  });

  const bolts = Object.values(assembly.parts)
    .filter((p) => /^Bolt_M8_\d+$/.test(p.name))
    .map((p) => p.id);

  const sequence = {
    ...emptySequence(assembly),
    operations: [
      step('remove-bolts', bolts, 120),
      step('remove-cover', [idOf('Cover_Plate')], 90),
      step('remove-gasket', [idOf('Cover_Gasket')], 70),
      step('remove-shaft', [idOf('Main_Shaft')], -160),
    ],
  };

  it('lays a 4-step sequence on a 6s timeline', () => {
    expect(totalDuration(sequence)).toBeCloseTo(6);
  });

  it('moves 8 bolts together in one operation', () => {
    const f = resolveFrame(sequence, 1.0);
    expect(bolts.length).toBe(8);
    for (const b of bolts) expect(poseFor(f, b).translate[2]).toBeCloseTo(120);
  });

  it('keeps earlier removals applied at the end (accumulation)', () => {
    const f = resolveFrame(sequence, totalDuration(sequence));
    expect(poseFor(f, idOf('Cover_Plate')).translate[2]).toBeCloseTo(90);
    expect(poseFor(f, idOf('Cover_Gasket')).translate[2]).toBeCloseTo(70);
    expect(poseFor(f, idOf('Main_Shaft')).translate[2]).toBeCloseTo(-160);
    for (const b of bolts) expect(poseFor(f, b).translate[2]).toBeCloseTo(120);
  });

  it('leaves the housing untouched throughout', () => {
    for (const t of [0, 1.5, 3, 4.5, 6]) {
      expect(poseFor(resolveFrame(sequence, t), idOf('Housing_Body')).translate).toEqual([0, 0, 0]);
    }
  });

  it('scrubbing backward reproduces earlier frames exactly', () => {
    const forward = resolveFrame(sequence, 2.2);
    resolveFrame(sequence, 5.5);
    const back = resolveFrame(sequence, 2.2);
    expect(poseFor(back, idOf('Cover_Plate'))).toEqual(poseFor(forward, idOf('Cover_Plate')));
  });

  it('handles a 500-part scrub without pathological slowdown', () => {
    const many = Object.values(assembly.parts).map((p) => p.id);
    const big = {
      ...sequence,
      operations: [...sequence.operations, step('bulk', many, 200)],
    };
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) resolveFrame(big, (i / 200) * totalDuration(big));
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
  });
});
