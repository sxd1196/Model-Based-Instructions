/**
 * Motion lanes: the step's choreography, under the chip strip.
 *
 * One line per motion until clicked — "8 parts · ⤴ Z 120mm · [bar] 0.0→1.1s"
 * — expanding to typed XYZ / axis+degrees / seconds fields. Two entry
 * methods, one lane: drag the gizmo in the viewport, or press + Motion and
 * type numbers. Bars drag at both edges with magnetic snap to other lanes'
 * edges, so "then" means exactly then.
 *
 * Design notes:
 * - Lanes are MERGED cluster tracks (see buildLanes) — a sub-assembly drag
 *   reads as the single motion the author performed.
 * - Timing is displayed in SECONDS; the schema keeps fractions, so
 *   stretching a step's duration stretches its choreography proportionally.
 * - Easing is deliberately absent from the UI (defaults easeInOut).
 */
import { useCallback, useRef, useState } from 'react';
import { useStore } from '@/state/store';
import {
  axisAngleToQuat,
  buildLanes,
  describeMove,
  fractionToSeconds,
  quatToAxisAngle,
  secondsToFraction,
  snapEdge,
  type Lane,
} from '@/domain/lanes';
import type { Move, Operation } from '@/domain/schema';

export function MotionLanes({ op }: { op: Operation }) {
  const sequence = useStore((s) => s.sequence);
  const selection = useStore((s) => s.selection);
  const updateLaneTracks = useStore((s) => s.updateLaneTracks);
  const removeLaneTracks = useStore((s) => s.removeLaneTracks);
  const addMotionForSelection = useStore((s) => s.addMotionForSelection);
  const updateOperation = useStore((s) => s.updateOperation);
  const parkAtOperationEnd = useStore((s) => s.parkAtOperationEnd);

  const [expanded, setExpanded] = useState<string | null>(null);

  if (!sequence) return null;
  const lanes = buildLanes(op);

  const nameOf = (id: string) => sequence.assembly.parts[id]?.name ?? id;
  const laneLabel = (lane: Lane) =>
    lane.parts.length === 1 ? nameOf(lane.parts[0]) : `${lane.parts.length} parts`;
  const laneKey = (lane: Lane) => lane.trackIds[0];

  return (
    <div className="lanes">
      <div className="lanes-head">
        <span className="lanes-title">Motions</span>
        <label title="Seconds of motion">
          duration
          <input
            type="number" min={0.1} step={0.1} value={op.duration}
            onChange={(e) =>
              updateOperation(op.id, { duration: Math.max(0.1, Number(e.target.value)) })
            }
          />s
        </label>
        <label title="Hold at the end before the next step">
          dwell
          <input
            type="number" min={0} step={0.1} value={op.dwell}
            onChange={(e) =>
              updateOperation(op.id, { dwell: Math.max(0, Number(e.target.value)) })
            }
          />s
        </label>
        <button
          className="lanes-add"
          disabled={!selection.length}
          title={selection.length
            ? 'Add a motion for the selected parts — then type the movement'
            : 'Select parts first'}
          onClick={() => addMotionForSelection(op.id)}
        >
          + Motion ({selection.length})
        </button>
      </div>

      {!lanes.length && (
        <div className="lanes-empty">
          Drag a part with the gizmo, or select parts and press <b>+ Motion</b>.
        </div>
      )}

      <div className="lanes-scroll">
        {lanes.map((lane) => (
          <LaneRow
            key={laneKey(lane)}
            lane={lane}
            op={op}
            label={laneLabel(lane)}
            expanded={expanded === laneKey(lane)}
            onToggle={() =>
              setExpanded(expanded === laneKey(lane) ? null : laneKey(lane))
            }
            onPatch={(patch) => {
              updateLaneTracks(op.id, lane.trackIds, patch);
              parkAtOperationEnd(op.id);
            }}
            onRemove={() => removeLaneTracks(op.id, lane.trackIds)}
            otherEdges={lanes
              .filter((l) => laneKey(l) !== laneKey(lane))
              .flatMap((l) => [l.start, l.end])}
          />
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  lane: Lane;
  op: Operation;
  label: string;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (patch: { to?: Move; start?: number; end?: number }) => void;
  onRemove: () => void;
  otherEdges: number[];
}

function LaneRow({ lane, op, label, expanded, onToggle, onPatch, onRemove, otherEdges }: RowProps) {
  const barRef = useRef<HTMLDivElement>(null);

  /** Drag either bar edge (or the body to slide the window). */
  const onBarPointerDown = useCallback(
    (e: React.PointerEvent, grab: 'start' | 'end' | 'body') => {
      e.preventDefault();
      e.stopPropagation();
      const host = barRef.current?.parentElement;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const span = lane.end - lane.start;
      const origin = { start: lane.start, end: lane.end, x: e.clientX };

      const move = (ev: PointerEvent) => {
        const df = (ev.clientX - origin.x) / rect.width;
        if (grab === 'start') {
          const v = snapEdge(Math.min(origin.start + df, lane.end - 0.02), otherEdges);
          onPatch({ start: Math.max(0, v) });
        } else if (grab === 'end') {
          const v = snapEdge(Math.max(origin.end + df, lane.start + 0.02), otherEdges);
          onPatch({ end: Math.min(1, v) });
        } else {
          let s = origin.start + df;
          s = Math.max(0, Math.min(s, 1 - span));
          const snapped = snapEdge(s, otherEdges, 0.02);
          const s2 = Math.abs(snapped - s) < 0.02 && snapped + span <= 1 ? snapped : s;
          onPatch({ start: s2, end: s2 + span });
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [lane, onPatch, otherEdges],
  );

  const aa = quatToAxisAngle(lane.move.rotate);
  const setTranslate = (i: number, v: number) => {
    const t = [...lane.move.translate] as [number, number, number];
    t[i] = v;
    onPatch({ to: { ...lane.move, translate: t } });
  };
  const setRotation = (axis: typeof aa.axis, angle: number) => {
    onPatch({
      to: { ...lane.move, rotate: axisAngleToQuat(axis, aa.vector, angle) },
    });
  };

  return (
    <div className={`lane${expanded ? ' open' : ''}`}>
      <div className="lane-line" onClick={onToggle}>
        <span className="lane-parts" title={lane.parts.join(', ')}>{label}</span>
        <span className="lane-desc">{describeMove(lane.move)}</span>

        <div className="lane-bar-host">
          <div
            ref={barRef}
            className="lane-bar"
            style={{
              left: `${lane.start * 100}%`,
              width: `${Math.max((lane.end - lane.start) * 100, 2)}%`,
            }}
            onPointerDown={(e) => onBarPointerDown(e, 'body')}
          >
            <span
              className="lane-grip left"
              onPointerDown={(e) => onBarPointerDown(e, 'start')}
            />
            <span
              className="lane-grip right"
              onPointerDown={(e) => onBarPointerDown(e, 'end')}
            />
          </div>
        </div>

        <span className="lane-time">
          {fractionToSeconds(lane.start, op.duration).toFixed(1)} →{' '}
          {fractionToSeconds(lane.end, op.duration).toFixed(1)}s
        </span>
        <button
          className="lane-x"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Delete this motion"
        >
          ✕
        </button>
      </div>

      {expanded && (
        <div className="lane-editor" onClick={(e) => e.stopPropagation()}>
          <div className="lane-field-group">
            <span className="lane-field-label">move mm</span>
            {(['X', 'Y', 'Z'] as const).map((axis, i) => (
              <label key={axis} className="lane-num">
                <span>{axis}</span>
                <input
                  type="number" step={1}
                  value={round1(lane.move.translate[i])}
                  onChange={(e) => setTranslate(i, Number(e.target.value))}
                />
              </label>
            ))}
          </div>

          <div className="lane-field-group">
            <span className="lane-field-label">rotate</span>
            <select
              value={aa.axis}
              onChange={(e) => setRotation(e.target.value as typeof aa.axis, aa.angle || 90)}
            >
              <option value="X">about X</option>
              <option value="Y">about Y</option>
              <option value="Z">about Z</option>
              {aa.axis === 'custom' && <option value="custom">custom axis</option>}
            </select>
            <label className="lane-num">
              <input
                type="number" step={5}
                value={round1(aa.angle)}
                onChange={(e) => setRotation(aa.axis, Number(e.target.value))}
              />
              <span>°</span>
            </label>
          </div>

          <div className="lane-field-group">
            <span className="lane-field-label">timing</span>
            <label className="lane-num">
              <input
                type="number" step={0.1} min={0}
                value={fractionToSeconds(lane.start, op.duration)}
                onChange={(e) =>
                  onPatch({
                    start: Math.min(
                      secondsToFraction(Number(e.target.value), op.duration),
                      lane.end - 0.02,
                    ),
                  })
                }
              />
              <span>s →</span>
            </label>
            <label className="lane-num">
              <input
                type="number" step={0.1} min={0}
                value={fractionToSeconds(lane.end, op.duration)}
                onChange={(e) =>
                  onPatch({
                    end: Math.max(
                      secondsToFraction(Number(e.target.value), op.duration),
                      lane.start + 0.02,
                    ),
                  })
                }
              />
              <span>s</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;
