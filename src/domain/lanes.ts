/**
 * Pure helpers behind the motion-lanes UI.
 *
 * The lanes show each motion as a plain sentence — "↑ Z 120mm · ⟳ Z 90°" —
 * and accept typed edits in those terms. Everything here converts between
 * that human vocabulary and the schema's quaternion/fraction storage, plus
 * the merge logic that collapses per-parent-cluster tracks into one visual
 * lane when they carry identical motion.
 *
 * Renderer-free (AGENTS.md §2.1).
 */
import type { Move, Operation, Quat, Track, Vec3 } from './schema';
import { IDENTITY_QUAT } from './schema';
import { quatFromAxisAngle } from './transform';

export type AxisName = 'X' | 'Y' | 'Z' | 'custom';

export interface AxisAngle {
  axis: AxisName;
  /** Unit vector actually stored; meaningful when axis === 'custom'. */
  vector: Vec3;
  /** Degrees. */
  angle: number;
}

const CARDINALS: Array<{ name: Exclude<AxisName, 'custom'>; v: Vec3 }> = [
  { name: 'X', v: [1, 0, 0] },
  { name: 'Y', v: [0, 1, 0] },
  { name: 'Z', v: [0, 0, 1] },
];

/** ~1 degree of axis tilt — hand-dragged ring rotations display as clean cardinals. */
const CARDINAL_TOLERANCE = 0.9998;

/**
 * Decompose a quaternion to axis + angle in degrees.
 *
 * Near-cardinal axes snap to X/Y/Z for DISPLAY (a work instruction should
 * say 90° about Z, not 89.7° about [0.01, 0.02, 0.9996]); the sign convention
 * keeps the angle positive by flipping the axis when needed.
 */
export function quatToAxisAngle(q: Quat): AxisAngle {
  const [x, y, z, w] = q;
  const clampedW = Math.max(-1, Math.min(1, w));
  let angle = 2 * Math.acos(Math.abs(clampedW));
  const s = Math.sqrt(Math.max(0, 1 - clampedW * clampedW));

  if (angle < 1e-6 || s < 1e-9) {
    return { axis: 'Z', vector: [0, 0, 1], angle: 0 };
  }

  // Normalize sign so w >= 0 (same rotation, positive-angle form).
  const sign = w < 0 ? -1 : 1;
  let v: Vec3 = [(x * sign) / s, (y * sign) / s, (z * sign) / s];

  for (const c of CARDINALS) {
    const dot = v[0] * c.v[0] + v[1] * c.v[1] + v[2] * c.v[2];
    if (dot > CARDINAL_TOLERANCE) {
      return { axis: c.name, vector: c.v, angle: toDeg(angle) };
    }
    if (dot < -CARDINAL_TOLERANCE) {
      // Flip to the positive cardinal with a negative angle: '-90° about Z'
      // reads better than '90° about -Z'.
      return { axis: c.name, vector: c.v, angle: -toDeg(angle) };
    }
  }

  return { axis: 'custom', vector: v, angle: toDeg(angle) };
}

/** Compose an axis name (or custom vector) + degrees into a quaternion. */
export function axisAngleToQuat(axis: AxisName, vector: Vec3, angleDeg: number): Quat {
  if (Math.abs(angleDeg) < 1e-9) return IDENTITY_QUAT;
  const v = axis === 'custom' ? vector : CARDINALS.find((c) => c.name === axis)!.v;
  return quatFromAxisAngle(v, (angleDeg * Math.PI) / 180);
}

const toDeg = (rad: number) => Math.round(((rad * 180) / Math.PI) * 100) / 100;

// ---------------------------------------------------------------- lanes

export interface Lane {
  /** Track ids merged into this visual lane. */
  trackIds: string[];
  /** Every part driven, across all merged tracks. */
  parts: string[];
  move: Move;
  /** Fractions of the step, straight from the schema. */
  start: number;
  end: number;
}

const sameVec = (a: Vec3, b: Vec3) =>
  Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6;

const sameQuat = (a: Quat, b: Quat) => {
  // q and -q are the same rotation.
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  return Math.abs(Math.abs(dot) - 1) < 1e-9;
};

/** True when two tracks would read as the SAME motion to a human. */
export function tracksMergeable(a: Track, b: Track): boolean {
  return (
    Math.abs(a.start - b.start) < 1e-6 &&
    Math.abs(a.end - b.end) < 1e-6 &&
    a.easing === b.easing &&
    sameVec(a.to.translate, b.to.translate) &&
    sameQuat(a.to.rotate, b.to.rotate)
  );
}

/**
 * Collapse an operation's tracks into visual lanes.
 *
 * A sub-assembly drag writes one track per parent cluster (frame math), but
 * the author performed ONE motion — showing nine identical lanes for it is
 * noise. Tracks with identical motion + timing merge into one lane; they
 * split back into separate lanes only when the author staggers them.
 *
 * NOTE: merged tracks may carry different translate values in their own
 * parent frames for the same world motion. Merging on equality is therefore
 * conservative — clusters under rotated parents stay separate lanes. That is
 * accepted: over-merging would edit motions the author sees as distinct.
 */
export function buildLanes(operation: Operation): Lane[] {
  const lanes: Lane[] = [];

  for (const track of operation.tracks) {
    const host = lanes.find((lane) => {
      const first = operation.tracks.find((t) => t.id === lane.trackIds[0])!;
      return tracksMergeable(first, track);
    });

    if (host) {
      host.trackIds.push(track.id);
      host.parts.push(...track.parts);
    } else {
      lanes.push({
        trackIds: [track.id],
        parts: [...track.parts],
        move: track.to,
        start: track.start,
        end: track.end,
      });
    }
  }

  // Waterfall order: earlier motions first, then longer ones.
  lanes.sort((a, b) => a.start - b.start || a.end - b.end);
  return lanes;
}

// ---------------------------------------------------------------- display

/** "↑ Z 120mm · ⟳ Z 90°" — the collapsed lane's sentence. */
export function describeMove(move: Move): string {
  const parts: string[] = [];

  const t = move.translate;
  const mag = Math.hypot(t[0], t[1], t[2]);
  if (mag > 1e-6) {
    const axes: Array<[string, number, string, string]> = [
      ['X', t[0], '→', '←'],
      ['Y', t[1], '↑', '↓'],
      ['Z', t[2], '⤴', '⤵'],
    ];
    const dominant = axes.reduce((m, x) => (Math.abs(x[1]) > Math.abs(m[1]) ? x : m));
    const isAxial = Math.abs(Math.abs(dominant[1]) - mag) < 1e-6;
    if (isAxial) {
      const [name, value, pos, neg] = dominant;
      parts.push(`${value >= 0 ? pos : neg} ${name} ${fmt(Math.abs(value))}mm`);
    } else {
      parts.push(`↗ ${fmt(mag)}mm`);
    }
  }

  const aa = quatToAxisAngle(move.rotate);
  if (Math.abs(aa.angle) > 1e-6) {
    parts.push(`⟳ ${aa.axis === 'custom' ? '∗' : aa.axis} ${fmt(aa.angle)}°`);
  }

  return parts.length ? parts.join(' · ') : 'no motion';
}

const fmt = (n: number) => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

// ---------------------------------------------------------------- timing

/** Fraction -> seconds within a step, for display. */
export function fractionToSeconds(fraction: number, duration: number): number {
  return Math.round(fraction * duration * 100) / 100;
}

/** Seconds -> clamped fraction of a step, for storage. */
export function secondsToFraction(seconds: number, duration: number): number {
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(1, seconds / duration));
}

/**
 * Snap a dragged edge (fraction) to the nearby edges of OTHER lanes, so
 * "then" means exactly then — no 0.02s gaps from imprecise mouse work.
 */
export function snapEdge(
  fraction: number,
  otherEdges: number[],
  tolerance = 0.03,
): number {
  let best = fraction;
  let bestDist = tolerance;
  for (const edge of otherEdges) {
    const d = Math.abs(edge - fraction);
    if (d < bestDist) {
      best = edge;
      bestDist = d;
    }
  }
  return Math.max(0, Math.min(1, best));
}
