/**
 * Schema tests: defaults, validation, and migration safety.
 *
 * The schema is the contract for saved files. A default that silently changes
 * meaning breaks every project on disk, so the defaults are pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  Annotation,
  IDENTITY_QUAT,
  Move,
  Operation,
  SCHEMA_VERSION,
  Sequence,
  Track,
  migrate,
  parseSequence,
  plainToRich,
  richToPlain,
} from './schema';

const minimalAssembly = {
  id: 'a1',
  name: 'asm',
  modelUrl: '/x.glb',
  parts: {},
};

const minimalSequence = { id: 's1', assembly: minimalAssembly };

describe('defaults', () => {
  it('fills a minimal sequence with safe defaults', () => {
    const s = parseSequence(minimalSequence);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.name).toBe('Untitled sequence');
    expect(s.intent).toBe('disassembly');
    expect(s.operations).toEqual([]);
    expect(s.homeCamera).toBeNull();
    expect(s.units).toBe('mm');
  });

  it('defaults a Move to identity', () => {
    const m = Move.parse({});
    expect(m.translate).toEqual([0, 0, 0]);
    expect(m.rotate).toEqual(IDENTITY_QUAT);
    expect(m.pivot).toEqual([0, 0, 0]);
  });

  it('defaults a Track to a full-window eased motion', () => {
    const t = Track.parse({ id: 't', parts: ['p'] });
    expect(t.start).toBe(0);
    expect(t.end).toBe(1);
    expect(t.easing).toBe('easeInOut');
  });

  it('defaults an Operation to a visible, readable duration', () => {
    const o = Operation.parse({ id: 'o' });
    expect(o.duration).toBeGreaterThan(0);
    expect(o.dwell).toBeGreaterThanOrEqual(0);
    expect(o.camera).toBeNull();
    expect(o.meta).toEqual({});
  });
});

describe('validation', () => {
  it('rejects a track with no parts', () => {
    expect(() => Track.parse({ id: 't', parts: [] })).toThrow();
  });

  it('rejects non-positive duration', () => {
    expect(() => Operation.parse({ id: 'o', duration: 0 })).toThrow();
    expect(() => Operation.parse({ id: 'o', duration: -1 })).toThrow();
  });

  it('rejects negative dwell', () => {
    expect(() => Operation.parse({ id: 'o', dwell: -1 })).toThrow();
  });

  it('rejects a track window outside [0,1]', () => {
    expect(() => Track.parse({ id: 't', parts: ['p'], start: -0.5 })).toThrow();
    expect(() => Track.parse({ id: 't', parts: ['p'], end: 1.5 })).toThrow();
  });

  it('rejects an unknown easing name', () => {
    expect(() => Track.parse({ id: 't', parts: ['p'], easing: 'bouncy' })).toThrow();
  });

  it('rejects a malformed vector', () => {
    expect(() => Move.parse({ translate: [1, 2] })).toThrow();
    expect(() => Move.parse({ translate: ['a', 'b', 'c'] })).toThrow();
  });

  it('rejects a non-mm unit', () => {
    expect(() => parseSequence({ ...minimalSequence, units: 'inch' })).toThrow();
  });

  it('rejects a future schema version rather than misreading it', () => {
    // Uses SCHEMA_VERSION + 1 so this stays correct across version bumps.
    expect(() =>
      parseSequence({ ...minimalSequence, schemaVersion: SCHEMA_VERSION + 1 }),
    ).toThrow();
  });

  it('rejects an annotation with an unknown anchor kind', () => {
    expect(() =>
      Operation.parse({
        id: 'o',
        annotations: [{ id: 'a', text: 'x', anchor: { kind: 'galaxy' } }],
      }),
    ).toThrow();
  });

  it('accepts both valid annotation anchors', () => {
    const o = Operation.parse({
      id: 'o',
      annotations: [
        { id: 'a', text: 'part', anchor: { kind: 'part', partId: 'p1' } },
        { id: 'b', text: 'world', anchor: { kind: 'world', point: [1, 2, 3] } },
      ],
    });
    expect(o.annotations).toHaveLength(2);
  });
});

describe('v2 -> v3 migration (screen callouts)', () => {
  it('opens a v2 project and accepts a screen anchor after migration', () => {
    const v2 = {
      schemaVersion: 2,
      id: 'p1',
      name: 'v2 project',
      assembly: {
        id: 'a1', name: 'asm', sourceFile: '', modelUrl: 'x.glb',
        parts: { p: { id: 'p', name: 'P', parentId: null, isGroup: false,
          restTranslate: [0, 0, 0], restRotate: [0, 0, 0, 1] } },
      },
      operations: [{
        id: 'o1', title: 't', description: '', duration: 1, dwell: 0,
        tracks: [], camera: null, styles: [], meta: {},
        annotations: [{
          id: 'a', text: 'part note',
          anchor: { kind: 'part', partId: 'p' },
          offset: [12, -12], leader: true,
        }],
      }],
      homeCamera: null, units: 'mm',
    };
    const seq = Sequence.parse(migrate(v2));
    expect(seq.schemaVersion).toBe(SCHEMA_VERSION);
    // Existing part anchor untouched, px offset converted to world mm (v4).
    expect(seq.operations[0].annotations[0].anchor.kind).toBe('part');
    expect(seq.operations[0].annotations[0].labelOffset).toEqual([24, 24, 0]);
  });
});

describe('v1 -> v2 migration', () => {
  /** A realistic v1 project: plain-text callouts, no rich/leader/feature. */
  const v1 = {
    schemaVersion: 1,
    id: 's1',
    name: 'Legacy teardown',
    intent: 'disassembly',
    units: 'mm',
    assembly: minimalAssembly,
    operations: [
      {
        id: 'op1',
        title: 'Remove bolts',
        description: 'Star pattern.',
        duration: 1.5,
        dwell: 0.4,
        tracks: [{ id: 't', parts: ['p1'], to: { translate: [0, 0, 120] } }],
        camera: null,
        annotations: [
          { id: 'a1', text: 'Torque 12 Nm', anchor: { kind: 'part', partId: 'p1' }, offset: [12, -12] },
          { id: 'a2', text: 'Fixed note', anchor: { kind: 'world', point: [1, 2, 3] }, offset: [0, 0] },
        ],
        styles: [],
        meta: { torque: '12 Nm' },
      },
    ],
    homeCamera: null,
  };

  it('opens a v1 project without error', () => {
    expect(() => parseSequence(v1)).not.toThrow();
  });

  it('stamps the current schema version', () => {
    expect(parseSequence(v1).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('preserves v1 callout text verbatim', () => {
    const annos = parseSequence(v1).operations[0].annotations;
    expect(annos[0].text).toBe('Torque 12 Nm');
    expect(annos[1].text).toBe('Fixed note');
  });

  it('defaults leader lines ON for migrated callouts', () => {
    expect(parseSequence(v1).operations[0].annotations[0].leader).toBe(true);
  });

  it('leaves rich and feature undefined rather than inventing them', () => {
    const a = parseSequence(v1).operations[0].annotations[0];
    expect(a.rich).toBeUndefined();
    expect(a.anchor.kind === 'part' && a.anchor.feature).toBeUndefined();
  });

  it('preserves motion and meta through migration', () => {
    const op = parseSequence(v1).operations[0];
    expect(op.tracks[0].to.translate).toEqual([0, 0, 120]);
    expect(op.meta.torque).toBe('12 Nm');
  });

  it('a document with no schemaVersion is treated as v1', () => {
    const { schemaVersion, ...noVersion } = v1;
    expect(parseSequence(noVersion).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('migration is idempotent', () => {
    const once = parseSequence(v1);
    const twice = parseSequence(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});

describe('rich text', () => {
  it('round-trips plain <-> rich', () => {
    const rich = plainToRich('Torque to 12 N·m\nUse T-30 Torx');
    expect(richToPlain(rich)).toBe('Torque to 12 N·m\nUse T-30 Torx');
  });

  it('accepts marks and hex colours', () => {
    const a = Annotation.parse({
      id: 'a', text: 'Ø25', anchor: { kind: 'world', point: [0, 0, 0] },
      rich: [[
        { text: 'Ø25 ', marks: ['bold'] },
        { text: 'H7', marks: ['sup'], color: '#ff8800' },
      ]],
    });
    expect(a.rich?.[0][1].marks).toEqual(['sup']);
    expect(a.rich?.[0][1].color).toBe('#ff8800');
  });

  it('rejects an unknown mark', () => {
    expect(() => Annotation.parse({
      id: 'a', text: 'x', anchor: { kind: 'world', point: [0, 0, 0] },
      rich: [[{ text: 'x', marks: ['blink'] }]],
    })).toThrow();
  });

  it('rejects a non-hex colour so CSS cannot be smuggled in', () => {
    // e.g. url(javascript:...) or expression(...) in a colour field.
    expect(() => Annotation.parse({
      id: 'a', text: 'x', anchor: { kind: 'world', point: [0, 0, 0] },
      rich: [[{ text: 'x', color: 'url(evil)' }]],
    })).toThrow();
  });
});

describe('feature anchors', () => {
  it('accepts a vertex anchor with a normal', () => {
    const a = Annotation.parse({
      id: 'a', text: 'corner',
      anchor: {
        kind: 'part', partId: 'p1',
        feature: { kind: 'vertex', local: [10, 0, 5], normal: [0, 0, 1] },
      },
    });
    expect(a.anchor.kind === 'part' && a.anchor.feature?.kind).toBe('vertex');
  });

  it('rejects an unknown feature kind', () => {
    expect(() => Annotation.parse({
      id: 'a', text: 'x',
      anchor: { kind: 'part', partId: 'p1', feature: { kind: 'hole', local: [0, 0, 0] } },
    })).toThrow();
  });

  it('feature is optional — the part origin is the default anchor', () => {
    const a = Annotation.parse({
      id: 'a', text: 'x', anchor: { kind: 'part', partId: 'p1' },
    });
    expect(a.anchor.kind === 'part' && a.anchor.feature).toBeUndefined();
  });
});

describe('round trip', () => {
  it('is stable through JSON serialization', () => {
    const original = parseSequence({
      ...minimalSequence,
      operations: [
        {
          id: 'op1',
          title: 'Step',
          tracks: [{ id: 't', parts: ['p1'], to: { translate: [0, 0, 50] } }],
          meta: { torque: '12 Nm' },
        },
      ],
    });
    const reparsed = parseSequence(JSON.parse(JSON.stringify(original)));
    expect(reparsed).toEqual(original);
  });

  it('preserves unicode in CAD names and instructions', () => {
    const s = parseSequence({
      ...minimalSequence,
      name: 'Gehäuse — Ø25 · 12 N·m',
    });
    expect(parseSequence(JSON.parse(JSON.stringify(s))).name).toBe('Gehäuse — Ø25 · 12 N·m');
  });
});

describe('v3 -> v4 migration', () => {
  const v3doc = () => ({
    schemaVersion: 3,
    id: 'seq1',
    name: 'Legacy',
    intent: 'disassembly',
    assembly: {
      id: 'a1', name: 'Asm', sourceFile: '', modelUrl: 'demo://x',
      parts: { p1: { id: 'p1', name: 'Part', parentId: null } },
    },
    operations: [
      {
        id: 'op1',
        title: 'Step',
        description: 'Existing instruction.',
        duration: 1, dwell: 0, tracks: [], camera: null, styles: [], meta: {},
        annotations: [
          {
            id: 'a1', text: 'Wear gloves',
            anchor: { kind: 'screen', corner: 'br' },
            offset: [12, -12], leader: false,
          },
          {
            id: 'a2', text: 'Torque 12 Nm',
            anchor: { kind: 'part', partId: 'p1' },
            offset: [30, -20], leader: true,
          },
        ],
      },
    ],
    homeCamera: null,
    units: 'mm',
  });

  it('folds screen notes into the step instruction', () => {
    const seq = parseSequence(v3doc());
    expect(seq.operations[0].description).toBe('Existing instruction.\nWear gloves');
    expect(seq.operations[0].noteCorner).toBe('br');
    // The screen annotation itself is gone.
    expect(seq.operations[0].annotations).toHaveLength(1);
    expect(seq.operations[0].annotations[0].id).toBe('a2');
  });

  it('converts px offsets to world labelOffset without dropping the callout', () => {
    const seq = parseSequence(v3doc());
    const a = seq.operations[0].annotations[0];
    expect(a.labelOffset).toEqual([60, 40, 0]);
    expect((a as unknown as Record<string, unknown>).offset).toBeUndefined();
  });

  it('a v3 screen note with empty text vanishes without touching the instruction', () => {
    const doc = v3doc();
    doc.operations[0].annotations[0].text = '   ';
    const seq = parseSequence(doc);
    expect(seq.operations[0].description).toBe('Existing instruction.');
  });

  it('v1 documents still climb all the way to the current version', () => {
    const doc = v3doc() as Record<string, unknown>;
    delete doc.schemaVersion;
    const seq = parseSequence(doc);
    expect(seq.schemaVersion).toBe(SCHEMA_VERSION);
  });
});
