/**
 * Snapping a raycast hit to a CAD feature.
 *
 * A leader line that lands mid-face looks sloppy; engineers point at corners,
 * edges, and face centres. This module takes the triangle a ray hit and picks
 * the most plausible feature the user meant.
 *
 * Pure and renderer-free (AGENTS.md §2.1): callers pass plain triangle
 * coordinates, so the whole snap decision is testable without WebGL.
 */
import type { Vec3 } from './schema';

export type SnapKind = 'vertex' | 'edge' | 'face';

export interface SnapCandidate {
  kind: SnapKind;
  /** The snapped position, in the same frame as the input triangle. */
  point: Vec3;
  /** Distance from the raw hit point to this candidate. */
  distance: number;
}

export interface SnapResult extends SnapCandidate {
  /** Face normal of the hit triangle, for offsetting the label off material. */
  normal: Vec3;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function normalize(a: Vec3): Vec3 {
  const l = len(a);
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

export function distance(a: Vec3, b: Vec3): number {
  return len(sub(a, b));
}

/** Unit normal of a triangle, via the right-hand rule on (b-a) x (c-a). */
export function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return normalize(cross(sub(b, a), sub(c, a)));
}

export function triangleCentroid(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

/** Closest point to `p` on the segment ab, clamped to the segment. */
export function closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  if (denom === 0) return a; // degenerate edge
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / denom));
  return add(a, scale(ab, t));
}

/**
 * Decide which feature a hit point most likely meant.
 *
 * Priority is vertex > edge > face, each within a tolerance expressed as a
 * FRACTION of the triangle's size rather than an absolute distance — a bolt
 * head and a housing panel need very different absolute tolerances, and the
 * app has no fixed scale.
 */
export function snapToFeature(
  hit: Vec3,
  triangle: [Vec3, Vec3, Vec3],
  opts: { vertexTolerance?: number; edgeTolerance?: number } = {},
): SnapResult {
  const [a, b, c] = triangle;
  const vertexTolerance = opts.vertexTolerance ?? 0.22;
  const edgeTolerance = opts.edgeTolerance ?? 0.14;

  // Scale reference: the longest edge. Robust for slivers and huge faces alike.
  const size = Math.max(distance(a, b), distance(b, c), distance(c, a));
  const normal = triangleNormal(a, b, c);

  if (size === 0) {
    return { kind: 'vertex', point: a, distance: 0, normal };
  }

  // --- vertices
  const vertices: SnapCandidate[] = [a, b, c].map((v) => ({
    kind: 'vertex' as const,
    point: v,
    distance: distance(hit, v),
  }));
  const nearestVertex = vertices.reduce((m, v) => (v.distance < m.distance ? v : m));
  if (nearestVertex.distance <= size * vertexTolerance) {
    return { ...nearestVertex, normal };
  }

  // --- edges: snap to the MIDPOINT, which is what a leader line should mark.
  const edges: Array<[Vec3, Vec3]> = [
    [a, b],
    [b, c],
    [c, a],
  ];
  const edgeHits: SnapCandidate[] = edges.map(([p, q]) => {
    const onSegment = closestPointOnSegment(hit, p, q);
    return {
      kind: 'edge' as const,
      point: onSegment,
      distance: distance(hit, onSegment),
    };
  });
  const nearestEdge = edgeHits.reduce((m, e) => (e.distance < m.distance ? e : m));
  if (nearestEdge.distance <= size * edgeTolerance) {
    return { ...nearestEdge, normal };
  }

  // --- face
  const centroid = triangleCentroid(a, b, c);
  return {
    kind: 'face',
    point: centroid,
    distance: distance(hit, centroid),
    normal,
  };
}

/**
 * Offset an anchor slightly along the surface normal.
 *
 * Without this the leader line's endpoint z-fights with the face it sits on,
 * which reads as flicker while orbiting.
 */
export function liftOffSurface(point: Vec3, normal: Vec3, amount: number): Vec3 {
  return add(point, scale(normalize(normal), amount));
}
