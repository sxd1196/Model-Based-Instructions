/**
 * Axis legend drawn in DOM next to the 3D triad.
 *
 * DOM rather than 3D text: at ~11px, extruded glyphs are unreadable and cost a
 * draw call each. The colours match `AXIS_COLORS` in viewer/Orientation.tsx —
 * change both together.
 */
import { useStore } from '@/state/store';

export function AxisLegend() {
  const sequence = useStore((s) => s.sequence);
  if (!sequence) return null;

  return (
    <div className="axis-legend" aria-label="Axis colours">
      <span><i style={{ background: '#ff4d4d' }} />X</span>
      <span><i style={{ background: '#4dff88' }} />Y</span>
      <span><i style={{ background: '#4d94ff' }} />Z</span>
      <em>mm</em>
    </div>
  );
}
