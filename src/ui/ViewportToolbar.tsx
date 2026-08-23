/** Floating viewport toolbar: picking, snapping, and explode. */
import { useStore } from '@/state/store';

export function ViewportToolbar() {
  const sequence = useStore((s) => s.sequence);
  const snap = useStore((s) => s.snap);
  const axisLock = useStore((s) => s.axisLock);
  const pickEnabled = useStore((s) => s.pickEnabled);
  const selection = useStore((s) => s.selection);
  const activeOperationId = useStore((s) => s.activeOperationId);

  const setSnap = useStore((s) => s.setSnap);
  const setAxisLock = useStore((s) => s.setAxisLock);
  const setPickEnabled = useStore((s) => s.setPickEnabled);
  const explodeSelection = useStore((s) => s.explodeSelection);

  if (!sequence) return null;

  // No mode buttons: the gizmo carries translate arrows and rotate rings at
  // once, and orbiting works whenever the pointer is not on a handle. Modes
  // existed only to switch TransformControls' single-personality widget.
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
        {selection.length > 1
          ? `${selection.length} parts — drag moves them as one rigid group`
          : selection.length === 1
            ? 'Arrows move · rings rotate'
            : 'Click a part · shift adds · alt picks exact mesh'}
      </div>
    </div>
  );
}
