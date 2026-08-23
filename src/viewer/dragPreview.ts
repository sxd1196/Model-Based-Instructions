/**
 * The live-drag preview channel between DragGizmo and SceneBinder.
 *
 * While a handle is being dragged, the provisional Move for the affected
 * parts lives here and SceneBinder renders it INSTEAD of the evaluated frame
 * for those parts. On release the same Move (computed by the same shared
 * domain functions) is committed to the store, so the part lands exactly
 * where the preview showed it.
 *
 * A mutable module singleton, not React state or the store, on purpose:
 * it changes every pointer-move during a drag, and per-frame React state
 * updates are banned in the hot path (AGENTS.md §7). Both writer and reader
 * live in viewer/, so no dependency rule is bent.
 */
import type { Move } from '@/domain/schema';

export interface DragPreview {
  active: boolean;
  /** Part ids the preview move applies to. */
  parts: Set<string>;
  /** Cumulative Move vs rest pose — same semantics as a track's `to`. */
  move: Move | null;
}

export const dragPreview: DragPreview = {
  active: false,
  parts: new Set(),
  move: null,
};

export function beginPreview(partIds: string[]): void {
  dragPreview.parts.clear();
  for (const id of partIds) dragPreview.parts.add(id);
  dragPreview.move = null;
  dragPreview.active = true;
}

export function updatePreview(move: Move): void {
  dragPreview.move = move;
}

export function endPreview(): void {
  dragPreview.active = false;
  dragPreview.parts.clear();
  dragPreview.move = null;
}

// Dev-only visibility for headless checks.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__dragPreviewProbe', {
    get: () => ({
      active: dragPreview.active,
      parts: [...dragPreview.parts],
      move: dragPreview.move,
    }),
    configurable: true,
  });
}
