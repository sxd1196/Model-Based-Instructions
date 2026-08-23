/**
 * Store tests: authoring actions, undo/redo, and timeline navigation.
 *
 * These matter because the store is where user intent becomes document state.
 * A bug here silently corrupts saved work, which is worse than a crash.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { buildAssemblyFromScene } from '@/cad/loadGltf';
import { makeDemoAssembly } from '@/cad/demo';
import { poseFor, resolveFrame, totalDuration } from '@/domain/evaluate';
import { Sequence as SequenceSchema } from '@/domain/schema';

const { root, name } = makeDemoAssembly();
const { assembly } = buildAssemblyFromScene(root, 'demo://x', { name });

const partId = (n: string) =>
  Object.values(assembly.parts).find((p) => p.name === n)!.id;

const s = () => useStore.getState();

beforeEach(() => {
  useStore.setState({
    sequence: null,
    selection: [],
    activeOperationId: null,
    time: 0,
    playing: false,
    playbackRate: 1,
    loading: false,
    warnings: [],
    past: [],
    future: [],
  });
  s().newFromAssembly(assembly);
});

describe('operations', () => {
  it('adds a step and makes it active', () => {
    const id = s().addOperation();
    expect(id).toBeTruthy();
    expect(s().sequence!.operations).toHaveLength(1);
    expect(s().activeOperationId).toBe(id);
  });

  it('numbers new steps sequentially', () => {
    s().addOperation();
    s().addOperation();
    expect(s().sequence!.operations.map((o) => o.title)).toEqual(['Step 1', 'Step 2']);
  });

  it('edits title and duration', () => {
    const id = s().addOperation()!;
    s().updateOperation(id, { title: 'Remove cover', duration: 3 });
    const op = s().sequence!.operations[0];
    expect(op.title).toBe('Remove cover');
    expect(op.duration).toBe(3);
  });

  it('removes a step and reassigns active', () => {
    const a = s().addOperation()!;
    s().addOperation();
    s().removeOperation(a);
    expect(s().sequence!.operations).toHaveLength(1);
    expect(s().activeOperationId).not.toBe(a);
  });

  it('reorders steps', () => {
    s().addOperation({ title: 'A' });
    s().addOperation({ title: 'B' });
    s().addOperation({ title: 'C' });
    s().reorderOperation(2, 0);
    expect(s().sequence!.operations.map((o) => o.title)).toEqual(['C', 'A', 'B']);
  });

  it('ignores out-of-range reorder instead of corrupting the list', () => {
    s().addOperation({ title: 'A' });
    s().reorderOperation(5, 99);
    expect(s().sequence!.operations.map((o) => o.title)).toEqual(['A']);
  });

  it('duplicates a step with fresh ids so edits do not alias', () => {
    const id = s().addOperation({ title: 'Bolt out' })!;
    s().addTrack(id, [partId('Cover_Plate')], {
      translate: [0, 0, 50], rotate: [0, 0, 0, 1], pivot: [0, 0, 0],
    });
    s().duplicateOperation(id);

    const [a, b] = s().sequence!.operations;
    expect(b.title).toBe('Bolt out (copy)');
    expect(b.id).not.toBe(a.id);
    expect(b.tracks[0].id).not.toBe(a.tracks[0].id);

    // Editing the copy must not touch the original.
    s().updateTrack(b.id, b.tracks[0].id, { easing: 'linear' });
    expect(s().sequence!.operations[0].tracks[0].easing).toBe('easeInOut');
  });
});

describe('tracks', () => {
  it('adds a motion from a selection', () => {
    const id = s().addOperation()!;
    s().select([partId('Cover_Plate'), partId('Cover_Gasket')]);
    s().addTrack(id, s().selection);
    expect(s().sequence!.operations[0].tracks[0].parts).toHaveLength(2);
  });

  it('refuses to add an empty track', () => {
    const id = s().addOperation()!;
    s().addTrack(id, []);
    expect(s().sequence!.operations[0].tracks).toHaveLength(0);
  });

  it('removes a track', () => {
    const id = s().addOperation()!;
    s().addTrack(id, [partId('Main_Shaft')]);
    const tid = s().sequence!.operations[0].tracks[0].id;
    s().removeTrack(id, tid);
    expect(s().sequence!.operations[0].tracks).toHaveLength(0);
  });

  it('authored motion actually shows up in the evaluated frame', () => {
    // The real integration point: store edit -> evaluator output.
    const id = s().addOperation({ duration: 2, dwell: 0 })!;
    s().addTrack(id, [partId('Cover_Plate')], {
      translate: [0, 0, 80], rotate: [0, 0, 0, 1], pivot: [0, 0, 0],
    });
    const f = resolveFrame(s().sequence!, 2);
    expect(poseFor(f, partId('Cover_Plate')).translate[2]).toBeCloseTo(80);
  });
});

describe('selection', () => {
  it('replaces by default and appends when additive', () => {
    s().select(['a']);
    s().select(['b']);
    expect(s().selection).toEqual(['b']);
    s().select(['c'], true);
    expect(s().selection).toEqual(['b', 'c']);
  });

  it('dedupes additive selection', () => {
    s().select(['a']);
    s().select(['a'], true);
    expect(s().selection).toEqual(['a']);
  });
});

describe('playhead', () => {
  it('clamps to [0, total]', () => {
    s().addOperation({ duration: 2, dwell: 0 });
    s().setTime(-10);
    expect(s().time).toBe(0);
    s().setTime(999);
    expect(s().time).toBeCloseTo(2);
  });

  it('seeks to the start of a given operation', () => {
    s().addOperation({ duration: 2, dwell: 0.5 });
    const b = s().addOperation({ duration: 1, dwell: 0 })!;
    s().seekToOperation(b);
    expect(s().time).toBeCloseTo(2.5);
    expect(s().playing).toBe(false);
  });
});

describe('undo / redo', () => {
  it('undoes an add', () => {
    s().addOperation();
    expect(s().sequence!.operations).toHaveLength(1);
    s().undo();
    expect(s().sequence!.operations).toHaveLength(0);
  });

  it('redoes after undo', () => {
    s().addOperation();
    s().undo();
    s().redo();
    expect(s().sequence!.operations).toHaveLength(1);
  });

  it('undoes a title edit back to the prior value', () => {
    const id = s().addOperation({ title: 'original' })!;
    s().updateOperation(id, { title: 'changed' });
    s().undo();
    expect(s().sequence!.operations[0].title).toBe('original');
  });

  it('undoes a delete, restoring the step', () => {
    const id = s().addOperation({ title: 'keepme' })!;
    s().removeOperation(id);
    expect(s().sequence!.operations).toHaveLength(0);
    s().undo();
    expect(s().sequence!.operations[0].title).toBe('keepme');
  });

  it('clears the redo stack on a new edit after undo', () => {
    s().addOperation({ title: 'A' });
    s().undo();
    s().addOperation({ title: 'B' });
    s().redo();
    // Redo must not resurrect 'A' after a divergent edit.
    expect(s().sequence!.operations.map((o) => o.title)).toEqual(['B']);
  });

  it('undo on an empty history is a no-op, not a crash', () => {
    expect(() => s().undo()).not.toThrow();
    expect(s().sequence!.operations).toHaveLength(0);
  });

  it('history snapshots are deep copies, not references', () => {
    const id = s().addOperation({ title: 'A' })!;
    s().addTrack(id, [partId('Main_Shaft')]);
    s().updateTrack(id, s().sequence!.operations[0].tracks[0].id, {
      to: { translate: [0, 0, 999], rotate: [0, 0, 0, 1], pivot: [0, 0, 0] },
    });
    s().undo();
    expect(s().sequence!.operations[0].tracks[0].to.translate[2]).toBe(0);
  });

  it('survives 30 edits then 30 undos', () => {
    for (let i = 0; i < 30; i++) s().addOperation({ title: `S${i}` });
    for (let i = 0; i < 30; i++) s().undo();
    expect(s().sequence!.operations).toHaveLength(0);
  });
});

describe('styles', () => {
  it('replaces a prior style for the same part instead of stacking', () => {
    const id = s().addOperation()!;
    const p = partId('Housing_Body');
    s().setStyle(id, { parts: [p], mode: 'ghost' });
    s().setStyle(id, { parts: [p], mode: 'hidden' });
    const styles = s().sequence!.operations[0].styles;
    expect(styles).toHaveLength(1);
    expect(styles[0].mode).toBe('hidden');
  });
});

describe('annotations', () => {
  it('adds and removes callouts', () => {
    const id = s().addOperation()!;
    s().addAnnotation(id, {
      text: 'Torque to 12 Nm',
      anchor: { kind: 'world', point: [0, 0, 0] },
      offset: [12, -12],
    });
    expect(s().sequence!.operations[0].annotations).toHaveLength(1);
    const aid = s().sequence!.operations[0].annotations[0].id;
    s().removeAnnotation(id, aid);
    expect(s().sequence!.operations[0].annotations).toHaveLength(0);
  });
});

describe('round trip', () => {
  it('survives JSON save -> parse -> load with identical playback', () => {
    const id = s().addOperation({ title: 'Lift cover', duration: 2, dwell: 0.5 })!;
    s().addTrack(id, [partId('Cover_Plate')], {
      translate: [0, 0, 90], rotate: [0, 0, 0, 1], pivot: [0, 0, 0],
    });
    s().setOperationCamera(id, { position: [300, 200, 300], target: [0, 0, 0], fov: 45 });

    const before = s().sequence!;
    const json = JSON.parse(JSON.stringify(before));
    const after = SequenceSchema.parse(json);

    expect(totalDuration(after)).toBeCloseTo(totalDuration(before));
    for (const t of [0, 0.5, 1, 1.5, 2, 2.5]) {
      expect(poseFor(resolveFrame(after, t), partId('Cover_Plate')).translate).toEqual(
        poseFor(resolveFrame(before, t), partId('Cover_Plate')).translate,
      );
    }
  });

  it('rejects a malformed project instead of loading garbage', () => {
    expect(() => s().loadFromJson({ nope: true })).toThrow();
  });

  it('rejects a future schema version', () => {
    const bad = { ...JSON.parse(JSON.stringify(s().sequence)), schemaVersion: 99 };
    expect(() => s().loadFromJson(bad)).toThrow();
  });
});
