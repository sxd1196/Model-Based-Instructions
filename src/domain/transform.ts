/**
 * Reference implementation of part pose composition.
 *
 * `SceneBinder` does this same math with reused three.js scratch objects to
 * stay allocation-free in the frame loop (AGENTS.md §7). That version cannot
 * be unit tested without a WebGL context, so this pure array-based twin is the
 * spec, and `transform.test.ts` asserts the two agree numerically.
 *
 * If you change the pose math in SceneBinder, change it here too — the
 * cross-check test will fail loudly if they drift.
 */
import type { Move, Quat, Vec3 } from './schema';

/** Rotate vector v by quaternion q (XYZW). */
export function applyQuat(v: Vec3, q: Quat): Vec3 {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;

  // t = 2 * cross(q.xyz, v);  v' = v + qw * t + cross(q.xyz, t)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);

  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Hamilton product a*b (XYZW), i.e. apply b then a. */
export function multiplyQuat(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * Compose a part's final local transform from its CAD rest pose and an
 * authored Move.
 *
 * Order is: rotate the rest position about `pivot`, then add `translate`.
 * Rotating first is what makes "swing the door open about its hinge" work —
 * translating first would move the hinge.
 */
export function composePartTransform(
  restTranslate: Vec3,
  restRotate: Quat,
  move: Move,
): { position: Vec3; rotation: Quat } {
  const rel: Vec3 = [
    restTranslate[0] - move.pivot[0],
    restTranslate[1] - move.pivot[1],
    restTranslate[2] - move.pivot[2],
  ];

  const spun = applyQuat(rel, move.rotate);

  return {
    position: [
      spun[0] + move.pivot[0] + move.translate[0],
      spun[1] + move.pivot[1] + move.translate[1],
      spun[2] + move.pivot[2] + move.translate[2],
    ],
    // Premultiply: the authored rotation is applied in the parent frame,
    // on top of whatever orientation the CAD gave the part.
    rotation: multiplyQuat(move.rotate, restRotate),
  };
}

/** Quaternion for a rotation of `angleRad` about a unit-ish axis. */
export function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const h = angleRad / 2;
  const s = Math.sin(h) / len;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}
