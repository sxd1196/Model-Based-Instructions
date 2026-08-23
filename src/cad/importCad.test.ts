/**
 * STEP import tests.
 *
 * Runs the REAL OpenCascade WASM module against a generated fixture — no
 * mocks, because the thing worth verifying is that OCCT actually preserves
 * separate named solids. Regenerate the fixture with:
 *
 *   node scripts/make-step-fixture.mjs > src/cad/fixtures/two_boxes.step
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { describeFile, importCadFile } from './importCad';
import { buildAssemblyFromScene, indexScene } from './loadGltf';

const fixture = () => {
  const buf = readFileSync(join(process.cwd(), 'src/cad/fixtures/two_boxes.step'));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

describe('describeFile', () => {
  it('accepts STEP in both spellings', () => {
    expect(describeFile('part.step').supported).toBe(true);
    expect(describeFile('PART.STP').supported).toBe(true);
  });

  it('accepts IGES, BREP and glTF', () => {
    for (const f of ['a.iges', 'a.igs', 'a.brep', 'a.glb', 'a.gltf']) {
      expect(describeFile(f).supported).toBe(true);
    }
  });

  it('rejects SolidWorks with an ACTIONABLE message', () => {
    // Being honest about this matters more than appearing capable: the format
    // is closed and no open-source reader exists.
    const r = describeFile('gearbox.SLDASM');
    expect(r.supported).toBe(false);
    expect(r.message).toMatch(/STEP AP242/);
    expect(r.message).toMatch(/File → Save As/);
  });

  it('rejects Inventor and Fusion with export instructions', () => {
    expect(describeFile('a.iam').message).toMatch(/STEP/);
    expect(describeFile('a.f3d').message).toMatch(/STEP/);
  });

  it('names the supported formats for an unknown extension', () => {
    expect(describeFile('notes.txt').message).toMatch(/\.step/);
  });
});

describe('importCadFile (real OpenCascade WASM)', () => {
  it('parses a STEP file into separate named meshes', async () => {
    const result = await importCadFile(fixture(), 'two_boxes.step');

    const meshes: THREE.Mesh[] = [];
    result.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });

    expect(meshes).toHaveLength(2);
    expect(meshes.map((m) => m.name).sort()).toEqual(['BlockA', 'BlockB']);
  }, 30_000);

  it('does NOT merge solids into one mesh', async () => {
    // The failure mode the whole app guards against.
    const result = await importCadFile(fixture(), 'two_boxes.step');
    expect(result.meshCount).toBe(2);
  }, 30_000);

  it('produces real triangles with normals', async () => {
    const result = await importCadFile(fixture(), 'two_boxes.step');
    expect(result.triangleCount).toBeGreaterThan(0);

    let checked = 0;
    result.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      expect(m.geometry.attributes.position.count).toBeGreaterThan(0);
      expect(m.geometry.attributes.normal).toBeDefined();
      checked++;
    });
    expect(checked).toBe(2);
  }, 30_000);

  it('geometry has sane dimensions in mm', async () => {
    const result = await importCadFile(fixture(), 'two_boxes.step');
    const box = new THREE.Box3().setFromObject(result.scene);
    const size = box.getSize(new THREE.Vector3());
    // BlockA is 50x40x30 at origin, BlockB is 20mm at x=80 => 100mm overall.
    expect(size.x).toBeCloseTo(100, 0);
    expect(size.y).toBeCloseTo(40, 0);
    expect(size.z).toBeCloseTo(30, 0);
  }, 30_000);

  it('feeds straight into the existing assembly extractor', async () => {
    // The real integration point: STEP import must produce a scene the rest
    // of the app treats identically to a glTF import.
    const result = await importCadFile(fixture(), 'two_boxes.step');
    const { assembly, warnings } = buildAssemblyFromScene(
      result.scene as THREE.Group, 'mem://step', { name: 'Two boxes' },
    );

    const names = Object.values(assembly.parts).map((p) => p.name);
    expect(names).toContain('BlockA');
    expect(names).toContain('BlockB');
    expect(warnings.some((w) => w.startsWith('CRITICAL'))).toBe(false);
  }, 30_000);

  it('rejects a SolidWorks file before touching the parser', async () => {
    await expect(importCadFile(new ArrayBuffer(8), 'x.sldasm')).rejects.toThrow(/SolidWorks/);
  });

  it('reports a useful error for a corrupt STEP file', async () => {
    const junk = new TextEncoder().encode('this is not a step file').buffer;
    await expect(importCadFile(junk, 'bad.step')).rejects.toThrow(/OpenCascade|AP214|AP242/);
  }, 30_000);
});

describe('instanced parts with duplicate names (real CAD pattern)', () => {
  // Two identical components arrive with IDENTICAL names (e.g. two
  // "faucet_handle_standard_handle" instances). Without deduplication,
  // name-based scene lookup is ambiguous: clicking the second instance
  // highlighted the first, and the tree showed indistinguishable rows.
  const dupes = () => {
    const buf = readFileSync(join(process.cwd(), 'src/cad/fixtures/two_dupes.step'));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };

  it('suffixes duplicate names so each instance is unique', async () => {
    const result = await importCadFile(dupes(), 'two_dupes.step');
    const names: string[] = [];
    result.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) names.push(o.name);
    });
    expect(names.sort()).toEqual(['Widget', 'Widget_2']);
  }, 30_000);

  it('every part maps to its OWN scene object (selection is unambiguous)', async () => {
    const result = await importCadFile(dupes(), 'two_dupes.step');
    const { assembly } = buildAssemblyFromScene(
      result.scene as THREE.Group, 'mem://dupes', { name: 'Dupes' },
    );
    const index = indexScene(result.scene, assembly);

    const meshParts = Object.values(assembly.parts).filter((p) => !p.isGroup);
    const objects = meshParts.map((p) => index.get(p.id));
    expect(objects.every(Boolean)).toBe(true);
    // The old bug: both ids resolved to the SAME object.
    expect(new Set(objects).size).toBe(meshParts.length);
  }, 30_000);

  it('collapses OCCT single-mesh wrapper nodes (no doubled tree rows)', async () => {
    // OCCT wraps each solid in a node named identically to its mesh; without
    // collapsing, every part shows twice in the assembly tree.
    const result = await importCadFile(dupes(), 'two_dupes.step');

    let groups = 0;
    let meshes = 0;
    result.scene.traverse((o) => {
      if (o === result.scene) return;
      if ((o as THREE.Mesh).isMesh) meshes++;
      else groups++;
    });
    expect(meshes).toBe(2);
    // The only surviving group (if any) is a real container, not a wrapper.
    expect(groups).toBeLessThanOrEqual(1);
  }, 30_000);
});
