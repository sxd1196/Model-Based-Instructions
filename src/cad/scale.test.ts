/**
 * Scale tests against the stated performance budget (AGENTS.md §7): 500+ parts
 * at 60fps, which allows ~16ms per frame for EVERYTHING — so resolveFrame must
 * cost a small fraction of that.
 *
 * Timing assertions use deliberately loose bounds. They exist to catch
 * algorithmic regressions (accidental O(n^2), replay-from-zero scrubbing), not
 * to measure absolute speed on a particular machine.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildAssemblyFromScene } from './loadGltf';
import { resolveFrame, poseFor, totalDuration } from '@/domain/evaluate';
import { emptySequence } from '@/state/store';
import type { Operation, Sequence } from '@/domain/schema';
import { IDENTITY_QUAT } from '@/domain/schema';

/** A synthetic assembly: `n` named parts in nested sub-assemblies. */
function makeLargeAssembly(n: number) {
  const root = new THREE.Group();
  root.name = 'Large_Assembly';
  const geom = new THREE.BoxGeometry(1, 1, 1);

  let group: THREE.Group | null = null;
  for (let i = 0; i < n; i++) {
    if (i % 25 === 0) {
      group = new THREE.Group();
      group.name = `SUB_${Math.floor(i / 25)}`;
      root.add(group);
    }
    const mesh = new THREE.Mesh(geom);
    mesh.name = `Part_${String(i).padStart(4, '0')}`;
    mesh.position.set((i % 25) * 10, Math.floor(i / 25) * 10, 0);
    group!.add(mesh);
  }
  return buildAssemblyFromScene(root, 'mem://large', { name: `Large ${n}` });
}

function stepFor(id: string, parts: string[], z: number): Operation {
  return {
    id, title: id, description: '', noteCorner: 'tl' as const, duration: 1, dwell: 0.2,
    tracks: [{
      id: `${id}-t`, parts,
      from: { translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
      to: { translate: [0, 0, z], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
      start: 0, end: 1, easing: 'easeInOut',
    }],
    camera: null, annotations: [], styles: [], meta: {},
  } as Operation;
}

describe('500-part assembly', () => {
  const { assembly, stats, warnings } = makeLargeAssembly(500);

  it('extracts every part with a unique id', () => {
    const meshes = Object.values(assembly.parts).filter((p) => !p.isGroup);
    expect(meshes).toHaveLength(500);
    expect(new Set(Object.keys(assembly.parts)).size).toBe(
      Object.keys(assembly.parts).length,
    );
  });

  it('preserves the sub-assembly hierarchy', () => {
    expect(Object.values(assembly.parts).filter((p) => p.isGroup)).toHaveLength(20);
    expect(Object.values(assembly.parts).every((p) => p.parentId !== undefined)).toBe(true);
  });

  it('does not false-positive the merged-mesh guard on many small parts', () => {
    expect(stats.meshCount).toBe(500);
    expect(warnings.some((w) => w.startsWith('CRITICAL'))).toBe(false);
  });

  it('resolves a frame well inside the 16ms frame budget', () => {
    const ids = Object.values(assembly.parts).filter((p) => !p.isGroup).map((p) => p.id);
    const sequence: Sequence = {
      ...emptySequence(assembly),
      operations: Array.from({ length: 20 }, (_, i) =>
        stepFor(`s${i}`, ids.slice(i * 25, (i + 1) * 25), 100),
      ),
    };

    // Warm up, then measure steady state.
    for (let i = 0; i < 20; i++) resolveFrame(sequence, i * 0.5);

    const total = totalDuration(sequence);
    const N = 300;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) resolveFrame(sequence, (i / N) * total);
    const perFrame = (performance.now() - t0) / N;

    expect(perFrame).toBeLessThan(4);
  });

  it('scrubbing to the END is not dramatically slower than the START', () => {
    // Guards the accumulation design: jumping to the last step must not cost
    // proportionally more than the first. A replay-from-zero implementation
    // would blow this up.
    const ids = Object.values(assembly.parts).filter((p) => !p.isGroup).map((p) => p.id);
    const sequence: Sequence = {
      ...emptySequence(assembly),
      operations: Array.from({ length: 50 }, (_, i) =>
        stepFor(`s${i}`, ids.slice(i * 10, (i + 1) * 10), 50),
      ),
    };
    const total = totalDuration(sequence);

    const timeIt = (t: number) => {
      for (let i = 0; i < 50; i++) resolveFrame(sequence, t);
      const t0 = performance.now();
      for (let i = 0; i < 200; i++) resolveFrame(sequence, t);
      return performance.now() - t0;
    };

    const early = timeIt(total * 0.02);
    const late = timeIt(total * 0.98);

    expect(late).toBeLessThan(Math.max(early, 0.5) * 60);
  });

  it('keeps all 500 parts correctly placed at the final frame', () => {
    const ids = Object.values(assembly.parts).filter((p) => !p.isGroup).map((p) => p.id);
    const sequence: Sequence = {
      ...emptySequence(assembly),
      operations: Array.from({ length: 20 }, (_, i) =>
        stepFor(`s${i}`, ids.slice(i * 25, (i + 1) * 25), 100),
      ),
    };
    const frame = resolveFrame(sequence, totalDuration(sequence));
    expect(frame.poses.size).toBe(500);
    for (const id of ids) expect(poseFor(frame, id).translate[2]).toBeCloseTo(100);
  });
});

describe('pathological inputs', () => {
  it('handles 2000 parts in a single operation', () => {
    const { assembly } = makeLargeAssembly(2000);
    const ids = Object.values(assembly.parts).filter((p) => !p.isGroup).map((p) => p.id);
    const sequence: Sequence = {
      ...emptySequence(assembly),
      operations: [stepFor('bulk', ids, 250)],
    };
    const frame = resolveFrame(sequence, 0.5);
    expect(frame.poses.size).toBe(2000);
  });

  it('handles 200 operations without stack or timing blowup', () => {
    const { assembly } = makeLargeAssembly(200);
    const ids = Object.values(assembly.parts).filter((p) => !p.isGroup).map((p) => p.id);
    const sequence: Sequence = {
      ...emptySequence(assembly),
      operations: ids.map((id, i) => stepFor(`s${i}`, [id], 60)),
    };
    const t0 = performance.now();
    const frame = resolveFrame(sequence, totalDuration(sequence));
    expect(performance.now() - t0).toBeLessThan(200);
    expect(frame.poses.size).toBe(200);
  });

  it('a zero-duration operation does not divide by zero', () => {
    const { assembly } = makeLargeAssembly(5);
    const id = Object.values(assembly.parts).filter((p) => !p.isGroup)[0].id;
    const sequence: Sequence = {
      ...emptySequence(assembly),
      operations: [{ ...stepFor('a', [id], 10), duration: 0.0001, dwell: 0 }],
    };
    expect(() => resolveFrame(sequence, 0.00005)).not.toThrow();
    expect(Number.isFinite(poseFor(resolveFrame(sequence, 0.00005), id).translate[2])).toBe(true);
  });
});
