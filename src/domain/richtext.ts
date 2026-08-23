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
