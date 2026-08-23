/**
 * Rich text editing helper tests.
 */
import { describe, expect, it } from 'vitest';
import { hasMark, rangeHasMark, richColor, richToHtml, setColor, setColorInRange, syncRichToPlain, toggleMark, toggleMarkInRange } from './richtext';
import { plainToRich, richToPlain, type RichText } from './schema';

describe('toggleMark', () => {
  it('seeds from plain text on first use', () => {
    const r = toggleMark(undefined, 'Torque 12 Nm', 'bold');
    expect(richToPlain(r)).toBe('Torque 12 Nm');
    expect(hasMark(r, 'bold')).toBe(true);
  });

  it('toggles off when already fully applied', () => {
    const on = toggleMark(undefined, 'x', 'bold');
    expect(hasMark(toggleMark(on, 'x', 'bold'), 'bold')).toBe(false);
  });

  it('composes multiple marks', () => {
    let r = toggleMark(undefined, 'Ø25', 'bold');
    r = toggleMark(r, 'Ø25', 'italic');
    expect(hasMark(r, 'bold')).toBe(true);
    expect(hasMark(r, 'italic')).toBe(true);
  });

  it('does not duplicate a mark already present on a span', () => {
    const seeded: RichText = [[{ text: 'x', marks: ['bold'] }]];
    // Not every span has it => treated as turning ON, must not double up.
    const r = toggleMark([...seeded, [{ text: 'y', marks: [] }]], 'x', 'bold');
    expect(r[0][0].marks.filter((m) => m === 'bold')).toHaveLength(1);
  });

  it('preserves the text through toggling', () => {
    const r = toggleMark(undefined, 'Line one\nLine two', 'underline');
    expect(richToPlain(r)).toBe('Line one\nLine two');
  });
});

describe('hasMark', () => {
  it('is false for empty or undefined rich text', () => {
    expect(hasMark(undefined, 'bold')).toBe(false);
    expect(hasMark([], 'bold')).toBe(false);
  });

  it('requires EVERY span to carry the mark', () => {
    const mixed: RichText = [[
      { text: 'a', marks: ['bold'] },
      { text: 'b', marks: [] },
    ]];
    expect(hasMark(mixed, 'bold')).toBe(false);
  });
});

describe('colour', () => {
  it('applies a colour to every span', () => {
    const r = setColor(undefined, 'hot', '#ff0000');
    expect(r.flat().every((s) => s.color === '#ff0000')).toBe(true);
    expect(richColor(r)).toBe('#ff0000');
  });

  it('reports null when spans disagree', () => {
    const mixed: RichText = [[
      { text: 'a', marks: [], color: '#ff0000' },
      { text: 'b', marks: [], color: '#00ff00' },
    ]];
    expect(richColor(mixed)).toBeNull();
  });

  it('reports null when no colour is set', () => {
    expect(richColor(plainToRich('x'))).toBeNull();
  });
});

describe('syncRichToPlain', () => {
  it('keeps formatting when the text is edited', () => {
    const bold = toggleMark(undefined, 'old text', 'bold');
    const synced = syncRichToPlain(bold, 'new text')!;
    expect(richToPlain(synced)).toBe('new text');
    expect(hasMark(synced, 'bold')).toBe(true);
  });

  it('preserves colour across an edit', () => {
    const colored = setColor(undefined, 'a', '#123456');
    expect(richColor(syncRichToPlain(colored, 'b')!)).toBe('#123456');
  });

  it('returns undefined when there was no formatting to keep', () => {
    expect(syncRichToPlain(undefined, 'anything')).toBeUndefined();
  });

  it('handles multi-line edits', () => {
    const bold = toggleMark(undefined, 'one', 'bold');
    const synced = syncRichToPlain(bold, 'one\ntwo')!;
    expect(richToPlain(synced)).toBe('one\ntwo');
    expect(hasMark(synced, 'bold')).toBe(true);
  });
});

describe('range formatting (selection-aware)', () => {
  it('bolds ONLY the selected range, splitting spans', () => {
    // "Torque to 12 Nm" — select "12 Nm" (chars 10..15).
    const rich = toggleMarkInRange(undefined, 'Torque to 12 Nm', 10, 15, 'bold');
    expect(rich[0].map((s) => [s.text, s.marks.join(',')])).toEqual([
      ['Torque to ', ''],
      ['12 Nm', 'bold'],
    ]);
  });

  it('a mid-word range splits into three spans', () => {
    const rich = toggleMarkInRange(undefined, 'abcdef', 2, 4, 'italic');
    expect(rich[0].map((s) => s.text)).toEqual(['ab', 'cd', 'ef']);
    expect(rich[0][1].marks).toEqual(['italic']);
    expect(rich[0][0].marks).toEqual([]);
  });

  it('toggling the same range twice removes the mark', () => {
    const once = toggleMarkInRange(undefined, 'hello world', 0, 5, 'bold');
    const twice = toggleMarkInRange(once, 'hello world', 0, 5, 'bold');
    expect(twice.flat().every((s) => !s.marks.includes('bold'))).toBe(true);
  });

  it('stacks marks: bold a range, then italic a sub-range', () => {
    const bolded = toggleMarkInRange(undefined, 'critical torque', 0, 8, 'bold');
    const both = toggleMarkInRange(bolded, 'critical torque', 0, 4, 'italic');
    const first = both[0][0];
    expect(first.text).toBe('crit');
    expect(first.marks.sort()).toEqual(['bold', 'italic']);
    expect(both[0][1].marks).toEqual(['bold']);
  });

  it('ranges span paragraphs (newline counts one char)', () => {
    const rich = toggleMarkInRange(undefined, 'ab\ncd', 1, 4, 'underline');
    expect(rich[0].map((s) => [s.text, s.marks.join(',')])).toEqual([
      ['a', ''], ['b', 'underline'],
    ]);
    expect(rich[1].map((s) => [s.text, s.marks.join(',')])).toEqual([
      ['c', 'underline'], ['d', ''],
    ]);
  });

  it('collapsed selection falls back to whole-label toggle', () => {
    const rich = toggleMarkInRange(undefined, 'all of it', 3, 3, 'bold');
    expect(rich.flat().every((s) => s.marks.includes('bold'))).toBe(true);
  });

  it('colours only the range', () => {
    const rich = setColorInRange(undefined, 'warning here', 0, 7, '#ff0000');
    expect(rich[0][0].color).toBe('#ff0000');
    expect(rich[0][1].color).toBeUndefined();
  });

  it('rangeHasMark answers per-range, not per-label', () => {
    const rich = toggleMarkInRange(undefined, 'half bold here', 0, 4, 'bold');
    expect(rangeHasMark(rich, 'half bold here', 0, 4, 'bold')).toBe(true);
    expect(rangeHasMark(rich, 'half bold here', 5, 9, 'bold')).toBe(false);
  });

  it('round-trips to HTML with the range styled', () => {
    const rich = toggleMarkInRange(undefined, 'Torque 12 Nm', 7, 12, 'bold');
    expect(richToHtml(rich, 'Torque 12 Nm')).toBe('<div>Torque <strong>12 Nm</strong></div>');
  });
});
