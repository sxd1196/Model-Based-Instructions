/**
 * The peel loop v2: hierarchical assembly-by-disassembly.
 *
 * v1 planned individual MESHES with a direct-parent-only subassembly pass —
 * which tore multi-mesh parts apart (Bolt = Head + Shank leaving in
 * different steps) and never saw nested subassemblies. v2's atomic rule:
 *
 *   THE PLANNING UNIT IS A NODE OF THE BOM TREE, TRIED LARGEST-FIRST.
 *
 * Each round walks the remaining forest top-down: can this whole subtree
 * leave as one rigid unit? If yes -> one step. If not, recurse into its
 * children. A leaf GROUP that holds only meshes (a physical part authored
 * as several bodies) is atomic — it either leaves whole or waits. Meshes
 * never travel alone unless they are direct leaf parts.
 *
 * Identical siblings (same signature set + name family) that are free in
 * the same round along the same direction batch into ONE step — but only
 * the free ones: 10 bolts where 4 are accessible batches the 4; the rest
 * wait for their blockers (user: "only 4 can move together — that logic
 * needs to somehow be determined". This is that logic.)
 *
 * Direction choice is contact-normal-ranked (see feasibility.rankedDirections)
 * and collision checks use the penetration budget — both v2 fixes for
 * "parts running into each other".
 */
import type { Assembly } from '@/domain/schema';
import {
  collectPartGeoms,
  feasibleDirections,
  removalDistance,
  resetContactCache,
  type Dir,
  type PartGeom,
} from './feasibility';
import * as THREE from 'three';

export interface PlannedStep {
  /** Mesh ids that move in this step (a unit's meshes, or an identical batch). */
  parts: string[];
  dir: Dir | null;
  /** World-mm travel for the authored motion. */
  distance: number;
  /** Human-readable label ("SUB_Cover", "4× Bolt_M8"). */
  label: string;
  /** Why the planner believes this step is feasible — shown in review. */
  reason: string;
  /** Peel round the step came from (also drives park-distance staggering). */
  round: number;
  /** True for the leftover step when the peel jammed. */
  unplanned?: boolean;
}

/** A BOM-tree node the planner can move as one rigid unit. */
interface Unit {
  /** Group id (or mesh id for loose leaf meshes). */
  nodeId: string;
  name: string;
  /** All descendant mesh ids — what actually moves. */
  meshes: string[];
  /** Child units (empty for atomic units). */
  children: Unit[];
  /** Depth in the tree (0 = root children), for diagnostics. */
  depth: number;
}

function familyName(name: string): string {
  return name.replace(/[_\s-]?\d+([_\s-]?[A-Za-z]+)?$/i, '') || name;
}

/** Build the unit forest from the assembly tree, meshes only at the leaves. */
function buildUnitForest(assembly: Assembly, geoms: Map<string, PartGeom>): Unit[] {
  const parts = assembly.parts;
  const childrenOf = new Map<string | null, string[]>();
  for (const p of Object.values(parts)) {
    const key = p.parentId ?? null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(p.id);
  }

  const build = (id: string, depth: number): Unit | null => {
    const p = parts[id];
    if (!p) return null;
    if (!p.isGroup) {
      // A loose mesh directly under this level.
      if (!geoms.has(id)) return null;
      return { nodeId: id, name: p.name, meshes: [id], children: [], depth };
    }
    const kids = (childrenOf.get(id) ?? [])
      .map((c) => build(c, depth + 1))
      .filter((u): u is Unit => !!u);
    const meshes = kids.flatMap((k) => k.meshes);
    if (!meshes.length) return null;
    // NOTE (v2 fix): an earlier version collapsed groups whose children are
    // all meshes into atomic units, intending "Bolt = Head + Shank moves
    // whole". But a subassembly of simple one-mesh parts (SUB_Housing =
    // Body + Flange) is indistinguishable by shape — and collapsing it made
    // its parts individually unreachable, jamming the peel. Children stay
    // exposed; multi-body cohesion comes from largest-first ordering (the
    // parent unit is ALWAYS tried before its pieces).
    return { nodeId: id, name: p.name, meshes, children: kids, depth };
  };

  return (childrenOf.get(null) ?? [])
    .map((id) => build(id, 0))
    .filter((u): u is Unit => !!u);
}

/** Do all of this unit's meshes remain un-peeled? */
const fullyRemaining = (u: Unit, remaining: Map<string, PartGeom>) =>
  u.meshes.every((m) => remaining.has(m));

/** Signature of a unit for identical-sibling batching. */
const unitSig = (u: Unit, geoms: Map<string, PartGeom>) =>
  u.meshes.map((m) => geoms.get(m)?.signature ?? '?').sort().join('|');

export const __dbgForest = buildUnitForest;

export function planSequence(
  assembly: Assembly,
  index: Map<string, THREE.Object3D>,
): PlannedStep[] {
  resetContactCache();
  const geoms = collectPartGeoms(index);
  const remaining = new Map<string, PartGeom>(geoms);
  const forest = buildUnitForest(assembly, geoms);
  const steps: PlannedStep[] = [];
  let round = 0;

  while (remaining.size > 0) {
    round++;
    if (round > 300) break; // safety valve

    /**
     * One peel round: walk the forest top-down and find the FIRST feasible
     * unit (largest wins because parents are tried before children). Then
     * batch its identical free siblings.
     */
    type Candidate = { unit: Unit; dir: Dir; parent: Unit | null; volume: number };
    const candidates: Candidate[] = [];

    const visit = (units: Unit[], parent: Unit | null): void => {
      for (const u of units) {
        if (!fullyRemaining(u, remaining)) {
          // Partially peeled: only descend.
          visit(u.children, u);
          continue;
        }
        // Whole-assembly guard: the FIRST step must not "remove" the entire
        // model in one go. Once anything has been peeled, the remainder is
        // legitimately removable (the last part on the bench is a step too
        // — flagging it as unsequenceable reads broken).
        if (u.meshes.length === remaining.size && steps.length === 0) {
          visit(u.children, u);
          continue;
        }
        const dirs = feasibleDirections(u.meshes, remaining, geoms);
        if (dirs.length) {
          let volume = 0;
          for (const m of u.meshes) volume += geoms.get(m)?.volume ?? 0;
          candidates.push({ unit: u, dir: dirs[0].dir, parent, volume });
          // Feasible whole: don't descend — the unit leaves as one piece.
          continue;
        }
        visit(u.children, u);
      }
    };
    visit(forest, null);

    // Fasteners-first among this round's feasible units: smallest volume
    // moves first (bolts before the cover, handles before the body). Tree
    // order broke this — first-found was whatever the CAD listed first.
    const found = candidates.length
      ? candidates.reduce((a, b) => (b.volume < a.volume ? b : a))
      : null;

    if (!found) {
      const leftovers = [...remaining.keys()];
      steps.push({
        parts: leftovers,
        dir: null,
        distance: 0,
        label: `${leftovers.length} parts`,
        reason:
          'no collision-free removal direction found (checked every level of the BOM tree along ±X/±Y/±Z) — interlocked or press-fit geometry; sequence these manually',
        round,
        unplanned: true,
      });
      break;
    }

    const { unit, dir, parent } = found as Candidate;

    // ---- identical-sibling batching, feasibility-partitioned: only the
    // siblings that are THEMSELVES free along the same dir this round.
    const sibs = (parent ? parent.children : forest).filter(
      (s) =>
        s !== unit &&
        fullyRemaining(s, remaining) &&
        familyName(s.name) === familyName(unit.name) &&
        unitSig(s, geoms) === unitSig(unit, geoms),
    );
    const batch: Unit[] = [unit];
    for (const s of sibs) {
      const dirs = feasibleDirections(s.meshes, remaining, geoms);
      if (dirs.length && dirs[0].dir === dir) batch.push(s);
    }

    const meshes = batch.flatMap((b) => b.meshes);
    const label =
      batch.length > 1 ? `${batch.length}× ${familyName(unit.name)}` : unit.name;
    const kind =
      unit.children.length > 0 || unit.meshes.length > 1 ? 'sub-assembly' : 'part';
    steps.push({
      parts: meshes,
      dir,
      distance: removalDistance(meshes, dir, remaining, geoms),
      label,
      reason:
        batch.length > 1
          ? `${batch.length} identical ${kind === 'sub-assembly' ? 'sub-assemblies' : 'parts'} free along ${dir}, contact-guided (round ${round})`
          : `${kind} free along ${dir}, contact-guided (round ${round})`,
      round,
    });
    for (const m of meshes) remaining.delete(m);
  }

  return steps;
}
