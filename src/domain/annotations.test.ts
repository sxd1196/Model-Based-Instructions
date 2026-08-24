/**
 * Callout anchoring tests.
 *
 * The point of a part-anchored callout is that it FOLLOWS the part. These
 * tests assert the label position tracks the animated geometry rather than
 * sitting at the origin, which was the known gap before this feature.
 */
import { describe, expect, it } from 'vitest';
import { partPositionAt, resolveAnnotationPoint, resolveFrame } from './evaluate';
import { quatFromAxisAngle } from './transform';
import { buildAssemblyFromScene } from '@/cad/loadGltf';
import { makeDemoAssembly } from '@/cad/demo';
import { emptySequence } from '@/state/store';
import { Annotation as Annotation_, IDENTITY_QUAT, type Annotation, type Operation, type Sequence } from './schema';

const { root, name } = makeDemoAssembly();
const { assembly } = buildAssemblyFromScene(root, 'demo://x', { name });

const idOf = (n: string) =>
  Object.values(assembly.parts).find((p) => p.name === n)!.id;

const near = (a: number[], b: number[], p = 4) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], p));

function seqWith(operations: Operation[]): Sequence {
  return { ...emptySequence(assembly), operations };
}

function slide(partId: string, z: number, rotate = IDENTITY_QUAT): Operation {
  return {
    id: 'op', title: 'move', description: '', noteCorner: 'tl' as const,
    section: null, duration: 1, dwell: 0,
    tracks: [{
      id: 't', parts: [partId],
      from: { translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
      to: { translate: [0, 0, z], rotate, pivot: [0, 0, 0] },
      start: 0, end: 1, easing: 'linear',
    }],
    camera: null, annotations: [], styles: [], meta: {},
  } as Operation;
}

describe('partPositionAt', () => {
  it('returns the rest position when nothing has moved', () => {
    const s = seqWith([]);
    const frame = resolveFrame(s, 0);
    const id = idOf('Cover_Plate');
    near(partPositionAt(s, frame, id)!, assembly.parts[id].restTranslate);
  });

  it('tracks a part as it animates', () => {
    const id = idOf('Cover_Plate');
    const rest = assembly.parts[id].restTranslate;
    const s = seqWith([slide(id, 100)]);

    near(partPositionAt(s, resolveFrame(s, 0), id)!, rest);
    near(partPositionAt(s, resolveFrame(s, 0.5), id)!, [rest[0], rest[1], rest[2] + 50]);
    near(partPositionAt(s, resolveFrame(s, 1), id)!, [rest[0], rest[1], rest[2] + 100]);
  });

  it('accounts for rotation about a pivot', () => {
    const id = idOf('Cover_Plate');
    const s = seqWith([{
      ...slide(id, 0),
      tracks: [{
        id: 't', parts: [id],
        from: { translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: [0, 0, 0] },
        to: {
          translate: [0, 0, 0],
          rotate: quatFromAxisAngle([0, 0, 1], Math.PI),
          pivot: [0, 0, 0],
        },
        start: 0, end: 1, easing: 'linear',
      }],
    } as Operation]);

    const rest = assembly.parts[id].restTranslate;
    const end = partPositionAt(s, resolveFrame(s, 1), id)!;
    // 180 degrees about Z negates X and Y, leaves Z.
    near(end, [-rest[0], -rest[1], rest[2]], 4);
  });

  it('returns null for an unknown part instead of throwing', () => {
    const s = seqWith([]);
    expect(partPositionAt(s, resolveFrame(s, 0), 'bogus')).toBeNull();
  });
});

describe('resolveAnnotationPoint', () => {
  const worldAnno: Annotation = Annotation_.parse({
    id: 'a', text: 'fixed',
    anchor: { kind: 'world', point: [10, 20, 30] },
    offset: [12, -12],
  });

  it('passes world anchors through unchanged', () => {
    const s = seqWith([]);
    near(resolveAnnotationPoint(s, resolveFrame(s, 0), worldAnno)!, [10, 20, 30]);
  });

  it('a part-anchored callout MOVES with its part', () => {
    // This is the regression that motivated the feature: it used to render
    // at the origin regardless of where the part was.
    const id = idOf('Cover_Plate');
    const rest = assembly.parts[id].restTranslate;
    const anno: Annotation = Annotation_.parse({
      id: 'a', text: 'Lift cover',
      anchor: { kind: 'part', partId: id },
      offset: [12, -12],
    });
    const s = seqWith([{ ...slide(id, 90), annotations: [anno] }]);

    const start = resolveAnnotationPoint(s, resolveFrame(s, 0), anno)!;
    const end = resolveAnnotationPoint(s, resolveFrame(s, 1), anno)!;

    near(start, rest);
    near(end, [rest[0], rest[1], rest[2] + 90]);
    expect(end[2] - start[2]).toBeCloseTo(90);
  });

  it('is never pinned at the origin for a part with a non-zero rest pose', () => {
    const id = idOf('Cover_Plate');
    const anno: Annotation = Annotation_.parse({
      id: 'a', text: 'x',
      anchor: { kind: 'part', partId: id },
      offset: [0, 0],
    });
    const s = seqWith([]);
    const p = resolveAnnotationPoint(s, resolveFrame(s, 0), anno)!;
    expect(Math.hypot(...p)).toBeGreaterThan(0);
  });

  it('returns null when the anchored part no longer exists', () => {
    const anno: Annotation = Annotation_.parse({
      id: 'a', text: 'orphan',
      anchor: { kind: 'part', partId: 'deleted-part' },
      offset: [0, 0],
    });
    const s = seqWith([]);
    expect(resolveAnnotationPoint(s, resolveFrame(s, 0), anno)).toBeNull();
  });

  it('follows a part through accumulated earlier operations', () => {
    const id = idOf('Cover_Plate');
    const rest = assembly.parts[id].restTranslate;
    const anno: Annotation = Annotation_.parse({
      id: 'a', text: 'later',
      anchor: { kind: 'part', partId: id },
      offset: [0, 0],
    });
    const s = seqWith([
      { ...slide(id, 40), id: 'op1' },
      { ...slide(idOf('Main_Shaft'), 10), id: 'op2', annotations: [anno] },
    ]);

    // During step 2 the cover is still displaced by step 1.
    const p = resolveAnnotationPoint(s, resolveFrame(s, 1.5), anno)!;
    near(p, [rest[0], rest[1], rest[2] + 40]);
  });
});
