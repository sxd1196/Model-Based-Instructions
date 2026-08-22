/**
 * glTF loading + assembly-tree extraction.
 *
 * This module is where the single most dangerous failure mode in the whole
 * project lives: an exporter that MERGES the assembly into one mesh. If that
 * happens, individual parts cannot be moved and the app is useless. So we
 * detect it loudly at load time rather than letting you discover it after
 * authoring twenty operations.
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import * as THREE from 'three';
import type { Assembly, PartNode, Quat, Vec3 } from '@/domain/schema';

export interface LoadResult {
  scene: THREE.Group;
  assembly: Assembly;
  /** Non-fatal problems worth showing the user. */
  warnings: string[];
  stats: {
    meshCount: number;
    groupCount: number;
    triangleCount: number;
    /** Bounding box diagonal, model units. Used to auto-frame the camera. */
    diagonal: number;
    center: Vec3;
  };
}

/**
 * Heuristic threshold. A real multi-level CAD assembly essentially never
 * arrives as a single mesh; if it does, the export was flattened.
 */
const MERGED_MESH_TRIANGLE_THRESHOLD = 5000;

let loader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  if (loader) return loader;
  loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  loader.setDRACOLoader(draco);
  return loader;
}

/** Stable, collision-free id for every node, even when CAD names repeat. */
function assignIds(root: THREE.Object3D): Map<THREE.Object3D, string> {
  const ids = new Map<THREE.Object3D, string>();
  const used = new Set<string>();
  let counter = 0;

  root.traverse((obj) => {
    const base = (obj.name || 'node').replace(/\s+/g, '_');
    let id = base;
    // Deduplicate: CAD exports frequently repeat names for instanced fasteners.
    while (used.has(id)) id = `${base}__${counter++}`;
    used.add(id);
    ids.set(obj, id);
  });

  return ids;
}

function toVec3(v: THREE.Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

function toQuat(q: THREE.Quaternion): Quat {
  return [q.x, q.y, q.z, q.w];
}

export async function loadAssembly(
  url: string,
  opts: { name?: string; sourceFile?: string } = {},
): Promise<LoadResult> {
  const gltf = await getLoader().loadAsync(url);
  const scene = gltf.scene as THREE.Group;
  return buildAssemblyFromScene(scene, url, opts);
}

export function buildAssemblyFromScene(
  scene: THREE.Group,
  url: string,
  opts: { name?: string; sourceFile?: string } = {},
): LoadResult {
  const ids = assignIds(scene);
  const parts: Record<string, PartNode> = {};
  const warnings: string[] = [];

  let meshCount = 0;
  let groupCount = 0;
  let triangleCount = 0;
  let unnamed = 0;

  scene.traverse((obj) => {
    if (obj === scene) return;

    const id = ids.get(obj)!;
    const parent = obj.parent && obj.parent !== scene ? ids.get(obj.parent)! : null;
    const isMesh = (obj as THREE.Mesh).isMesh === true;

    if (isMesh) {
      meshCount++;
      const geom = (obj as THREE.Mesh).geometry;
      if (geom?.index) triangleCount += geom.index.count / 3;
      else if (geom?.attributes.position) triangleCount += geom.attributes.position.count / 3;
    } else {
      groupCount++;
    }

    if (!obj.name) unnamed++;

    parts[id] = {
      id,
      name: obj.name || `(unnamed ${isMesh ? 'mesh' : 'group'})`,
      parentId: parent,
      isGroup: !isMesh,
      restTranslate: toVec3(obj.position),
      restRotate: toQuat(obj.quaternion),
    };
  });

  // --- The merged-mesh check. This is the load-bearing validation. ---
  if (meshCount === 0) {
    warnings.push(
      'CRITICAL: no meshes found in this file. Nothing can be displayed or animated.',
    );
  } else if (meshCount === 1 && triangleCount > MERGED_MESH_TRIANGLE_THRESHOLD) {
    warnings.push(
      `CRITICAL: this file contains ONE merged mesh (${Math.round(triangleCount).toLocaleString()} triangles). ` +
        'Individual parts cannot be moved. Re-export from FreeCAD/CAD Assistant ' +
        'with each solid as a separate named object, and do NOT enable any ' +
        '"merge"/"join"/"single object" option.',
    );
  } else if (meshCount < 5 && triangleCount > MERGED_MESH_TRIANGLE_THRESHOLD) {
    warnings.push(
      `Only ${meshCount} meshes for ${Math.round(triangleCount).toLocaleString()} triangles. ` +
        'Sub-assemblies may have been flattened on export; check that each part is separate.',
    );
  }

  if (unnamed > 0) {
    warnings.push(
      `${unnamed} object(s) have no name. Named parts are strongly recommended — ` +
        'unnamed nodes get synthetic ids that change if the CAD is re-exported, ' +
        'which will break saved sequences.',
    );
  }

  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const diagonal = size.length();

  if (!Number.isFinite(diagonal) || diagonal === 0) {
    warnings.push('Model bounding box is empty or invalid; camera framing may be wrong.');
  }

  return {
    scene,
    assembly: {
      id: crypto.randomUUID(),
      name: opts.name ?? 'Assembly',
      sourceFile: opts.sourceFile ?? '',
      modelUrl: url,
      parts,
    },
    warnings,
    stats: {
      meshCount,
      groupCount,
      triangleCount: Math.round(triangleCount),
      diagonal,
      center: toVec3(center),
    },
  };
}

/** Index the live three.js scene by part id so the viewer can pose parts O(1). */
export function indexScene(
  scene: THREE.Object3D,
  assembly: Assembly,
): Map<string, THREE.Object3D> {
  const byName = new Map<string, THREE.Object3D[]>();
  scene.traverse((obj) => {
    const list = byName.get(obj.name) ?? [];
    list.push(obj);
    byName.set(obj.name, list);
  });

  const out = new Map<string, THREE.Object3D>();
  const consumed = new Map<string, number>();

  for (const part of Object.values(assembly.parts)) {
    const candidates = byName.get(part.name) ?? byName.get(part.id);
    if (!candidates?.length) continue;
    const i = consumed.get(part.name) ?? 0;
    const obj = candidates[Math.min(i, candidates.length - 1)];
    consumed.set(part.name, i + 1);
    out.set(part.id, obj);
  }

  return out;
}
