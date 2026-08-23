/**
 * Store tests for direct-manipulation authoring: viewport picking and
 * gizmo drag commits.
 *
 * Kept separate from store.test.ts so the two concerns stay readable.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { buildAssemblyFromScene } from '@/cad/loadGltf';
import { makeDemoAssembly } from '@/cad/demo';
import { poseFor, resolveFrame } from '@/domain/evaluate';
import { composePartTransform, quatFromAxisAngle } from '@/domain/transform';
import { IDENTITY_QUAT, type Vec3 } from '@/domain/schema';

const { root, name } = makeDemoAssembly();
const { assembly } = buildAssemblyFromScene(root, 'demo://x', { name });

const idOf = (n: string) =>
  Object.values(assembly.parts).find((p) => p.name === n)!.id;

const s = () => useStore.getState();

beforeEach(() => {
  useStore.setState({
    sequence: null, selection: [], activeOperationId: null,
    time: 0, playing: false, playbackRate: 1, loading: false,
    warnings: [], past: [], future: [],
    snap: 0, axisLock: false, pickEnabled: true,
  });
  s().newFromAssembly(assembly);
});

describe('pickPart', () => {
  it('clicking a bolt sub-mesh selects the whole bolt geometry', () => {
    s().pickPart(idOf('Bolt_M8_01_Shank'));
    const names = s().selection.map((id) => assembly.parts[id].name).sort();
    expect(names).toEqual(['Bolt_M8_01_Head', 'Bolt_M8_01_Shank']);
  });

  it('deep mode selects only the clicked mesh', () => {
    s().pickPart(idOf('Bolt_M8_01_Shank'), { deep: true });
    expect(s().selection).toEqual([idOf('Bolt_M8_01_Shank')]);
  });

  it('additive picking accumulates without duplicates', () => {
    s().pickPart(idOf('Bolt_M8_01_Shank'));
    s().pickPart(idOf('Bolt_M8_02_Shank'), { additive: true });
    s().pickPart(idOf('Bolt_M8_01_Head'), { additive: true });
    expect(s().selection).toHaveLength(4);
    expect(new Set(s().selection).size).toBe(4);
  });

  it('never selects a group, only posable meshes', () => {
    s().pickPart(idOf('Cover_Plate'));
    expect(s().selection.every((id) => !assembly.parts[id].isGroup)).toBe(true);
  });

  it('an unknown id leaves the selection untouched', () => {
    s().select([idOf('Main_Shaft')]);
    s().pickPart('bogus');
    expect(s().selection).toEqual([idOf('Main_Shaft')]);
  });
});

describe('commitDrag', () => {
  it('creates a track from a drag and it reads back through the evaluator', () => {
    s().addOperation({ duration: 1, dwell: 0 });
    const part = idOf('Cover_Plate');
    const rest = assembly.parts[part].restTranslate;

    // Simulate dragging 90mm along +Z.
    const dragged: Vec3 = [rest[0], rest[1], rest[2] + 90];
    s().commitDrag(part, dragged, assembly.parts[part].restRotate);

    expect(s().sequence!.operations[0].tracks).toHaveLength(1);
    const f = resolveFrame(s().sequence!, 1);
    expect(poseFor(f, part).translate[2]).toBeCloseTo(90);
  });

  it('a second drag UPDATES the existing track instead of stacking', () => {
    s().addOperation();
    const part = idOf('Cover_Plate');
    const rest = assembly.parts[part].restTranslate;
    const q = assembly.parts[part].restRotate;

    s().commitDrag(part, [rest[0], rest[1], rest[2] + 50], q);
    s().commitDrag(part, [rest[0], rest[1], rest[2] + 120], q);

    expect(s().sequence!.operations[0].tracks).toHaveLength(1);
    expect(s().sequence!.operations[0].tracks[0].to.translate[2]).toBeCloseTo(120);
  });

  it('a drag ending at rest does not create a dead track', () => {
    s().addOperation();
    const part = idOf('Cover_Plate');
    s().commitDrag(part, assembly.parts[part].restTranslate, assembly.parts[part].restRotate);
    expect(s().sequence!.operations[0].tracks).toHaveLength(0);
  });

  it('AUTO-CREATES a step when none exists rather than discarding the drag', () => {
    // Changed deliberately from the original assertion, which required an
    // active operation and made a first drag silently do nothing. That was
    // the reported gizmo bug: no step, no feedback, no motion.
    const part = idOf('Cover_Plate');
    const rest = assembly.parts[part].restTranslate;
    expect(s().sequence!.operations).toHaveLength(0);

    s().commitDrag(part, [rest[0], rest[1], rest[2] + 60], assembly.parts[part].restRotate);

    expect(s().sequence!.operations).toHaveLength(1);
    expect(s().sequence!.operations[0].tracks[0].to.translate[2]).toBeCloseTo(60);
  });

  it('applies grid snapping', () => {
    useStore.setState({ snap: 25 });
    s().addOperation();
    const part = idOf('Cover_Plate');
    const rest = assembly.parts[part].restTranslate;
    s().commitDrag(part, [rest[0], rest[1], rest[2] + 97.3], assembly.parts[part].restRotate);
    expect(s().sequence!.operations[0].tracks[0].to.translate[2]).toBeCloseTo(100);
  });

  it('applies axis lock to clean up a sloppy drag', () => {
    useStore.setState({ axisLock: true });
    s().addOperation();
    const part = idOf('Cover_Plate');
    const rest = assembly.parts[part].restTranslate;
    // Mostly +Z with a little wobble on X and Y.
    s().commitDrag(
      part,
      [rest[0] + 0.4, rest[1] - 0.3, rest[2] + 80],
      assembly.parts[part].restRotate,
    );
    const t = s().sequence!.operations[0].tracks[0].to.translate;
    expect(t[0]).toBe(0);
    expect(t[1]).toBe(0);
    expect(t[2]).toBeCloseTo(80);
  });

  it('round-trips a rotation drag exactly', () => {
    s().addOperation();
    const part = idOf('Main_Shaft');
    const node = assembly.parts[part];
    const authored = quatFromAxisAngle([0, 0, 1], Math.PI / 4);

    // Where the gizmo would leave the part after that rotation.
    const posed = composePartTransform(node.restTranslate, node.restRotate, {
      translate: [0, 0, 0], rotate: authored, pivot: [0, 0, 0],
    });
    s().commitDrag(part, posed.position, posed.rotation);

    const stored = s().sequence!.operations[0].tracks[0].to.rotate;
    const dot = Math.abs(stored.reduce((acc, v, i) => acc + v * authored[i], 0));
    expect(dot).toBeCloseTo(1, 5);
  });

  it('is undoable', () => {
    s().addOperation();
    const part = idOf('Cover_Plate');
    const rest = assembly.parts[part].restTranslate;
    s().commitDrag(part, [rest[0], rest[1], rest[2] + 90], assembly.parts[part].restRotate);
    expect(s().sequence!.operations[0].tracks).toHaveLength(1);
    s().undo();
    expect(s().sequence!.operations[0].tracks).toHaveLength(0);
  });

  it('drags on different parts create separate tracks', () => {
    s().addOperation();
    for (const nm of ['Cover_Plate', 'Cover_Gasket']) {
      const p = idOf(nm);
      const r = assembly.parts[p].restTranslate;
      s().commitDrag(p, [r[0], r[1], r[2] + 40], assembly.parts[p].restRotate);
    }
    expect(s().sequence!.operations[0].tracks).toHaveLength(2);
  });
});

describe('REGRESSION: authored motion is visible immediately', () => {
  it('parks the playhead at the end of the drag so the part MOVES', () => {
    // Reported bug: on a freshly loaded app the gizmo moved but the part
    // stayed put, until you played the step. Cause: newFromAssembly leaves
    // time=0, and a new track runs IDENTITY -> dragged, so resolveFrame(0)
    // renders the part at rest while the gizmo sits where it was dropped.
    const part = idOf('Cover_Plate');
    const rest = assembly.parts[part].restTranslate;

    expect(s().time).toBe(0);
    s().commitDrag(part, [rest[0], rest[1], rest[2] + 90], assembly.parts[part].restRotate);

    // The playhead must land where the motion is complete.
    expect(s().time).toBeGreaterThan(0);

    const frame = resolveFrame(s().sequence!, s().time);
    expect(poseFor(frame, part).translate[2]).toBeCloseTo(90);
  });

  it('a second drag on the same part is also immediately visible', () => {
    const part = idOf('Cover_Plate');
    const rest = assembly.parts[part].restTranslate;
    const q = assembly.parts[part].restRotate;

    s().commitDrag(part, [rest[0], rest[1], rest[2] + 40], q);
    s().commitDrag(part, [rest[0], rest[1], rest[2] + 120], q);

    const frame = resolveFrame(s().sequence!, s().time);
    expect(poseFor(frame, part).translate[2]).toBeCloseTo(120);
  });

  it('a group drag is immediately visible too', () => {
    const bolts = Object.values(assembly.parts)
      .filter((p) => /^Bolt_M8_\d+_(Shank|Head)$/.test(p.name))
      .map((p) => p.id);

    s().commitGroupDrag(bolts, [0, 0, 0], [0, 0, 75], IDENTITY_QUAT);

    const frame = resolveFrame(s().sequence!, s().time);
    expect(poseFor(frame, bolts[0]).translate[2]).toBeCloseTo(75);
  });

  it('does not move the playhead when the drag is rejected as a no-op', () => {
    const part = idOf('Cover_Plate');
    s().commitDrag(part, assembly.parts[part].restTranslate, assembly.parts[part].restRotate);
    expect(s().time).toBe(0);
    expect(s().sequence!.operations).toHaveLength(0);
  });
});

describe('REGRESSION: rotation drags', () => {
  it('rotating in place does NOT fling the part across the scene', () => {
    // Reported bug: the rotate rings did nothing usable. Cause: moveFromDrag
    // defaulted the pivot to the world origin, so an in-place rotation
    // produced a huge translate, which axisLock then collapsed onto one axis
    // and snap quantized — corrupting the result beyond recognition.
    useStore.setState({ snap: 5, axisLock: true });

    const part = idOf('Cover_Plate');
    const node = assembly.parts[part];
    const spin = quatFromAxisAngle([0, 0, 1], Math.PI / 4);

    // A rotate-only gizmo drag leaves the handle where it was.
    const posed = composePartTransform(node.restTranslate, node.restRotate, {
      translate: [0, 0, 0], rotate: spin, pivot: node.restTranslate,
    });
    s().commitDrag(part, posed.position, posed.rotation);

    const frame = resolveFrame(s().sequence!, s().time);
    const move = poseFor(frame, part);

    // The part must end up where the gizmo left it, not somewhere else.
    const final = composePartTransform(node.restTranslate, node.restRotate, move);
    const drift = Math.hypot(
      final.position[0] - posed.position[0],
      final.position[1] - posed.position[1],
      final.position[2] - posed.position[2],
    );
    expect(drift).toBeLessThan(1);
  });

  it('records the authored rotation accurately', () => {
    useStore.setState({ snap: 5, axisLock: true });

    const part = idOf('Main_Shaft');
    const node = assembly.parts[part];
    const spin = quatFromAxisAngle([0, 1, 0], Math.PI / 3);

    const posed = composePartTransform(node.restTranslate, node.restRotate, {
      translate: [0, 0, 0], rotate: spin, pivot: node.restTranslate,
    });
    s().commitDrag(part, posed.position, posed.rotation);

    const stored = s().sequence!.operations[0].tracks[0].to.rotate;
    const dot = Math.abs(stored.reduce((acc, v, i) => acc + v * spin[i], 0));
    expect(dot).toBeCloseTo(1, 4);
  });

  it('does not snap or axis-lock the translate of a rotating drag', () => {
    // Quantizing the translate of a rotated transform breaks the result.
    useStore.setState({ snap: 25, axisLock: true });

    const part = idOf('Cover_Plate');
    const node = assembly.parts[part];
    const spin = quatFromAxisAngle([1, 0, 0], 0.7);

    const posed = composePartTransform(node.restTranslate, node.restRotate, {
      translate: [3, 7, 11], rotate: spin, pivot: node.restTranslate,
    });
    s().commitDrag(part, posed.position, posed.rotation);

    const t = s().sequence!.operations[0].tracks[0].to.translate;
    const allMultiples =
      t.every((n) => Math.abs(n % 25) < 1e-6);
    expect(allMultiples).toBe(false);
  });
});

describe('explodeSelection', () => {
  it('creates outward tracks for the whole selection', () => {
    s().addOperation();
    const bolts = Object.values(assembly.parts)
      .filter((p) => /^Bolt_M8_\d+$/.test(p.name))
      .map((p) => p.id);
    s().select(bolts);
    s().explodeSelection(0.6);

    const tracks = s().sequence!.operations[0].tracks;
    expect(tracks.length).toBeGreaterThan(0);
    // Every explode move must actually displace the part.
    for (const t of tracks) {
      expect(Math.hypot(...t.to.translate)).toBeGreaterThan(0);
    }
  });

  it('is a no-op with an empty selection', () => {
    s().addOperation();
    s().explodeSelection(0.5);
    expect(s().sequence!.operations[0].tracks).toHaveLength(0);
  });

  it('is undoable in one step', () => {
    s().addOperation();
    s().select(Object.values(assembly.parts).filter((p) => !p.isGroup).map((p) => p.id));
    s().explodeSelection(0.5);
    expect(s().sequence!.operations[0].tracks.length).toBeGreaterThan(0);
    s().undo();
    expect(s().sequence!.operations[0].tracks).toHaveLength(0);
  });
});

describe('gizmo settings', () => {
  it('toggles mode and clamps snap to non-negative', () => {
    
    s().setSnap(-5);
    expect(s().snap).toBe(0);
    s().setSnap(10);
    expect(s().snap).toBe(10);
  });
});
