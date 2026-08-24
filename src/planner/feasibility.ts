/**
 * The feasibility kernel: which parts can be removed, and along which axis?
 *
 * This is the load-bearing function of the sequence planner. For a candidate
 * part (or rigid group of parts), we ask: can it sweep along one of the six
 * canonical directions all the way out of the assembly without hitting the
 * parts that remain? If yes, it is removable NOW — and in reversed
 * (assembly) order it was installed LAST.
 *
 * Implementation: sampled sweep with two phases per sample —
 *   broad:  AABB overlap (cheap, rejects most pairs)
 *   narrow: triangle-accurate intersection via three-mesh-bvh
 * The BVH per geometry is built once and cached. No allocations in the
 * sample loop beyond three scratch matrices.
 *
 * Honest limits (documented, not hidden): rigid canonical-axis sweeps only —
 * no rotation-to-extract (threaded parts "unscrew" is approximated by their
 * axial slide), no compound paths, and tessellation noise can make touching
 * faces read as collisions; the CLEARANCE epsilon absorbs normal contact.
 */
import * as THREE from 'three';
import { computeBoundsTree, acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';

// Register BVH acceleration once.
(THREE.BufferGeometry.prototype as unknown as { computeBoundsTree?: unknown }).computeBoundsTree ||= computeBoundsTree;
(THREE.Mesh.prototype as unknown as { raycast?: unknown }).raycast = acceleratedRaycast;

export type Dir = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export const DIR_VEC: Record<Dir, THREE.Vector3> = {
  '+X': new THREE.Vector3(1, 0, 0),
  '-X': new THREE.Vector3(-1, 0, 0),
  '+Y': new THREE.Vector3(0, 1, 0),
  '-Y': new THREE.Vector3(0, -1, 0),
  '+Z': new THREE.Vector3(0, 0, 1),
  '-Z': new THREE.Vector3(0, 0, -1),
};

/** Preference order: gravity-up first, lateral, then down. */
export const DIR_ORDER: Dir[] = ['+Z', '+X', '-X', '+Y', '-Y', '-Z'];

export interface PartGeom {
  id: string;
  mesh: THREE.Mesh;
  /** World-space AABB at rest. */
  aabb: THREE.Box3;
  volume: number;
  /** Rounded geometry signature for identical-part batching. */
  signature: string;
}

const _bvhCache = new WeakMap<THREE.BufferGeometry, MeshBVH>();
function bvhOf(geom: THREE.BufferGeometry): MeshBVH {
  let bvh = _bvhCache.get(geom);
  if (!bvh) {
    bvh = new MeshBVH(geom);
    _bvhCache.set(geom, bvh);
  }
  return bvh;
}

/** Collect world-space geometry records for every part mesh. */
export function collectPartGeoms(index: Map<string, THREE.Object3D>): Map<string, PartGeom> {
  const out = new Map<string, PartGeom>();
  for (const [id, obj] of index) {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) continue;
    mesh.updateWorldMatrix(true, false);
    const aabb = new THREE.Box3().setFromObject(mesh);
    const size = aabb.getSize(new THREE.Vector3());
    const volume = Math.max(size.x * size.y * size.z, 1e-9);
    // Signature: quantized dimensions + triangle count. Deliberately loose —
    // it batches "the 8 identical bolts", not exact-geometry equality.
    const tris = (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
    const q = (n: number) => Math.round(n * 10) / 10;
    const signature = `${q(size.x)}x${q(size.y)}x${q(size.z)}:${tris}`;
    out.set(id, { id, mesh, aabb, volume, signature });
  }
  return out;
}

const _matA = new THREE.Matrix4();
const _matRel = new THREE.Matrix4();
const _shifted = new THREE.Box3();
const _inv = new THREE.Matrix4();

/**
 * Does `moving` (offset by `offset` world units) intersect `fixed`?
 * Narrow-phase triangle test in the fixed mesh's local frame.
 */
function intersectsAt(moving: PartGeom, offset: THREE.Vector3, fixed: PartGeom): boolean {
  // Broad phase: shifted AABB vs AABB, with a tiny shrink so resting
  // face-to-face contact does not count as a collision.
  _shifted.copy(moving.aabb).translate(offset);
  _shifted.expandByScalar(-CONTACT_EPS);
  if (!_shifted.intersectsBox(fixed.aabb)) return false;

  // Narrow phase: BVH intersect. Transform: moving-local -> world -> +offset
  // -> fixed-local.
  moving.mesh.updateWorldMatrix(true, false);
  fixed.mesh.updateWorldMatrix(true, false);
  _matA.copy(moving.mesh.matrixWorld);
  _matA.premultiply(new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z));
  _inv.copy(fixed.mesh.matrixWorld).invert();
  _matRel.multiplyMatrices(_inv, _matA);

  return bvhOf(fixed.mesh.geometry as THREE.BufferGeometry).intersectsGeometry(
    moving.mesh.geometry as THREE.BufferGeometry,
    _matRel,
  );
}

/** Contact epsilon in mm: face-on-face assembly contact must not read as a crash. */
const CONTACT_EPS = 0.25;
/** Sweep sampling density: samples per part-bbox-length of travel. */
const SAMPLES_PER_LENGTH = 4;

export interface SweepResult {
  ok: boolean;
  /** First blocking part id when !ok — feeds the step "reason" and debugging. */
  blockedBy?: string;
}

const _zero = new THREE.Vector3();

/**
 * Pairs that already intersect at REST are excluded from sweep blocking.
 *
 * Real CAD interpenetrates on purpose: threads aren't modeled (bolt shank
 * vs hole), gaskets are drawn compressed, press-fits overlap. Treating rest
 * contact as a collision would make everything unremovable. This is the
 * standard blocking-graph construction (Wilson): only NEW contact blocks.
 * Cost: a false "free" is possible through an ignored pair — acceptable for
 * a DRAFT the human reviews, and cheaper than exact thread modelling.
 */
function restIntersecting(a: PartGeom, b: PartGeom): boolean {
  return intersectsAt(a, _zero, b);
}

const _restPairs = new WeakMap<PartGeom, Set<string>>();
function ignoredPartners(g: PartGeom, all: Map<string, PartGeom>): Set<string> {
  let set = _restPairs.get(g);
  if (!set) {
    set = new Set();
    for (const [oid, other] of all) {
      if (oid !== g.id && restIntersecting(g, other)) set.add(oid);
    }
    _restPairs.set(g, set);
  }
  return set;
}

/**
 * Can `movingIds` (as one rigid unit) sweep along `dir` until fully clear of
 * the AABB of everything remaining?
 */
export function canSweepOut(
  movingIds: string[],
  dir: Dir,
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
): SweepResult {
  const moving = movingIds.map((id) => geoms.get(id)!).filter(Boolean);
  if (!moving.length) return { ok: false };

  const movingSet = new Set(movingIds);
  const fixed: PartGeom[] = [];
  const restBox = new THREE.Box3();
  for (const [id, g] of remaining) {
    if (movingSet.has(id)) continue;
    fixed.push(g);
    restBox.union(g.aabb);
  }
  if (!fixed.length) return { ok: true };

  // Travel distance: enough that the moving unit's box fully clears the
  // remaining assembly's box along dir.
  const unitBox = new THREE.Box3();
  for (const g of moving) unitBox.union(g.aabb);
  const v = DIR_VEC[dir];
  const axis = v.x !== 0 ? 'x' : v.y !== 0 ? 'y' : 'z';
  const travel =
    v[axis] > 0
      ? restBox.max[axis] - unitBox.min[axis]
      : unitBox.max[axis] - restBox.min[axis];
  if (travel <= 0) return { ok: true }; // already clear

  const unitLen = Math.max(unitBox.max[axis] - unitBox.min[axis], 1);
  const samples = Math.max(3, Math.ceil((travel / unitLen) * SAMPLES_PER_LENGTH));

  const offset = new THREE.Vector3();
  for (let s = 1; s <= samples; s++) {
    const d = (travel * s) / samples;
    offset.copy(v).multiplyScalar(d);
    for (const m of moving) {
      const ignored = ignoredPartners(m, geoms);
      for (const f of fixed) {
        if (ignored.has(f.id)) continue; // rest contact: threads/gasket/press-fit
        if (intersectsAt(m, offset, f)) return { ok: false, blockedBy: f.id };
      }
    }
  }
  return { ok: true };
}

/**
 * All feasible removal directions for a unit, in preference order.
 * Returns [] when the unit is currently blocked in all six directions.
 */
export function feasibleDirections(
  movingIds: string[],
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
): { dir: Dir; blockedBy?: string }[] {
  const out: { dir: Dir }[] = [];
  for (const dir of DIR_ORDER) {
    if (canSweepOut(movingIds, dir, remaining, geoms).ok) out.push({ dir });
  }
  return out;
}

/** Removal travel for authoring: clear the assembly plus a readable margin. */
export function removalDistance(
  movingIds: string[],
  dir: Dir,
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
): number {
  const movingSet = new Set(movingIds);
  const restBox = new THREE.Box3();
  let any = false;
  for (const [id, g] of remaining) {
    if (movingSet.has(id)) continue;
    restBox.union(g.aabb);
    any = true;
  }
  const unitBox = new THREE.Box3();
  for (const id of movingIds) {
    const g = geoms.get(id);
    if (g) unitBox.union(g.aabb);
  }
  const v = DIR_VEC[dir];
  const axis = v.x !== 0 ? 'x' : v.y !== 0 ? 'y' : 'z';
  const unitLen = Math.max(unitBox.max[axis] - unitBox.min[axis], 5);
  if (!any) return unitLen * 1.5;
  const travel =
    v[axis] > 0
      ? restBox.max[axis] - unitBox.min[axis]
      : unitBox.max[axis] - restBox.min[axis];
  return Math.max(travel, 0) + unitLen * 0.75;
}
