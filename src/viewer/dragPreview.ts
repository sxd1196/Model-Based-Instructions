/**
 * The live-drag preview channel between DragGizmo and SceneBinder.
 *
 * While a handle is being dragged, the provisional Moves for the affected
 * parts live here and SceneBinder renders them INSTEAD of the evaluated frame
 * for those parts. On release the same Moves (computed by the same shared
 * domain functions) are committed to the store, so parts land exactly where
 * the preview showed them.
 *
 * Moves are stored PER PART: a group drag spanning several parent frames
 * produces a different local Move per cluster (see clusterMoveFromDrag), and
 * a single shared Move would replay the scattered-bolt-circle bug in the
 * preview even after the commit path was fixed.
 *
 * A mutable module singleton, not React state or the store, on purpose:
 * it changes every pointer-move during a drag, and per-frame React state
 * updates are banned in the hot path (AGENTS.md §7). Both writer and reader
 * live in viewer/, so no dependency rule is bent.
 */
import type { Move } from '@/domain/schema';

export interface DragPreview {
  active: boolean;
  /** Per-part provisional Move, same semantics as a track's `to`. */
  moves: Map<string, Move>;
}

export const dragPreview: DragPreview = {
  active: false,
  moves: new Map(),
};

export function beginPreview(): void {
  dragPreview.moves.clear();
  dragPreview.active = true;
}

export function updatePreview(moves: Iterable<[string, Move]>): void {
  dragPreview.moves.clear();
  for (const [id, move] of moves) dragPreview.moves.set(id, move);
}

export function endPreview(): void {
  dragPreview.active = false;
  dragPreview.moves.clear();
}

// Dev-only visibility for headless checks.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__dragPreviewProbe', {
    get: () => ({
      active: dragPreview.active,
      parts: [...dragPreview.moves.keys()],
      moves: Object.fromEntries(dragPreview.moves),
    }),
    configurable: true,
  });
}
