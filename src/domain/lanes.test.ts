/**
 * Lane helper tests: axis/angle round trips, merging, display, timing.
 */
import { describe, expect, it } from 'vitest';
import {
  axisAngleToQuat,
  buildLanes,
  describeMove,
  fractionToSeconds,
  quatToAxisAngle,
  secondsToFraction,
  snapEdge,
  tracksMergeable,
} from './lanes';
import { quatFromAxisAngle } from './transform';
import { IDENTITY_MOVE, IDENTITY_QUAT, type Operation, type Track } from './schema';

const track = (partial: Partial<Track>): Track => ({
  id: Math.random().toString(36).slice(2),
  parts: ['p1'],
  from: IDENTITY_MOVE,
  to: IDENTITY_MOVE,
  start: 0,
  end: 1,
  easing: 'easeInOut',
  ...partial,
});

const op = (tracks: Track[]): Operation => ({
  id: 'op', title: '', description: '', noteCorner: 'tl' as const, duration: 2, dwell: 0,
  tracks, camera: null, annotations: [], styles: [], meta: {}, section: null,
});

describe('quatToAxisAngle', () => {
  it('round-trips a cardinal rotation', () => {
    const q = axisAngleToQuat('Z', [0, 0, 1], 90);
    const aa = quatToAxisAngle(q);
    expect(aa.axis).toBe('Z');
    expect(aa.angle).toBeCloseTo(90, 4);
  });

  it('identity reads as 0 degrees', () => {
    expect(quatToAxisAngle(IDENTITY_QUAT).angle).toBe(0);
  });

  it('SNAPS a hand-dragged near-cardinal to the clean axis', () => {
    // A ring drag is never mathematically exact; the display must say
    // 'Z 90' not 'custom 89.7' (same philosophy as the 5mm grid snap).
    const wobbly = quatFromAxisAngle([0.01, 0.008, 0.9999], Math.PI / 2);
    const aa = quatToAxisAngle(wobbly);
    expect(aa.axis).toBe('Z');
  });

  it('a genuinely diagonal axis stays custom', () => {
    const diag = quatFromAxisAngle([1, 1, 0], Math.PI / 3);
    expect(quatToAxisAngle(diag).axis).toBe('custom');
  });

  it('negative-axis rotations read as negative angles about the positive axis', () => {
    const q = quatFromAxisAngle([0, 0, -1], Math.PI / 4);
    const aa = quatToAxisAngle(q);
    expect(aa.axis).toBe('Z');
    expect(aa.angle).toBeCloseTo(-45, 3);
  });

  it('round-trips a custom axis through axisAngleToQuat', () => {
    const q1 = quatFromAxisAngle([1, 2, 3], 1.1);
    const aa = quatToAxisAngle(q1);
    const q2 = axisAngleToQuat('custom', aa.vector, aa.angle);
    const dot = Math.abs(q1.reduce((a, v, i) => a + v * q2[i], 0));
    expect(dot).toBeCloseTo(1, 5);
  });
});

describe('lane merging', () => {
  const move = { translate: [0, 0, 120] as [number, number, number], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] as [number, number, number] };

  it('merges cluster tracks with identical motion + timing into one lane', () => {
    // A SUB drag writes one track per parent cluster; the author did ONE
    // motion, so the UI shows ONE lane.
    const lanes = buildLanes(op([
      track({ parts: ['a', 'b'], to: move }),
      track({ parts: ['c'], to: move }),
      track({ parts: ['d'], to: move }),
    ]));
    expect(lanes).toHaveLength(1);
    expect(lanes[0].parts.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(lanes[0].trackIds).toHaveLength(3);
  });

  it('does NOT merge tracks with different timing (staggered lanes split)', () => {
    const lanes = buildLanes(op([
      track({ parts: ['a'], to: move, start: 0, end: 0.5 }),
      track({ parts: ['b'], to: move, start: 0.5, end: 1 }),
    ]));
    expect(lanes).toHaveLength(2);
  });

  it('does NOT merge different motions', () => {
    const lanes = buildLanes(op([
      track({ parts: ['a'], to: move }),
      track({ parts: ['b'], to: { ...move, translate: [80, 0, 0] } }),
    ]));
    expect(lanes).toHaveLength(2);
  });

  it('orders lanes as a waterfall by start time', () => {
    const lanes = buildLanes(op([
      track({ parts: ['late'], to: move, start: 0.6, end: 1 }),
      track({ parts: ['early'], to: { ...move, translate: [5, 0, 0] }, start: 0, end: 0.4 }),
    ]));
    expect(lanes[0].parts).toEqual(['early']);
  });

  it('q and -q count as the same rotation for merging', () => {
    const q = quatFromAxisAngle([0, 0, 1], 1);
    const negQ = q.map((v) => -v) as typeof q;
    expect(tracksMergeable(
      track({ to: { ...move, rotate: q } }),
      track({ to: { ...move, rotate: negQ } }),
    )).toBe(true);
  });
});

describe('describeMove', () => {
  it('axial translation reads as one arrow', () => {
    expect(describeMove({ translate: [0, 0, 120], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] }))
      .toBe('⤴ Z 120mm');
  });

  it('negative axis flips the glyph', () => {
    expect(describeMove({ translate: [-80, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] }))
      .toBe('← X 80mm');
  });

  it('diagonal translation falls back to magnitude', () => {
    expect(describeMove({ translate: [30, 40, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] }))
      .toBe('↗ 50mm');
  });

  it('rotation joins with a dot separator', () => {
    const q = axisAngleToQuat('Z', [0, 0, 1], 90);
    expect(describeMove({ translate: [0, 0, 30], rotate: q, pivot: [0, 0, 0] }))
      .toBe('⤴ Z 30mm · ⟳ Z 90°');
  });

  it('identity reads as no motion', () => {
    expect(describeMove(IDENTITY_MOVE)).toBe('no motion');
  });
});

describe('timing conversion + edge snap', () => {
  it('fraction <-> seconds round-trips against the step duration', () => {
    expect(fractionToSeconds(0.5, 1.5)).toBeCloseTo(0.75);
    expect(secondsToFraction(0.75, 1.5)).toBeCloseTo(0.5);
  });

  it('seconds clamp to the step', () => {
    expect(secondsToFraction(99, 2)).toBe(1);
    expect(secondsToFraction(-1, 2)).toBe(0);
  });

  it('a dragged edge snaps to a nearby lane edge', () => {
    expect(snapEdge(0.52, [0.5, 0.8])).toBe(0.5);
  });

  it('an edge outside tolerance stays put', () => {
    expect(snapEdge(0.6, [0.5, 0.8])).toBe(0.6);
  });
});
