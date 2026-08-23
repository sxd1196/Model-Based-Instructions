/**
 * Sequential (chained) tracks on the same part within one operation.
 *
 * The manufacturing case: one STEP is one work-instruction card, but its
 * choreography is several motions — bolts spin out, THEN the plate lifts,
 * THEN it slides aside. Multiple tracks on one part must CHAIN (each starts
 * where the previous ended), not fight last-write-wins.
 *
 * Semantics pinned here:
 *  - Tracks on a part are ordered by their start fraction.
 *  - Track i interpolates FROM the previous track's `to` TO its own `to`
 *    (implicit chaining — editing an earlier leg re-bases later ones, which
 *    is what an author expects; stored `from` is used only for the first leg).
 *  - Between windows the part HOLDS the last completed leg's pose.
 *  - Operations still accumulate across steps (AGENTS.md §2.4).
 */
import { describe, expect, it } from 'vitest';
import { resolveFrame, poseFor } from './evaluate';
import { buildAssemblyFromScene } from '@/cad/loadGltf';
import { makeDemoAssembly } from '@/cad/demo';
import { emptySequence } from '@/state/store';
import { IDENTITY_MOVE, IDENTITY_QUAT, type Operation, type Sequence, type Track } from './schema';
import { quatFromAxisAngle } from './transform';

const { root, name } = makeDemoAssembly();
const { assembly } = buildAssemblyFromScene(root, 'demo://x', { name });

const idOf = (n: string) =>
  Object.values(assembly.parts).find((p) => p.name === n)!.id;

const track = (partIds: string[], partial: Partial<Track>): Track => ({
  id: Math.random().toString(36).slice(2),
  parts: partIds,
  from: IDENTITY_MOVE,
  to: IDENTITY_MOVE,
  start: 0,
  end: 1,
  easing: 'linear',
  ...partial,
});

const op = (tracks: Track[], partial: Partial<Operation> = {}): Operation => ({
  id: Math.random().toString(36).slice(2),
  title: 'op', description: '', noteCorner: 'tl' as const, duration: 1, dwell: 0,
  tracks, camera: null, annotations: [], styles: [], meta: {},
  ...partial,
});

const seq = (ops: Operation[]): Sequence => ({
  ...emptySequence(assembly),
  operations: ops,
});

describe('sequential tracks on one part (lift then slide)', () => {
  const plate = () => idOf('Cover_Plate');

  const liftThenSlide = () =>
    seq([
      op([
        // Leg 1 (0 -> 0.5): lift +120 Z.
        track([plate()], {
          to: { translate: [0, 0, 120], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
          start: 0, end: 0.5,
        }),
        // Leg 2 (0.5 -> 1): slide +80 X, KEEPING the lift.
        track([plate()], {
          to: { translate: [80, 0, 120], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
          start: 0.5, end: 1,
        }),
      ]),
    ]);

  it('leg 1 animates normally', () => {
    const s = liftThenSlide();
    const mid = poseFor(resolveFrame(s, 0.25), plate());
    expect(mid.translate[2]).toBeCloseTo(60, 5);
    expect(mid.translate[0]).toBeCloseTo(0, 5);
  });

  it('leg 2 STARTS FROM leg 1 end, not from rest', () => {
    // The bug being pinned: last-write-wins made leg 2 interpolate
    // IDENTITY -> [80,0,120], so at its midpoint the part TELEPORTED to
    // z=60 after having reached z=120 — motion went backwards.
    const s = liftThenSlide();
    const mid = poseFor(resolveFrame(s, 0.75), plate());
    expect(mid.translate[2]).toBeCloseTo(120, 5); // lift HELD
    expect(mid.translate[0]).toBeCloseTo(40, 5);  // slide halfway
  });

  it('the boundary instant matches from both sides', () => {
    const s = liftThenSlide();
    const atEnd1 = poseFor(resolveFrame(s, 0.4999), plate());
    const atStart2 = poseFor(resolveFrame(s, 0.5001), plate());
    // 0.0002s of scrub legitimately moves the part a hair; what must NOT
    // happen is a jump (the old teleport was 60mm). Sub-0.1mm = continuous.
    expect(Math.abs(atStart2.translate[2] - atEnd1.translate[2])).toBeLessThan(0.1);
    expect(Math.abs(atStart2.translate[0] - atEnd1.translate[0])).toBeLessThan(0.1);
  });

  it('holds the completed pose in a GAP between windows', () => {
    const s = seq([
      op([
        track([plate()], {
          to: { translate: [0, 0, 100], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
          start: 0, end: 0.3,
        }),
        track([plate()], {
          to: { translate: [50, 0, 100], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
          start: 0.7, end: 1,
        }),
      ]),
    ]);
    // In the dead zone (0.3..0.7) the part sits at leg 1's end, unmoved.
    const held = poseFor(resolveFrame(s, 0.5), plate());
    expect(held.translate).toEqual([0, 0, 100]);
  });

  it('three legs chain (bolts pattern: spin, lift, slide)', () => {
    const spin = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const s = seq([
      op([
        track([plate()], {
          to: { translate: [0, 0, 0], rotate: spin, pivot: [0, 0, 67] },
          start: 0, end: 1 / 3,
        }),
        track([plate()], {
          to: { translate: [0, 0, 90], rotate: spin, pivot: [0, 0, 67] },
          start: 1 / 3, end: 2 / 3,
        }),
        track([plate()], {
          to: { translate: [70, 0, 90], rotate: spin, pivot: [0, 0, 67] },
          start: 2 / 3, end: 1,
        }),
      ]),
    ]);
    const final = poseFor(resolveFrame(s, 1), plate());
    expect(final.translate).toEqual([70, 0, 90]);
    // Mid leg 3: rotation done and held, translate between legs 2 and 3.
    const mid3 = poseFor(resolveFrame(s, 5 / 6), plate());
    expect(mid3.translate[2]).toBeCloseTo(90, 5);
    expect(mid3.translate[0]).toBeCloseTo(35, 5);
    const dot = Math.abs(mid3.rotate.reduce((a, v, i) => a + v * spin[i], 0));
    expect(dot).toBeCloseTo(1, 6);
  });

  it('an out-of-order tracks array still chains by START time', () => {
    // Authors reorder lanes; array order must not matter.
    const s = seq([
      op([
        track([plate()], {
          to: { translate: [80, 0, 120], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
          start: 0.5, end: 1,
        }),
        track([plate()], {
          to: { translate: [0, 0, 120], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
          start: 0, end: 0.5,
        }),
      ]),
    ]);
    const mid = poseFor(resolveFrame(s, 0.75), plate());
    expect(mid.translate[2]).toBeCloseTo(120, 5);
    expect(mid.translate[0]).toBeCloseTo(40, 5);
  });

  it('independent parts on separate tracks are untouched by chaining', () => {
    const shaft = idOf('Main_Shaft');
    const s = seq([
      op([
        track([plate()], {
          to: { translate: [0, 0, 120], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
          start: 0, end: 0.5,
        }),
        track([shaft], {
          to: { translate: [0, 0, -60], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
          start: 0.5, end: 1,
        }),
      ]),
    ]);
    const mid = resolveFrame(s, 0.75);
    expect(poseFor(mid, plate()).translate[2]).toBeCloseTo(120, 5);
    expect(poseFor(mid, shaft).translate[2]).toBeCloseTo(-30, 5);
  });

  it('chained motion still ACCUMULATES into later operations (§2.4)', () => {
    const s = seq([
      op([
        track([plate()], {
          to: { translate: [0, 0, 120], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
          start: 0, end: 0.5,
        }),
        track([plate()], {
          to: { translate: [80, 0, 120], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
          start: 0.5, end: 1,
        }),
      ], { duration: 1 }),
      op([
        track([idOf('Main_Shaft')], {
          to: { translate: [0, 0, -50], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
        }),
      ], { duration: 1 }),
    ]);
    // Scrubbed into step 2: the plate holds its full chained end pose.
    const inStep2 = poseFor(resolveFrame(s, 1.5), plate());
    expect(inStep2.translate).toEqual([80, 0, 120]);
  });

  it('a single track per part behaves exactly as before', () => {
    const s = seq([
      op([
        track([plate()], {
          from: { translate: [0, 0, 10], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
          to: { translate: [0, 0, 110], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
        }),
      ]),
    ]);
    // Stored `from` is honoured for the FIRST (only) leg.
    expect(poseFor(resolveFrame(s, 0), plate()).translate[2]).toBeCloseTo(10, 5);
    expect(poseFor(resolveFrame(s, 0.5), plate()).translate[2]).toBeCloseTo(60, 5);
  });
});
