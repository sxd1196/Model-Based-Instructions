/**
 * The evaluator: the single source of truth for "what does the scene look like
 * at time t".
 *
 * This file is intentionally free of three.js. It does its own tiny bit of quat
 * math so the timeline can be evaluated in a test, in a worker, or on a server
 * for headless render/export — none of which should need a WebGL context.
 *
 * Everything here is PURE. Same sequence + same t always yields the same frame.
 * That property is what makes scrubbing, undo, and deterministic video export
 * work without a separate code path.
 */
import type {
  Annotation,
  CameraPose,
  Move,
  Operation,
  PartStyle,
  Quat,
  Sequence,
  Vec3,
} from './schema';
import { IDENTITY_MOVE, IDENTITY_QUAT, ZERO_VEC } from './schema';
import { applyEasing, clamp01, lerp } from './easing';

// ---------------------------------------------------------------- math

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Spherical linear interpolation, XYZW. Handles the double-cover sign flip. */
export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  let [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;

  let cos = ax * bx + ay * by + az * bz + aw * bw;

  // A quaternion and its negation are the same rotation. Without this flip
  // you get the "long way around" spin — a classic CAD animation artifact.
  if (cos < 0) {
    cos = -cos;
    ax = -ax;
    ay = -ay;
    az = -az;
    aw = -aw;
    // note: we negate `a` so we travel the short arc toward b
  }

  // Nearly parallel: fall back to linear + normalize to dodge div-by-zero.
  if (cos > 0.9995) {
    const out: Quat = [
      lerp(ax, bx, t),
      lerp(ay, by, t),
      lerp(az, bz, t),
      lerp(aw, bw, t),
    ];
    return normalizeQuat(out);
  }

  const theta = Math.acos(cos);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;

  return [
    ax * wa + bx * wb,
    ay * wa + by * wb,
    az * wa + bz * wb,
    aw * wa + bw * wb,
  ];
}

export function normalizeQuat(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len === 0) return IDENTITY_QUAT;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

function lerpMove(from: Move, to: Move, t: number): Move {
  return {
    translate: lerpVec3(from.translate, to.translate, t),
    rotate: slerpQuat(from.rotate, to.rotate, t),
    // Pivot is a frame definition, not an animated quantity. Interpolating it
    // would make the rotation axis drift mid-motion. Take the source pivot.
    pivot: from.pivot,
  };
}

// ---------------------------------------------------------------- timing

export interface OperationTiming {
  operation: Operation;
  index: number;
  /** Absolute seconds at which motion begins. */
  startTime: number;
  /** Absolute seconds at which motion ends (before dwell). */
  motionEndTime: number;
  /** Absolute seconds at which the whole step ends (after dwell). */
  endTime: number;
}

/** Lay operations end to end on an absolute timeline. */
export function buildTimeline(sequence: Sequence): OperationTiming[] {
  const out: OperationTiming[] = [];
  let cursor = 0;
  sequence.operations.forEach((operation, index) => {
    const startTime = cursor;
    const motionEndTime = startTime + operation.duration;
    const endTime = motionEndTime + operation.dwell;
    out.push({ operation, index, startTime, motionEndTime, endTime });
    cursor = endTime;
  });
  return out;
}

export function totalDuration(sequence: Sequence): number {
  const timeline = buildTimeline(sequence);
  return timeline.length ? timeline[timeline.length - 1].endTime : 0;
}

/** Which operation is live at absolute time t, and how far through its motion. */
export function locate(
  timeline: OperationTiming[],
  time: number,
): { entry: OperationTiming; localT: number } | null {
  if (!timeline.length) return null;

  const last = timeline[timeline.length - 1];
  if (time >= last.endTime) return { entry: last, localT: 1 };
  if (time <= 0) return { entry: timeline[0], localT: 0 };

  for (const entry of timeline) {
    if (time < entry.endTime) {
      const span = entry.motionEndTime - entry.startTime;
      const localT = span <= 0 ? 1 : clamp01((time - entry.startTime) / span);
      return { entry, localT };
    }
  }
  return { entry: last, localT: 1 };
}

// ---------------------------------------------------------------- frame

export type StyleMode = PartStyle['mode'];

export interface ResolvedFrame {
  /** partId -> accumulated offset from rest pose. Only moved parts appear. */
  poses: Map<string, Move>;
  /** partId -> visual treatment for this instant. */
  styles: Map<string, StyleMode>;
  /** Interpolated camera, or null to leave the camera under user control. */
  camera: CameraPose | null;
  /** Annotations visible right now, from the active operation. */
  annotations: Annotation[];
  activeOperationId: string | null;
  activeOperationIndex: number;
}

const EMPTY_FRAME: ResolvedFrame = {
  poses: new Map(),
  styles: new Map(),
  camera: null,
  annotations: [],
  activeOperationId: null,
  activeOperationIndex: -1,
};

/**
 * Resolve the complete scene state at absolute time `time`.
 *
 * Semantics that matter:
 *  - Operations ACCUMULATE. Every operation before the current one is applied
 *    at its final state, so a part removed in step 2 stays removed in step 9.
 *    This is why you can scrub to any point without replaying from zero.
 *  - The current operation is applied at its eased, partial value.
 *  - Later tracks win on conflict (last write), matching author intuition.
 */
export function resolveFrame(sequence: Sequence, time: number): ResolvedFrame {
  const timeline = buildTimeline(sequence);
  const hit = locate(timeline, time);
  if (!hit) return EMPTY_FRAME;

  const { entry, localT } = hit;
  const poses = new Map<string, Move>();
  const styles = new Map<string, StyleMode>();

  // 1. Bake every completed operation at its end state.
  for (let i = 0; i < entry.index; i++) {
    applyOperation(timeline[i].operation, 1, poses, styles);
  }

  // 2. Apply the live operation partially.
  applyOperation(entry.operation, localT, poses, styles);

  return {
    poses,
    styles,
    camera: resolveCamera(sequence, timeline, entry.index, localT),
    annotations: entry.operation.annotations,
    activeOperationId: entry.operation.id,
    activeOperationIndex: entry.index,
  };
}

function applyOperation(
  operation: Operation,
  opT: number,
  poses: Map<string, Move>,
  styles: Map<string, StyleMode>,
): void {
  for (const style of operation.styles) {
    for (const partId of style.parts) styles.set(partId, style.mode);
  }

  for (const track of operation.tracks) {
    // Map the operation-level progress onto this track's [start,end] window.
    const span = track.end - track.start;
    const raw = span <= 0 ? (opT >= track.end ? 1 : 0) : (opT - track.start) / span;
    const eased = applyEasing(track.easing, clamp01(raw));
    const move = lerpMove(track.from, track.to, eased);
    for (const partId of track.parts) poses.set(partId, move);
  }
}

/**
 * Camera resolution walks BACKWARD to find the last authored pose, so an
 * operation with `camera: null` correctly holds the previous shot instead of
 * snapping home. The fly-in is eased over the current operation only.
 */
function resolveCamera(
  sequence: Sequence,
  timeline: OperationTiming[],
  index: number,
  localT: number,
): CameraPose | null {
  const target = timeline[index]?.operation.camera ?? null;

  let previous: CameraPose | null = sequence.homeCamera;
  for (let i = index - 1; i >= 0; i--) {
    const cam = timeline[i].operation.camera;
    if (cam) {
      previous = cam;
      break;
    }
  }

  if (!target) return previous;
  if (!previous) return target;

  const t = applyEasing('easeInOut', localT);
  return {
    position: lerpVec3(previous.position, target.position, t),
    target: lerpVec3(previous.target, target.target, t),
    fov: lerp(previous.fov, target.fov, t),
  };
}

/** Convenience for the viewer: pose for one part, identity if untouched. */
export function poseFor(frame: ResolvedFrame, partId: string): Move {
  return frame.poses.get(partId) ?? IDENTITY_MOVE;
}

export { IDENTITY_MOVE, IDENTITY_QUAT, ZERO_VEC };
