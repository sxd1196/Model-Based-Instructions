/**
 * The peel loop: assembly-by-disassembly sequence planning.
 *
 * Ask "what can come off RIGHT NOW", peel it, recurse. Everything removable
 * in round k was installed after everything removable in round k+1 — reverse
 * the peel and you have an assembly order. We present disassembly (v1).
 *
 * Heuristics (in order):
 *  - subassembly cohesion: when a CAD subassembly can leave as one rigid
 *    unit, it does — one step, moving together (how a human would author it)
 *  - fasteners first within a round: smaller parts before the big part they
 *    retain (bolts out, then the cover)
 *  - identical-part batching: same-signature parts freed in the same round
 *    with the same direction merge into ONE step ("remove 8x bolt")
 *  - direction preference: +Z, laterals, -Z (DIR_ORDER in feasibility)
 *
 * Failure honesty: when nothing peels (interlocked or tessellation-noisy
 * geometry), the remains land in a single flagged step — never guessed.
 */
import type { Assembly } from '@/domain/schema';
import {
  collectPartGeoms,
  feasibleDirections,
  removalDistance,
  type Dir,
  type PartGeom,
} from './feasibility';
import * as THREE from 'three';

export interface PlannedStep {
  /** Mesh part ids that move in this step, as one unit or an identical batch. */
  parts: string[];
  dir: Dir | null;
  /** World-mm travel for the authored motion. */
  distance: number;
  /** Human-readable label for the movers ("8x Bolt_M8", "SUB_Cover"). */
  label: string;
  /** Why the planner believes this step is feasible — shown in review. */
  reason: string;
  /** Peel round the step came from (diagnostics). */
  round: number;
  /** True for the leftover step when the peel jammed. */
  unplanned?: boolean;
}

/** Group ids by their direct parent group (subassembly), from the assembly tree. */
function subassemblyOf(assembly: Assembly, id: string): string | null {
  return assembly.parts[id]?.parentId ?? null;
}

function nameOf(assembly: Assembly, id: string): string {
  return assembly.parts[id]?.name ?? id;
}

/** Strip trailing instance digits so Bolt_M8_03_Head batches as Bolt_M8. */
function familyName(name: string): string {
  return name.replace(/[_\s-]?\d+([_\s-]?(Head|Shank|Body))?$/i, '');
}

export function planSequence(
  assembly: Assembly,
  index: Map<string, THREE.Object3D>,
): PlannedStep[] {
  const geoms = collectPartGeoms(index);
  const remaining = new Map<string, PartGeom>(geoms);
  const steps: PlannedStep[] = [];
  let round = 0;

  // Subassembly membership among leaf meshes.
  const subMembers = new Map<string, string[]>();
  for (const id of geoms.keys()) {
    const sub = subassemblyOf(assembly, id);
    if (!sub) continue;
    if (!subMembers.has(sub)) subMembers.set(sub, []);
    subMembers.get(sub)!.push(id);
  }

  while (remaining.size > 0) {
    round++;
    if (round > 200) break; // safety valve

    // ---- 1. Whole subassemblies that can leave as one rigid unit.
    // Identical sibling subassemblies (the 8 bolt groups) freed in the same
    // round with the same direction batch into ONE step.
    let peeled = false;
    for (const [sub, members] of subMembers) {
      const live = members.filter((m) => remaining.has(m));
      if (live.length < 2 || live.length === remaining.size) continue;
      const dirs = feasibleDirections(live, remaining, geoms);
      if (!dirs.length) continue;

      const dir = dirs[0].dir;
      const subName = assembly.parts[sub]?.name ?? sub;
      const sigOf = (ids: string[]) =>
        ids.map((m) => geoms.get(m)?.signature ?? '?').sort().join('|');
      const mySig = sigOf(live);
      const fam = familyName(subName);

      // Gather identical siblings that are ALSO free along the same dir.
      const batchSubs: string[] = [sub];
      const batchParts: string[] = [...live];
      for (const [other, otherMembers] of subMembers) {
        if (other === sub || batchSubs.includes(other)) continue;
        const otherLive = otherMembers.filter((m) => remaining.has(m));
        if (otherLive.length < 2) continue;
        if (familyName(assembly.parts[other]?.name ?? other) !== fam) continue;
        if (sigOf(otherLive) !== mySig) continue;
        const otherDirs = feasibleDirections(otherLive, remaining, geoms);
        if (otherDirs.length && otherDirs[0].dir === dir) {
          batchSubs.push(other);
          batchParts.push(...otherLive);
        }
      }

      const label =
        batchSubs.length > 1 ? `${batchSubs.length}× ${fam || subName}` : subName;
      steps.push({
        parts: batchParts,
        dir,
        distance: removalDistance(batchParts, dir, remaining, geoms),
        label,
        reason:
          batchSubs.length > 1
            ? `${batchSubs.length} identical sub-assemblies free along ${dir} (round ${round})`
            : `sub-assembly free along ${dir} as one unit (round ${round})`,
        round,
      });
      for (const m of batchParts) remaining.delete(m);
      peeled = true;
      break; // re-evaluate from scratch — the world changed
    }
    if (peeled) continue;

    // ---- 2. Individual parts removable this round.
    const removable: { id: string; dir: Dir; volume: number }[] = [];
    for (const id of remaining.keys()) {
      const dirs = feasibleDirections([id], remaining, geoms);
      if (dirs.length) removable.push({ id, dir: dirs[0].dir, volume: geoms.get(id)!.volume });
    }

    if (!removable.length) {
      // Peel jammed. Flag the leftovers honestly and stop.
      const leftovers = [...remaining.keys()];
      steps.push({
        parts: leftovers,
        dir: null,
        distance: 0,
        label: `${leftovers.length} parts`,
        reason:
          'could not find a collision-free removal direction — interlocked geometry or tessellation contact; sequence these manually',
        round,
        unplanned: true,
      });
      break;
    }

    // Fasteners first: smallest volume family first within the round.
    removable.sort((a, b) => a.volume - b.volume);

    // Batch identical parts (same signature + same family name + same dir).
    const batched = new Set<string>();
    for (const cand of removable) {
      if (batched.has(cand.id)) continue;
      const g = geoms.get(cand.id)!;
      const fam = familyName(nameOf(assembly, cand.id));
      const batch = removable.filter(
        (r) =>
          !batched.has(r.id) &&
          r.dir === cand.dir &&
          geoms.get(r.id)!.signature === g.signature &&
          familyName(nameOf(assembly, r.id)) === fam,
      );
      // A bolt made of Head+Shank meshes: batch by family too, different sigs.
      const ids = batch.map((b) => b.id);
      for (const id of ids) batched.add(id);

      const label = ids.length > 1 ? `${ids.length}× ${fam || nameOf(assembly, cand.id)}` : nameOf(assembly, cand.id);
      steps.push({
        parts: ids,
        dir: cand.dir,
        distance: removalDistance(ids, cand.dir, remaining, geoms),
        label,
        reason:
          ids.length > 1
            ? `${ids.length} identical parts free along ${cand.dir} (round ${round})`
            : `free along ${cand.dir} (round ${round})`,
        round,
      });
      for (const id of ids) remaining.delete(id);
    }
  }

  return steps;
}
