/**
 * Draft generation: planner output -> real Operations, authored the way a
 * careful human would author them in THIS app.
 *
 * Best practices applied per step (user-specified):
 *  - the MOVER is always highlighted (style: highlight on the moving parts)
 *  - camera reframes when the action moves to a different region; holds
 *    otherwise (steps are cheap, camera choreography is rot)
 *  - every step gets a template instruction from planner facts — honest
 *    terse truth, no invented prose
 *  - 5s/1s timing defaults, one motion lane per step
 *  - moves go through the SAME parent-frame cluster math as gizmo drags
 *
 * Every operation is tagged meta.plannedBy = 'sequence-planner-v1' plus the
 * planner's reason — the review UI keys off it, and it survives as
 * provenance after accept.
 */
import type { Assembly, CameraPose, Operation, Track } from '@/domain/schema';
import { clusterByParentFrame } from '@/domain/authoring';
import { clusterMoveFromDrag } from '@/domain/rigid';
import { IDENTITY_MOVE, IDENTITY_QUAT } from '@/domain/schema';
import * as THREE from 'three';
import { DIR_VEC, type PartGeom } from './feasibility';
import type { PlannedStep } from './peel';

const uid = () => crypto.randomUUID();

const DIR_WORD: Record<string, string> = {
  '+X': 'out along +X', '-X': 'out along −X',
  '+Y': 'out along +Y', '-Y': 'out along −Y',
  '+Z': 'straight up', '-Z': 'straight down',
};

/** Template instruction from planner facts only. */
function instructionFor(step: PlannedStep): string {
  if (step.unplanned) {
    return (
      `${step.label} could not be sequenced automatically — ` +
      `no collision-free removal direction was found. Sequence these manually.`
    );
  }
  const qty = step.parts.length > 1 && step.label.includes('×') ? step.label : `the ${step.label}`;
  return `Remove ${qty} — ${DIR_WORD[step.dir!] ?? step.dir} until clear.`;
}

/** World AABB centre + radius of a part set (for camera framing). */
function boundsOf(ids: string[], geoms: Map<string, PartGeom>) {
  const box = new THREE.Box3();
  for (const id of ids) {
    const g = geoms.get(id);
    if (g) box.union(g.aabb);
  }
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 10);
  return { centre, radius };
}

/**
 * Camera for a step: three-quarter view of the WHOLE remaining assembly with
 * the mover's full travel visible. v1 framed the moving part tight — "too
 * zoomed in" (user) — a work instruction frames the assembly with the action
 * in context, and the shot must contain where the part GOES, not just where
 * it starts.
 */
function cameraFor(
  step: PlannedStep,
  geoms: Map<string, PartGeom>,
  assemblyCentre: THREE.Vector3,
  assemblyRadius: number,
): CameraPose {
  const { centre: moverCentre } = boundsOf(step.parts, geoms);

  // The shot's subject: assembly centre pulled slightly toward the action.
  const subject = assemblyCentre.clone().lerp(moverCentre, 0.25);

  // Radius must cover the assembly AND the parked position of the mover.
  const parked = moverCentre.clone();
  if (step.dir) {
    const v = DIR_VEC[step.dir];
    parked.addScaledVector(v, step.distance);
  }
  const frameR = Math.max(
    assemblyRadius * 1.45,
    subject.distanceTo(parked) * 1.15,
  );

  const view = new THREE.Vector3(1, -1, 0.65);
  if (step.dir) {
    const d = DIR_VEC[step.dir];
    if (Math.abs(view.clone().normalize().dot(d)) > 0.75) {
      view.set(-1, -1, 0.65);
    }
  }
  const position = subject.clone().add(view.normalize().multiplyScalar(frameR * 2.1));
  return {
    position: [position.x, position.y, position.z],
    target: [subject.x, subject.y, subject.z],
    fov: 45,
  };
}

/** Does the action region differ enough from the previous step to recut? */
function needsRecut(prev: THREE.Vector3 | null, next: THREE.Vector3, assemblyRadius: number): boolean {
  if (!prev) return true;
  return prev.distanceTo(next) > assemblyRadius * 0.35;
}

export interface DraftResult {
  operations: Operation[];
  /** Ids of operations flagged unplanned (leftover step). */
  unplannedOpIds: string[];
}

export function draftOperations(
  steps: PlannedStep[],
  assembly: Assembly,
  geoms: Map<string, PartGeom>,
): DraftResult {
  const all = new THREE.Box3();
  for (const g of geoms.values()) all.union(g.aabb);
  const assemblyCentre = all.getCenter(new THREE.Vector3());
  const assemblyRadius = Math.max(all.getSize(new THREE.Vector3()).length() / 2, 50);

  const operations: Operation[] = [];
  const unplannedOpIds: string[] = [];
  let lastCamCentre: THREE.Vector3 | null = null;

  steps.forEach((step, i) => {
    const id = uid();

    /**
     * Park distance (v2): assembly-scaled and STAGGERED by removal order,
     * exploded-view style. v1 parked at clearance + 3/4 part-length — a
     * bolt parked 20mm from a 500mm machine ("nowhere near far enough"),
     * and every round parked at the same shell, leaving early parts sitting
     * inside later parts' escape paths. Staggering by round means each
     * wave lands one shell farther out than the last.
     */
    const parkDistance = step.unplanned
      ? 0
      : Math.max(step.distance, assemblyRadius * 0.55) +
        assemblyRadius * 0.3 * (step.round - 1);

    // ---- tracks: pure world translation dir*distance, expressed per parent
    // cluster with the SAME math a gizmo drag commits (bolt-circle safe).
    const tracks: Track[] = [];
    if (!step.unplanned && step.dir) {
      const v = DIR_VEC[step.dir];
      const delta: [number, number, number] = [
        v.x * parkDistance, v.y * parkDistance, v.z * parkDistance,
      ];
      for (const cluster of clusterByParentFrame(assembly, step.parts)) {
        const move = clusterMoveFromDrag(
          null, cluster.frame, [0, 0, 0], delta, IDENTITY_QUAT,
        );
        tracks.push({
          id: uid(),
          parts: cluster.parts,
          from: { ...IDENTITY_MOVE },
          to: move,
          start: 0, end: 1, easing: 'easeInOut',
        });
      }
    }

    // ---- camera: recut only when the action moves regions.
    const { centre } = boundsOf(step.parts, geoms);
    let camera: CameraPose | null = null;
    const stepForCam = { ...step, distance: parkDistance };
    if (!step.unplanned && needsRecut(lastCamCentre, centre, assemblyRadius)) {
      camera = cameraFor(stepForCam, geoms, assemblyCentre, assemblyRadius);
      lastCamCentre = centre;
    }

    const op: Operation = {
      id,
      title: step.unplanned
        ? `Review: ${step.label} unsequenced`
        : `Step ${i + 1} — remove ${step.label}`,
      description: instructionFor(step),
      noteCorner: 'tl',
      duration: 5,
      dwell: 1,
      tracks,
      camera,
      annotations: [],
      // The user's rule for planner output: ALWAYS highlight the mover.
      styles: step.unplanned ? [] : [{ parts: step.parts, mode: 'highlight' }],
      section: null,
      meta: {
        plannedBy: 'sequence-planner-v1',
        planReason: step.reason,
        ...(step.unplanned ? { planUnplanned: 'true' } : {}),
      },
    };
    operations.push(op);
    if (step.unplanned) unplannedOpIds.push(id);
  });

  return { operations, unplannedOpIds };
}
