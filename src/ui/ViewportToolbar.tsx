/** Floating viewport toolbar: picking, home, undo/redo, and explode. */
import { useStore } from '@/state/store';
import { selectableParts } from '@/domain/authoring';

export function ViewportToolbar() {
  const sequence = useStore((s) => s.sequence);
  const axisLock = useStore((s) => s.axisLock);
  const pickEnabled = useStore((s) => s.pickEnabled);
  const selection = useStore((s) => s.selection);
  const activeOperationId = useStore((s) => s.activeOperationId);

  const setAxisLock = useStore((s) => s.setAxisLock);
  const setPickEnabled = useStore((s) => s.setPickEnabled);
  const explodeSelection = useStore((s) => s.explodeSelection);
  const goHomeSelection = useStore((s) => s.goHomeSelection);

  if (!sequence) return null;

  // Can the selection go home? Only if the active step actually moves it.
  const op = sequence.operations.find((o) => o.id === activeOperationId);
  const selectedMeshes = selectableParts(sequence.assembly, selection);
  const canHome =
    selectedMeshes.length > 0 &&
    !!op?.tracks.some((t) => t.parts.some((p) => selectedMeshes.includes(p)));

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
          disabled={!canHome}
          onClick={goHomeSelection}
          title="Return the selected component or sub-assembly to its home position (removes its motion from this step)"
        >
          ⌂ Home
        </button>
        {/* Undo/redo are DISABLED pending rework: the user reports undo still
            misbehaving on motion edits, so the buttons are greyed out rather
            than offering a broken feature. History is still recorded; the
            buttons come back when the behaviour is verified trustworthy. */}
        <button disabled title="Undo — temporarily disabled while we fix history behaviour">↶</button>
        <button disabled title="Redo — temporarily disabled while we fix history behaviour">↷</button>
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
