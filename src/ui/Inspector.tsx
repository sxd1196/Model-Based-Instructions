/** Inspector: what the step SAYS — title, instruction/note, camera, callouts. */
import { useStore } from '@/state/store';
import type { CameraPose } from '@/domain/schema';
import { RichTextEditor } from './RichTextEditor';

// Quadrant glyphs: ◰ U+25F0 is UPPER-left, ◱ LOWER-left, ◲ LOWER-right,
// ◳ UPPER-right. The first mapping had top/bottom inverted (user-reported).
const CORNER_GLYPH = { tl: '◰', tr: '◳', bl: '◱', br: '◲' } as const;
const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;

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

      <div className="field">
        <div className="field-head">
          <span>Instruction</span>
          {/* The instruction IS the on-screen note; pick its corner. */}
          <div className="corner-pick" title="Corner of the viewport where the note appears">
            {CORNERS.map((c) => (
              <button
                key={c}
                className={op.noteCorner === c ? 'on' : ''}
                title={{ tl: 'top left', tr: 'top right', bl: 'bottom left', br: 'bottom right' }[c]}
                onClick={() => updateOperation(op.id, { noteCorner: c })}
              >
                {CORNER_GLYPH[c]}
              </button>
            ))}
          </div>
        </div>
        <RichTextEditor
          text={op.description}
          rich={op.descriptionRich}
          rows={3}
          placeholder="What the operator does in this step — shown in the viewport corner and in the exported doc."
          onChange={(patch) =>
            updateOperation(op.id, {
              ...(patch.text !== undefined ? { description: patch.text } : {}),
              descriptionRich: patch.rich,
            })
          }
        />
      </div>

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
            title={selection.length
              ? 'Add a callout attached to the selected part, then place its anchor'
              : 'Select a part first, or the callout pins to the world origin'}
            onClick={() => {
              addAnnotation(op.id, {
                text: 'New callout',
                anchor: selection.length
                  ? { kind: 'part', partId: selection[0] }
                  : { kind: 'world', point: [0, 0, 0] },
              });
              // Launch straight into the guided two-step placement for the
              // callout we just created.
              const created = useStore
                .getState()
                .sequence?.operations.find((o) => o.id === op.id)?.annotations.at(-1);
              if (created) {
                setAnchorMode({ operationId: op.id, annotationId: created.id });
              }
            }}
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
              <RichTextEditor
                text={a.text}
                rich={a.rich}
                rows={1}
                placeholder="Callout text"
                onChange={(patch) =>
                  updateAnnotation(op.id, a.id, {
                    ...(patch.text !== undefined ? { text: patch.text } : {}),
                    rich: patch.rich,
                  })
                }
              />
              <button className="anno-x" onClick={() => removeAnnotation(op.id, a.id)}>✕</button>
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
                title="Guided placement: click the anchor feature, then pull the note to where you want it"
                onClick={() =>
                  setAnchorMode(
                    isArmed(a.id) ? null : { operationId: op.id, annotationId: a.id },
                  )
                }
              >
                {isArmed(a.id) ? '◉ placing…' : '⌖ place'}
              </button>

              <span className="anno-dist" title="Leader length (anchor to note)">
                ↔ {Math.hypot(...a.labelOffset).toFixed(0)}mm
              </span>

              <label className="leader-toggle" title="Draw a leader line">
                <input
                  type="checkbox"
                  checked={a.leader}
                  onChange={(e) => updateAnnotation(op.id, a.id, { leader: e.target.checked })}
                />
                leader
              </label>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
