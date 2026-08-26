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

    /**
     * PLANNING PROXY: collision math runs on a decimated copy, not the
     * render mesh. Dense STEP tessellation (the faucet is ~100k tris/part)
     * made narrow-phase sweeps cost MINUTES; vertex-cluster decimation to a
     * ~1.2mm grid keeps planning-relevant shape (holes, bosses, walls) and
     * cuts tests to milliseconds. The render mesh is untouched — only the
     * planner sees the proxy. Grid size trades fidelity for speed; features
     * thinner than ~1.2mm can be missed, acceptable for a reviewed DRAFT.
     */
    const planMesh = (() => {
      if (tris <= 8000) return mesh;
      // Cell is WORLD mm; convert to local units via the mesh's world scale.
      const ws = new THREE.Vector3();
      mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), ws);
      const localCell = 1.2 / (Math.abs(ws.x) || 1);
      const m = new THREE.Mesh(
        decimateByClustering(mesh.geometry as THREE.BufferGeometry, localCell),
        mesh.material,
      );
      return m;
    })();
    if (planMesh !== mesh) {
      planMesh.matrixWorld.copy(mesh.matrixWorld);
      planMesh.matrixAutoUpdate = false;
      planMesh.updateWorldMatrix = (() => void 0) as typeof mesh.updateWorldMatrix;
    }

    out.set(id, { id, mesh: planMesh, aabb, volume, signature });
  }
  return out;
}

/**
 * Vertex-clustering decimation: snap vertices to a world-`cell`-sized grid,
 * merge, drop degenerate triangles. O(n), no dependency, quality is plenty
 * for sweep collision (this is a proxy, not a render mesh).
 */
function decimateByClustering(geom: THREE.BufferGeometry, cell: number): THREE.BufferGeometry {
  const pos = geom.attributes.position;
  const idx = geom.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;

  const keyOf = (x: number, y: number, z: number) =>
    `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;

  const clusterIndex = new Map<string, number>();
  const clustered: number[] = [];
  const remap = new Uint32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = keyOf(x, y, z);
    let ci = clusterIndex.get(key);
    if (ci === undefined) {
      ci = clustered.length / 3;
      clusterIndex.set(key, ci);
      clustered.push(x, y, z);
    }
    remap[i] = ci;
  }

  const newIdx: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const a = remap[idx ? idx.getX(t * 3) : t * 3];
    const b = remap[idx ? idx.getX(t * 3 + 1) : t * 3 + 1];
    const c = remap[idx ? idx.getX(t * 3 + 2) : t * 3 + 2];
    if (a !== b && b !== c && a !== c) newIdx.push(a, b, c);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(clustered, 3));
  out.setIndex(newIdx);
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
/**
 * Hard cap on distance between sweep samples (mm). Without it, sample count
 * scales off the MOVER's size, and a long part hops over thin walls between
 * samples (tunneling) — the v1 "parts pass through each other" bug, cause #3.
 */
const MAX_SAMPLE_STEP = 2.5;

export interface SweepResult {
  ok: boolean;
  /** First blocking part id when !ok — feeds the step "reason" and debugging. */
  blockedBy?: string;
}

const _zero = new THREE.Vector3();

/**
 * Penetration DEPTH between two parts (mm): max distance-inside-the-fixed-mesh
 * over sample points of the moving geometry.
 *
 * CRITICAL: points are sampled ALONG EDGES, not just at vertices. CAD
 * tessellation puts vertices only where curvature demands them — a cylinder
 * has vertices at its end rings ONLY, so a shank passing through a thin part
 * mid-length has NO vertex inside it and vertex sampling reads depth 0 at
 * rest but >0 mid-sweep, wrongly blocking legal extractions (found on the
 * gearbox gasket). Edge walking at ≤2.5mm spacing closes those gaps.
 */
function penetrationDepth(moving: PartGeom, offset: THREE.Vector3, fixed: PartGeom, stopAbove = Infinity, probeBudget = 2500): number {
  _shifted.copy(moving.aabb).translate(offset);
  if (!_shifted.intersectsBox(fixed.aabb)) return 0;

  moving.mesh.updateWorldMatrix(true, false);
  fixed.mesh.updateWorldMatrix(true, false);
  _matA.copy(moving.mesh.matrixWorld);
  _matA.premultiply(new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z));
  _inv.copy(fixed.mesh.matrixWorld).invert();
  _matRel.multiplyMatrices(_inv, _matA);

  const bvh = bvhOf(fixed.mesh.geometry as THREE.BufferGeometry);
  const geom = moving.mesh.geometry as THREE.BufferGeometry;
  const pos = geom.attributes.position;
  const idx = geom.index;
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const scale = new THREE.Vector3();
  fixed.mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  const su = Math.abs(scale.x) || 1;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const p = new THREE.Vector3();
  const inside = (pt: THREE.Vector3): number => {
    const hits = bvh.raycast(new THREE.Ray(pt, _px), THREE.DoubleSide);
    if (hits.length % 2 === 0) return 0;
    bvh.closestPointToPoint(pt, target);
    return target.distance * su;
  };

  let worst = 0;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const triStride = Math.max(1, Math.floor(triCount / 400)); // ≤400 tris probed
  const stepLocal = MAX_SAMPLE_STEP / su; // ≤2.5mm world spacing on edges

  // Probe budget, spread across the WHOLE mesh (front-biased truncation
  // skews results): estimate probes per edge from stepLocal, then widen the
  // tri stride so expected total stays ~2500. Dense STEP tessellation
  // (faucet ~100k tris) cost minutes unbounded; this keeps calls ~ms.
  const est = Math.max(1, Math.min(12, Math.round(4 / stepLocal)));
  const budgetStride = Math.max(triStride, Math.ceil((triCount * 3 * (est + 1)) / probeBudget));
  for (let t = 0; t < triCount; t += budgetStride) {
    for (let e = 0; e < 3; e++) {
      const i0 = idx ? idx.getX(t * 3 + e) : t * 3 + e;
      const i1 = idx ? idx.getX(t * 3 + ((e + 1) % 3)) : t * 3 + ((e + 1) % 3);
      a.fromBufferAttribute(pos, i0).applyMatrix4(_matRel);
      b.fromBufferAttribute(pos, i1).applyMatrix4(_matRel);
      const len = a.distanceTo(b);
      const n = Math.min(Math.max(1, Math.ceil(len / stepLocal)), 24);
      for (let s = 0; s <= n; s++) {
        p.lerpVectors(a, b, s / n);
        const d = inside(p);
        if (d > worst) worst = d;
        // Early exit: caller only needs 'over budget or not' — deep plows
        // (the common block) resolve in a handful of probes instead of a
        // full-mesh scan. THE fix that took the faucet from 261s to seconds.
        if (worst > stopAbove) return worst;
      }
    }
  }
  return worst;
}
const _px = new THREE.Vector3(1, 0, 0);

/**
 * Rest-contact record for a touching/overlapping pair: its baseline
 * penetration budget, and the contact normal (unit vector pointing AWAY
 * from the fixed part at the closest approach — the "push-out" direction).
 */
interface RestContact {
  depth: number;
  normal: THREE.Vector3;
}

const _restContacts = new Map<string, RestContact | null>();
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Baseline the rest relationship of a pair: null when far apart; otherwise
 * the penetration budget (0 for clean touch) and the contact normal.
 *
 * v1's fatal flaw was making rest-intersecting pairs invisible FOREVER, in
 * every direction — parts could plow straight through their neighbours.
 * v2 keeps a BUDGET: during a sweep the pair only blocks when penetration
 * EXCEEDS its rest depth (+tolerance). Sliding out of a hole stays legal;
 * sliding deeper INTO the neighbour is a collision from the first sample.
 */
function restContactOf(a: PartGeom, b: PartGeom): RestContact | null {
  const key = pairKey(a.id, b.id);
  const hit = _restContacts.get(key);
  if (hit !== undefined) return hit;

  // Proximity gate: AABBs inflated by 2mm must overlap to bother.
  _shifted.copy(a.aabb).expandByScalar(2);
  if (!_shifted.intersectsBox(b.aabb)) {
    _restContacts.set(key, null);
    return null;
  }

  const depth = penetrationDepth(a, _zero, b);
  const touching = depth > 0 || intersectsAt(a, _zero, b);

  // Contact normal via closest points between the two meshes, computed from
  // a's sampled vertices against b's BVH: normal points from b's surface
  // toward a — the direction a must move to separate.
  a.mesh.updateWorldMatrix(true, false);
  b.mesh.updateWorldMatrix(true, false);
  _matA.copy(a.mesh.matrixWorld);
  _inv.copy(b.mesh.matrixWorld).invert();
  _matRel.multiplyMatrices(_inv, _matA);
  const bvh = bvhOf(b.mesh.geometry as THREE.BufferGeometry);
  const pos = (a.mesh.geometry as THREE.BufferGeometry).attributes.position;
  const v = new THREE.Vector3();
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  let best = Infinity;
  const bestPoint = new THREE.Vector3();
  const bestSurface = new THREE.Vector3();
  const stride = Math.max(1, Math.floor(pos.count / 200));
  for (let i = 0; i < pos.count; i += stride) {
    v.fromBufferAttribute(pos, i).applyMatrix4(_matRel);
    bvh.closestPointToPoint(v, target);
    if (target.distance < best) {
      best = target.distance;
      bestPoint.copy(v);
      bestSurface.copy(target.point);
    }
  }

  // Only meaningful when the pair is actually close (< 1.5mm) or touching.
  if (!touching && best * 1 /* local≈world for uniform scale */ > 1.5) {
    _restContacts.set(key, null);
    return null;
  }

  // b-local -> world direction from surface point to a's vertex.
  const normal = bestPoint.sub(bestSurface);
  normal.applyMatrix4(new THREE.Matrix4().extractRotation(b.mesh.matrixWorld));
  if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1);
  normal.normalize();

  const rec: RestContact = { depth, normal };
  _restContacts.set(key, rec);
  return rec;
}

export const __dbgPenetration = penetrationDepth;

/** Clear cached rest contacts (fresh model). */
export function resetContactCache(): void {
  _restContacts.clear();
}

/**
 * The aggregate "push-out" vector for a unit: sum of contact normals against
 * all still-assembled neighbours. This is the discrete version of the net
 * contact force Assemble-Them-All reads out of its simulator — geometry
 * already knows the escape direction before anything moves. Used to RANK
 * the six probe directions (best-aligned first).
 */
export function pushOutVector(
  movingIds: string[],
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
): THREE.Vector3 {
  const movingSet = new Set(movingIds);
  const out = new THREE.Vector3();
  for (const id of movingIds) {
    const g = geoms.get(id);
    if (!g) continue;
    for (const [oid, other] of remaining) {
      if (movingSet.has(oid)) continue;
      const rc = restContactOf(g, other);
      // Penetrating pairs (unmodelled threads etc.) have ill-defined normals
      // — closest-point from an INSIDE vertex points anywhere. Only clean
      // surface contacts (depth ≈ 0) vote on the escape direction.
      if (rc && rc.depth < 0.5) out.add(rc.normal);
    }
  }
  return out;
}

/** Probe order for a unit: aligned-with-push-out first, gravity as tiebreak. */
export function rankedDirections(
  movingIds: string[],
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
): Dir[] {
  const push = pushOutVector(movingIds, remaining, geoms);
  if (push.lengthSq() < 1e-9) return [...DIR_ORDER];
  push.normalize();
  const score = (d: Dir) => push.dot(DIR_VEC[d]);
  return [...DIR_ORDER].sort((a, b) => {
    const diff = score(b) - score(a);
    if (Math.abs(diff) > 1e-6) return diff;
    return DIR_ORDER.indexOf(a) - DIR_ORDER.indexOf(b); // stable gravity tiebreak
  });
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
  const samples = Math.max(
    3,
    Math.ceil((travel / unitLen) * SAMPLES_PER_LENGTH),
    Math.ceil(travel / MAX_SAMPLE_STEP), // tunneling guard: never hop >2.5mm
  );

  /**
   * Budget tolerance: rest depth + 30% + 0.6mm. The slack absorbs edge-
   * sample jitter (probes land on different points at each offset, ±0.5mm
   * on the gearbox gasket); real plowing deepens by many mm and still trips.
   * Original tighter budget (15%+0.1) false-blocked the bolt extraction. Sliding OUT of a hole keeps
   * penetration ≤ rest depth (legal); any move that deepens contact exceeds
   * the budget immediately (blocked). Pairs with no rest contact have budget
   * 0 — plain honest collision detection.
   *
   * PERFORMANCE: pair-first, not sample-first. For each (mover, fixed) pair
   * the axis interval of d where their AABBs can overlap is computed in
   * closed form; pairs whose boxes never meet along the travel cost ZERO
   * narrow-phase tests, and the rest are sampled only inside their interval
   * (≤2.5mm steps, capped). Sample-first scanning made dense STEP meshes
   * take minutes; this makes them take seconds.
   */
  const offset = new THREE.Vector3();
  const o1 = axis === 'x' ? 'y' : 'x';
  const o2 = axis === 'z' ? 'y' : 'z';
  for (const m of moving) {
    for (const f of fixed) {
      // Off-axis AABB overlap never changes during an axis sweep.
      if (
        m.aabb.max[o1] < f.aabb.min[o1] - CONTACT_EPS ||
        m.aabb.min[o1] > f.aabb.max[o1] + CONTACT_EPS ||
        m.aabb.max[o2] < f.aabb.min[o2] - CONTACT_EPS ||
        m.aabb.min[o2] > f.aabb.max[o2] + CONTACT_EPS
      ) {
        continue;
      }
      // 1-D interval of travel d where the boxes overlap on the sweep axis.
      const dirSign = v[axis];
      let dMin: number;
      let dMax: number;
      if (dirSign > 0) {
        dMin = f.aabb.min[axis] - m.aabb.max[axis];
        dMax = f.aabb.max[axis] - m.aabb.min[axis];
      } else {
        dMin = m.aabb.min[axis] - f.aabb.max[axis];
        dMax = m.aabb.max[axis] - f.aabb.min[axis];
      }
      const start = Math.max(dMin + CONTACT_EPS, travel / samples);
      const end = Math.min(dMax - CONTACT_EPS, travel);
      if (end <= start) continue;

      const span = end - start;
      // Rest contact decided upfront (cached): it sets both the penetration
      // budget AND the sampling density. Non-touching pairs use fine steps
      // with the cheap boolean test only; touching pairs use sparse steps
      // (plow violations are deep and persistent — 12 samples across the
      // overlap catch them) and a light probe budget. This is what took the
      // faucet plan from 260s to seconds: fine-stepped FULL penetration
      // scans on every legal sliding sample were the entire cost.
      const rc = restContactOf(m, f);
      const budget = rc ? rc.depth * 1.3 + 0.6 : 0;
      const n = budget > 0
        ? Math.min(Math.max(3, Math.ceil(span / MAX_SAMPLE_STEP)), 8)
        : Math.min(Math.max(3, Math.ceil(span / MAX_SAMPLE_STEP)), 60);
      for (let s = 0; s <= n; s++) {
        const d = start + (span * s) / n;
        offset.copy(v).multiplyScalar(d);
        if (!intersectsAt(m, offset, f)) continue;
        if (budget <= 0) return { ok: false, blockedBy: f.id };
        if (penetrationDepth(m, offset, f, budget, 300) > budget) {
          return { ok: false, blockedBy: f.id };
        }
      }
    }
  }
  return { ok: true };
}

/**
 * All feasible removal directions for a unit, best-first.
 *
 * v2: probe order is RANKED by the unit's aggregate contact normal (the
 * push-out vector) — "move opposite the plane you're touching on" — instead
 * of a fixed gravity-first order. Gravity breaks ties.
 */
export function feasibleDirections(
  movingIds: string[],
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
): { dir: Dir; blockedBy?: string }[] {
  const out: { dir: Dir }[] = [];
  for (const dir of rankedDirections(movingIds, remaining, geoms)) {
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
