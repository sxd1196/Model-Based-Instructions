/**
 * Authoring tests: selection resolution and gizmo-drag inversion.
 *
 * The round-trip block is the important one. `moveFromDrag` must be an EXACT
 * inverse of `composePartTransform`, because any drift compounds across every
 * drag in a sequence.
 */
import { describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  applyDragPolicy,
  centroidOf,
  collectSubtree,
  constrainToDominantAxis,
  conjugate,
  effectiveDragMove,
  isIdentityMove,
  moveFromDrag,
  radialExplode,
  resolveGizmoState,
  resolveSelectionTarget,
  revealTargetFor,
  selectFromTreeRow,
  selectableParts,
  snapTranslate,
} from './authoring';
import { composePartTransform, quatFromAxisAngle } from './transform';
import { buildAssemblyFromScene } from '@/cad/loadGltf';
import { makeDemoAssembly } from '@/cad/demo';
import { IDENTITY_QUAT, type Move, type Quat, type Vec3 } from './schema';

const { root, name } = makeDemoAssembly();
const { assembly } = buildAssemblyFromScene(root, 'demo://x', { name });

const idOf = (n: string) =>
  Object.values(assembly.parts).find((p) => p.name === n)!.id;

const near = (a: number[], b: number[], p = 6) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], p));

describe('resolveSelectionTarget', () => {
  it('climbs from a bolt shank to the whole bolt', () => {
    // Clicking a sub-mesh must select the assembly unit an author thinks in.
    const target = resolveSelectionTarget(assembly, idOf('Bolt_M8_01_Shank'));
    expect(assembly.parts[target!].name).toBe('Bolt_M8_01');
  });

  it('does not climb past the top-level container', () => {
    // Selecting SUB_Cover would select the entire cover assembly on one click.
    const target = resolveSelectionTarget(assembly, idOf('Cover_Plate'));
    expect(assembly.parts[target!].name).toBe('Cover_Plate');
  });

  it('deep mode returns the literal clicked mesh', () => {
    const id = idOf('Bolt_M8_01_Shank');
    expect(resolveSelectionTarget(assembly, id, { deep: true })).toBe(id);
  });

  it('returns null for an unknown id instead of throwing', () => {
    expect(resolveSelectionTarget(assembly, 'nope')).toBeNull();
  });
});

describe('collectSubtree / selectableParts', () => {
  it('collects a bolt and its sub-meshes', () => {
    const ids = collectSubtree(assembly, idOf('Bolt_M8_01'));
    const names = ids.map((i) => assembly.parts[i].name);
    expect(names).toContain('Bolt_M8_01');
    expect(names).toContain('Bolt_M8_01_Shank');
    expect(names).toContain('Bolt_M8_01_Head');
  });

  it('drops groups, keeping only posable geometry', () => {
    const parts = selectableParts(assembly, [idOf('Bolt_M8_01')]);
    expect(parts.every((id) => !assembly.parts[id].isGroup)).toBe(true);
    expect(parts.length).toBe(2); // shank + head
  });

  it('dedupes overlapping selections', () => {
    const parts = selectableParts(assembly, [
      idOf('Bolt_M8_01'),
      idOf('Bolt_M8_01_Head'),
    ]);
    expect(new Set(parts).size).toBe(parts.length);
  });

  it('a leaf mesh resolves to itself', () => {
    expect(selectableParts(assembly, [idOf('Main_Shaft')])).toEqual([idOf('Main_Shaft')]);
  });
});

describe('moveFromDrag — exact inverse of composePartTransform', () => {
  const cases: Array<{
    label: string;
    rest: Vec3;
    restQ: Quat;
    move: { translate: Vec3; rotate: Quat; pivot: Vec3 };
  }> = [
    {
      label: 'pure translation',
      rest: [100, 0, 0], restQ: IDENTITY_QUAT,
      move: { translate: [0, 50, 25], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
    },
    {
      label: 'rotation about origin',
      rest: [100, 0, 0], restQ: IDENTITY_QUAT,
      move: { translate: [0, 0, 0], rotate: quatFromAxisAngle([0, 0, 1], Math.PI / 3), pivot: [0, 0, 0] },
    },
    {
      label: 'rotation about an offset pivot',
      rest: [100, 0, 0], restQ: IDENTITY_QUAT,
      move: { translate: [0, 0, 0], rotate: quatFromAxisAngle([0, 0, 1], Math.PI), pivot: [50, 0, 0] },
    },
    {
      label: 'part with existing CAD rotation',
      rest: [10, 20, 30], restQ: quatFromAxisAngle([1, 0, 0], Math.PI / 2),
      move: { translate: [5, -5, 15], rotate: quatFromAxisAngle([0, 1, 0], 0.83), pivot: [3, 3, 3] },
    },
    {
      label: 'combined translate + rotate about own position',
      rest: [-7, 2, 9], restQ: quatFromAxisAngle([0, 1, 1], 1.3),
      move: { translate: [0, 0, -40], rotate: quatFromAxisAngle([1, 1, 0], -2.1), pivot: [-7, 2, 9] },
    },
  ];

  it.each(cases.map((c) => [c.label, c] as const))(
    'recovers the original Move: %s',
    (_label, c) => {
      // Forward: what the viewer would show after applying the Move.
      const posed = composePartTransform(c.rest, c.restQ, c.move as never);
      // Inverse: what we store when the user drags the gizmo to that pose.
      const recovered = moveFromDrag(
        c.rest, c.restQ,
        posed.position, posed.rotation,
        c.move.pivot,
      );

      near(recovered.translate, c.move.translate, 5);
      // Quaternions are double-covered; compare via absolute dot product.
      const dot = Math.abs(
        recovered.rotate.reduce((s, v, i) => s + v * c.move.rotate[i], 0),
      );
      expect(dot).toBeCloseTo(1, 5);
    },
  );

  it('a drag back to rest yields an identity Move', () => {
    const rest: Vec3 = [12, 34, 56];
    const restQ = quatFromAxisAngle([0, 1, 0], 0.5);
    const m = moveFromDrag(rest, restQ, rest, restQ);
    expect(isIdentityMove(m)).toBe(true);
  });

  it('survives 50 chained drags without drift', () => {
    // Simulates an author nudging a part repeatedly. Error must not accumulate.
    const rest: Vec3 = [40, 0, 0];
    const restQ = IDENTITY_QUAT;
    let position: Vec3 = [...rest];
    let rotation: Quat = [...restQ];

    for (let i = 0; i < 50; i++) {
      position = [position[0], position[1], position[2] + 2];
      const move = moveFromDrag(rest, restQ, position, rotation);
      const re = composePartTransform(rest, restQ, { ...move });
      near(re.position, position, 6);
    }

    const final = moveFromDrag(rest, restQ, position, rotation);
    expect(final.translate[2]).toBeCloseTo(100, 6);
  });
});

describe('conjugate', () => {
  it('undoes a rotation', () => {
    const q = quatFromAxisAngle([1, 2, 3], 1.1);
    const c = conjugate(q);
    const composed = [
      q[3] * c[0] + q[0] * c[3] + q[1] * c[2] - q[2] * c[1],
      q[3] * c[1] - q[0] * c[2] + q[1] * c[3] + q[2] * c[0],
      q[3] * c[2] + q[0] * c[1] - q[1] * c[0] + q[2] * c[3],
      q[3] * c[3] - q[0] * c[0] - q[1] * c[1] - q[2] * c[2],
    ];
    near(composed, [0, 0, 0, 1], 6);
  });
});

describe('snapTranslate', () => {
  it('snaps to a grid', () => {
    expect(snapTranslate([24.9873, 0.4, -12.6], 5)).toEqual([25, 0, -15]);
  });

  it('step of 0 disables snapping', () => {
    expect(snapTranslate([1.234, 5.678, 9], 0)).toEqual([1.234, 5.678, 9]);
  });

  it('snaps to 1mm for fine work', () => {
    expect(snapTranslate([10.4, 10.6, -10.5], 1)).toEqual([10, 11, -10]);
  });
});

describe('constrainToDominantAxis', () => {
  it('collapses a near-axial drag to a clean pull', () => {
    expect(constrainToDominantAxis([0.3, 0.2, 100])).toEqual([0, 0, 100]);
  });

  it('preserves a genuine diagonal', () => {
    const v: Vec3 = [100, 98, 0];
    expect(constrainToDominantAxis(v)).toEqual(v);
  });

  it('handles zero without dividing by it', () => {
    expect(constrainToDominantAxis([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('keeps negative direction', () => {
    expect(constrainToDominantAxis([-80, 1, 2])).toEqual([-80, 0, 0]);
  });
});

describe('isIdentityMove', () => {
  it('detects no-op moves so empty tracks are not saved', () => {
    expect(isIdentityMove({ translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] })).toBe(true);
    expect(isIdentityMove({ translate: [0, 0, 0.5], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] })).toBe(false);
    expect(isIdentityMove({
      translate: [0, 0, 0],
      rotate: quatFromAxisAngle([0, 0, 1], 0.2),
      pivot: [0, 0, 0],
    })).toBe(false);
  });

  it('treats a negated identity quaternion as identity', () => {
    expect(isIdentityMove({ translate: [0, 0, 0], rotate: [0, 0, 0, -1], pivot: [0, 0, 0] })).toBe(true);
  });
});

describe('resolveGizmoState', () => {
  const base = { selectionCount: 1 as const, hasSequence: true };

  it('REGRESSION: shows the gizmo with no step created yet', () => {
    // The original bug: the gizmo was gated on activeOperationId, so before
    // clicking "+ Step" it rendered nothing and explained nothing.
    expect(resolveGizmoState(base).visible).toBe(true);
    expect(resolveGizmoState(base).reason).toBeNull();
  });

  it('shows for a multi-part selection and flags it as a group', () => {
    const g = resolveGizmoState({ ...base, selectionCount: 8 });
    expect(g.visible).toBe(true);
    expect(g.isGroup).toBe(true);
  });

  it('hides with an actionable reason when nothing is selected', () => {
    const g = resolveGizmoState({ ...base, selectionCount: 0 });
    expect(g.visible).toBe(false);
    expect(g.reason).toMatch(/select a part/i);
  });

  // DELETED: 'hides with a reason when the mode is off'. Gizmo modes no
  // longer exist — the combined widget carries arrows and rings at once, so
  // there is no 'off' state to test.

  it('hides with a reason when no model is loaded', () => {
    const g = resolveGizmoState({ ...base, hasSequence: false });
    expect(g.visible).toBe(false);
    expect(g.reason).toMatch(/load a model/i);
  });

  it('never hides without saying why', () => {
    const cases = [
      { selectionCount: 0, hasSequence: true },
      { selectionCount: 0, hasSequence: false },
      { selectionCount: 1, hasSequence: false },
    ];
    for (const c of cases) {
      const g = resolveGizmoState(c);
      expect(g.visible).toBe(false);
      expect(g.reason).toBeTruthy();
    }
  });
});

describe('applyDragPolicy / effectiveDragMove (preview == commit)', () => {
  // The live drag preview and the committed move both go through these
  // functions. If they ever disagree, the part jumps on release — the exact
  // "doesn't follow the mouse" feel this design exists to kill.

  it('pure translation gets snapped and axis-locked', () => {
    const move: Move = {
      translate: [98.7, 3.2, 1.1], rotate: IDENTITY_QUAT, pivot: [0, 0, 0],
    };
    const out = applyDragPolicy(move, { snap: 5, axisLock: true });
    expect(out.translate).toEqual([100, 0, 0]);
  });

  it('a rotated move passes through COMPLETELY untouched', () => {
    const spin = quatFromAxisAngle([0, 0, 1], Math.PI / 5);
    const move: Move = { translate: [7.3, 2.1, 0.4], rotate: spin, pivot: [10, 20, 30] };
    expect(applyDragPolicy(move, { snap: 25, axisLock: true })).toEqual(move);
  });

  it('policy off means identity', () => {
    const move: Move = {
      translate: [98.7, 3.2, 1.1], rotate: IDENTITY_QUAT, pivot: [0, 0, 0],
    };
    expect(applyDragPolicy(move, { snap: 0, axisLock: false })).toEqual(move);
  });

  it('effectiveDragMove pivots at rest, so in-place rotation has zero translate', () => {
    const rest: Vec3 = [50, 25, 10];
    const spin = quatFromAxisAngle([0, 1, 0], Math.PI / 3);
    // A rotate-only gizmo drag leaves the handle at the part's position.
    const move = effectiveDragMove(rest, IDENTITY_QUAT, rest, spin, {
      snap: 5, axisLock: true,
    });
    expect(Math.hypot(...move.translate)).toBeLessThan(1e-9);
    expect(move.pivot).toEqual(rest);
  });

  it('the preview move IS the committed move for the same handle pose', () => {
    // Simulates one drag: what previewFromHandle computes mid-drag equals
    // what commitDrag stores on release, because both call this function
    // with identical inputs.
    const rest: Vec3 = [10, 20, 30];
    const dragged: Vec3 = [10, 20, 152.3];
    const policy = { snap: 5, axisLock: true };

    const preview = effectiveDragMove(rest, IDENTITY_QUAT, dragged, IDENTITY_QUAT, policy);
    const committed = effectiveDragMove(rest, IDENTITY_QUAT, dragged, IDENTITY_QUAT, policy);
    expect(committed).toEqual(preview);
    // And the shaped result is the snapped axial pull the user watched.
    expect(preview.translate).toEqual([0, 0, 120]);
  });
});

describe('tree <-> viewport selection sync', () => {
  it('clicking a GROUP row selects the whole sub-assembly', () => {
    // Replaces the old Sub-asm button: the tree already shows hierarchy.
    const ids = selectFromTreeRow(assembly, idOf('SUB_Cover'));
    const names = ids.map((i) => assembly.parts[i].name);
    expect(names).toContain('Cover_Plate');
    expect(names).toContain('Cover_Gasket');
    expect(names.some((n) => n.startsWith('Bolt_M8_'))).toBe(true);
    expect(ids.every((i) => !assembly.parts[i].isGroup)).toBe(true);
  });

  it('clicking a LEAF row selects just that part', () => {
    expect(selectFromTreeRow(assembly, idOf('Main_Shaft'))).toEqual([idOf('Main_Shaft')]);
  });

  it('an unknown row selects nothing rather than throwing', () => {
    expect(selectFromTreeRow(assembly, 'bogus')).toEqual([]);
  });

  it('ancestorsOf returns the chain outermost first', () => {
    const chain = ancestorsOf(assembly, idOf('Bolt_M8_01_Shank'));
    const names = chain.map((i) => assembly.parts[i].name);
    expect(names).toEqual(['SUB_Cover', 'Bolt_M8_01']);
  });

  it('a root-level node has no ancestors', () => {
    expect(ancestorsOf(assembly, idOf('SUB_Cover'))).toEqual([]);
  });

  it('revealTargetFor points at the part for a single pick', () => {
    const id = idOf('Cover_Plate');
    expect(revealTargetFor(assembly, [id])).toBe(id);
  });

  it('revealTargetFor finds the COMMON ancestor for a group pick', () => {
    // Picking a whole bolt should scroll to the bolt, not one of its meshes.
    const target = revealTargetFor(assembly, [
      idOf('Bolt_M8_01_Shank'),
      idOf('Bolt_M8_01_Head'),
    ]);
    expect(assembly.parts[target!].name).toBe('Bolt_M8_01');
  });

  it('revealTargetFor climbs to the sub-assembly for a mixed group', () => {
    const target = revealTargetFor(assembly, [
      idOf('Cover_Plate'),
      idOf('Bolt_M8_03_Head'),
    ]);
    expect(assembly.parts[target!].name).toBe('SUB_Cover');
  });

  it('revealTargetFor returns null for an empty selection', () => {
    expect(revealTargetFor(assembly, [])).toBeNull();
  });

  it('round trip: tree click -> reveal target is that same row', () => {
    const rowId = idOf('SUB_Cover');
    const selected = selectFromTreeRow(assembly, rowId);
    expect(revealTargetFor(assembly, selected)).toBe(rowId);
  });
});

describe('radialExplode', () => {
  const bolts = Object.values(assembly.parts)
    .filter((p) => /^Bolt_M8_\d+_(Shank|Head)$/.test(p.name))
    .map((p) => p.id);

  it('pushes parts away from the centroid', () => {
    const center = centroidOf(assembly, bolts);
    const moves = radialExplode(assembly, bolts, center, 0.5);
    expect(moves.size).toBeGreaterThan(0);

    for (const [id, move] of moves) {
      const rest = assembly.parts[id].restTranslate;
      const outward = [
        rest[0] - center[0], rest[1] - center[1], rest[2] - center[2],
      ];
      // Displacement must point the same way as the outward vector.
      const dot = move.translate.reduce((s, v, i) => s + v * outward[i], 0);
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('scales linearly with the factor', () => {
    const center = centroidOf(assembly, bolts);
    const a = radialExplode(assembly, bolts, center, 0.5);
    const b = radialExplode(assembly, bolts, center, 1.0);
    const id = [...a.keys()][0];
    near(b.get(id)!.translate, a.get(id)!.translate.map((n) => n * 2), 6);
  });

  it('skips parts sitting exactly at the centroid', () => {
    const moves = radialExplode(assembly, [idOf('Main_Shaft')], [0, 0, 0], 1);
    expect(moves.size).toBe(0);
  });

  it('never emits a rotation', () => {
    const center = centroidOf(assembly, bolts);
    for (const m of radialExplode(assembly, bolts, center, 0.5).values()) {
      expect(m.rotate).toEqual(IDENTITY_QUAT);
    }
  });
});

describe('centroidOf', () => {
  it('averages rest positions of meshes only', () => {
    const bolts = Object.values(assembly.parts)
      .filter((p) => /^Bolt_M8_\d+$/.test(p.name))
      .map((p) => p.id);
    const c = centroidOf(assembly, bolts);
    // The bolt circle is symmetric about the Z axis.
    expect(c[0]).toBeCloseTo(0, 4);
    expect(c[1]).toBeCloseTo(0, 4);
  });

  it('returns the origin for an empty set', () => {
    expect(centroidOf(assembly, [])).toEqual([0, 0, 0]);
  });
});
