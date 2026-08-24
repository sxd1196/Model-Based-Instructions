/**
 * Draft generation tests: planner steps -> real Operations that the REAL
 * evaluator animates correctly, with the user's authoring rules applied
 * (mover always highlighted, camera recuts only on region change, template
 * instructions, provenance meta).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildAssemblyFromScene, indexScene } from '@/cad/loadGltf';
import { makeDemoAssembly } from '@/cad/demo';
import { planSequence } from './peel';
import { collectPartGeoms } from './feasibility';
import { draftOperations } from './draft';
import { resolveFrame } from '@/domain/evaluate';
import { parseSequence, SCHEMA_VERSION } from '@/domain/schema';
import type { Sequence } from '@/domain/schema';

const { root, name } = makeDemoAssembly();
const { assembly, scene } = buildAssemblyFromScene(root as THREE.Group, 'demo://x', { name });
const index = indexScene(scene, assembly);
const geoms = collectPartGeoms(index);
const steps = planSequence(assembly, index);
const { operations, unplannedOpIds } = draftOperations(steps, assembly, geoms);

const seq: Sequence = {
  schemaVersion: SCHEMA_VERSION,
  id: 'draft-test',
  name: 'draft',
  intent: 'disassembly',
  assembly,
  operations,
  homeCamera: null,
  units: 'mm',
};

describe('draftOperations', () => {
  it('produces a schema-valid sequence', () => {
    expect(() => parseSequence(JSON.parse(JSON.stringify(seq)))).not.toThrow();
  });

  it('EVERY planned step highlights its movers (user rule)', () => {
    for (const op of operations) {
      if (op.meta.planUnplanned) continue;
      expect(op.styles).toHaveLength(1);
      expect(op.styles[0].mode).toBe('highlight');
      const tracked = op.tracks.flatMap((t) => t.parts).sort();
      expect([...op.styles[0].parts].sort()).toEqual(tracked);
    }
  });

  it('moves actually move through the real evaluator', () => {
    // End of step 1 (the bolts): every bolt mesh displaced, housing parked.
    const op1 = operations[0];
    const frame = resolveFrame(seq, op1.duration);
    for (const pid of op1.tracks.flatMap((t) => t.parts)) {
      const move = frame.poses.get(pid);
      expect(move).toBeDefined();
      const mag = Math.hypot(...move!.translate);
      expect(mag).toBeGreaterThan(10);
    }
    const housing = Object.values(assembly.parts).find((p) => p.name === 'Housing_Body');
    if (housing) {
      const hm = frame.poses.get(housing.id);
      expect(!hm || Math.hypot(...hm.translate) < 1e-6).toBe(true);
    }
  });

  it('bolt-circle rigidity survives drafting (parent-frame clusters)', () => {
    // The 8 bolts live in 8 different parent groups on a 58mm circle. If the
    // draft fed one world delta to all without frame math, they would scatter.
    const op1 = operations[0];
    const frame = resolveFrame(seq, op1.duration);
    const mags = op1.tracks.flatMap((t) => t.parts).map((pid) => {
      const m = frame.poses.get(pid)!;
      return Math.hypot(...m.translate);
    });
    const [min, max] = [Math.min(...mags), Math.max(...mags)];
    expect(max - min).toBeLessThan(1e-6); // identical travel magnitude = rigid batch
  });

  it('camera recuts on region change, holds otherwise', () => {
    const cams = operations.filter((o) => !o.meta.planUnplanned).map((o) => o.camera);
    expect(cams[0]).not.toBeNull(); // first step always frames
    // At least one later step holds the previous shot (null camera).
    expect(cams.slice(1).some((c) => c === null)).toBe(true);
  });

  it('instructions are template-honest and non-empty', () => {
    for (const op of operations) {
      expect(op.description.length).toBeGreaterThan(10);
      if (!op.meta.planUnplanned) expect(op.description).toMatch(/^Remove /);
    }
  });

  it('provenance meta on every drafted op; unplanned steps flagged', () => {
    for (const op of operations) {
      expect(op.meta.plannedBy).toBe('sequence-planner-v1');
      expect(op.meta.planReason!.length).toBeGreaterThan(5);
    }
    for (const id of unplannedOpIds) {
      const op = operations.find((o) => o.id === id)!;
      expect(op.meta.planUnplanned).toBe('true');
      expect(op.tracks).toHaveLength(0); // never guess motion
    }
  });

  it('5s/1s defaults on drafted steps', () => {
    for (const op of operations) {
      expect(op.duration).toBe(5);
      expect(op.dwell).toBe(1);
    }
  });
});
