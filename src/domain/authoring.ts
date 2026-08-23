/**
 * Authoring helpers: turning direct manipulation into schema Moves.
 *
 * Pure and renderer-free (AGENTS.md §2.1) so the whole drag/select pipeline is
 * testable without WebGL. The viewer supplies raw numbers from three.js; every
 * decision about what those numbers MEAN lives here.
 */
import type { Assembly, Move, PartNode, Quat, Vec3 } from './schema';
import { IDENTITY_QUAT } from './schema';
import { applyQuat, multiplyQuat } from './transform';

// ---------------------------------------------------------------- selection

/**
 * Walk up from a clicked node to the outermost ancestor that is still a
 * "meaningful" selection unit.
 *
 * Clicking a bolt head should select the whole bolt, not the head mesh —
 * otherwise authoring a 500-part teardown means clicking 3000 sub-meshes.
 * Stops below the root so you never select the entire assembly by accident.
 */
export function resolveSelectionTarget(
  assembly: Assembly,
  clickedId: string,
  opts: { deep?: boolean } = {},
): string | null {
  const node = assembly.parts[clickedId];
  if (!node) return null;
  if (opts.deep) return clickedId; // alt-click: take the literal mesh

  let current: PartNode = node;
  while (current.parentId) {
    const parent = assembly.parts[current.parentId];
    if (!parent) break;
    // Never climb into a node with no parent of its own — that is the root
    // container, and selecting it would select everything.
    if (!parent.parentId) break;
    current = parent;
  }
  return current.id;
}

/** Every descendant of a node, inclusive. Used to move a sub-assembly. */
export function collectSubtree(assembly: Assembly, rootId: string): string[] {
  const byParent = new Map<string | null, string[]>();
  for (const node of Object.values(assembly.parts)) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node.id);
    byParent.set(node.parentId, list);
  }

  const out: string[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    for (const child of byParent.get(id) ?? []) stack.push(child);
  }
  return out;
}

/** Mesh ids only — groups carry no geometry and cannot be posed directly. */
export function selectableParts(assembly: Assembly, ids: string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    for (const desc of collectSubtree(assembly, id)) {
      if (!assembly.parts[desc]?.isGroup) out.add(desc);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------- drag

/**
 * Invert `composePartTransform`: given where the user dragged a part to,
 * recover the Move that produces that pose.
 *
 * This is the heart of gizmo authoring. It must be an exact inverse — if it
 * drifts, every drag introduces error that compounds across a sequence.
 *
 * Forward:  spun = rotate(rest - pivot) + pivot;  final = spun + translate
 * Inverse:  translate = final - (rotate(rest - pivot) + pivot)
 */
export function moveFromDrag(
  restTranslate: Vec3,
  restRotate: Quat,
  draggedPosition: Vec3,
  draggedRotation: Quat,
  pivot: Vec3 = [0, 0, 0],
): Move {
  // Recover the authored rotation: dragged = authored * rest
  //                        =>     authored = dragged * rest^-1
  const rotate = multiplyQuat(draggedRotation, conjugate(restRotate));

  const rel: Vec3 = [
    restTranslate[0] - pivot[0],
    restTranslate[1] - pivot[1],
    restTranslate[2] - pivot[2],
  ];
  const spun = applyQuat(rel, rotate);

  return {
    translate: [
      draggedPosition[0] - (spun[0] + pivot[0]),
      draggedPosition[1] - (spun[1] + pivot[1]),
      draggedPosition[2] - (spun[2] + pivot[2]),
    ],
    rotate,
    pivot,
  };
}

/** Unit-quaternion inverse. */
export function conjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

// ---------------------------------------------------------------- snapping

/**
 * Snap a translation to a grid. CAD work is full of round numbers, and a drag
 * that lands on 24.9873mm reads as sloppy in a work instruction.
 */
export function snapTranslate(v: Vec3, step: number): Vec3 {
  if (step <= 0) return v;
  return [
    Math.round(v[0] / step) * step,
    Math.round(v[1] / step) * step,
    Math.round(v[2] / step) * step,
  ];
}

/**
 * Constrain a translation to its dominant axis.
 *
 * Most assembly motions are pure axial pulls — a bolt comes straight out, a
 * cover lifts straight up. Free 3D dragging almost never produces a clean
 * axis, so this makes the common case correct by default.
 */
export function constrainToDominantAxis(v: Vec3, threshold = 0.15): Vec3 {
  const mags = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
  const max = Math.max(...mags);
  if (max === 0) return v;

  const out: Vec3 = [0, 0, 0];
  const axis = mags.indexOf(max);
  out[axis] = v[axis];

  // If another axis is comparable, the user meant a diagonal — leave it alone.
  const others = mags.filter((_, i) => i !== axis);
  if (others.some((m) => m / max > 1 - threshold)) return v;

  return out;
}

/** True when a Move is indistinguishable from no motion at all. */
export function isIdentityMove(move: Move, epsilon = 1e-6): boolean {
  const noTranslate = move.translate.every((n) => Math.abs(n) < epsilon);
  const noRotate = Math.abs(Math.abs(move.rotate[3]) - 1) < epsilon;
  return noTranslate && noRotate;
}

// ---------------------------------------------------------------- drag policy

export interface DragPolicy {
  /** Grid step in mm; 0 disables. */
  snap: number;
  /** Collapse near-axial translations onto their dominant axis. */
  axisLock: boolean;
}

/**
 * Post-process a raw drag Move with snap and axis lock.
 *
 * Skipped entirely when the drag carries rotation: snap and axis lock are
 * translation aids, and quantizing the translate of a rotated transform
 * corrupts the result (the original rotate-fling bug).
 *
 * SINGLE SOURCE OF TRUTH for drag shaping — the live preview during a drag
 * and the committed move on release both call this, which is what guarantees
 * the part lands exactly where the preview showed it.
 */
export function applyDragPolicy(move: Move, policy: DragPolicy): Move {
  const rotated = Math.abs(Math.abs(move.rotate[3]) - 1) > 1e-6;
  if (rotated) return move;

  let out = move;
  if (policy.axisLock) {
    out = { ...out, translate: constrainToDominantAxis(out.translate) };
  }
  if (policy.snap > 0) {
    out = { ...out, translate: snapTranslate(out.translate, policy.snap) };
  }
  return out;
}

/**
 * The complete authored Move for a SINGLE part drag: inverse of the pose
 * composition, pivoted at the part's rest position, shaped by policy.
 */
export function effectiveDragMove(
  restTranslate: Vec3,
  restRotate: Quat,
  draggedPosition: Vec3,
  draggedRotation: Quat,
  policy: DragPolicy,
): Move {
  return applyDragPolicy(
    moveFromDrag(restTranslate, restRotate, draggedPosition, draggedRotation, restTranslate),
    policy,
  );
}

// ---------------------------------------------------------------- gizmo

export interface GizmoState {
  visible: boolean;
  /** Why the gizmo is hidden, in words a user can act on. Null when visible. */
  reason: string | null;
  /** True when the drag will move several parts rigidly. */
  isGroup: boolean;
}

/**
 * Decide whether the drag gizmo should appear, and if not, WHY.
 *
 * Extracted as a pure function because the original inline condition silently
 * required an active operation: with no step created yet the gizmo rendered
 * nothing and gave no explanation, which reads as "the app is broken".
 *
 * The rule now: the gizmo appears whenever something is selected. There are
 * no modes — the combined widget carries translate arrows and rotate rings
 * at once, so mode state (and the buttons to switch it) no longer exist.
 * Committing a drag with no step creates one (see commitDrag).
 */
export function resolveGizmoState(args: {
  selectionCount: number;
  hasSequence: boolean;
}): GizmoState {
  const { selectionCount, hasSequence } = args;
  const isGroup = selectionCount > 1;

  if (!hasSequence) {
    return { visible: false, reason: 'Load a model first', isGroup };
  }
  if (selectionCount === 0) {
    return { visible: false, reason: 'Select a part to move it', isGroup };
  }

  return { visible: true, reason: null, isGroup };
}

/**
 * Selecting a TREE ROW.
 *
 * Clicking a group row selects the whole sub-assembly; clicking a leaf selects
 * that part. This replaces the old "Sub-asm" toolbar button — the tree already
 * expresses hierarchy, so selecting a branch should just work.
 */
export function selectFromTreeRow(
  assembly: Assembly,
  nodeId: string,
): string[] {
  const node = assembly.parts[nodeId];
  if (!node) return [];
  // selectableParts already walks the subtree and drops group containers.
  return selectableParts(assembly, [nodeId]);
}

/**
 * The chain of ancestor ids for a part, outermost first.
 *
 * The tree uses this to auto-expand and reveal a part picked in the viewport.
 */
export function ancestorsOf(assembly: Assembly, partId: string): string[] {
  const out: string[] = [];
  let current = assembly.parts[partId];
  const seen = new Set<string>();

  while (current?.parentId) {
    // Defensive: a malformed export could contain a parent cycle.
    if (seen.has(current.parentId)) break;
    seen.add(current.parentId);
    out.unshift(current.parentId);
    current = assembly.parts[current.parentId];
  }
  return out;
}

/**
 * Which tree row should be scrolled into view for a given selection.
 *
 * Picking one part reveals that part. Picking a group reveals their common
 * ancestor rather than scrolling to an arbitrary member.
 */
export function revealTargetFor(
  assembly: Assembly,
  selection: string[],
): string | null {
  if (!selection.length) return null;
  if (selection.length === 1) return selection[0];

  const chains = selection.map((id) => [...ancestorsOf(assembly, id), id]);
  let common: string | null = null;
  for (let depth = 0; ; depth++) {
    const at = chains[0][depth];
    if (at === undefined) break;
    if (!chains.every((c) => c[depth] === at)) break;
    common = at;
  }
  return common ?? selection[0];
}

// ---------------------------------------------------------------- explode

/**
 * Radial explode offsets from the assembly centroid.
 *
 * Not sequence inference — just a better blank page than every part sitting at
 * the origin. The author then edits from here.
 */
export function radialExplode(
  assembly: Assembly,
  partIds: string[],
  center: Vec3,
  factor: number,
): Map<string, Move> {
  const out = new Map<string, Move>();
  for (const id of partIds) {
    const node = assembly.parts[id];
    if (!node || node.isGroup) continue;

    const dir: Vec3 = [
      node.restTranslate[0] - center[0],
      node.restTranslate[1] - center[1],
      node.restTranslate[2] - center[2],
    ];
    const len = Math.hypot(...dir);
    // A part sitting exactly at the centroid has no meaningful direction.
    if (len < 1e-6) continue;

    out.set(id, {
      translate: [dir[0] * factor, dir[1] * factor, dir[2] * factor],
      rotate: IDENTITY_QUAT,
      pivot: [0, 0, 0],
    });
  }
  return out;
}

/** Centroid of the given parts' rest positions. */
export function centroidOf(assembly: Assembly, partIds: string[]): Vec3 {
  let n = 0;
  const sum: Vec3 = [0, 0, 0];
  for (const id of partIds) {
    const node = assembly.parts[id];
    if (!node || node.isGroup) continue;
    sum[0] += node.restTranslate[0];
    sum[1] += node.restTranslate[1];
    sum[2] += node.restTranslate[2];
    n++;
  }
  return n === 0 ? [0, 0, 0] : [sum[0] / n, sum[1] / n, sum[2] / n];
}
