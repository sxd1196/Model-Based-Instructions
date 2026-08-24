/**
 * Post-import options dialog.
 *
 * Appears after a CAD/glTF model parses (the geometry is needed to plan, so
 * this cannot literally precede conversion), before the user lands in the
 * empty editor. Extensible: future import-time options join this panel.
 */
import { useState } from 'react';

interface Props {
  modelName: string;
  partCount: number;
  onContinue: (opts: { runPlanner: boolean }) => void;
}

export function ImportOptionsDialog({ modelName, partCount, onContinue }: Props) {
  const [runPlanner, setRunPlanner] = useState(false);

  return (
    <div className="import-dialog-backdrop">
      <div className="import-dialog">
        <h3>{modelName}</h3>
        <div className="hint">{partCount} parts loaded.</div>

        <label className="import-opt">
          <input
            type="checkbox"
            checked={runPlanner}
            onChange={(e) => setRunPlanner(e.target.checked)}
          />
          <div>
            <div className="import-opt-title">Draft an assembly sequence automatically</div>
            <div className="import-opt-hint">
              Analyzes the geometry and proposes a step-by-step disassembly
              draft — camera angles, highlights, and instructions included.
              You review and approve every step before it becomes yours.
            </div>
          </div>
        </label>

        <div className="import-dialog-actions">
          <button className="btn big" onClick={() => onContinue({ runPlanner })}>
            {runPlanner ? 'Run planner' : 'Start from scratch'}
          </button>
        </div>
      </div>
    </div>
  );
}
