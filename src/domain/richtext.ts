/**
 * Whole-label rich text editing helpers.
 *
 * The Inspector applies formatting to an entire callout rather than a
 * selection range: per-span editing needs a real editor surface, while a bold
 * warning or a superscript tolerance covers what CAD annotation actually
 * needs. These helpers keep that policy in one tested place.
 */
import type { RichText, TextMark } from './schema';
import { plainToRich } from './schema';

/** Whitelisted output tags. Closed set => project files cannot inject markup. */
const HTML_TAGS: Record<TextMark, string> = {
  bold: 'strong', italic: 'em', underline: 'u', sup: 'sup', sub: 'sub', code: 'code',
};

/** Ensure we have a RichText to work with, seeding from plain text if needed. */
function ensure(rich: RichText | undefined, plain: string): RichText {
  if (rich?.length) return rich;
  return plainToRich(plain);
}

/** True when EVERY span carries the mark — i.e. the button reads as active. */
export function hasMark(rich: RichText | undefined, mark: TextMark): boolean {
  if (!rich?.length) return false;
  const spans = rich.flat();
  if (!spans.length) return false;
  return spans.every((s) => s.marks.includes(mark));
}

/** Toggle a mark across the whole label. */
export function toggleMark(
  rich: RichText | undefined,
  plain: string,
  mark: TextMark,
): RichText {
  const base = ensure(rich, plain);
  const turningOff = hasMark(base, mark);

  return base.map((para) =>
    para.map((span) => ({
      ...span,
      marks: turningOff
        ? span.marks.filter((m) => m !== mark)
        : span.marks.includes(mark)
          ? span.marks
          : [...span.marks, mark],
    })),
  );
}

/** The label's colour, when every span agrees on one. */
export function richColor(rich: RichText | undefined): string | null {
  const spans = rich?.flat() ?? [];
  if (!spans.length) return null;
  const first = spans[0].color;
  if (!first) return null;
  return spans.every((s) => s.color === first) ? first : null;
}

/** Apply a colour to the whole label. */
export function setColor(
  rich: RichText | undefined,
  plain: string,
  color: string,
): RichText {
  return ensure(rich, plain).map((para) => para.map((span) => ({ ...span, color })));
}

/**
 * Keep `rich` in step with an edited plain string.
 *
 * Typing in the text field must not silently discard formatting, but the spans
 * no longer match the new text. Policy: preserve the first span's marks and
 * colour, collapse to a single span. Predictable beats clever here.
 */
export function syncRichToPlain(
  rich: RichText | undefined,
  plain: string,
): RichText | undefined {
  if (!rich?.length) return undefined;
  const first = rich.flat()[0];
  if (!first) return undefined;
  return plain
    .split('\n')
    .map((line) =>
      line ? [{ text: line, marks: [...first.marks], color: first.color }] : [],
    );
}

// ---------------------------------------------------------------- ranges
//
// Selection-aware formatting: apply a mark/colour to a CHARACTER RANGE of
// the document rather than the whole label. Offsets are plain-text character
// positions (newlines count 1), which is exactly what a textarea's
// selectionStart/End report.

interface SpanSlice {
  para: number;
  span: { text: string; marks: TextMark[]; color?: string };
  /** Document-order character offset where this span begins. */
  at: number;
}

/** Flatten with character offsets; newline between paragraphs counts 1 char. */
function slices(rich: RichText): SpanSlice[] {
  const out: SpanSlice[] = [];
  let at = 0;
  rich.forEach((para, p) => {
    if (p > 0) at += 1; // the newline
    for (const span of para) {
      out.push({ para: p, span, at });
      at += span.text.length;
    }
    if (!para.length) {
      // Empty paragraph occupies no chars but must survive rebuilding.
      out.push({ para: p, span: { text: '', marks: [] }, at });
    }
  });
  return out;
}

/** Rebuild a RichText from slices, dropping empty spans but keeping paragraphs. */
function rebuild(all: SpanSlice[], paraCount: number): RichText {
  const paras: RichText = Array.from({ length: paraCount }, () => []);
  for (const s of all) {
    if (s.span.text.length || paras[s.para].length === 0) {
      if (s.span.text.length) paras[s.para].push(s.span);
    }
  }
  return paras;
}

/**
 * Split spans at [start,end) and hand the covered pieces to `fn` to restyle.
 * The workhorse behind range marks and range colour.
 */
function mapRange(
  rich: RichText,
  start: number,
  end: number,
  fn: (span: { text: string; marks: TextMark[]; color?: string }) => {
    text: string;
    marks: TextMark[];
    color?: string;
  },
): RichText {
  const out: SpanSlice[] = [];
  for (const s of slices(rich)) {
    const sStart = s.at;
    const sEnd = s.at + s.span.text.length;

    if (sEnd <= start || sStart >= end || !s.span.text.length) {
      out.push(s);
      continue;
    }

    const cutA = Math.max(start - sStart, 0);
    const cutB = Math.min(end - sStart, s.span.text.length);

    const before = s.span.text.slice(0, cutA);
    const middle = s.span.text.slice(cutA, cutB);
    const after = s.span.text.slice(cutB);

    if (before) out.push({ ...s, span: { ...s.span, marks: [...s.span.marks], text: before } });
    if (middle) out.push({ ...s, at: s.at + cutA, span: fn({ ...s.span, marks: [...s.span.marks], text: middle }) });
    if (after) out.push({ ...s, at: s.at + cutB, span: { ...s.span, marks: [...s.span.marks], text: after } });
  }
  return rebuild(out, rich.length);
}

/** True when every character in [start,end) carries the mark. */
export function rangeHasMark(
  rich: RichText | undefined,
  plain: string,
  start: number,
  end: number,
  mark: TextMark,
): boolean {
  const base = ensure(rich, plain);
  let covered = false;
  for (const s of slices(base)) {
    const sStart = s.at;
    const sEnd = s.at + s.span.text.length;
    if (sEnd <= start || sStart >= end || !s.span.text.length) continue;
    covered = true;
    if (!s.span.marks.includes(mark)) return false;
  }
  return covered;
}

/**
 * Toggle a mark on [start,end) only. A collapsed selection (start===end)
 * falls back to the whole label — the pre-selection behaviour.
 */
export function toggleMarkInRange(
  rich: RichText | undefined,
  plain: string,
  start: number,
  end: number,
  mark: TextMark,
): RichText {
  if (start === end) return toggleMark(rich, plain, mark);
  const base = ensure(rich, plain);
  const turningOff = rangeHasMark(base, plain, start, end, mark);
  return mapRange(base, start, end, (span) => ({
    ...span,
    marks: turningOff
      ? span.marks.filter((m) => m !== mark)
      : span.marks.includes(mark)
        ? span.marks
        : [...span.marks, mark],
  }));
}

/** Colour [start,end) only; collapsed selection colours the whole label. */
export function setColorInRange(
  rich: RichText | undefined,
  plain: string,
  start: number,
  end: number,
  color: string,
): RichText {
  if (start === end) return setColor(rich, plain, color);
  return mapRange(ensure(rich, plain), start, end, (span) => ({ ...span, color }));
}

/**
 * Serialize RichText to HTML for the exported work instructions.
 *
 * Text is escaped and only whitelisted tags are emitted, so this cannot
 * produce markup a project file smuggled in.
 */
export function richToHtml(rich: RichText | undefined, plain: string): string {
  if (!rich?.length) return escapeHtml(plain);

  return rich
    .map((para) => {
      if (!para.length) return '<br>';
      const inner = para
        .map((span) => {
          let html = escapeHtml(span.text);
          for (const mark of span.marks) {
            const tag = HTML_TAGS[mark];
            html = `<${tag}>${html}</${tag}>`;
          }
          // Colour is hex-validated by the schema; re-check defensively.
          if (span.color && /^#[0-9a-fA-F]{3,8}$/.test(span.color)) {
            html = `<span style="color:${span.color}">${html}</span>`;
          }
          return html;
        })
        .join('');
      return `<div>${inner}</div>`;
    })
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
