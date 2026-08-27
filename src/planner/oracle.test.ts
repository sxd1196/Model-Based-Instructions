/**
 * Oracle sanity: the collision checker must convict a DELIBERATELY bad
 * animation and acquit a clean one. If these fail, no bake-off number can
 * be trusted — this is the "why would I believe you this time" test.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000 });
import * as THREE from 'three';
import { buildAssemblyFromScene, indexScene } from '@/cad/loadGltf';
import { evaluateSequenceCollisions } from './oracle';
import { SCHEMA_VERSION, type Sequence } from '@/domain/schema';

const mkScene = () => {
  const root = new THREE.Group();
  root.name = 'oracle-fixture';
  const geo = new THREE.BoxGeometry(40, 40, 40);
  const a = new THREE.Mesh(geo.clone(), new THREE.MeshStandardMaterial());
  a.name = 'Block_A';
  a.position.set(0, 0, 0);
  const b = new THREE.Mesh(geo.clone(), new THREE.MeshStandardMaterial());
  b.name = 'Block_B';
  b.position.set(100, 0, 0);
  root.add(a, b);
  return buildAssemblyFromScene(root, 'demo://oracle', { name: 'oracle-fixture' });
};

const mkSequence = (assembly: Sequence['assembly'], translate: [number, number, number]): Sequence => {
  const partA = Object.values(assembly.parts).find((p) => p.name === 'Block_A')!;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'seq', name: 'oracle', intent: 'disassembly', assembly,
    homeCamera: null, units: 'mm',
    operations: [{
      id: 'op1', title: 'move', description: '', noteCorner: 'tl',
      duration: 5, dwell: 1, camera: null, annotations: [], styles: [],
      meta: {}, section: null,
      tracks: [{
        id: 'tr1', parts: [partA.id],
        from: { translate: [0, 0, 0], rotate: [0, 0, 0, 1], pivot: [0, 0, 0] },
        to: { translate, rotate: [0, 0, 0, 1], pivot: [0, 0, 0] },
        start: 0, end: 1, easing: 'easeInOut',
      }],
    }],
  } as unknown as Sequence;
};

describe('collision oracle (independent checker)', () => {
  it('CONVICTS: driving Block_A straight through Block_B', () => {
    const { assembly, scene } = mkScene();
    const index = indexScene(scene, assembly);
    // A travels +200 in X: passes straight through B at x=100.
    const seq = mkSequence(assembly, [200, 0, 0]);
    const res = evaluateSequenceCollisions(seq, index, { frames: 40 });
    expect(res.violations.length).toBe(1);
    expect(res.violations[0].depthMm).toBeGreaterThan(10);
    const names = [res.violations[0].aName, res.violations[0].bName];
    expect(names).toContain('Block_A');
    expect(names).toContain('Block_B');
  });

  it('ACQUITS: moving Block_A cleanly away', () => {
    const { assembly, scene } = mkScene();
    const index = indexScene(scene, assembly);
    const seq = mkSequence(assembly, [-200, 0, 0]);
    const res = evaluateSequenceCollisions(seq, index, { frames: 40 });
    expect(res.violations).toEqual([]);
  });

  it('ACQUITS: a genuine near miss stays clean — and a sloppy one convicts', () => {
    const { assembly, scene } = mkScene();
    const index = indexScene(scene, assembly);
    // NOTE: the y-offset EASES IN with the motion, so [200,42,0] — my first
    // attempt at a 'near miss' — actually clips B's corner by 17mm mid-path
    // (y is only ~21 when x sweeps past B). The oracle caught my own bad
    // fixture: kept here as evidence the checker sees path interpolation,
    // not just endpoints. [200,150,0] keeps ≥5mm clearance the whole way.
    const clean = evaluateSequenceCollisions(mkSequence(assembly, [200, 150, 0]), index, { frames: 40 });
    expect(clean.violations).toEqual([]);
    const sloppy = evaluateSequenceCollisions(mkSequence(assembly, [200, 42, 0]), index, { frames: 40 });
    expect(sloppy.violations.length).toBe(1);
    expect(sloppy.violations[0].depthMm).toBeGreaterThan(10);
  });
});
