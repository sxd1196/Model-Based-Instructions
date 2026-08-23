/**
 * Rich text editing helper tests.
 */
import { describe, expect, it } from 'vitest';
import { hasMark, richColor, setColor, syncRichToPlain, toggleMark } from './richtext';
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
