/** Operation list + scrubber + motion lanes. The authoring spine of the app. */
import { useStore } from '@/state/store';
import { buildTimeline, totalDuration } from '@/domain/evaluate';
import { MotionLanes } from './MotionLanes';

export function Timeline() {
  const sequence = useStore((s) => s.sequence);
  const time = useStore((s) => s.time);
  const playing = useStore((s) => s.playing);
  const rate = useStore((s) => s.playbackRate);
  const activeId = useStore((s) => s.activeOperationId);

  const setTime = useStore((s) => s.setTime);
  const goHome = useStore((s) => s.goHome);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const togglePlay = useStore((s) => s.togglePlay);
  const setRate = useStore((s) => s.setPlaybackRate);
  const seekTo = useStore((s) => s.seekToOperation);
  const addOperation = useStore((s) => s.addOperation);
  const removeOperation = useStore((s) => s.removeOperation);
  const duplicateOperation = useStore((s) => s.duplicateOperation);
  const reorder = useStore((s) => s.reorderOperation);

  if (!sequence) return null;

  const timeline = buildTimeline(sequence);
  const total = totalDuration(sequence);
  const activeOp = sequence.operations.find((o) => o.id === activeId) ?? null;

  return (
    <div className="timeline">
      <div className="transport">
        <button className="primary" onClick={togglePlay} title="Space">
          {playing ? '❚❚' : '▶'}
        </button>
        <button
          className="home-btn"
          onClick={goHome}
          title="Return every component to its original position (playhead to 0)"
        >
          ⌂ Home
        </button>
        <button
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          ↶
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          ↷
        </button>
        <span className="time">
          {time.toFixed(2)}s / {total.toFixed(2)}s
        </span>
        <input
          className="scrub"
          type="range"
          min={0}
          max={Math.max(total, 0.001)}
          step={0.01}
          value={time}
          onChange={(e) => setTime(Number(e.target.value))}
        />
        <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
          <option value={0.25}>0.25×</option>
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={4}>4×</option>
        </select>
        <button onClick={() => addOperation()}>+ Step</button>
      </div>

      <div className="track-strip">
        {timeline.map((entry, i) => {
          const width = total > 0 ? ((entry.endTime - entry.startTime) / total) * 100 : 0;
          const isActive = entry.operation.id === activeId;
          return (
            <div
              key={entry.operation.id}
              className={`chip${isActive ? ' active' : ''}`}
              style={{ width: `${Math.max(width, 6)}%` }}
              onClick={() => seekTo(entry.operation.id)}
              title={`${entry.operation.title} — ${entry.operation.duration}s +${entry.operation.dwell}s dwell`}
            >
              <span className="chip-index">{i + 1}</span>
              <span className="chip-title">{entry.operation.title}</span>
              <span className="chip-actions">
                <button onClick={(e) => { e.stopPropagation(); reorder(i, Math.max(0, i - 1)); }}>◀</button>
                <button onClick={(e) => { e.stopPropagation(); reorder(i, Math.min(timeline.length - 1, i + 1)); }}>▶</button>
                <button onClick={(e) => { e.stopPropagation(); duplicateOperation(entry.operation.id); }}>⧉</button>
                <button onClick={(e) => { e.stopPropagation(); removeOperation(entry.operation.id); }}>✕</button>
              </span>
            </div>
          );
        })}
        {!timeline.length && (
          <div className="strip-empty">
            No steps yet — select parts, then press <b>+ Step</b>.
          </div>
        )}
        {total > 0 && (
          <div className="playhead" style={{ left: `${(time / total) * 100}%` }} />
        )}
      </div>

      {/* The active step's choreography: motion lanes with draggable timing.
          Motion lives HERE (temporal); the Inspector keeps what the step
          SAYS (title, instruction, camera, callouts). */}
      {activeOp && <MotionLanes op={activeOp} />}
    </div>
  );
}
