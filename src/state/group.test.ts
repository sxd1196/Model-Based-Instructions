/**
 * Store tests for group manipulation and callout editing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { buildAssemblyFromScene } from '@/cad/loadGltf';
import { makeDemoAssembly } from '@/cad/demo';
import { resolveFrame, resolveAnnotationPoint } from '@/domain/evaluate';
import { composePartTransform, quatFromAxisAngle } from '@/domain/transform';
import { parentWorldTransform } from '@/domain/authoring';
import { applyRigid } from '@/domain/rigid';
import { IDENTITY_QUAT, type Vec3 } from '@/domain/schema';

const { root, name } = makeDemoAssembly();
const { assembly } = buildAssemblyFromScene(root, 'demo://x', { name });

const idOf = (n: string) =>
  Object.values(assembly.parts).find((p) => p.name === n)!.id;

const s = () => useStore.getState();

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

beforeEach(() => {
  useStore.setState({
    sequence: null, selection: [], activeOperationId: null,
    time: 0, playing: false, playbackRate: 1, loading: false,
    warnings: [], past: [], future: [],
    snap: 0, axisLock: false, pickEnabled: true,
  });
  s().newFromAssembly(assembly);
});

describe('commitGroupDrag', () => {
  const boltParts = () =>
    Object.values(assembly.parts)
      .filter((p) => /^Bolt_M8_\d+_(Shank|Head)$/.test(p.name))
      .map((p) => p.id);

  // Bolts live in 8 separate Bolt_M8_NN parent groups placed on a circle, so
  // a drag spanning them writes one track PER PARENT CLUSTER (8 here). One
  // shared world-space Move was the scattered-bolt-circle bug: a Move is
  // applied in each part's PARENT frame, so parts under offset parents each
  // need their own local Move to express the same world motion.
  const CLUSTERS = 8;

  /** World position of a part under the frame at time t. */
  const worldAt = (id: string, t: number): Vec3 => {
    const frame = resolveFrame(s().sequence!, t);
    const node = assembly.parts[id];
    const move = frame.poses.get(id) ?? {
      translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0],
    };
    const local = composePartTransform(node.restTranslate, node.restRotate, move);
    const parent = parentWorldTransform(assembly, id);
    const placed = applyRigid(
      { rotation: parent.rotation, translation: parent.position },
      local.position,
    );
    return placed;
  };

  it('writes one track per parent cluster covering the whole group', () => {
    s().addOperation();
    const parts = boltParts();
    s().commitGroupDrag(parts, [0, 0, 0], [0, 0, 120], IDENTITY_QUAT);

    const tracks = s().sequence!.operations[0].tracks;
    expect(tracks).toHaveLength(CLUSTERS);
    expect(tracks.flatMap((t) => t.parts).sort()).toEqual([...parts].sort());
  });

  it('moves every member by the same world translation', () => {
    s().addOperation({ duration: 1, dwell: 0 });
    const parts = boltParts();
    s().commitGroupDrag(parts, [0, 0, 0], [0, 0, 75], IDENTITY_QUAT);

    for (const id of parts) {
      const before = worldAt(id, 0);
      const after = worldAt(id, 1);
      expect(after[2] - before[2]).toBeCloseTo(75, 4);
      expect(after[0] - before[0]).toBeCloseTo(0, 4);
    }
  });

  it('PRESERVES relative WORLD distances under a rotating drag', () => {
    s().addOperation({ duration: 1, dwell: 0 });
    const parts = boltParts();
    s().commitGroupDrag(
      parts,
      [0, 0, 70],
      [40, -20, 150],
      quatFromAxisAngle([0.2, 1, 0.3], 1.1),
    );

    // Rigidity must hold in WORLD space across parent clusters.
    const before = parts.map((id) => worldAt(id, 0));
    const after = parts.map((id) => worldAt(id, 1));
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        expect(dist(after[i], after[j])).toBeCloseTo(dist(before[i], before[j]), 3);
      }
    }
  });

  it('a second group drag accumulates on the same tracks', () => {
    s().addOperation({ duration: 1, dwell: 0 });
    const parts = boltParts();
    s().commitGroupDrag(parts, [0, 0, 0], [0, 0, 50], IDENTITY_QUAT);
    s().commitGroupDrag(parts, [0, 0, 50], [0, 0, 90], IDENTITY_QUAT);

    // Accumulates in place: still one track per cluster, not doubled.
    expect(s().sequence!.operations[0].tracks).toHaveLength(CLUSTERS);
    const id = parts[0];
    expect(worldAt(id, 1)[2] - worldAt(id, 0)[2]).toBeCloseTo(90, 4);
  });

  it('a DIFFERENT group gets its own tracks', () => {
    s().addOperation();
    s().commitGroupDrag(boltParts(), [0, 0, 0], [0, 0, 50], IDENTITY_QUAT);
    s().commitGroupDrag(
      [idOf('Cover_Plate'), idOf('Cover_Gasket')],
      [0, 0, 0], [0, 0, 30], IDENTITY_QUAT,
    );
    // 8 bolt clusters + 1 cover cluster (plate+gasket share SUB_Cover).
    expect(s().sequence!.operations[0].tracks).toHaveLength(CLUSTERS + 1);
  });

  it('expands a sub-assembly group id into its meshes', () => {
    s().addOperation();
    // Pass the bolt CONTAINER, not its meshes.
    s().commitGroupDrag([idOf('Bolt_M8_01')], [0, 0, 0], [0, 0, 60], IDENTITY_QUAT);
    const track = s().sequence!.operations[0].tracks[0];
    expect(track.parts.length).toBe(2); // shank + head
    expect(track.parts.every((p) => !assembly.parts[p].isGroup)).toBe(true);
  });

  it('applies snapping to a pure translation', () => {
    useStore.setState({ snap: 25 });
    s().addOperation();
    s().commitGroupDrag(boltParts(), [0, 0, 0], [0, 0, 97], IDENTITY_QUAT);
    expect(s().sequence!.operations[0].tracks[0].to.translate[2]).toBeCloseTo(100);
  });

  it('does NOT snap a rotating drag, which would break rigidity', () => {
    useStore.setState({ snap: 25, axisLock: true });
    s().addOperation();
    const parts = boltParts();
    s().commitGroupDrag(parts, [0, 0, 0], [3, 7, 97], quatFromAxisAngle([0, 0, 1], 0.6));

    const t = s().sequence!.operations[0].tracks[0].to.translate;
    // Untouched by snapping: not a multiple of 25 on every axis.
    expect(t[0] % 25 === 0 && t[1] % 25 === 0 && t[2] % 25 === 0).toBe(false);
  });

  it('AUTO-CREATES a step when none exists rather than discarding the drag', () => {
    // Deliberately inverted from the original assertion — see the matching
    // note in state/authoring.test.ts. Silently dropping a drag was the bug.
    expect(s().sequence!.operations).toHaveLength(0);
    s().commitGroupDrag(boltParts(), [0, 0, 0], [0, 0, 50], IDENTITY_QUAT);
    expect(s().sequence!.operations).toHaveLength(1);
    expect(s().sequence!.operations[0].tracks).toHaveLength(CLUSTERS);
  });

  it('a NO-OP click on the gizmo does not create an empty step', () => {
    // PivotControls fires dragEnd even for a plain click on the widget; an
    // identity drag with no active operation must leave the timeline alone.
    // (Regression: selecting a part created an empty op on every click.)
    expect(s().sequence!.operations).toHaveLength(0);
    s().commitGroupDrag(boltParts(), [10, 20, 30], [10, 20, 30], IDENTITY_QUAT);
    expect(s().sequence!.operations).toHaveLength(0);
  });

  it('is undoable in one step', () => {
    s().addOperation();
    s().commitGroupDrag(boltParts(), [0, 0, 0], [0, 0, 80], IDENTITY_QUAT);
    expect(s().sequence!.operations[0].tracks).toHaveLength(CLUSTERS);
    s().undo();
    expect(s().sequence!.operations[0].tracks).toHaveLength(0);
  });
});

describe('addMotionForSelection (typed-entry path)', () => {
  it('first motion spans the whole step', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('Cover_Plate')] });
    s().addMotionForSelection(opId);
    const t = s().sequence!.operations[0].tracks;
    expect(t).toHaveLength(1);
    expect([t[0].start, t[0].end]).toEqual([0, 1]);
  });

  it('a second motion on the same part SPLITS the step into equal windows', () => {
    // "Add another motion" means "then do this" — lane 1 compresses to the
    // first half, lane 2 takes the second, chaining via the evaluator.
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('Cover_Plate')] });
    s().addMotionForSelection(opId);
    s().addMotionForSelection(opId);

    const t = s().sequence!.operations[0].tracks;
    expect(t).toHaveLength(2);
    expect([t[0].start, t[0].end]).toEqual([0, 0.5]);
    expect([t[1].start, t[1].end]).toEqual([0.5, 1]);
  });

  it('a third motion makes thirds, preserving order', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('Cover_Plate')] });
    s().addMotionForSelection(opId);
    s().addMotionForSelection(opId);
    s().addMotionForSelection(opId);

    const t = s().sequence!.operations[0].tracks;
    expect(t).toHaveLength(3);
    expect(t[0].end).toBeCloseTo(1 / 3, 6);
    expect(t[1].start).toBeCloseTo(1 / 3, 6);
    expect(t[2].start).toBeCloseTo(2 / 3, 6);
  });

  it('a motion for a DIFFERENT part is untouched by the split', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('Cover_Plate')] });
    s().addMotionForSelection(opId);
    useStore.setState({ selection: [idOf('Main_Shaft')] });
    s().addMotionForSelection(opId);

    const t = s().sequence!.operations[0].tracks;
    // The plate's lane keeps its full window; the shaft gets its own.
    expect([t[0].start, t[0].end]).toEqual([0, 1]);
    expect([t[1].start, t[1].end]).toEqual([0, 1]);
  });

  it('a sub-assembly selection writes one track per parent cluster', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('SUB_Cover')] });
    s().addMotionForSelection(opId);
    // 8 bolt clusters + plate/gasket cluster.
    expect(s().sequence!.operations[0].tracks).toHaveLength(9);
  });
});

describe('updateLaneTracks / removeLaneTracks', () => {
  it('patches every track in a merged lane together', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('SUB_Cover')] });
    s().addMotionForSelection(opId);
    const ids = s().sequence!.operations[0].tracks.map((t) => t.id);

    s().updateLaneTracks(opId, ids, { start: 0.25, end: 0.75 });
    for (const t of s().sequence!.operations[0].tracks) {
      expect([t.start, t.end]).toEqual([0.25, 0.75]);
    }
  });

  it('removes a whole merged lane in one undoable step', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('SUB_Cover')] });
    s().addMotionForSelection(opId);
    const ids = s().sequence!.operations[0].tracks.map((t) => t.id);

    s().removeLaneTracks(opId, ids);
    expect(s().sequence!.operations[0].tracks).toHaveLength(0);
    s().undo();
    expect(s().sequence!.operations[0].tracks).toHaveLength(9);
  });
});

describe('selectSubassemblyOf', () => {
  it('selects every mesh in the containing sub-assembly', () => {
    s().selectSubassemblyOf(idOf('Bolt_M8_01_Shank'));
    const names = s().selection.map((id) => assembly.parts[id].name);
    // SUB_Cover contains the plate, gasket, and all 8 bolts.
    expect(names).toContain('Cover_Plate');
    expect(names).toContain('Bolt_M8_05_Head');
    expect(s().selection.every((id) => !assembly.parts[id].isGroup)).toBe(true);
  });

  it('additive mode accumulates', () => {
    s().selectSubassemblyOf(idOf('Cover_Plate'));
    const first = s().selection.length;
    s().selectSubassemblyOf(idOf('Main_Shaft'), true);
    expect(s().selection.length).toBeGreaterThan(first);
    expect(new Set(s().selection).size).toBe(s().selection.length);
  });
});

describe('updateAnnotation', () => {
  it('edits text', () => {
    const opId = s().addOperation()!;
    s().addAnnotation(opId, {
      text: 'old', anchor: { kind: 'world', point: [0, 0, 0] }, labelOffset: [0, 0, 0],
    });
    const aid = s().sequence!.operations[0].annotations[0].id;
    s().updateAnnotation(opId, aid, { text: 'new' });
    expect(s().sequence!.operations[0].annotations[0].text).toBe('new');
  });

  it('re-pins a world callout to a part so it starts following', () => {
    const opId = s().addOperation({ duration: 1, dwell: 0 })!;
    const part = idOf('Cover_Plate');
    s().addTrack(opId, [part], {
      translate: [0, 0, 90], rotate: IDENTITY_QUAT, pivot: [0, 0, 0],
    });
    s().addAnnotation(opId, {
      text: 'x', anchor: { kind: 'world', point: [0, 0, 0] }, labelOffset: [0, 0, 0],
    });
    const aid = s().sequence!.operations[0].annotations[0].id;

    s().updateAnnotation(opId, aid, { anchor: { kind: 'part', partId: part } });

    const seq = s().sequence!;
    const anno = seq.operations[0].annotations[0];
    const start = resolveAnnotationPoint(seq, resolveFrame(seq, 0), anno)!;
    const end = resolveAnnotationPoint(seq, resolveFrame(seq, 1), anno)!;
    expect(end[2] - start[2]).toBeCloseTo(90);
  });

  it('edits the label offset', () => {
    const opId = s().addOperation()!;
    s().addAnnotation(opId, {
      text: 'x', anchor: { kind: 'world', point: [0, 0, 0] }, labelOffset: [0, 0, 0],
    });
    const aid = s().sequence!.operations[0].annotations[0].id;
    s().updateAnnotation(opId, aid, { labelOffset: [40, -30, 0] });
    expect(s().sequence!.operations[0].annotations[0].labelOffset).toEqual([40, -30, 0]);
  });

  it('is undoable', () => {
    const opId = s().addOperation()!;
    s().addAnnotation(opId, {
      text: 'original', anchor: { kind: 'world', point: [0, 0, 0] }, labelOffset: [0, 0, 0],
    });
    const aid = s().sequence!.operations[0].annotations[0].id;
    s().updateAnnotation(opId, aid, { text: 'changed' });
    s().undo();
    expect(s().sequence!.operations[0].annotations[0].text).toBe('original');
  });
});
