/**
 * Rigid-transform tests for multi-part gizmo drags.
 *
 * The load-bearing property is RIGIDITY: after a group drag, the distances and
 * angles between parts must be unchanged. If that breaks, a sub-assembly
 * visibly deforms when you drag it, which is the worst kind of bug because it
 * looks like a physics glitch rather than a math error.
 */
import { describe, expect, it } from 'vitest';
import {
  applyRigid,
  composeRigid,
  gizmoDragToRigid,
  groupMoveFromDrag,
  IDENTITY_RIGID,
  moveToRigid,
  rigidToMove,
} from './rigid';
import { composePartTransform, quatFromAxisAngle } from './transform';
import { IDENTITY_QUAT, type Move, type Quat, type Vec3 } from './schema';

const near = (a: number[], b: number[], p = 5) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], p));

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const HALF_PI = Math.PI / 2;

describe('moveToRigid / rigidToMove', () => {
  it('round-trips a pure translation', () => {
    const m: Move = { translate: [10, 20, 30], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] };
    near(rigidToMove(moveToRigid(m)).translate, [10, 20, 30]);
  });

  it('converts a pivoted rotation to an equivalent origin-pivot move', () => {
    // Rotating [100,0,0] by 180 about pivot [50,0,0] lands at [0,0,0].
    const m: Move = {
      translate: [0, 0, 0],
      rotate: quatFromAxisAngle([0, 0, 1], Math.PI),
      pivot: [50, 0, 0],
    };
    const equivalent = rigidToMove(moveToRigid(m));
    const viaOriginal = composePartTransform([100, 0, 0], IDENTITY_QUAT, m);
    const viaEquivalent = composePartTransform([100, 0, 0], IDENTITY_QUAT, equivalent);
    near(
      [viaEquivalent.position[0], viaEquivalent.position[1], viaEquivalent.position[2]],
      [viaOriginal.position[0], viaOriginal.position[1], viaOriginal.position[2]],
    );
  });

  it('identity move is the identity rigid', () => {
    const r = moveToRigid({ translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [7, 7, 7] });
    near(r.translation, [0, 0, 0]);
    near(r.rotation, IDENTITY_QUAT);
  });
});

describe('composeRigid', () => {
  it('applies first then second', () => {
    const first = { rotation: IDENTITY_QUAT, translation: [10, 0, 0] as Vec3 };
    const second = { rotation: IDENTITY_QUAT, translation: [0, 5, 0] as Vec3 };
    near(applyRigid(composeRigid(first, second), [0, 0, 0]), [10, 5, 0]);
  });

  it('is order dependent when rotation is involved', () => {
    const move = { rotation: IDENTITY_QUAT, translation: [100, 0, 0] as Vec3 };
    const spin = { rotation: quatFromAxisAngle([0, 0, 1], HALF_PI), translation: [0, 0, 0] as Vec3 };

    // Translate then spin: the point sweeps around the origin.
    near(applyRigid(composeRigid(move, spin), [0, 0, 0]), [0, 100, 0]);
    // Spin then translate: the point ends up on the X axis.
    near(applyRigid(composeRigid(spin, move), [0, 0, 0]), [100, 0, 0]);
  });

  it('composing with identity changes nothing', () => {
    const r = { rotation: quatFromAxisAngle([1, 1, 0], 0.7), translation: [3, -4, 5] as Vec3 };
    const composed = composeRigid(r, IDENTITY_RIGID);
    near(composed.translation, r.translation);
    near(applyRigid(composed, [1, 2, 3]), applyRigid(r, [1, 2, 3]));
  });
});

describe('gizmoDragToRigid', () => {
  it('a pure handle translation moves points by the same delta', () => {
    const rigid = gizmoDragToRigid([50, 50, 0], [50, 50, 100], IDENTITY_QUAT);
    near(applyRigid(rigid, [0, 0, 0]), [0, 0, 100]);
    near(applyRigid(rigid, [10, 20, 30]), [10, 20, 130]);
  });

  it('rotation happens about the gizmo handle, not the world origin', () => {
    // Gizmo at [100,0,0], spin 90 about Z, no translation.
    // A point AT the handle must not move.
    const rigid = gizmoDragToRigid([100, 0, 0], [100, 0, 0], quatFromAxisAngle([0, 0, 1], HALF_PI));
    near(applyRigid(rigid, [100, 0, 0]), [100, 0, 0]);
    // A point 10 ahead on X swings to 10 ahead on Y.
    near(applyRigid(rigid, [110, 0, 0]), [100, 10, 0]);
  });
});

describe('groupMoveFromDrag — the multi-part gizmo contract', () => {
  /** Five parts in a fixed arrangement, standing in for a sub-assembly. */
  const parts: Array<{ rest: Vec3; restQ: Quat }> = [
    { rest: [0, 0, 0], restQ: IDENTITY_QUAT },
    { rest: [50, 0, 0], restQ: IDENTITY_QUAT },
    { rest: [0, 50, 0], restQ: quatFromAxisAngle([1, 0, 0], HALF_PI) },
    { rest: [0, 0, 50], restQ: IDENTITY_QUAT },
    { rest: [-30, 20, 10], restQ: quatFromAxisAngle([0, 1, 0], 0.6) },
  ];

  const posed = (move: Move) =>
    parts.map((p) => composePartTransform(p.rest, p.restQ, move).position);

  it('ONE Move drives every part in the group', () => {
    // This is why Track.parts is a list: a rigid group needs one track.
    const move = groupMoveFromDrag(null, [0, 0, 0], [0, 0, 120], IDENTITY_QUAT);
    for (const p of parts) {
      const out = composePartTransform(p.rest, p.restQ, move);
      near([out.position[2]], [p.rest[2] + 120]);
    }
  });

  it('PRESERVES relative distances — the rigidity guarantee', () => {
    const move = groupMoveFromDrag(
      null,
      [4, 14, 12],
      [200, -60, 35],
      quatFromAxisAngle([0.3, 1, 0.2], 1.9),
    );
    const after = posed(move);

    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        expect(dist(after[i], after[j])).toBeCloseTo(dist(parts[i].rest, parts[j].rest), 4);
      }
    }
  });

  it('preserves relative ORIENTATION across the group', () => {
    const q = quatFromAxisAngle([0, 0, 1], HALF_PI);
    const move = groupMoveFromDrag(null, [0, 0, 0], [0, 0, 0], q);

    // Every part's rotation must be premultiplied by the same q.
    for (const p of parts) {
      const out = composePartTransform(p.rest, p.restQ, move);
      const expected = composePartTransform(p.rest, p.restQ, {
        translate: [0, 0, 0], rotate: q, pivot: [0, 0, 0],
      });
      near(out.rotation, expected.rotation, 5);
    }
  });

  it('accumulates a second drag on top of the first', () => {
    const first = groupMoveFromDrag(null, [0, 0, 0], [0, 0, 50], IDENTITY_QUAT);
    // Gizmo now sits 50 further along Z; drag another 30.
    const second = groupMoveFromDrag(first, [0, 0, 50], [0, 0, 80], IDENTITY_QUAT);

    for (const p of parts) {
      const out = composePartTransform(p.rest, p.restQ, second);
      expect(out.position[2]).toBeCloseTo(p.rest[2] + 80, 4);
    }
  });

  it('accumulates rotation then translation correctly', () => {
    const spin = quatFromAxisAngle([0, 0, 1], HALF_PI);
    const first = groupMoveFromDrag(null, [0, 0, 0], [0, 0, 0], spin);
    const second = groupMoveFromDrag(first, [0, 0, 0], [0, 0, 40], IDENTITY_QUAT);

    // Part at [50,0,0] spins to [0,50,0], then lifts 40 in Z.
    const out = composePartTransform([50, 0, 0], IDENTITY_QUAT, second);
    near([out.position[0], out.position[1], out.position[2]], [0, 50, 40], 4);
  });

  it('stays rigid across 20 chained drags', () => {
    let move: Move | null = null;
    let handle: Vec3 = [0, 0, 0];

    for (let i = 0; i < 20; i++) {
      const next: Vec3 = [handle[0] + 5, handle[1] + 2, handle[2] + 7];
      move = groupMoveFromDrag(move, handle, next, quatFromAxisAngle([0, 1, 0], 0.05));
      handle = next;
    }

    const after = posed(move!);
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        expect(dist(after[i], after[j])).toBeCloseTo(dist(parts[i].rest, parts[j].rest), 3);
      }
    }
  });

  it('a no-op drag leaves parts exactly at rest', () => {
    const move = groupMoveFromDrag(null, [12, 34, 56], [12, 34, 56], IDENTITY_QUAT);
    for (const p of parts) {
      const out = composePartTransform(p.rest, p.restQ, move);
      near([out.position[0], out.position[1], out.position[2]], p.rest, 6);
    }
  });

  it('keeps the composed quaternion unit-length', () => {
    let move: Move | null = null;
    let handle: Vec3 = [0, 0, 0];
    for (let i = 0; i < 30; i++) {
      const next: Vec3 = [handle[0] + 1, handle[1], handle[2]];
      move = groupMoveFromDrag(move, handle, next, quatFromAxisAngle([1, 1, 1], 0.2));
      handle = next;
      expect(Math.hypot(...move.rotate)).toBeCloseTo(1, 5);
    }
  });
});
