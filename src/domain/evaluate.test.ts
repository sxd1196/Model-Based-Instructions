import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  locate,
  poseFor,
  resolveFrame,
  slerpQuat,
  totalDuration,
} from './evaluate';
import type { Operation, Sequence } from './schema';
import { IDENTITY_QUAT, Sequence as SequenceSchema } from './schema';

function op(partial: Partial<Operation> & { id: string }): Operation {
  return {
    title: partial.id,
    description: '',
    duration: 1,
    dwell: 0,
    tracks: [],
    camera: null,
    annotations: [],
    styles: [],
    meta: {},
    ...partial,
  } as Operation;
}

function seq(operations: Operation[]): Sequence {
  return SequenceSchema.parse({
    id: 's1',
    name: 'test',
    assembly: {
      id: 'a1',
      name: 'asm',
      modelUrl: '/x.glb',
      parts: {},
    },
    operations,
  });
}

const slide = (id: string, part: string, z: number, duration = 1) =>
  op({
    id,
    duration,
    tracks: [
      {
        id: `${id}-t`,
        parts: [part],
        from: { translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
        to: { translate: [0, 0, z], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
        start: 0,
        end: 1,
        easing: 'linear',
      },
    ],
  });

describe('timeline', () => {
  it('lays operations end to end including dwell', () => {
    const s = seq([
      op({ id: 'a', duration: 2, dwell: 0.5 }),
      op({ id: 'b', duration: 1, dwell: 0 }),
    ]);
    const t = buildTimeline(s);
    expect(t[0].startTime).toBe(0);
    expect(t[0].motionEndTime).toBe(2);
    expect(t[0].endTime).toBe(2.5);
    expect(t[1].startTime).toBe(2.5);
    expect(totalDuration(s)).toBe(3.5);
  });

  it('clamps before start and after end', () => {
    const t = buildTimeline(seq([op({ id: 'a' })]));
    expect(locate(t, -5)?.localT).toBe(0);
    expect(locate(t, 999)?.localT).toBe(1);
  });

  it('holds localT at 1 during dwell', () => {
    const t = buildTimeline(seq([op({ id: 'a', duration: 1, dwell: 1 })]));
    expect(locate(t, 1.5)?.localT).toBe(1);
  });
});

describe('resolveFrame', () => {
  it('interpolates the live operation', () => {
    const f = resolveFrame(seq([slide('a', 'bolt', 100)]), 0.5);
    expect(poseFor(f, 'bolt').translate[2]).toBeCloseTo(50);
  });

  it('ACCUMULATES completed operations - part stays moved', () => {
    // The critical property: scrub to step 3, and the part removed in step 1
    // must still be gone. Without accumulation you get parts snapping back.
    const s = seq([
      slide('a', 'cover', 100),
      slide('b', 'gasket', 50),
      slide('c', 'shaft', 25),
    ]);
    const f = resolveFrame(s, 2.5);
    expect(poseFor(f, 'cover').translate[2]).toBeCloseTo(100);
    expect(poseFor(f, 'gasket').translate[2]).toBeCloseTo(50);
    expect(poseFor(f, 'shaft').translate[2]).toBeCloseTo(12.5);
  });

  it('leaves untouched parts at identity', () => {
    const f = resolveFrame(seq([slide('a', 'bolt', 100)]), 0.5);
    expect(poseFor(f, 'housing').translate).toEqual([0, 0, 0]);
  });

  it('is deterministic', () => {
    const s = seq([slide('a', 'p', 10), slide('b', 'q', 20)]);
    const x = resolveFrame(s, 1.3);
    const y = resolveFrame(s, 1.3);
    expect(poseFor(x, 'q')).toEqual(poseFor(y, 'q'));
  });

  it('respects per-track windows within one operation', () => {
    const s = seq([
      op({
        id: 'a',
        duration: 1,
        tracks: [
          {
            id: 't1',
            parts: ['late'],
            from: { translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
            to: { translate: [0, 0, 100], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
            start: 0.5,
            end: 1,
            easing: 'linear',
          },
        ],
      }),
    ]);
    // At 25% through the op, a track that starts at 50% must not have moved.
    expect(poseFor(resolveFrame(s, 0.25), 'late').translate[2]).toBeCloseTo(0);
    expect(poseFor(resolveFrame(s, 0.75), 'late').translate[2]).toBeCloseTo(50);
  });

  it('carries styles forward from completed operations', () => {
    const s = seq([
      op({ id: 'a', styles: [{ parts: ['frame'], mode: 'ghost' }] }),
      op({ id: 'b' }),
    ]);
    expect(resolveFrame(s, 1.5).styles.get('frame')).toBe('ghost');
  });

  it('handles an empty sequence without throwing', () => {
    expect(resolveFrame(seq([]), 5).activeOperationId).toBeNull();
  });
});

describe('camera', () => {
  const cam = (z: number) => ({ position: [0, 0, z] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 45 });

  it('holds the previous pose when an operation has no camera', () => {
    const s = seq([op({ id: 'a', camera: cam(100) }), op({ id: 'b', camera: null })]);
    expect(resolveFrame(s, 1.5).camera?.position[2]).toBeCloseTo(100);
  });

  it('tweens between authored poses', () => {
    const s = seq([op({ id: 'a', camera: cam(0) }), op({ id: 'b', camera: cam(100) })]);
    const mid = resolveFrame(s, 1.5).camera!;
    expect(mid.position[2]).toBeGreaterThan(0);
    expect(mid.position[2]).toBeLessThan(100);
  });
});

describe('slerpQuat', () => {
  it('takes the short arc across the double cover', () => {
    // q and -q are the same rotation; naive lerp spins the long way.
    const a: [number, number, number, number] = [0, 0, 0, 1];
    const b: [number, number, number, number] = [0, 0, -0.0087, -0.99996];
    const mid = slerpQuat(a, b, 0.5);
    expect(Math.hypot(...mid)).toBeCloseTo(1, 5);
    expect(Math.abs(mid[3])).toBeGreaterThan(0.99);
  });

  it('returns unit quaternions', () => {
    // Use an exactly-normalized input; 0.7071 is short of sqrt(2)/2 and the
    // resulting error would be the test's, not slerp's.
    const h = Math.SQRT1_2;
    const r = slerpQuat([0, 0, 0, 1], [h, 0, 0, h], 0.37);
    expect(Math.hypot(...r)).toBeCloseTo(1, 6);
  });
});
