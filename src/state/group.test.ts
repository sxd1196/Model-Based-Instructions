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
import { parseSequence } from '@/domain/schema';
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
    axisLock: false, pickEnabled: true,
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

  // DELETED: drag-snap tests — snap removed per user decision (typed
  // motion values in the lanes panel replace grid snap).

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

describe('addMotionForParts / removePartFromLane (lane membership)', () => {
  it('move again: chains a second motion for the SAME parts without selection', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('Cover_Plate')] });
    s().addMotionForSelection(opId);
    // Selection cleared — the per-lane button passes parts explicitly.
    useStore.setState({ selection: [] });
    s().addMotionForParts(opId, [idOf('Cover_Plate')]);

    const t = s().sequence!.operations[0].tracks;
    expect(t).toHaveLength(2);
    expect([t[0].start, t[0].end]).toEqual([0, 0.5]);
    expect([t[1].start, t[1].end]).toEqual([0.5, 1]);
  });

  it('REGRESSION: move again on a MERGED lane compresses it as ONE unit', () => {
    // A SUB_Cover motion is 9 cluster tracks sharing one timing window (one
    // visual lane). The first compress implementation gave each TRACK its
    // own window, shattering the lane into a 9-step stagger the author
    // never wrote. Windows must be assigned per timing-group.
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('SUB_Cover')] });
    s().addMotionForSelection(opId);
    const parts = s().sequence!.operations[0].tracks.flatMap((t) => t.parts);

    s().addMotionForParts(opId, parts);

    const tracks = s().sequence!.operations[0].tracks;
    const windows = new Set(tracks.map((t) => `${t.start.toFixed(3)}:${t.end.toFixed(3)}`));
    // Exactly two timing windows: the original lane (0-0.5) and the new one (0.5-1).
    expect([...windows].sort()).toEqual(['0.000:0.500', '0.500:1.000']);
  });

  it('removes one part from a lane, keeping the rest moving', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('SUB_Cover')] });
    s().addMotionForSelection(opId);
    const before = s().sequence!.operations[0].tracks;
    const total = before.reduce((n, t) => n + t.parts.length, 0);
    const victim = idOf('Bolt_M8_03_Head');
    const ids = before.map((t) => t.id);

    s().removePartFromLane(opId, ids, victim);

    const after = s().sequence!.operations[0].tracks;
    const remaining = after.flatMap((t) => t.parts);
    expect(remaining).toHaveLength(total - 1);
    expect(remaining).not.toContain(victim);
  });

  it('a track emptied of parts is deleted entirely', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('Cover_Plate')] });
    s().addMotionForSelection(opId);
    const ids = s().sequence!.operations[0].tracks.map((t) => t.id);

    s().removePartFromLane(opId, ids, idOf('Cover_Plate'));
    expect(s().sequence!.operations[0].tracks).toHaveLength(0);
  });

  it('part removal is undoable in one step', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('SUB_Cover')] });
    s().addMotionForSelection(opId);
    const ids = s().sequence!.operations[0].tracks.map((t) => t.id);
    const total = s().sequence!.operations[0].tracks.reduce((n, t) => n + t.parts.length, 0);

    s().removePartFromLane(opId, ids, idOf('Cover_Gasket'));
    s().undo();
    const restored = s().sequence!.operations[0].tracks.reduce((n, t) => n + t.parts.length, 0);
    expect(restored).toBe(total);
  });
});

describe('goHomeSelection (per-component return to home)', () => {
  it('clears the selected part motion; other parts keep theirs', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('Cover_Plate')] });
    s().addMotionForSelection(opId);
    useStore.setState({ selection: [idOf('Main_Shaft')] });
    s().addMotionForSelection(opId);

    useStore.setState({ selection: [idOf('Cover_Plate')] });
    s().goHomeSelection();

    const remaining = s().sequence!.operations[0].tracks.flatMap((t) => t.parts);
    expect(remaining).toContain(idOf('Main_Shaft'));
    expect(remaining).not.toContain(idOf('Cover_Plate'));
  });

  it('a sub-assembly selection homes every mesh in it', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('SUB_Cover')] });
    s().addMotionForSelection(opId);
    expect(s().sequence!.operations[0].tracks.length).toBeGreaterThan(0);

    s().goHomeSelection();
    expect(s().sequence!.operations[0].tracks).toHaveLength(0);
  });

  it('no-ops when the active step does not move the selection (no empty checkpoint)', () => {
    s().addOperation();
    useStore.setState({ selection: [idOf('Cover_Plate')] });
    const pastBefore = useStore.getState().past.length;
    s().goHomeSelection();
    expect(useStore.getState().past.length).toBe(pastBefore);
  });

  it('is undoable in one step', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('SUB_Cover')] });
    s().addMotionForSelection(opId);
    const before = s().sequence!.operations[0].tracks.length;

    s().goHomeSelection();
    s().undo();
    expect(s().sequence!.operations[0].tracks).toHaveLength(before);
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

describe('REGRESSION: undo treats a bar drag as ONE step', () => {
  // A timing-bar drag fires updateLaneTracks per pointermove. Each call
  // checkpointed, so one drag buried the undo stack in micro-snapshots and
  // undo "replayed the motion" twitch by twitch instead of reverting it.
  it('a 30-move gesture adds exactly one undo entry', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('Cover_Plate')] });
    s().addMotionForSelection(opId);
    const ids = s().sequence!.operations[0].tracks.map((t) => t.id);
    const pastBefore = useStore.getState().past.length;

    s().beginGesture('Adjust timing');
    for (let i = 1; i <= 30; i++) {
      s().updateLaneTracks(opId, ids, { start: i / 100 }, true);
    }
    expect(useStore.getState().past.length).toBe(pastBefore + 1);

    // One undo restores the PRE-DRAG timing completely.
    s().undo();
    expect(s().sequence!.operations[0].tracks[0].start).toBe(0);
  });

  it('non-live lane edits still checkpoint individually', () => {
    const opId = s().addOperation()!;
    useStore.setState({ selection: [idOf('Cover_Plate')] });
    s().addMotionForSelection(opId);
    const ids = s().sequence!.operations[0].tracks.map((t) => t.id);
    const pastBefore = useStore.getState().past.length;

    s().updateLaneTracks(opId, ids, { start: 0.2 });
    s().updateLaneTracks(opId, ids, { start: 0.4 });
    expect(useStore.getState().past.length).toBe(pastBefore + 2);
  });
});

describe('default step timing', () => {
  it('new steps are 5s with 1s dwell', () => {
    s().addOperation();
    const op = s().sequence!.operations[0];
    expect(op.duration).toBe(5);
    expect(op.dwell).toBe(1);
  });
});

describe('section cuts (v5)', () => {
  it('sets, edits, and clears a whole-assembly section', () => {
    const opId = s().addOperation()!;
    s().setSection(opId, { axis: 'Z', offset: 30, flip: false, parts: [] });
    expect(s().sequence!.operations[0].section).toEqual({ axis: 'Z', offset: 30, flip: false, parts: [] });

    s().setSection(opId, { axis: 'Z', offset: -12.5, flip: true, parts: [] });
    expect(s().sequence!.operations[0].section!.offset).toBe(-12.5);
    expect(s().sequence!.operations[0].section!.flip).toBe(true);

    s().setSection(opId, null);
    expect(s().sequence!.operations[0].section).toBeNull();
  });

  it('selection-scoped section carries the part list', () => {
    const opId = s().addOperation()!;
    const parts = [idOf('Cover_Plate'), idOf('Cover_Gasket')];
    s().setSection(opId, { axis: 'X', offset: 0, flip: false, parts });
    expect(s().sequence!.operations[0].section!.parts).toEqual(parts);
  });

  it('live plane drags are one undo step (gesture pattern)', () => {
    const opId = s().addOperation()!;
    s().setSection(opId, { axis: 'Y', offset: 0, flip: false, parts: [] });
    const pastBefore = useStore.getState().past.length;

    s().beginGesture('Move section plane');
    for (let i = 1; i <= 20; i++) {
      s().setSection(opId, { axis: 'Y', offset: i * 2, flip: false, parts: [] }, true);
    }
    expect(useStore.getState().past.length).toBe(pastBefore + 1);

    s().undo();
    expect(s().sequence!.operations[0].section!.offset).toBe(0);
  });

  it('the evaluator surfaces the active section and only the active one', () => {
    const op1 = s().addOperation()!;
    const op2 = s().addOperation()!;
    s().setSection(op1, { axis: 'Z', offset: 10, flip: false, parts: [] });

    const seq = s().sequence!;
    const d1 = seq.operations[0].duration;
    const inOp1 = resolveFrame(seq, d1 * 0.5);
    expect(inOp1.section?.offset).toBe(10);

    const inOp2 = resolveFrame(seq, d1 + seq.operations[0].dwell + 0.1);
    expect(inOp2.section).toBeNull();
    void op2;
  });

  it('round-trips through save/load (schema v5)', () => {
    const opId = s().addOperation()!;
    s().setSection(opId, { axis: 'X', offset: 42, flip: true, parts: [idOf('Cover_Plate')] });
    const json = JSON.parse(JSON.stringify(s().sequence));
    const parsed = parseSequence(json);
    expect(parsed.operations[0].section).toEqual(s().sequence!.operations[0].section);
  });
});

describe('draft review lifecycle', () => {
  const fakeDraft = () => {
    const mk = (title: string) => ({
      id: crypto.randomUUID(), title, description: 'Remove x — straight up.',
      noteCorner: 'tl' as const, duration: 5, dwell: 1, tracks: [], camera: null,
      annotations: [], styles: [], meta: { plannedBy: 'sequence-planner-v1', planReason: 'test' },
      section: null,
    });
    return [mk('s1'), mk('s2'), mk('s3')];
  };

  it('install -> all steps pending, sequence holds the draft', () => {
    const ops = fakeDraft();
    s().beginDraftReview(ops, []);
    expect(useStore.getState().draftReview).not.toBeNull();
    expect(Object.values(useStore.getState().draftReview!.verdicts)).toEqual(['pending', 'pending', 'pending']);
    expect(s().sequence!.operations).toHaveLength(3);
  });

  it('accept keeps approved+pending, drops rejected, exits review', () => {
    const ops = fakeDraft();
    s().beginDraftReview(ops, []);
    s().setDraftVerdict(ops[1].id, 'rejected');
    s().setDraftVerdict(ops[2].id, 'approved');
    s().acceptDraft();
    const st = useStore.getState();
    expect(st.draftReview).toBeNull();
    expect(st.sequence!.operations.map((o) => o.title)).toEqual(['s1', 's3']);
  });

  it('discard empties the sequence and exits review', () => {
    s().beginDraftReview(fakeDraft(), []);
    s().discardDraft();
    const st = useStore.getState();
    expect(st.draftReview).toBeNull();
    expect(st.sequence!.operations).toHaveLength(0);
  });

  it('accept and discard are both undoable', () => {
    const ops = fakeDraft();
    s().beginDraftReview(ops, []);
    s().discardDraft();
    s().undo();
    expect(s().sequence!.operations).toHaveLength(3);
  });
});
