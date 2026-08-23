/**
 * Frame-aware group rotation tests.
 *
 * Reproduces the reported bug: rotating SUB_Cover 90° scattered its bolts
 * (see rigidToParentFrame's doc comment). The root cause was feeding the
 * gizmo's WORLD transform directly into Moves that the evaluator applies in
 * each part's PARENT frame — correct only when the parent sits at the world
 * origin with identity rotation, which the demo's sub-assemblies happened to
 * satisfy... until they were moved, or until a real CAD file arrived.
 */
import { describe, expect, it } from 'vitest';
import {
  clusterByParentFrame,
  parentWorldTransform,
  selectableParts,
  shapeDragWorld,
} from './authoring';
import {
  clusterMoveFromDrag,
  WORLD_FRAME,
  rigidToParentFrame,
  poseToParentFrame,
  applyRigid,
  gizmoDragToRigid,
  moveToRigid,
  type Frame,
} from './rigid';
import { quatFromAxisAngle } from './transform';
import { resolveFrame, poseFor } from './evaluate';
import { buildAssemblyFromScene } from '@/cad/loadGltf';
import { makeDemoAssembly } from '@/cad/demo';
import { emptySequence } from '@/state/store';
import { IDENTITY_QUAT, type Sequence, type Vec3 } from './schema';

const { root, name } = makeDemoAssembly();
const { assembly } = buildAssemblyFromScene(root, 'demo://x', { name });

const idOf = (n: string) =>
  Object.values(assembly.parts).find((p) => p.name === n)!.id;

/** World position of a part after applying its cluster's Move. */
function worldAfter(
  sequence: Sequence,
  partId: string,
  t: number,
): Vec3 {
  const frame = resolveFrame(sequence, t);
  const move = poseFor(frame, partId);
  const node = assembly.parts[partId];
  const parent = parentWorldTransform(assembly, partId);

  // local pose = move applied to rest (pivot form), then place into world.
  const rigid = moveToRigid(move);
  const local = applyRigid(rigid, node.restTranslate);
  const rigidParent = { rotation: parent.rotation, translation: parent.position };
  return applyRigid(rigidParent, local);
}

describe('parentWorldTransform', () => {
  it('is identity for a top-level group', () => {
    const f = parentWorldTransform(assembly, idOf('SUB_Cover'));
    expect(f.position).toEqual([0, 0, 0]);
    expect(f.rotation).toEqual([0, 0, 0, 1]);
  });

  it('reflects the parent group placement for a nested mesh', () => {
    // Bolt shanks live inside Bolt_M8_NN groups positioned on a 58mm circle.
    const shank = idOf('Bolt_M8_01_Shank');
    const f = parentWorldTransform(assembly, shank);
    expect(Math.hypot(f.position[0], f.position[1])).toBeCloseTo(58, 4);
    expect(f.position[2]).toBeCloseTo(70, 4);
  });
});

describe('rigidToParentFrame', () => {
  it('is identity when the parent is the world frame', () => {
    const spin = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const world = gizmoDragToRigid([10, 20, 30], [15, 20, 30], spin);
    const local = rigidToParentFrame(world, {
      position: [0, 0, 0],
      rotation: IDENTITY_QUAT,
    });
    expect(local.rotation).toEqual(world.rotation);
    local.translation.forEach((v, i) => expect(v).toBeCloseTo(world.translation[i], 10));
  });

  it('a local move through the parent frame reproduces the world motion', () => {
    // The defining property: for any point p (local), placing it into world,
    // applying the world transform, equals applying the LOCAL transform then
    // placing into world.
    const parent: Frame = {
      position: [40, -25, 12],
      rotation: quatFromAxisAngle([0, 1, 0], 0.6),
    };
    const world = gizmoDragToRigid(
      [10, 5, 0],
      [22, 5, -8],
      quatFromAxisAngle([1, 2, 3], 0.9),
    );
    const local = rigidToParentFrame(world, parent);

    const parentRigid = { rotation: parent.rotation, translation: parent.position };
    for (const p of [[0, 0, 0], [10, -5, 3], [-7, 2, 14]] as Vec3[]) {
      const placedThenMoved = applyRigid(world, applyRigid(parentRigid, p));
      const movedThenPlaced = applyRigid(parentRigid, applyRigid(local, p));
      placedThenMoved.forEach((v, i) => expect(v).toBeCloseTo(movedThenPlaced[i], 8));
    }
  });
});

describe('poseToParentFrame', () => {
  it('round-trips with the parent placement', () => {
    const parent: Frame = {
      position: [5, 6, 7],
      rotation: quatFromAxisAngle([0, 0, 1], 1.1),
    };
    const parentRigid = { rotation: parent.rotation, translation: parent.position };
    const worldPos: Vec3 = [30, -10, 4];
    const local = poseToParentFrame(worldPos, IDENTITY_QUAT, parent);
    const back = applyRigid(parentRigid, local.position);
    back.forEach((v, i) => expect(v).toBeCloseTo(worldPos[i], 8));
  });
});

describe('clusterByParentFrame', () => {
  it('splits a sub-assembly selection by parent group', () => {
    const ids = selectableParts(assembly, [idOf('SUB_Cover')]);
    const clusters = clusterByParentFrame(assembly, ids);

    // Plate+gasket under SUB_Cover, each bolt's meshes under its own group.
    expect(clusters.length).toBe(9);
    const sizes = clusters.map((c) => c.parts.length).sort((a, b) => a - b);
    expect(sizes).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it('single-parent selections stay one cluster', () => {
    const clusters = clusterByParentFrame(assembly, [
      idOf('Cover_Plate'),
      idOf('Cover_Gasket'),
    ]);
    expect(clusters.length).toBe(1);
  });
});

describe('REGRESSION: off-origin CAD meshes (origins at model origin)', () => {
  // Real STEP imports frequently bake geometry in world coordinates: every
  // node origin sits at [0,0,0] while the visible part is far away. Reported
  // symptom: clicking a faucet handle parked the gizmo in the middle of the
  // cabinet. The gizmo now parks at the mesh's bounding-box centre, and a
  // drag pivots about the HANDLE, so these tests pin the math that makes an
  // in-place rotation of an off-origin part stay in place.

  it('rotation about the part CENTRE keeps the part centred (not orbiting)', () => {
    // Part whose origin is the world origin but whose geometry centre is at
    // [200, 0, 50] — the faucet-handle pattern.
    const center: Vec3 = [200, 0, 50];
    const spin = quatFromAxisAngle([0, 0, 1], Math.PI / 2);

    // Gizmo parks at the visual centre; a rotate-only drag pivots there.
    const move = clusterMoveFromDrag(null, WORLD_FRAME, center, center, spin);

    // The ORIGIN of the part orbits the pivot...
    const newOrigin = applyRigid(moveToRigid(move), [0, 0, 0]);
    // ...but the geometry CENTRE must stay exactly where it was.
    const newCenter = applyRigid(moveToRigid(move), center);
    newCenter.forEach((v, i) => expect(v).toBeCloseTo(center[i], 8));
    // Sanity: this is a real rotation, not identity.
    expect(Math.hypot(newOrigin[0], newOrigin[1], newOrigin[2])).toBeGreaterThan(1);
  });

  it('rotating about the NODE ORIGIN would fling the part (the old bug)', () => {
    // Documents why parking at getWorldPosition() was wrong: the same spin
    // pivoted at the node origin moves the geometry centre 283mm away.
    const center: Vec3 = [200, 0, 50];
    const spin = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const move = clusterMoveFromDrag(null, WORLD_FRAME, [0, 0, 0], [0, 0, 0], spin);
    const newCenter = applyRigid(moveToRigid(move), center);
    const drift = Math.hypot(...newCenter.map((v, i) => v - center[i]));
    expect(drift).toBeGreaterThan(200);
  });
});

describe('REGRESSION: rotating a sub-assembly preserves its shape', () => {
  it('a 90° world spin keeps every bolt at its correct world position', () => {
    // The reported bug, reconstructed: rotate SUB_Cover 90° about world Z
    // around the gizmo centroid and verify each part lands where a rigid
    // body rotation of the WHOLE sub-assembly would put it.
    const ids = selectableParts(assembly, [idOf('SUB_Cover')]);
    const spin = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const centroid: Vec3 = [0, 0, 67]; // roughly the cover centre

    const sequence: Sequence = { ...emptySequence(assembly), operations: [] };
    const op = {
      id: 'op1', title: 'Rotate cover', description: '', noteCorner: 'tl' as const,
      duration: 1, dwell: 0,
      tracks: [] as Sequence['operations'][number]['tracks'],
      camera: null, annotations: [], styles: [], meta: {},
    };

    // One track per parent cluster — what commitGroupDrag now writes.
    for (const cluster of clusterByParentFrame(assembly, ids)) {
      const move = clusterMoveFromDrag(null, cluster.frame, centroid, centroid, spin);
      op.tracks.push({
        id: `t_${cluster.parentId}`, parts: cluster.parts,
        from: { translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
        to: move, start: 0, end: 1, easing: 'linear',
      });
    }
    sequence.operations.push(op);

    // Expected: pure rigid rotation of each part's rest WORLD position.
    const worldSpin = gizmoDragToRigid(centroid, centroid, spin);

    for (const id of ids) {
      const node = assembly.parts[id];
      const parent = parentWorldTransform(assembly, id);
      const parentRigid = { rotation: parent.rotation, translation: parent.position };
      const restWorld = applyRigid(parentRigid, node.restTranslate);
      const expected = applyRigid(worldSpin, restWorld);

      const actual = worldAfter(sequence, id, 1);
      actual.forEach((v, i) => {
        expect(Math.abs(v - expected[i]),
          `${node.name} axis ${i}: got ${v}, want ${expected[i]}`).toBeLessThan(1e-6);
      });
    }
  });

  it('bolt circle RADIUS is preserved through the spin (no confetti)', () => {
    // The visual symptom: bolts flung outward/inward. Verify pairwise
    // distances between two bolts survive the rotation.
    const b1 = idOf('Bolt_M8_01_Shank');
    const b2 = idOf('Bolt_M8_05_Shank');
    const ids = selectableParts(assembly, [idOf('SUB_Cover')]);
    const spin = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const centroid: Vec3 = [0, 0, 67];

    const sequence: Sequence = { ...emptySequence(assembly), operations: [] };
    const tracks = clusterByParentFrame(assembly, ids).map((cluster, i) => ({
      id: `t${i}`, parts: cluster.parts,
      from: { translate: [0, 0, 0] as Vec3, rotate: IDENTITY_QUAT, pivot: [0, 0, 0] as Vec3 },
      to: clusterMoveFromDrag(null, cluster.frame, centroid, centroid, spin),
      start: 0, end: 1, easing: 'linear' as const,
    }));
    sequence.operations.push({
      id: 'op1', title: '', description: '', noteCorner: 'tl' as const, duration: 1, dwell: 0,
      tracks, camera: null, annotations: [], styles: [], meta: {},
    });

    const parentRigid = (id: string) => {
      const f = parentWorldTransform(assembly, id);
      return { rotation: f.rotation, translation: f.position };
    };
    const before = Math.hypot(
      ...applyRigid(parentRigid(b1), assembly.parts[b1].restTranslate)
        .map((v, i) => v - applyRigid(parentRigid(b2), assembly.parts[b2].restTranslate)[i]),
    );
    const a1 = worldAfter(sequence, b1, 1);
    const a2 = worldAfter(sequence, b2, 1);
    const after = Math.hypot(...a1.map((v, i) => v - a2[i]));

    expect(after).toBeCloseTo(before, 6);
  });
});

describe('shapeDragWorld (snap for every drag, incl. rotation)', () => {
  const policy = { snap: 5, axisLock: false };

  it('snaps a pure translation to the grid', () => {
    const end = shapeDragWorld([0, 0, 0], [11.7, 0, 0], IDENTITY_QUAT, policy);
    expect(end).toEqual([10, 0, 0]);
  });

  it('REGRESSION: snaps the translation of a ROTATING drag (was skipped)', () => {
    // "Snap isn't working": every rotating drag silently bypassed snap.
    const rot: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const end = shapeDragWorld([10, 10, 0], [23.4, 10, 0], rot, policy);
    expect(end).toEqual([25, 10, 0]);
  });

  it('axis lock never applies to a rotating drag', () => {
    const rot: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const end = shapeDragWorld([0, 0, 0], [8, 6, 0], rot, { snap: 0, axisLock: true });
    expect(end).toEqual([8, 6, 0]); // both components survive
  });

  it('group rigidity survives a snapped rotating drag end-to-end', () => {
    // The reason snap must shape the WORLD delta: quantize per cluster and
    // the bolt circle scatters; quantize the shared delta and every part
    // still follows ONE world rigid transform exactly.
    const rot: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const start: [number, number, number] = [0, 0, 30];
    const end = shapeDragWorld(start, [11.2, 0.4, 30], rot, policy);

    // The one true world transform every part must follow.
    const world = gizmoDragToRigid(start, end, rot);

    const frames: Frame[] = [
      WORLD_FRAME,
      { position: [58, 0, 0], rotation: quatFromAxisAngle([0, 0, 1], Math.PI / 4) },
    ];
    const rests: Vec3[] = [[10, 0, 0], [3, -2, 5]];

    for (let i = 0; i < frames.length; i++) {
      const move = clusterMoveFromDrag(null, frames[i], start, end, rot);
      // Part's world position after the move: move applied in the parent
      // frame, then the parent frame applied — same as the evaluator.
      const worldPos = applyRigid(
        { translation: frames[i].position, rotation: frames[i].rotation },
        applyRigid(moveToRigid(move), rests[i]),
      );
      const restWorld = applyRigid(
        { translation: frames[i].position, rotation: frames[i].rotation },
        rests[i],
      );
      const expected = applyRigid(world, restWorld);
      expect(worldPos[0]).toBeCloseTo(expected[0], 4);
      expect(worldPos[1]).toBeCloseTo(expected[1], 4);
      expect(worldPos[2]).toBeCloseTo(expected[2], 4);
    }
  });
});
