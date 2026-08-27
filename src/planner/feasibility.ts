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
import { plannerConfig } from './config';

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
 * penetration budget, the contact normal (unit vector pointing AWAY from
 * the fixed part — the "push-out" direction), and the contact patch size.
 */
interface RestContact {
  depth: number;
  normal: THREE.Vector3;
  /** How many sampled points sat within CONTACT_NEAR of the partner —
   * a contact AREA proxy: face-on-face ≈ many, edge touch ≈ few. */
  samples: number;
  /** Clearance-gradient magnitude: mm of separation gained per mm of travel
   * along the normal. ~0 means no usable direction was found. */
  rawMag: number;
}

/** World-mm distance below which a sample point counts as "in contact". */
const CONTACT_NEAR = 0.8;

const _restContacts = new Map<string, RestContact | null>();
/**
 * ORDERED key — found the hard way. The record is ASYMMETRIC (depth is
 * a-into-b, normal points away from b), but the key was unordered, so the
 * first caller's orientation won the cache slot and every later caller in
 * the opposite orientation read reversed data. Symptom: SUB_Cover feasible
 * in isolation, infeasible inside planSequence (different cache fill
 * order). Plans were call-order-dependent — poison for the bake-off.
 */
function pairKey(a: string, b: string): string {
  return a + '->' + b;
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

  /**
   * Contact normal, v3 (QUANTIFIED FIX — see .smoke/planner-report):
   * v2 used the difference vector of the SINGLE closest vertex pair. For
   * face-on-face mating that vector's length is ~0 and its direction is
   * tessellation noise (rawMag ≈ 0, silent +Z fallback) — measured on the
   * gearbox: plate/gasket contact produced an unusable normal, which is
   * exactly 'two planes slide past each other instead of away'.
   * v3 samples MANY points of a, and for each one within CONTACT_NEAR of
   * b's surface, votes with b's FACE NORMAL at the closest triangle
   * (oriented outward, toward a). Plane-on-plane → hundreds of identical
   * votes → rawMag ≈ sample count. The patch size doubles as a contact-
   * area proxy for direction ranking.
   */
  a.mesh.updateWorldMatrix(true, false);
  b.mesh.updateWorldMatrix(true, false);
  _matA.copy(a.mesh.matrixWorld);
  _inv.copy(b.mesh.matrixWorld).invert();
  _matRel.multiplyMatrices(_inv, _matA);
  const bvh = bvhOf(b.mesh.geometry as THREE.BufferGeometry);
  const pos = (a.mesh.geometry as THREE.BufferGeometry).attributes.position;
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const scaleB = new THREE.Vector3();
  b.mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scaleB);
  const suB = Math.abs(scaleB.x) || 1;

  /**
   * Contact patch size: sample along a's triangle edges (coarse meshes have
   * no vertices mid-face) and count points within CONTACT_NEAR of b.
   */
  const aGeom = a.mesh.geometry as THREE.BufferGeometry;
  const aIdx = aGeom.index;
  const aTriCount = aIdx ? aIdx.count / 3 : pos.count / 3;
  const scaleA = new THREE.Vector3();
  a.mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scaleA);
  const suA = Math.abs(scaleA.x) || 1;
  const edgeStepLocal = 2.5 / suA;
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pt = new THREE.Vector3();
  const triStrideA = Math.max(1, Math.ceil((aTriCount * 3 * 6) / 1200));

  let samples = 0;
  let bestDist = Infinity;
  for (let t = 0; t < aTriCount; t += triStrideA) {
    for (let e = 0; e < 3; e++) {
      const i0 = aIdx ? aIdx.getX(t * 3 + e) : t * 3 + e;
      const i1 = aIdx ? aIdx.getX(t * 3 + ((e + 1) % 3)) : t * 3 + ((e + 1) % 3);
      pA.fromBufferAttribute(pos, i0).applyMatrix4(_matRel);
      pB.fromBufferAttribute(pos, i1).applyMatrix4(_matRel);
      const len = pA.distanceTo(pB);
      const n = Math.min(Math.max(1, Math.ceil(len / edgeStepLocal)), 12);
      for (let s = 0; s <= n; s++) {
        pt.lerpVectors(pA, pB, s / n);
        bvh.closestPointToPoint(pt, target);
        const worldDist = target.distance * suB;
        if (worldDist < bestDist) bestDist = worldDist;
        if (worldDist <= CONTACT_NEAR) samples++;
      }
    }
  }

  // Not touching and no near-contact patch: not a contact pair.
  if (!touching && (samples === 0 || bestDist > 1.5)) {
    _restContacts.set(key, null);
    return null;
  }

  /**
   * Contact normal, three selectable methods (bake-off, see config.ts):
   *  - 'gradient': clearance gradient — probe ±1.5mm per axis, direction
   *    that opens the gap fastest (tessellation-independent).
   *  - 'triangles': mating-triangle reconstruction — cluster a's triangles
   *    facing b within CONTACT_NEAR by their own normals; the dominant
   *    cluster's area-weighted normal is the mate normal.
   *  - 'none': baseline — no contact steering at all.
   */
  const method = plannerConfig().normals;

  if (method === 'none') {
    const rec0: RestContact = { depth, normal: new THREE.Vector3(0, 0, 1), samples, rawMag: 0 };
    _restContacts.set(key, rec0);
    return rec0;
  }

  if (method === 'triangles') {
    const rec1 = triangleMateNormal(a, b, _matRel, samples, depth);
    _restContacts.set(key, rec1);
    return rec1;
  }

  /**
   * Contact normal via the CLEARANCE GRADIENT (v3 — quantified fix).
   *
   * v2 used the closest-vertex-pair difference vector: on face-on-face
   * mates its length is ~0 and its direction is tessellation noise, so
   * mating planes were invisible and the planner chose lateral slides —
   * the user's 'two planes slid past each other'. Face-normal voting was
   * tried and measured (coherence 0.15 on two mating plates: perimeter
   * points vote for side faces, votes cancel). The defensible measure:
   * probe ±1.5mm along each axis and take the gradient of SEPARATION
   * (min distance when clear, -penetration when overlapping). The push-out
   * direction is the one that opens the gap fastest — for a mating plane
   * that is exactly its normal, regardless of tessellation.
   */
  const PROBE = 1.5;
  const sepAt = (offset: THREE.Vector3): number => {
    const pen = penetrationDepth(a, offset, b, Infinity, 400);
    if (pen > 0) return -pen;
    // Clear: min distance via a bounded edge walk.
    _matA.copy(a.mesh.matrixWorld);
    _matA.premultiply(new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z));
    _matRel.multiplyMatrices(_inv, _matA);
    let minD = Infinity;
    const stride2 = triStrideA * 2;
    for (let t = 0; t < aTriCount; t += stride2) {
      for (let e = 0; e < 3; e += 2) {
        const i0 = aIdx ? aIdx.getX(t * 3 + e) : t * 3 + e;
        pA.fromBufferAttribute(pos, i0).applyMatrix4(_matRel);
        bvh.closestPointToPoint(pA, target);
        const d = target.distance * suB;
        if (d < minD) minD = d;
      }
    }
    return minD;
  };

  const base = sepAt(_zero);
  const grad = new THREE.Vector3();
  const probeVec = new THREE.Vector3();
  for (const [dx, dy, dz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
    probeVec.set(dx * PROBE, dy * PROBE, dz * PROBE);
    const plus = sepAt(probeVec);
    probeVec.multiplyScalar(-1);
    const minus = sepAt(probeVec);
    // Central difference, normalized by probe distance.
    grad.x += dx * (plus - minus) / (2 * PROBE);
    grad.y += dy * (plus - minus) / (2 * PROBE);
    grad.z += dz * (plus - minus) / (2 * PROBE);
  }
  // Restore _matRel for any later users (sepAt clobbered it).
  _matA.copy(a.mesh.matrixWorld);
  _matRel.multiplyMatrices(_inv, _matA);

  // rawMag: gradient magnitude (0..~1; 1 = separation grows 1mm per mm of
  // travel — a clean planar mate). Doubles as the coherence signal.
  const rawMag = grad.length();
  const normal = grad.clone();
  if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1);
  normal.normalize();
  void base;

  const rec: RestContact = { depth, normal, samples, rawMag };
  _restContacts.set(key, rec);
  return rec;
}

export const __dbgPenetration = penetrationDepth;

/**
 * Mating-triangle reconstruction ('triangles' bake-off variant).
 *
 * Walks a's triangles; each whose CENTROID lies within CONTACT_NEAR of b's
 * surface is a mating triangle. Mating triangles cluster by their own face
 * normal (~15° cones); the winning cluster (by summed area) defines the
 * mate plane, and its area-weighted normal — oriented AWAY from b — is the
 * escape direction. Reads the plane straight out of the tessellation, the
 * user's 'compare the triangles that are mating' technique.
 */
function triangleMateNormal(
  a: PartGeom,
  b: PartGeom,
  matRel: THREE.Matrix4,
  samples: number,
  depth: number,
): RestContact {
  const bvh = bvhOf(b.mesh.geometry as THREE.BufferGeometry);
  const aGeom = a.mesh.geometry as THREE.BufferGeometry;
  const pos = aGeom.attributes.position;
  const idx = aGeom.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };

  const scaleB = new THREE.Vector3();
  b.mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scaleB);
  const suB = Math.abs(scaleB.x) || 1;

  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  const toB = new THREE.Vector3();

  interface Cluster { normal: THREE.Vector3; area: number }
  const clusters: Cluster[] = [];

  const stride = Math.max(1, Math.floor(triCount / 1500));
  for (let t = 0; t < triCount; t += stride) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    p0.fromBufferAttribute(pos, i0).applyMatrix4(matRel);
    p1.fromBufferAttribute(pos, i1).applyMatrix4(matRel);
    p2.fromBufferAttribute(pos, i2).applyMatrix4(matRel);
    centroid.copy(p0).add(p1).add(p2).multiplyScalar(1 / 3);

    bvh.closestPointToPoint(centroid, target);
    if (target.distance * suB > CONTACT_NEAR) continue;

    // Face normal (b-local frame; fine for clustering, converted at the end)
    n.crossVectors(e1.subVectors(p1, p0), e2.subVectors(p2, p0));
    const area2 = n.length();
    if (area2 < 1e-12) continue;
    n.divideScalar(area2);
    // Orient away from b's surface at the contact.
    toB.subVectors(centroid, target.point);
    if (toB.lengthSq() > 1e-14 && n.dot(toB) < 0) n.negate();

    let hit = false;
    for (const c of clusters) {
      if (c.normal.dot(n) > 0.966) { // ~15° cone
        c.normal.lerp(n, area2 / (c.area + area2)).normalize();
        c.area += area2 / 2;
        hit = true;
        break;
      }
    }
    if (!hit) clusters.push({ normal: n.clone(), area: area2 / 2 });
  }

  if (!clusters.length) {
    return { depth, normal: new THREE.Vector3(0, 0, 1), samples, rawMag: 0 };
  }

  clusters.sort((x, y) => y.area - x.area);
  const total = clusters.reduce((s, c) => s + c.area, 0);
  const dominant = clusters[0];
  // Confidence = dominant cluster's share of mating area (1 = one clean
  // plane, low = wrapping/curved contact with no single escape plane).
  const rawMag = dominant.area / total;

  const normal = dominant.normal.clone();
  normal.applyMatrix4(new THREE.Matrix4().extractRotation(b.mesh.matrixWorld));
  normal.normalize();
  return { depth, normal, samples, rawMag };
}

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
      // v3: votes are WEIGHTED by contact patch size (sample count) — a
      // full mating face outvotes an incidental edge graze — and gated on
      // rawMag/samples coherence: a patch whose face normals cancel each
      // other (wrapping contact) carries no directional information.
      if (rc && rc.depth < 0.5 && rc.samples > 0) {
        // rawMag = clearance-gradient magnitude: ~1 for a clean planar mate,
        // ~0 when moving doesn't change separation (no directional info).
        const coherence = Math.min(rc.rawMag, 1);
        if (coherence > 0.3) {
          out.addScaledVector(rc.normal, rc.samples * coherence);
        }
      }
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
  return rankedDirectionsDetailed(movingIds, remaining, geoms).scores.map((s) => s.dir);
}

export interface DirScore {
  dir: Dir;
  /** Cosine alignment with the contact push-out vector (-1..1); 0 = no data. */
  align: number;
}

export interface ContactRecord {
  partner: string;
  samples: number;
  /** Clearance-gradient magnitude, capped at 1: 1 = clean planar mate. */
  coherence: number;
  depth: number;
  normal: [number, number, number];
}

/**
 * The QUANTITATIVE view of a direction decision (user requirement: no more
 * guessing — every choice must be explainable with numbers). Returns the
 * weighted push-out vector, each direction's alignment score, and the
 * per-partner contact evidence that produced them.
 */
export function rankedDirectionsDetailed(
  movingIds: string[],
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
): { push: THREE.Vector3; pushMag: number; scores: DirScore[]; contacts: ContactRecord[] } {
  const contacts: ContactRecord[] = [];
  const movingSet = new Set(movingIds);
  for (const id of movingIds) {
    const g = geoms.get(id);
    if (!g) continue;
    for (const [oid, other] of remaining) {
      if (movingSet.has(oid)) continue;
      const rc = restContactOf(g, other);
      if (rc) {
        contacts.push({
          partner: oid,
          samples: rc.samples,
          coherence: Math.min(rc.rawMag, 1),
          depth: rc.depth,
          normal: [rc.normal.x, rc.normal.y, rc.normal.z],
        });
      }
    }
  }

  const push = pushOutVector(movingIds, remaining, geoms);
  const pushMag = push.length();
  const unit = pushMag > 1e-9 ? push.clone().normalize() : null;
  const scores: DirScore[] = DIR_ORDER.map((dir) => ({
    dir,
    align: unit ? unit.dot(DIR_VEC[dir]) : 0,
  }));
  scores.sort((a, b) => {
    const diff = b.align - a.align;
    if (Math.abs(diff) > 1e-6) return diff;
    return DIR_ORDER.indexOf(a.dir) - DIR_ORDER.indexOf(b.dir);
  });
  return { push, pushMag, scores, contacts };
}

/**
 * Can `movingIds` (as one rigid unit) sweep along an ARBITRARY unit vector
 * until fully clear of everything remaining?
 *
 * v4: directions are no longer restricted to ±X/±Y/±Z (user: "why can't we
 * back off XY on a 45 if our mating plane is perpendicular to that?").
 * The pair-first interval optimization generalizes: for each axis with
 * v[axis]≠0 the travel interval where the AABBs can overlap is closed-form;
 * the pair's active interval is the INTERSECTION across axes, and axes with
 * v[axis]=0 must overlap statically or the pair never meets.
 */
export function canSweepOutVec(
  movingIds: string[],
  vec: THREE.Vector3,
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
): SweepResult {
  const moving = movingIds.map((id) => geoms.get(id)!).filter(Boolean);
  if (!moving.length) return { ok: false };
  const v = _sweepDir.copy(vec).normalize();

  const movingSet = new Set(movingIds);
  const fixed: PartGeom[] = [];
  const restBox = new THREE.Box3();
  for (const [id, g] of remaining) {
    if (movingSet.has(id)) continue;
    fixed.push(g);
    restBox.union(g.aabb);
  }
  if (!fixed.length) return { ok: true };

  const unitBox = new THREE.Box3();
  for (const g of moving) unitBox.union(g.aabb);

  // Travel to fully clear the remaining assembly's box: boxes separate as
  // soon as ANY axis separates -> exit distance = min over axes of that
  // axis' separation distance (axes with v=0 never separate -> Infinity).
  const travel = exitDistance(unitBox, restBox, v);
  if (travel <= 0) return { ok: true }; // already clear
  if (!Number.isFinite(travel)) return { ok: false }; // cannot clear along v

  const offset = new THREE.Vector3();
  for (const m of moving) {
    for (const f of fixed) {
      // Per-pair travel interval where AABBs can overlap: intersect the
      // per-axis intervals. Static-axis (v≈0) mismatch = never meets.
      let dMin = -Infinity;
      let dMax = Infinity;
      let disjoint = false;
      for (const axis of AXES) {
        const va = v[axis];
        if (Math.abs(va) < 1e-9) {
          if (
            m.aabb.max[axis] < f.aabb.min[axis] - CONTACT_EPS ||
            m.aabb.min[axis] > f.aabb.max[axis] + CONTACT_EPS
          ) {
            disjoint = true;
            break;
          }
          continue;
        }
        // Overlap on this axis while: f.min - m.max <= d*va <= f.max - m.min
        const lo = (f.aabb.min[axis] - m.aabb.max[axis]) / va;
        const hi = (f.aabb.max[axis] - m.aabb.min[axis]) / va;
        dMin = Math.max(dMin, Math.min(lo, hi));
        dMax = Math.min(dMax, Math.max(lo, hi));
      }
      if (disjoint || dMax <= dMin) continue;

      const start = Math.max(dMin + CONTACT_EPS, MAX_SAMPLE_STEP / 2);
      const end = Math.min(dMax - CONTACT_EPS, travel);
      if (end <= start) continue;

      const span = end - start;
      const rc = restContactOf(m, f);
      const budget = rc ? rc.depth + Math.min(rc.depth * 0.15, 2) + 0.6 : 0;
      const n = budget > 0
        ? Math.min(Math.max(3, Math.ceil(span / MAX_SAMPLE_STEP)), 8)
        : Math.min(Math.max(3, Math.ceil(span / MAX_SAMPLE_STEP)), 60);
      for (let s = 0; s <= n; s++) {
        const d = start + (span * s) / n;
        offset.copy(v).multiplyScalar(d);
        if (budget <= 0) {
          if (intersectsAt(m, offset, f)) return { ok: false, blockedBy: f.id };
          continue;
        }
        /**
         * Touching pairs: probe DEPTH directly, never gate on the surface-
         * intersection boolean. Found via bake-off run 3 + a manual scan:
         * the bearing driven -Z reached 50mm penetration INSIDE the housing
         * boss while `intersectsAt` reported false — full containment
         * crosses no surfaces, so the depth probe was never reached and the
         * sweep passed. penetrationDepth's inside-parity sampling detects
         * containment; the early-exit budget keeps it cheap.
         */
        if (penetrationDepth(m, offset, f, budget, 300) > budget) {
          return { ok: false, blockedBy: f.id };
        }
      }
    }
  }
  return { ok: true };
}

const _sweepDir = new THREE.Vector3();
const AXES = ['x', 'y', 'z'] as const;

/** Distance along v at which `unitBox` fully clears `restBox` (Infinity when
 * it cannot — v has no component on any separating axis). */
export function exitDistance(unitBox: THREE.Box3, restBox: THREE.Box3, v: THREE.Vector3): number {
  let best = Infinity;
  for (const axis of AXES) {
    const va = v[axis];
    if (Math.abs(va) < 1e-9) continue;
    const d = va > 0
      ? (restBox.max[axis] - unitBox.min[axis]) / va
      : (restBox.min[axis] - unitBox.max[axis]) / va;
    if (d < best) best = d;
  }
  return best;
}

/** Canonical-axis compatibility wrapper over the vector kernel. */
export function canSweepOut(
  movingIds: string[],
  dir: Dir,
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
): SweepResult {
  return canSweepOutVec(movingIds, DIR_VEC[dir], remaining, geoms);
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

/** A candidate escape vector with provenance (for the audit trail). */
export interface VecCandidate {
  vec: THREE.Vector3;
  /** Where this direction came from: canonical axis, a mating-contact
   * normal, the aggregate push-out, or a STEP B-rep plane normal. */
  source: 'axis' | 'contact' | 'push' | 'step-plane';
  /** Display label: '+Z' or '(0.71, 0.71, 0)'. */
  label: string;
}

const CANONICAL: VecCandidate[] = DIR_ORDER.map((d) => ({
  vec: DIR_VEC[d].clone(),
  source: 'axis' as const,
  label: d,
}));

export function labelForVec(v: THREE.Vector3): string {
  for (const d of DIR_ORDER) {
    if (v.dot(DIR_VEC[d]) > 0.999) return d;
  }
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
}

/**
 * Build the candidate escape-direction set for a unit (v4):
 *  - the six canonical axes (always)
 *  - each mating contact's normal — "back off the vector of the mating
 *    surface", the user's 45° case: a plane tilted 45° in XY contributes
 *    exactly its normal as a candidate
 *  - the aggregate push-out vector (multi-contact compromise direction)
 *  - STEP B-rep plane normals when the importer extracted them (both signs)
 * Deduped at ~10° (dot > 0.985). Order: contacts/push/step first (they carry
 * geometric intent), canonical axes as the fallback tail.
 */
export function candidateVectors(
  movingIds: string[],
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
  stepPlaneNormals?: [number, number, number][],
): VecCandidate[] {
  const det = rankedDirectionsDetailed(movingIds, remaining, geoms);
  const out: VecCandidate[] = [];
  const seen: THREE.Vector3[] = [];
  const push = (vec: THREE.Vector3, source: VecCandidate['source']) => {
    if (vec.lengthSq() < 1e-9) return;
    const u = vec.clone().normalize();
    for (const s of seen) if (s.dot(u) > 0.985) return; // ~10° dedupe
    seen.push(u);
    out.push({ vec: u, source, label: labelForVec(u) });
  };

  // Geometric-intent candidates first (skipped in axes-only baseline mode).
  const useMating = plannerConfig().directions === 'mating-vectors';
  if (useMating) for (const c of det.contacts) {
    if (c.coherence > 0.3) push(new THREE.Vector3(...c.normal), 'contact');
  }
  if (useMating && det.pushMag > 1e-6) push(det.push.clone(), 'push');
  if (useMating) for (const n of stepPlaneNormals ?? []) {
    push(new THREE.Vector3(...n), 'step-plane');
    push(new THREE.Vector3(-n[0], -n[1], -n[2]), 'step-plane');
  }
  // Canonical tail.
  for (const c of CANONICAL) push(c.vec, 'axis');

  // Rank by alignment with the push-out (geometry's opinion), stable within.
  if (det.pushMag > 1e-6) {
    const u = det.push.clone().normalize();
    out.sort((a, b) => u.dot(b.vec) - u.dot(a.vec));
  }
  return out;
}

/**
 * First feasible escape vector for a unit, searching geometric-intent
 * candidates before canonical axes. Returns the full candidate + evidence.
 */
export function feasibleVector(
  movingIds: string[],
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
  stepPlaneNormals?: [number, number, number][],
): { candidate: VecCandidate; tried: number } | null {
  const candidates = candidateVectors(movingIds, remaining, geoms, stepPlaneNormals);
  let tried = 0;
  for (const c of candidates) {
    tried++;
    if (canSweepOutVec(movingIds, c.vec, remaining, geoms).ok) {
      return { candidate: c, tried };
    }
  }
  return null;
}

/** Removal travel for authoring: clear the assembly plus a readable margin. */
export function removalDistance(
  movingIds: string[],
  dir: Dir,
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
): number {
  return removalDistanceVec(movingIds, DIR_VEC[dir], remaining, geoms);
}

/** Vector form: travel until the unit's AABB fully clears the remaining
 * assembly's AABB along v, plus a readable margin. */
export function removalDistanceVec(
  movingIds: string[],
  vec: THREE.Vector3,
  remaining: Map<string, PartGeom>,
  geoms: Map<string, PartGeom>,
): number {
  const v = vec.clone().normalize();
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
  const size = unitBox.getSize(new THREE.Vector3());
  const unitLen = Math.max(Math.abs(size.x * v.x) + Math.abs(size.y * v.y) + Math.abs(size.z * v.z), 5);
  if (!any) return unitLen * 1.5;
  const travel = exitDistance(unitBox, restBox, v);
  if (!Number.isFinite(travel)) return unitLen * 1.5;
  return Math.max(travel, 0) + unitLen * 0.75;
}
