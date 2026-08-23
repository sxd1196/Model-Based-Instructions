/**
 * I/O tests: work-instruction export and filename slugging.
 *
 * `buildInstructionsHtml` is pure so it can be asserted headlessly; the
 * download wrapper around it is a two-line browser call not worth mocking.
 */
import { describe, expect, it } from 'vitest';
import { buildInstructionsHtml, slug } from './project';
import { emptySequence } from '@/state/store';
import { buildAssemblyFromScene } from '@/cad/loadGltf';
import { makeDemoAssembly } from '@/cad/demo';
import type { Operation, Sequence } from '@/domain/schema';

const { root, name } = makeDemoAssembly();
const { assembly } = buildAssemblyFromScene(root, 'demo://x', { name });

const partId = (n: string) =>
  Object.values(assembly.parts).find((p) => p.name === n)!.id;

function op(partial: Partial<Operation> & { id: string }): Operation {
  return {
    title: partial.id, description: '', duration: 1, dwell: 0,
    tracks: [], camera: null, annotations: [], styles: [], meta: {},
    ...partial,
  } as Operation;
}

function seq(operations: Operation[]): Sequence {
  return { ...emptySequence(assembly), name: 'Gearbox teardown', operations };
}

describe('buildInstructionsHtml', () => {
  it('emits one section per operation, numbered in order', () => {
    const html = buildInstructionsHtml(
      seq([op({ id: 'a', title: 'Remove bolts' }), op({ id: 'b', title: 'Lift cover' })]),
    );
    expect((html.match(/<section class="step">/g) ?? [])).toHaveLength(2);
    expect(html.indexOf('Remove bolts')).toBeLessThan(html.indexOf('Lift cover'));
    expect(html).toContain('<span class="num">1</span>');
    expect(html).toContain('<span class="num">2</span>');
  });

  it('resolves part IDS to human-readable CAD names', () => {
    // An operator reading the doc must see "Cover_Plate", not a UUID.
    const html = buildInstructionsHtml(
      seq([
        op({
          id: 'a',
          tracks: [{
            id: 't', parts: [partId('Cover_Plate')],
            from: { translate: [0,0,0], rotate: [0,0,0,1], pivot: [0,0,0] },
            to: { translate: [0,0,90], rotate: [0,0,0,1], pivot: [0,0,0] },
            start: 0, end: 1, easing: 'easeInOut',
          }],
        }),
      ]),
    );
    expect(html).toContain('Cover_Plate');
  });

  it('includes meta fields — the BOP hook', () => {
    const html = buildInstructionsHtml(
      seq([op({ id: 'a', meta: { torque: '12 Nm', tool: 'T-30 Torx' } })]),
    );
    expect(html).toContain('torque');
    expect(html).toContain('12 Nm');
    expect(html).toContain('T-30 Torx');
  });

  it('shows cumulative timings that match the timeline', () => {
    const html = buildInstructionsHtml(
      seq([op({ id: 'a', duration: 2, dwell: 0.5 }), op({ id: 'b', duration: 1 })]),
    );
    expect(html).toContain('0.0s – 2.5s');
    expect(html).toContain('2.5s – 3.5s');
  });

  it('renders an em dash when a step moves nothing', () => {
    expect(buildInstructionsHtml(seq([op({ id: 'a' })]))).toContain('<dd>—</dd>');
  });

  it('escapes HTML so CAD names cannot inject markup', () => {
    // Real CAD names contain < > & (e.g. "Bracket <L> & Pin").
    const html = buildInstructionsHtml(
      seq([op({ id: 'a', title: '<script>alert(1)</script>', description: 'A & B' })]),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B');
  });

  it('handles an empty sequence without producing broken markup', () => {
    const html = buildInstructionsHtml(seq([]));
    expect(html).toContain('<h1>Gearbox teardown</h1>');
    expect(html).toContain('</html>');
  });

  it('is valid standalone HTML', () => {
    const html = buildInstructionsHtml(seq([op({ id: 'a' })]));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    // Must not depend on external assets — shop floor may be offline.
    expect(html).not.toMatch(/<link[^>]+href="http/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});

describe('slug', () => {
  it('makes filesystem-safe names', () => {
    expect(slug('Gearbox Teardown v2')).toBe('gearbox-teardown-v2');
    expect(slug('A/B:C*D')).toBe('a-b-c-d');
  });

  it('falls back rather than producing an empty filename', () => {
    expect(slug('!!!')).toBe('sequence');
    expect(slug('')).toBe('sequence');
  });
});
