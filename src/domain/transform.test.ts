/**
 * Rotation and pivot tests.
 *
 * Rotation is fully supported by the schema and evaluator but has no UI yet,
 * which makes it the most likely place for a silent bug. These tests pin the
 * semantics now so the UI can be built against a verified foundation.
 *
 * The final block cross-checks the pure implementation against three.js doing
 * the same operations, which is what SceneBinder uses at runtime.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyQuat,
  composePartTransform,
  multiplyQuat,
  quatFromAxisAngle,
} from './transform';
import { resolveFrame, poseFor, slerpQuat } from './evaluate';
import { IDENTITY_QUAT, Sequence as SequenceSchema, type Quat, type Vec3 } from './schema';

const near = (a: number[], b: number[], p = 5) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], p));

const HALF_PI = Math.PI / 2;

describe('applyQuat', () => {
  it('rotates +X to +Y about Z by 90 degrees', () => {
    near(applyQuat([1, 0, 0], quatFromAxisAngle([0, 0, 1], HALF_PI)), [0, 1, 0]);
  });

  it('leaves the rotation axis unchanged', () => {
    near(applyQuat([0, 0, 5], quatFromAxisAngle([0, 0, 1], 1.234)), [0, 0, 5]);
  });

  it('preserves length', () => {
    const r = applyQuat([3, 4, 5], quatFromAxisAngle([1, 2, 3], 0.9));
    expect(Math.hypot(...r)).toBeCloseTo(Math.hypot(3, 4, 5), 5);
  });

  it('identity is a no-op', () => {
    near(applyQuat([7, -2, 3], IDENTITY_QUAT), [7, -2, 3]);
  });
});

describe('multiplyQuat', () => {
  it('composes two 90 degree turns into 180', () => {
    const q = quatFromAxisAngle([0, 0, 1], HALF_PI);
    near(applyQuat([1, 0, 0], multiplyQuat(q, q)), [-1, 0, 0]);
  });

  it('matches three.js Quaternion.multiply', () => {
    const a = quatFromAxisAngle([1, 0, 0], 0.7);
    const b = quatFromAxisAngle([0, 1, 0], 1.1);
    const expected = new THREE.Quaternion(...a).multiply(new THREE.Quaternion(...b));
    near(multiplyQuat(a, b), [expected.x, expected.y, expected.z, expected.w]);
  });
});

describe('composePartTransform — pivot semantics', () => {
  const rest: Vec3 = [100, 0, 0];

  it('rotates about the origin by default', () => {
    const { position } = composePartTransform(rest, IDENTITY_QUAT, {
      translate: [0, 0, 0],
      rotate: quatFromAxisAngle([0, 0, 1], HALF_PI),
      pivot: [0, 0, 0],
    });
    near(position, [0, 100, 0]);
  });

  it('rotating about the part own position does not move it', () => {
    // A bolt spinning in place must not translate.
    const { position } = composePartTransform(rest, IDENTITY_QUAT, {
      translate: [0, 0, 0],
      rotate: quatFromAxisAngle([0, 0, 1], 1.0),
      pivot: rest,
    });
    near(position, rest);
  });

  it('swings about an offset pivot — the hinge case', () => {
    // Door panel at x=100, hinge at x=50. A 180 degree swing about the hinge
    // must land it at x=0, not mirror it through the origin.
    const { position } = composePartTransform([100, 0, 0], IDENTITY_QUAT, {
      translate: [0, 0, 0],
      rotate: quatFromAxisAngle([0, 0, 1], Math.PI),
      pivot: [50, 0, 0],
    });
    near(position, [0, 0, 0]);
  });

  it('applies rotation BEFORE translation', () => {
    // If translate were applied first, the pivot would move with it and the
    // result would be [0, 110, 0] instead.
    const { position } = composePartTransform([100, 0, 0], IDENTITY_QUAT, {
      translate: [0, 10, 0],
      rotate: quatFromAxisAngle([0, 0, 1], HALF_PI),
      pivot: [0, 0, 0],
    });
    near(position, [0, 110, 0]);
  });

  it('pure translation ignores pivot entirely', () => {
    const { position } = composePartTransform([5, 5, 5], IDENTITY_QUAT, {
      translate: [10, 0, 0],
      rotate: IDENTITY_QUAT,
      pivot: [999, 999, 999],
    });
    near(position, [15, 5, 5]);
  });

  it('identity move leaves the part exactly at rest', () => {
    const restQ = quatFromAxisAngle([0, 1, 0], 0.42);
    const { position, rotation } = composePartTransform([3, 4, 5], restQ, {
      translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0],
    });
    near(position, [3, 4, 5]);
    near(rotation, restQ);
  });

  it('composes onto a part that already has CAD rotation', () => {
    // The demo gearbox rotates cylinders by 90 degrees about X; authored
    // rotation must stack on that, not replace it.
    const restQ = quatFromAxisAngle([1, 0, 0], HALF_PI);
    const authored = quatFromAxisAngle([1, 0, 0], HALF_PI);
    const { rotation } = composePartTransform([0, 0, 0], restQ, {
      translate: [0, 0, 0], rotate: authored, pivot: [0, 0, 0],
    });
    near(rotation, quatFromAxisAngle([1, 0, 0], Math.PI));
  });
});

describe('rotation through the evaluator', () => {
  const spin = (deg: number) => quatFromAxisAngle([0, 0, 1], (deg * Math.PI) / 180);

  const sequence = SequenceSchema.parse({
    id: 's', name: 'spin',
    assembly: { id: 'a', name: 'a', modelUrl: '/x.glb', parts: {} },
    operations: [{
      id: 'op', title: 'Unscrew', duration: 2, dwell: 0,
      tracks: [{
        id: 't', parts: ['bolt'],
        from: { translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
        to: { translate: [0, 0, 30], rotate: spin(180), pivot: [0, 0, 0] },
        start: 0, end: 1, easing: 'linear',
      }],
    }],
  });

  it('interpolates rotation and translation together', () => {
    const mid = poseFor(resolveFrame(sequence, 1), 'bolt');
    expect(mid.translate[2]).toBeCloseTo(15);
    // Halfway through a 180 degree turn is 90 degrees.
    near(mid.rotate, spin(90), 4);
  });

  it('reaches the authored rotation exactly at the end', () => {
    near(poseFor(resolveFrame(sequence, 2), 'bolt').rotate, spin(180), 4);
  });

  it('keeps interpolated quaternions unit-length throughout', () => {
    for (let i = 0; i <= 20; i++) {
      const q = poseFor(resolveFrame(sequence, (i / 20) * 2), 'bolt').rotate;
      expect(Math.hypot(...q)).toBeCloseTo(1, 5);
    }
  });

  it('does not take the long way around for a small turn', () => {
    // The double-cover trap: interpolating toward a negated quaternion must
    // travel ~1 degree, not ~359.
    const tiny = spin(1);
    const negated: Quat = [-tiny[0], -tiny[1], -tiny[2], -tiny[3]];
    const mid = slerpQuat(IDENTITY_QUAT, negated, 0.5);
    // Half of 1 degree => w ~= cos(0.25 deg) ~= 0.99999
    expect(Math.abs(mid[3])).toBeGreaterThan(0.9999);
  });
});

describe('cross-check: pure implementation vs three.js', () => {
  /** Mirrors SceneBinder.applyPoses using real three.js objects. */
  function threeCompose(restT: Vec3, restQ: Quat, move: {
    translate: Vec3; rotate: Quat; pivot: Vec3;
  }) {
    const base = new THREE.Vector3(...restT);
    const baseQ = new THREE.Quaternion(...restQ);
    const q = new THREE.Quaternion(...move.rotate);
    const pivot = new THREE.Vector3(...move.pivot);

    const offset = base.clone().sub(pivot).applyQuaternion(q).add(pivot);
    const position = offset.add(new THREE.Vector3(...move.translate));
    const rotation = baseQ.clone().premultiply(q);

    return { position, rotation };
  }

  const cases = [
    { t: [100, 0, 0], q: IDENTITY_QUAT, m: { translate: [0, 50, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] } },
    { t: [100, 0, 0], q: IDENTITY_QUAT, m: { translate: [0, 0, 0], rotate: quatFromAxisAngle([0, 0, 1], HALF_PI), pivot: [0, 0, 0] } },
    { t: [100, 0, 0], q: IDENTITY_QUAT, m: { translate: [0, 0, 0], rotate: quatFromAxisAngle([0, 0, 1], Math.PI), pivot: [50, 0, 0] } },
    { t: [10, 20, 30], q: quatFromAxisAngle([1, 0, 0], HALF_PI), m: { translate: [5, -5, 15], rotate: quatFromAxisAngle([0, 1, 0], 0.83), pivot: [3, 3, 3] } },
    { t: [-7, 2, 9], q: quatFromAxisAngle([0, 1, 1], 1.3), m: { translate: [0, 0, -40], rotate: quatFromAxisAngle([1, 1, 0], -2.1), pivot: [-7, 2, 9] } },
  ] as const;

  it.each(cases.map((c, i) => [i, c] as const))(
    'case %i matches three.js for position and rotation',
    (_i, c) => {
      const pure = composePartTransform(c.t as Vec3, c.q as Quat, c.m as never);
      const ref = threeCompose(c.t as Vec3, c.q as Quat, c.m as never);
      near(pure.position, [ref.position.x, ref.position.y, ref.position.z], 4);
      near(pure.rotation, [ref.rotation.x, ref.rotation.y, ref.rotation.z, ref.rotation.w], 4);
    },
  );
});
