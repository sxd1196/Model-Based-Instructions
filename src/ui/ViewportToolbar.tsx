/** Floating viewport toolbar: gizmo mode, snapping, and explode. */
import { useStore } from '@/state/store';

export function ViewportToolbar() {
  const sequence = useStore((s) => s.sequence);
  const gizmo = useStore((s) => s.gizmo);
  const snap = useStore((s) => s.snap);
  const axisLock = useStore((s) => s.axisLock);
  const pickEnabled = useStore((s) => s.pickEnabled);
  const selection = useStore((s) => s.selection);
  const activeOperationId = useStore((s) => s.activeOperationId);

  const setGizmo = useStore((s) => s.setGizmo);
  const setSnap = useStore((s) => s.setSnap);
  const setAxisLock = useStore((s) => s.setAxisLock);
  const setPickEnabled = useStore((s) => s.setPickEnabled);
  const explodeSelection = useStore((s) => s.explodeSelection);

  if (!sequence) return null;


  return (
    <div className="vp-toolbar">
      <div className="vp-group">
        <button
          className={pickEnabled ? 'on' : ''}
          onClick={() => setPickEnabled(!pickEnabled)}
          title="Click geometry to select (shift = add, alt = exact mesh)"
        >
          ⬚ Pick
        </button>
      </div>

      <div className="vp-group">
        {([
          ['off', '✋', 'Look', 'Orbit only — no dragging'],
          ['translate', '✥', 'Move', 'Drag the arrows to move parts'],
          ['rotate', '⟳', 'Rotate', 'Drag the rings to rotate parts'],
        ] as const).map(([m, glyph, label, tip]) => (
          <button
            key={m}
            className={`vp-mode ${gizmo === m ? 'on' : ''}`}
            onClick={() => setGizmo(m)}
            title={`Gizmo: ${m} — ${tip}`}
          >
            <span className="vp-glyph">{glyph}</span>
            <span className="vp-label">{label}</span>
          </button>
        ))}
      </div>

      <div className="vp-group">
        <label title="Grid snap for drags">
          snap
          <select value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
            <option value={0}>off</option>
            <option value={1}>1mm</option>
            <option value={5}>5mm</option>
            <option value={10}>10mm</option>
            <option value={25}>25mm</option>
          </select>
        </label>
        <button
          className={axisLock ? 'on' : ''}
          onClick={() => setAxisLock(!axisLock)}
          title="Collapse near-axial drags onto one axis"
        >
          axis
        </button>
      </div>

      <div className="vp-group">
        <button
          disabled={!selection.length || !activeOperationId}
          onClick={() => explodeSelection(0.6)}
          title="Radial explode the selection as a starting point"
        >
          ✷ Explode
        </button>
      </div>

      <div className="vp-hint">
        {!activeOperationId
          ? 'Add a step to start authoring'
          : selection.length > 1
            ? `${selection.length} parts — drag moves them as one rigid group`
            : selection.length === 1
              ? 'Drag the gizmo to author motion'
              : 'Click a part · shift adds · alt picks exact mesh'}
      </div>
    </div>
  );
}
