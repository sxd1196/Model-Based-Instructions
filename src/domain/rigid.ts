/**
 * Rigid-transform algebra for group manipulation.
 *
 * A Move is stored as "rotate about pivot, then translate". That form is great
 * for authoring intent ("swing about the hinge") but awkward to COMPOSE. This
 * module converts to the plain affine form
 *
 *     x -> R*x + d
 *
 * where composition is trivial, then converts back.
 *
 * Why this matters: dragging N parts with one gizmo must produce ONE shared
 * Move on ONE track (that is what `Track.parts` being a list means). Composing
 * a prior move with a new drag delta in Move-form directly is messy; in affine
 * form it is two lines.
 *
 * Pure and renderer-free (AGENTS.md §2.1).
 */
import type { Move, Quat, Vec3 } from './schema';
import { IDENTITY_QUAT } from './schema';
import { applyQuat, multiplyQuat } from './transform';

/** A rigid body transform in plain affine form: x -> rotation*x + translation. */
export interface Rigid {
  rotation: Quat;
  translation: Vec3;
}

export const IDENTITY_RIGID: Rigid = {
  rotation: IDENTITY_QUAT,
  translation: [0, 0, 0],
};

/**
 * Move -> affine.
 *
 * final = R*(x - pivot) + pivot + t
 *       = R*x + (pivot - R*pivot + t)
 */
export function moveToRigid(move: Move): Rigid {
  const rp = applyQuat(move.pivot, move.rotate);
  return {
    rotation: move.rotate,
    translation: [
      move.pivot[0] - rp[0] + move.translate[0],
      move.pivot[1] - rp[1] + move.translate[1],
      move.pivot[2] - rp[2] + move.translate[2],
    ],
  };
}

/**
 * Affine -> Move, using the origin as pivot.
 *
 * With pivot = 0 the two forms coincide, so translate is just d. Authored
 * pivots are preserved elsewhere; this is only used for machine-generated
 * group moves where any equivalent representation is fine.
 */
export function rigidToMove(rigid: Rigid): Move {
  return {
    translate: [...rigid.translation] as Vec3,
    rotate: [...rigid.rotation] as Quat,
    pivot: [0, 0, 0],
  };
}

/**
 * Apply `first`, then `second`.
 *
 * (second ∘ first)(x) = R2*(R1*x + d1) + d2 = (R2*R1)*x + (R2*d1 + d2)
 */
export function composeRigid(first: Rigid, second: Rigid): Rigid {
  const rotated = applyQuat(first.translation, second.rotation);
  return {
    rotation: multiplyQuat(second.rotation, first.rotation),
    translation: [
      rotated[0] + second.translation[0],
      rotated[1] + second.translation[1],
      rotated[2] + second.translation[2],
    ],
  };
}

/**
 * The rigid transform a gizmo drag represents.
 *
 * The gizmo starts at `from` (its handle position when the drag began, with
 * identity orientation relative to that moment) and ends at `to` with rotation
 * `rotation`. Points rotate about the gizmo's start position, then translate.
 *
 *     x -> Q*(x - from) + from + (to - from) = Q*x + (to - Q*from)
 */
export function gizmoDragToRigid(from: Vec3, to: Vec3, rotation: Quat): Rigid {
  const rf = applyQuat(from, rotation);
  return {
    rotation,
    translation: [to[0] - rf[0], to[1] - rf[1], to[2] - rf[2]],
  };
}

/**
 * Total Move for a group drag: whatever the track already had, followed by
 * the new drag delta.
 *
 * Returns a single Move valid for EVERY part in the group, which is what lets
 * a rigid group live on one track instead of N.
 */
export function groupMoveFromDrag(
  priorMove: Move | null,
  gizmoStart: Vec3,
  gizmoEnd: Vec3,
  gizmoRotation: Quat,
): Move {
  const prior = priorMove ? moveToRigid(priorMove) : IDENTITY_RIGID;
  const drag = gizmoDragToRigid(gizmoStart, gizmoEnd, gizmoRotation);
  return rigidToMove(composeRigid(prior, drag));
}

/** Apply a rigid transform to a point. */
export function applyRigid(rigid: Rigid, point: Vec3): Vec3 {
  const r = applyQuat(point, rigid.rotation);
  return [
    r[0] + rigid.translation[0],
    r[1] + rigid.translation[1],
    r[2] + rigid.translation[2],
  ];
}
