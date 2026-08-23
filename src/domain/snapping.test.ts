/**
 * Feature-snapping tests.
 *
 * These pin the behaviour that makes leader lines look deliberate rather than
 * dropped at a random point on a face.
 */
import { describe, expect, it } from 'vitest';
import {
  closestPointOnSegment,
  distance,
  liftOffSurface,
  normalize,
  snapToFeature,
  triangleCentroid,
  triangleNormal,
} from './snapping';
import type { Vec3 } from './schema';

const near = (a: number[], b: number[], p = 5) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], p));

/** A unit right triangle in the XY plane. */
const TRI: [Vec3, Vec3, Vec3] = [
  [0, 0, 0],
  [100, 0, 0],
  [0, 100, 0],
];

describe('triangleNormal', () => {
  it('is unit length and perpendicular', () => {
    const n = triangleNormal(...TRI);
    expect(Math.hypot(...n)).toBeCloseTo(1, 6);
    near(n, [0, 0, 1]);
  });

  it('flips with winding order', () => {
    near(triangleNormal(TRI[0], TRI[2], TRI[1]), [0, 0, -1]);
  });
});

describe('closestPointOnSegment', () => {
  it('projects onto the segment interior', () => {
    near(closestPointOnSegment([50, 40, 0], [0, 0, 0], [100, 0, 0]), [50, 0, 0]);
  });

  it('clamps beyond the ends', () => {
    near(closestPointOnSegment([-40, 5, 0], [0, 0, 0], [100, 0, 0]), [0, 0, 0]);
    near(closestPointOnSegment([400, 5, 0], [0, 0, 0], [100, 0, 0]), [100, 0, 0]);
  });

  it('handles a degenerate zero-length edge', () => {
    near(closestPointOnSegment([9, 9, 9], [1, 1, 1], [1, 1, 1]), [1, 1, 1]);
  });
});

describe('snapToFeature', () => {
  it('snaps to a VERTEX when the hit is near a corner', () => {
    const r = snapToFeature([3, 2, 0], TRI);
    expect(r.kind).toBe('vertex');
    near(r.point, [0, 0, 0]);
  });

  it('snaps to each of the three corners', () => {
    expect(snapToFeature([98, 1, 0], TRI).point).toEqual([100, 0, 0]);
    expect(snapToFeature([1, 98, 0], TRI).point).toEqual([0, 100, 0]);
  });

  it('snaps to an EDGE when the hit is along a side but not a corner', () => {
    const r = snapToFeature([50, 2, 0], TRI);
    expect(r.kind).toBe('edge');
    near(r.point, [50, 0, 0]);
  });

  it('falls back to the FACE centroid in open space', () => {
    const r = snapToFeature([30, 30, 0], TRI);
    expect(r.kind).toBe('face');
    near(r.point, triangleCentroid(...TRI));
  });

  it('always returns the face normal regardless of snap kind', () => {
    for (const p of [[2, 2, 0], [50, 1, 0], [30, 30, 0]] as Vec3[]) {
      near(snapToFeature(p, TRI).normal, [0, 0, 1]);
    }
  });

  it('tolerance scales with triangle size, not absolute distance', () => {
    // The same 3mm offset is a vertex hit on a small triangle...
    const small: [Vec3, Vec3, Vec3] = [[0, 0, 0], [10, 0, 0], [0, 10, 0]];
    expect(snapToFeature([1.5, 1, 0], small).kind).toBe('vertex');

    // ...and lands on the face of a very large one.
    const large: [Vec3, Vec3, Vec3] = [[0, 0, 0], [5000, 0, 0], [0, 5000, 0]];
    expect(snapToFeature([1500, 1500, 0], large).kind).toBe('face');
  });

  it('reports the distance from the raw hit to the snapped point', () => {
    const r = snapToFeature([50, 2, 0], TRI);
    expect(r.distance).toBeCloseTo(2, 5);
  });

  it('handles a degenerate zero-area triangle without NaN', () => {
    const degenerate: [Vec3, Vec3, Vec3] = [[5, 5, 5], [5, 5, 5], [5, 5, 5]];
    const r = snapToFeature([1, 2, 3], degenerate);
    expect(r.point.every(Number.isFinite)).toBe(true);
    expect(r.normal.every(Number.isFinite)).toBe(true);
  });

  it('works on a triangle not aligned to any axis', () => {
    const tilted: [Vec3, Vec3, Vec3] = [[0, 0, 0], [60, 20, 30], [10, 70, -20]];
    const r = snapToFeature([59, 21, 30], tilted);
    expect(r.kind).toBe('vertex');
    near(r.point, [60, 20, 30]);
  });
});

describe('liftOffSurface', () => {
  it('moves the point along the normal', () => {
    near(liftOffSurface([1, 2, 3], [0, 0, 1], 5), [1, 2, 8]);
  });

  it('normalizes a non-unit normal first', () => {
    near(liftOffSurface([0, 0, 0], [0, 0, 10], 2), [0, 0, 2]);
  });

  it('a zero normal leaves the point unchanged', () => {
    near(liftOffSurface([4, 5, 6], [0, 0, 0], 3), [4, 5, 6]);
  });
});

describe('helpers', () => {
  it('normalize returns unit vectors', () => {
    expect(Math.hypot(...normalize([3, 4, 0]))).toBeCloseTo(1, 6);
  });

  it('distance is symmetric', () => {
    expect(distance([0, 0, 0], [3, 4, 0])).toBeCloseTo(5);
    expect(distance([3, 4, 0], [0, 0, 0])).toBeCloseTo(5);
  });
});
