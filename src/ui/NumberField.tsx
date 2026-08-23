/**
 * A number field that lets you actually TYPE.
 *
 * The naive controlled `<input type=number value={x} onChange=commit>` fights
 * the keyboard: every keystroke round-trips through the store and re-renders
 * the (rounded/clamped) value, so select-all + Delete instantly becomes "0"
 * and half-typed values like "1." get mangled. Reported as "delete subtracts
 * instead of clearing".
 *
 * This keeps a local string DRAFT while focused and commits only on blur or
 * Enter (Escape reverts). While unfocused it tracks the external value.
 */
import { useEffect, useRef, useState } from 'react';

export function NumberField({
  value,
  onCommit,
  step = 1,
  min,
  max,
  width,
  title,
}: {
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  width?: number;
  title?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  // External changes (undo, gizmo drag) refresh the field only when the user
  // is not mid-edit.
  useEffect(() => {
    if (draft !== null && document.activeElement !== ref.current) setDraft(null);
  }, [value, draft]);

  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (draft.trim() === '' || Number.isNaN(n)) return; // empty/garbage: revert
    let v = n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    if (v !== value) onCommit(v);
  };

  return (
    <input
      ref={ref}
      // type=text + inputMode: number spinners were stealing Delete/Backspace
      // semantics in some browsers and the step arrows caused the ±0.01 drift.
      type="text"
      inputMode="decimal"
      style={width ? { width } : undefined}
      title={title}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          setDraft(null);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          // Keep the convenience of arrow-stepping, without a native spinner.
          e.preventDefault();
          const base = draft !== null && draft.trim() !== '' ? Number(draft) : value;
          if (Number.isNaN(base)) return;
          const next = base + (e.key === 'ArrowUp' ? step : -step);
          const rounded = Math.round(next * 1000) / 1000;
          setDraft(String(rounded));
        }
      }}
    />
  );
}
