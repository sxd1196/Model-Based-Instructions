/**
 * Project bundle tests.
 *
 * The behaviour under test is the one that reads as data loss: saving a
 * project and reopening it must restore the geometry, not just the steps.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  buildBundle,
  exportSceneToGlb,
  importGlbBuffer,
  isBundle,
  openProjectJson,
} from './bundle';
import { makeDemoAssembly } from '@/cad/demo';
import { buildAssemblyFromScene } from '@/cad/loadGltf';
import { emptySequence } from '@/state/store';
import { IDENTITY_QUAT, type Operation, type Sequence } from '@/domain/schema';

const { root, name } = makeDemoAssembly();
const { assembly } = buildAssemblyFromScene(root, 'demo://x', { name });

const idOf = (n: string) =>
  Object.values(assembly.parts).find((p) => p.name === n)!.id;

function sequenceWithStep(): Sequence {
  const part = idOf('Cover_Plate');
  const op: Operation = {
    id: 'op1', noteCorner: 'tl' as const, title: 'Lift cover', description: 'Straight up.',
    duration: 1.5, dwell: 0.4,
    tracks: [{
      id: 't1', parts: [part],
      from: { translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
      to: { translate: [0, 0, 90], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
      start: 0, end: 1, easing: 'easeInOut',
    }],
    camera: null, annotations: [], styles: [], meta: { torque: '12 Nm' },
  };
  return { ...emptySequence(assembly), name: 'Gearbox teardown', operations: [op] };
}

describe('base64 round trip', () => {
  it('survives a large buffer without blowing the stack', () => {
    // String.fromCharCode(...bytes) throws on ~100k+ args; CAD models are MBs.
    const big = new Uint8Array(2_000_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;

    const restored = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(big.buffer)));
    expect(restored.length).toBe(big.length);
    expect(restored[0]).toBe(big[0]);
    expect(restored[123_456]).toBe(big[123_456]);
    expect(restored[big.length - 1]).toBe(big[big.length - 1]);
  });

  it('handles an empty buffer', () => {
    expect(base64ToArrayBuffer(arrayBufferToBase64(new ArrayBuffer(0))).byteLength).toBe(0);
  });
});

describe('isBundle', () => {
  it('recognises a bundle', () => {
    expect(isBundle({ kind: 'assembly-studio-project', bundleVersion: 1 })).toBe(true);
  });

  it('rejects a bare sequence and junk', () => {
    expect(isBundle({ id: 's', operations: [] })).toBe(false);
    expect(isBundle(null)).toBe(false);
    expect(isBundle('nope')).toBe(false);
  });
});

describe('glTF export / import round trip', () => {
  it('exports a scene and reads it back with names intact', async () => {
    const buffer = await exportSceneToGlb(root);
    expect(buffer.byteLength).toBeGreaterThan(0);

    const scene = await importGlbBuffer(buffer);
    const names: string[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) names.push(o.name);
    });

    expect(names).toContain('Housing_Body');
    expect(names).toContain('Main_Shaft');
    expect(names.filter((n) => n.startsWith('Bolt_M8_')).length).toBeGreaterThan(0);
  }, 30_000);

  it('preserves the assembly hierarchy through the round trip', async () => {
    const scene = await importGlbBuffer(await exportSceneToGlb(root));
    const { assembly: restored } = buildAssemblyFromScene(scene, 'mem://x');
    expect(Object.values(restored.parts).some((p) => p.isGroup)).toBe(true);
    expect(Object.values(restored.parts).some((p) => p.parentId !== null)).toBe(true);
  }, 30_000);
});

describe('buildBundle / openProjectJson', () => {
  it('embeds geometry and restores it on open', async () => {
    // The core fix: save then reopen must not lose the model.
    const sequence = sequenceWithStep();
    const bundle = await buildBundle(sequence, root);

    expect(bundle.kind).toBe('assembly-studio-project');
    expect(bundle.modelGlb).toBeTruthy();

    const opened = await openProjectJson(JSON.parse(JSON.stringify(bundle)));
    expect(opened.scene).not.toBeNull();
    expect(opened.warnings).toHaveLength(0);

    let meshes = 0;
    opened.scene!.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    expect(meshes).toBeGreaterThan(20);
  }, 30_000);

  it('preserves the authored sequence exactly', async () => {
    const sequence = sequenceWithStep();
    const bundle = await buildBundle(sequence, root);
    const opened = await openProjectJson(JSON.parse(JSON.stringify(bundle)));

    expect(opened.sequence.name).toBe('Gearbox teardown');
    expect(opened.sequence.operations).toHaveLength(1);
    expect(opened.sequence.operations[0].tracks[0].to.translate[2]).toBeCloseTo(90);
    expect(opened.sequence.operations[0].meta.torque).toBe('12 Nm');
  }, 30_000);

  it('still saves when there is no scene, and says so on open', async () => {
    const bundle = await buildBundle(sequenceWithStep(), null);
    expect(bundle.modelGlb).toBeUndefined();

    const opened = await openProjectJson(bundle);
    expect(opened.scene).toBeNull();
    expect(opened.warnings[0]).toMatch(/without geometry/i);
  });

  it('opens a LEGACY bare-sequence file with a clear warning', async () => {
    // Projects saved before bundling must keep opening (AGENTS.md §2.7).
    const legacy = JSON.parse(JSON.stringify(sequenceWithStep()));
    const opened = await openProjectJson(legacy);

    expect(opened.sequence.operations).toHaveLength(1);
    expect(opened.scene).toBeNull();
    expect(opened.warnings[0]).toMatch(/no embedded geometry/i);
  });

  it('reports corrupt embedded geometry rather than failing silently', async () => {
    const bundle = await buildBundle(sequenceWithStep(), null);
    const opened = await openProjectJson({ ...bundle, modelGlb: 'bm90IGEgZ2xi' });
    expect(opened.sequence.operations).toHaveLength(1);
    expect(opened.scene).toBeNull();
    expect(opened.warnings[0]).toMatch(/could not be read/i);
  }, 30_000);

  it('rejects a malformed sequence inside an otherwise valid bundle', async () => {
    await expect(
      openProjectJson({
        kind: 'assembly-studio-project',
        bundleVersion: 1,
        sequence: { nope: true },
      }),
    ).rejects.toThrow();
  });
});
