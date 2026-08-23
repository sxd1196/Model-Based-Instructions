/** Inspector: edit the active operation, its motions, camera, and callouts. */
import { useStore } from '@/state/store';
import type { CameraPose } from '@/domain/schema';
import { hasMark, richColor, setColor, syncRichToPlain, toggleMark } from '@/domain/richtext';

const MARK_GLYPH = { bold: 'B', italic: 'I', underline: 'U', sup: 'x²', sub: 'x₂', code: '</>' } as const;

export function Inspector() {
  const sequence = useStore((s) => s.sequence);
  const activeId = useStore((s) => s.activeOperationId);
  const selection = useStore((s) => s.selection);

  const updateOperation = useStore((s) => s.updateOperation);
  const setOperationCamera = useStore((s) => s.setOperationCamera);
  const setStyle = useStore((s) => s.setStyle);
  const addAnnotation = useStore((s) => s.addAnnotation);
  const updateAnnotation = useStore((s) => s.updateAnnotation);
  const removeAnnotation = useStore((s) => s.removeAnnotation);
  const setAnchorMode = useStore((s) => s.setAnchorMode);
  const anchorMode = useStore((s) => s.anchorMode);

  if (!sequence) return <div className="panel-empty">No model loaded</div>;

  const op = sequence.operations.find((o) => o.id === activeId);
  if (!op) return <div className="panel-empty">Select or add a step</div>;

  const isArmed = (annotationId: string) =>
    anchorMode?.annotationId === annotationId;

  const nameOf = (id: string) => sequence.assembly.parts[id]?.name ?? id;

  const captureCamera = () => {
    const pose = (window as any).__getCameraPose?.() as CameraPose | undefined;
    if (pose) setOperationCamera(op.id, pose);
  };

  return (
    <div className="inspector">
      <div className="panel-head">
        <span>Step {sequence.operations.indexOf(op) + 1}</span>
      </div>

      <label className="field">
        <span>Title</span>
        <input
          value={op.title}
          onChange={(e) => updateOperation(op.id, { title: e.target.value })}
        />
      </label>

      <label className="field">
        <span>Instruction</span>
        <textarea
          rows={3}
          value={op.description}
          placeholder="What the operator does in this step…"
          onChange={(e) => updateOperation(op.id, { description: e.target.value })}
        />
      </label>



      <div className="section">
        <div className="section-head">
          <span>Camera</span>
          <button onClick={captureCamera}>Capture view</button>
        </div>
        {op.camera ? (
          <div className="hint">
            pos [{op.camera.position.map((n) => n.toFixed(0)).join(', ')}] · fov {op.camera.fov}°
            <button onClick={() => setOperationCamera(op.id, null)}>clear</button>
          </div>
        ) : (
          <div className="hint">Holds previous shot.</div>
        )}
      </div>

      <div className="section">
        <div className="section-head">
          <span>Appearance</span>
        </div>
        <div className="btn-row">
          {(['normal', 'ghost', 'highlight', 'hidden'] as const).map((mode) => (
            <button
              key={mode}
              disabled={!selection.length}
              onClick={() => setStyle(op.id, { parts: selection, mode })}
            >
              {mode}
            </button>
          ))}
        </div>
        {op.styles.length > 0 && (
          <div className="hint">
            {op.styles.map((s, i) => (
              <div key={i}>{s.mode}: {s.parts.length} part(s)</div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-head">
          <span>Callouts</span>
          <button
            onClick={() =>
              addAnnotation(op.id, {
                text: 'New callout',
                anchor: selection.length
                  ? { kind: 'part', partId: selection[0] }
                  : { kind: 'world', point: [0, 0, 0] },
                offset: [12, -12],
              })
            }
          >
            + add
          </button>
        </div>

        {!op.annotations.length && (
          <div className="hint">
            Select a part first to pin a callout to it.
          </div>
        )}

        {op.annotations.map((a) => (
          <div className="anno-card" key={a.id}>
            <div className="anno-row">
              <input
                value={a.text}
                placeholder="Callout text"
                onChange={(e) =>
                  updateAnnotation(op.id, a.id, {
                    text: e.target.value,
                    rich: syncRichToPlain(a.rich, e.target.value),
                  })
                }
              />
              <button onClick={() => removeAnnotation(op.id, a.id)}>✕</button>
            </div>

            {/* Formatting: applies to the whole callout. Per-span editing
                would need a full editor; whole-label styling covers the
                real cases (a bold warning, a superscript tolerance). */}
            <div className="anno-marks">
              {(['bold', 'italic', 'underline', 'sup', 'sub', 'code'] as const).map((mark) => {
                const active = hasMark(a.rich, mark);
                return (
                  <button
                    key={mark}
                    className={active ? 'on' : ''}
                    title={mark}
                    onClick={() =>
                      updateAnnotation(op.id, a.id, {
                        rich: toggleMark(a.rich, a.text, mark),
                      })
                    }
                  >
                    {MARK_GLYPH[mark]}
                  </button>
                );
              })}
              <input
                type="color"
                title="Text colour"
                value={richColor(a.rich) ?? '#dfe3ea'}
                onChange={(e) =>
                  updateAnnotation(op.id, a.id, {
                    rich: setColor(a.rich, a.text, e.target.value),
                  })
                }
              />
              {a.rich && (
                <button
                  title="Clear formatting"
                  onClick={() => updateAnnotation(op.id, a.id, { rich: undefined })}
                >
                  ⌫
                </button>
              )}
            </div>

            <div className="anno-meta">
              {a.anchor.kind === 'part' ? (
                <span title={nameOf(a.anchor.partId)}>
                  📌 {nameOf(a.anchor.partId)}
                  {a.anchor.feature && (
                    <b className="feat"> · {a.anchor.feature.kind}</b>
                  )}
                </span>
              ) : (
                <span>🌐 fixed point</span>
              )}

              <button
                className={isArmed(a.id) ? 'on' : ''}
                title="Click a vertex, edge, or face in the viewport to anchor the leader"
                onClick={() =>
                  setAnchorMode(
                    isArmed(a.id) ? null : { operationId: op.id, annotationId: a.id },
                  )
                }
              >
                {isArmed(a.id) ? '◉ click a feature…' : '⌖ place anchor'}
              </button>

              <label className="leader-toggle" title="Draw a leader line">
                <input
                  type="checkbox"
                  checked={a.leader}
                  onChange={(e) => updateAnnotation(op.id, a.id, { leader: e.target.checked })}
                />
                leader
              </label>
            </div>

            <div className="anno-offset">
              <span>label offset</span>
              <input
                type="number" step={4} value={a.offset[0]}
                onChange={(e) =>
                  updateAnnotation(op.id, a.id, {
                    offset: [Number(e.target.value), a.offset[1]],
                  })
                }
              />
              <input
                type="number" step={4} value={a.offset[1]}
                onChange={(e) =>
                  updateAnnotation(op.id, a.id, {
                    offset: [a.offset[0], Number(e.target.value)],
                  })
                }
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


