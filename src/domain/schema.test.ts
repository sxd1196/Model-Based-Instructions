/**
 * Schema tests: defaults, validation, and migration safety.
 *
 * The schema is the contract for saved files. A default that silently changes
 * meaning breaks every project on disk, so the defaults are pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_QUAT,
  Move,
  Operation,
  SCHEMA_VERSION,
  Track,
  parseSequence,
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
    expect(() => parseSequence({ ...minimalSequence, schemaVersion: 2 })).toThrow();
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
