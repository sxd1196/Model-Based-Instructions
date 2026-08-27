/**
 * Draft review banner + per-step approve list.
 *
 * Shown while store.draftReview is non-null. The draft IS the live sequence —
 * play/scrub/orbit all work — but this surface makes its provisional nature
 * unmistakable (user requirement: "let people know it's a draft feature and
 * that they need to accept the draft to make it finalized").
 *
 * Per-step approve/reject (user choice #2): each step row carries ✓/✗ and
 * the planner's reason. Accept keeps approved + pending and drops rejected;
 * Discard throws the whole draft away.
 */
import { useStore } from '@/state/store';

export function DraftReviewBanner() {
  const review = useStore((s) => s.draftReview);
  const sequence = useStore((s) => s.sequence);
  const seekToOperation = useStore((s) => s.seekToOperation);
  const setDraftVerdict = useStore((s) => s.setDraftVerdict);
  const acceptDraft = useStore((s) => s.acceptDraft);
  const discardDraft = useStore((s) => s.discardDraft);
  const togglePlay = useStore((s) => s.togglePlay);
  const activeOperationId = useStore((s) => s.activeOperationId);

  if (!review || !sequence) return null;

  const ops = sequence.operations;
  const verdicts = review.verdicts;
  const rejected = Object.values(verdicts).filter((v) => v === 'rejected').length;
  const approved = Object.values(verdicts).filter((v) => v === 'approved').length;
  const placed = ops.filter((o) => !o.meta.planUnplanned).length;
  const unplanned = review.unplannedOpIds.length;

  return (
    <div className="draft-banner">
      <div className="draft-head">
        <span className="draft-tag">DRAFT — not final until accepted</span>
        <span className="draft-summary">
          {placed} steps proposed{unplanned > 0 && ` · ${unplanned} unresolved`}
          {approved > 0 && ` · ${approved} approved`}
          {rejected > 0 && ` · ${rejected} rejected`}
        </span>
        <button onClick={togglePlay} title="Play the draft through">▶ Play</button>
        <button
          title="Download the quantitative plan report (per-step direction scores, contact evidence, shear flags) — share it to debug the algorithm"
          onClick={() => {
            const report = (window as unknown as { __planReport?: unknown }).__planReport;
            if (!report) return;
            const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'plan-report.json';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          ⇩ Report
        </button>
        <div className="spacer" />
        <button
          className="draft-accept"
          onClick={acceptDraft}
          title="Keep every step you didn't reject and start editing from here"
        >
          ✓ Use this draft
        </button>
        <button
          className="draft-discard"
          onClick={() => {
            if (window.confirm('Discard the entire draft? You will start from an empty sequence.')) {
              discardDraft();
            }
          }}
        >
          ✗ Discard
        </button>
      </div>

      <div className="draft-steps">
        {ops.map((op, i) => {
          const v = verdicts[op.id] ?? 'pending';
          const isUnplanned = !!op.meta.planUnplanned;
          const isShear = !!op.meta.planShear;
          return (
            <div
              key={op.id}
              className={
                `draft-step ${v}` +
                (op.id === activeOperationId ? ' active' : '') +
                (isUnplanned ? ' unplanned' : '') +
                (isShear ? ' shear' : '')
              }
              onClick={() => seekToOperation(op.id)}
              title={op.meta.planReason}
            >
              <span className="draft-step-index">{i + 1}</span>
              <span className="draft-step-title">{op.title}{isShear && <span className="shear-tag" title="This move slides across a mating surface instead of away from it — review before accepting">⚠ shear</span>}</span>
              <span className="draft-step-reason">{op.meta.planReason}</span>
              {!isUnplanned && (
                <span className="draft-step-actions">
                  <button
                    className={v === 'approved' ? 'on' : ''}
                    title="Approve this step"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDraftVerdict(op.id, v === 'approved' ? 'pending' : 'approved');
                    }}
                  >
                    ✓
                  </button>
                  <button
                    className={v === 'rejected' ? 'on rej' : ''}
                    title="Reject — this step is dropped when you accept the draft"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDraftVerdict(op.id, v === 'rejected' ? 'pending' : 'rejected');
                    }}
                  >
                    ✗
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
