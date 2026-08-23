/**
 * A text field with selection-aware rich formatting.
 *
 * Select a range, hit B/I/U/x²/x₂/color — only the selection gets the mark.
 * With no selection the whole text is formatted (the old behaviour). One
 * component serves both the step instruction and 3D callout labels, so the
 * two kinds of note behave identically — a deliberate outcome of merging
 * "screen note" into the instruction.
 *
 * The formatting math lives in domain/richtext (toggleMarkInRange etc.);
 * this component only reads the textarea's selectionStart/End and hands the
 * range over.
 */
import { useRef } from 'react';
import type { RichText, TextMark } from '@/domain/schema';
import {
  rangeHasMark,
  setColorInRange,
  syncRichToPlain,
  toggleMarkInRange,
} from '@/domain/richtext';

const MARK_GLYPH: Record<TextMark, string> = {
  bold: 'B', italic: 'I', underline: 'U', sup: 'x²', sub: 'x₂', code: '</>',
};
const MARKS = Object.keys(MARK_GLYPH) as TextMark[];

interface Props {
  text: string;
  rich?: RichText;
  rows?: number;
  placeholder?: string;
  onChange: (patch: { text?: string; rich?: RichText }) => void;
}

export function RichTextEditor({ text, rich, rows = 2, placeholder, onChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  /** Current selection range; [0, len] when collapsed => whole-text mode. */
  const range = (): [number, number] => {
    const el = ref.current;
    if (!el) return [0, 0];
    return [el.selectionStart ?? 0, el.selectionEnd ?? 0];
  };

  const apply = (mark: TextMark) => {
    const [start, end] = range();
    onChange({ rich: toggleMarkInRange(rich, text, start, end, mark) });
    // Restore focus so consecutive formatting keeps working on the range.
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(start, end);
    });
  };

  const applyColor = (color: string) => {
    const [start, end] = range();
    onChange({ rich: setColorInRange(rich, text, start, end, color) });
  };

  return (
    <div className="rte">
      <textarea
        ref={ref}
        rows={rows}
        value={text}
        placeholder={placeholder}
        onChange={(e) =>
          onChange({
            text: e.target.value,
            rich: syncRichToPlain(rich, e.target.value),
          })
        }
      />
      <div className="rte-toolbar">
        {MARKS.map((mark) => {
          const [start, end] = range();
          const active =
            start !== end ? rangeHasMark(rich, text, start, end, mark) : false;
          return (
            <button
              key={mark}
              className={active ? 'on' : ''}
              title={`${mark} — select text to format only that range`}
              // preventDefault keeps the textarea selection alive through the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => apply(mark)}
            >
              {MARK_GLYPH[mark]}
            </button>
          );
        })}
        <input
          type="color"
          title="Text colour — select text to colour only that range"
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => applyColor(e.target.value)}
        />
        {rich && (
          <button
            title="Clear all formatting"
            onClick={() => onChange({ rich: undefined })}
          >
            ⌫
          </button>
        )}
      </div>
    </div>
  );
}
