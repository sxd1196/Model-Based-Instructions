/** Inspector: edit the active operation, its motions, camera, and callouts. */
import { useStore } from '@/state/store';
import type { CameraPose, Easing, Move } from '@/domain/schema';
import { IDENTITY_QUAT } from '@/domain/schema';

const EASINGS: Easing[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'step'];

export function Inspector() {
  const sequence = useStore((s) => s.sequence);
  const activeId = useStore((s) => s.activeOperationId);
  const selection = useStore((s) => s.selection);

  const updateOperation = useStore((s) => s.updateOperation);
  const addTrack = useStore((s) => s.addTrack);
  const updateTrack = useStore((s) => s.updateTrack);
  const removeTrack = useStore((s) => s.removeTrack);
  const setOperationCamera = useStore((s) => s.setOperationCamera);
  const setStyle = useStore((s) => s.setStyle);
  const addAnnotation = useStore((s) => s.addAnnotation);
  const updateAnnotation = useStore((s) => s.updateAnnotation);
  const removeAnnotation = useStore((s) => s.removeAnnotation);

  if (!sequence) return <div className="panel-empty">No model loaded</div>;

  const op = sequence.operations.find((o) => o.id === activeId);
  if (!op) return <div className="panel-empty">Select or add a step</div>;

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

      <div className="field-row">
        <label className="field">
          <span>Duration (s)</span>
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={op.duration}
            onChange={(e) =>
              updateOperation(op.id, { duration: Math.max(0.1, Number(e.target.value)) })
            }
          />
        </label>
        <label className="field">
          <span>Dwell (s)</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={op.dwell}
            onChange={(e) =>
              updateOperation(op.id, { dwell: Math.max(0, Number(e.target.value)) })
            }
          />
        </label>
      </div>

      <div className="section">
        <div className="section-head">
          <span>Motions</span>
          <button
            disabled={!selection.length}
            onClick={() => addTrack(op.id, selection)}
            title={selection.length ? '' : 'Select parts first'}
          >
            + from selection ({selection.length})
          </button>
        </div>

        {!op.tracks.length && <div className="hint">No motion yet.</div>}

        {op.tracks.map((track) => (
          <div className="track-card" key={track.id}>
            <div className="track-head">
              <span title={track.parts.map(nameOf).join(', ')}>
                {track.parts.length === 1
                  ? nameOf(track.parts[0])
                  : `${track.parts.length} parts`}
              </span>
              <button onClick={() => removeTrack(op.id, track.id)}>✕</button>
            </div>

            <MoveEditor
              label="Move to (mm)"
              move={track.to}
              onChange={(to) => updateTrack(op.id, track.id, { to })}
            />

            <div className="field-row">
              <label className="field">
                <span>Easing</span>
                <select
                  value={track.easing}
                  onChange={(e) =>
                    updateTrack(op.id, track.id, { easing: e.target.value as Easing })
                  }
                >
                  {EASINGS.map((x) => (
                    <option key={x} value={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Start</span>
                <input
                  type="number" min={0} max={1} step={0.05}
                  value={track.start}
                  onChange={(e) =>
                    updateTrack(op.id, track.id, { start: clamp01(Number(e.target.value)) })
                  }
                />
              </label>
              <label className="field">
                <span>End</span>
                <input
                  type="number" min={0} max={1} step={0.05}
                  value={track.end}
                  onChange={(e) =>
                    updateTrack(op.id, track.id, { end: clamp01(Number(e.target.value)) })
                  }
                />
              </label>
            </div>
          </div>
        ))}
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
                onChange={(e) => updateAnnotation(op.id, a.id, { text: e.target.value })}
              />
              <button onClick={() => removeAnnotation(op.id, a.id)}>✕</button>
            </div>

            <div className="anno-meta">
              {a.anchor.kind === 'part' ? (
                <span title={nameOf(a.anchor.partId)}>
                  📌 {nameOf(a.anchor.partId)}
                </span>
              ) : (
                <span>🌐 fixed point</span>
              )}

              <button
                disabled={!selection.length}
                title={selection.length ? 'Re-pin to the selected part' : 'Select a part first'}
                onClick={() =>
                  updateAnnotation(op.id, a.id, {
                    anchor: { kind: 'part', partId: selection[0] },
                  })
                }
              >
                pin to selection
              </button>

              {a.anchor.kind === 'part' && (
                <button
                  title="Detach: freeze at the part's rest position"
                  onClick={() => {
                    const partId = (a.anchor as { kind: 'part'; partId: string }).partId;
                    const rest = sequence.assembly.parts[partId]?.restTranslate ?? [0, 0, 0];
                    updateAnnotation(op.id, a.id, {
                      anchor: { kind: 'world', point: [...rest] as [number, number, number] },
                    });
                  }}
                >
                  unpin
                </button>
              )}
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

function MoveEditor({
  label,
  move,
  onChange,
}: {
  label: string;
  move: Move;
  onChange: (m: Move) => void;
}) {
  const set = (i: number, v: number) => {
    const t = [...move.translate] as [number, number, number];
    t[i] = v;
    onChange({ ...move, translate: t });
  };

  return (
    <div className="move-editor">
      <span className="move-label">{label}</span>
      <div className="xyz">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <label key={axis}>
            <span>{axis}</span>
            <input
              type="number"
              step={1}
              value={move.translate[i]}
              onChange={(e) => set(i, Number(e.target.value))}
            />
          </label>
        ))}
      </div>
      <div className="btn-row small">
        {([['+X', 0, 1], ['-X', 0, -1], ['+Y', 1, 1], ['-Y', 1, -1], ['+Z', 2, 1], ['-Z', 2, -1]] as const).map(
          ([lbl, axis, dir]) => (
            <button
              key={lbl}
              onClick={() => set(axis, move.translate[axis] + 25 * dir)}
              title="Nudge 25mm"
            >
              {lbl}
            </button>
          ),
        )}
        <button
          onClick={() =>
            onChange({ translate: [0, 0, 0], rotate: IDENTITY_QUAT, pivot: move.pivot })
          }
        >
          reset
        </button>
      </div>
    </div>
  );
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
