/**
 * Application state. Zustand + immer.
 *
 * Rule: this store holds AUTHORING state (the document + selection + playhead).
 * It never holds derived render state — that comes from resolveFrame() on demand.
 * Keeping derived data out of the store is what prevents the store from becoming
 * a dumping ground as the app grows.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type {
  Annotation,
  AnnotationInput,
  Assembly,
  CameraPose,
  Move,
  Operation,
  PartStyle,
  Quat,
  Sequence,
  Track,
  Vec3,
} from '@/domain/schema';
import {
  Annotation as AnnotationSchema,
  IDENTITY_MOVE,
  SCHEMA_VERSION,
  parseSequence,
} from '@/domain/schema';
import { totalDuration } from '@/domain/evaluate';
import {
  centroidOf,
  isIdentityMove,
  moveFromDrag,
  applyDragPolicy,
  radialExplode,
  resolveSelectionTarget,
  selectableParts,
} from '@/domain/authoring';
import { groupMoveFromDrag } from '@/domain/rigid';

const uid = () => crypto.randomUUID();

export function emptySequence(assembly: Assembly): Sequence {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid(),
    name: assembly.name || 'Untitled sequence',
    intent: 'disassembly',
    assembly,
    operations: [],
    homeCamera: null,
    units: 'mm',
  };
}

interface HistoryEntry {
  sequence: Sequence;
  label: string;
}

interface State {
  sequence: Sequence | null;
  /** Part ids currently selected in the tree/viewport. */
  selection: string[];
  /** Operation being edited. */
  activeOperationId: string | null;
  /** Absolute playhead position, seconds. */
  time: number;
  playing: boolean;
  playbackRate: number;
  loading: boolean;
  warnings: string[];
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Direct-manipulation gizmo mode. 'off' hides it. */
  /** Grid snap in mm for gizmo drags. 0 disables. */
  snap: number;
  /** Collapse a near-axial drag onto its dominant axis. */
  axisLock: boolean;
  /** Click geometry in the viewport to select. */
  pickEnabled: boolean;
  /**
   * When set, the next viewport click sets this annotation's leader anchor
   * instead of changing the selection.
   */
  anchorMode: { operationId: string; annotationId: string } | null;
}

interface Actions {
  loadSequence: (s: Sequence) => void;
  loadFromJson: (raw: unknown) => void;
  newFromAssembly: (a: Assembly, warnings?: string[]) => void;
  setWarnings: (w: string[] | ((prev: string[]) => string[])) => void;
  setLoading: (v: boolean) => void;

  select: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;
  /** Resolve a raw picked mesh id to a sensible selection unit, then select. */
  pickPart: (clickedId: string, opts?: { additive?: boolean; deep?: boolean }) => void;
  setSnap: (mm: number) => void;
  setAxisLock: (v: boolean) => void;
  setPickEnabled: (v: boolean) => void;
  /**
   * Commit a gizmo drag as a Move on the active operation.
   * Creates the track if the part has none yet, updates it otherwise.
   */
  commitDrag: (partId: string, position: Vec3, rotation: Quat) => void;
  /**
   * Commit a RIGID group drag: one shared Move applied to every part, kept on
   * a single track so the group stays one unit.
   */
  commitGroupDrag: (
    partIds: string[],
    gizmoStart: Vec3,
    gizmoEnd: Vec3,
    gizmoRotation: Quat,
  ) => void;
  /** Seed the active operation with a radial explode of the selection. */
  explodeSelection: (factor: number) => void;
  /** Select an entire sub-assembly by any member part. */
  selectSubassemblyOf: (partId: string, additive?: boolean) => void;

  setTime: (t: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setPlaybackRate: (r: number) => void;
  seekToOperation: (id: string) => void;
  /** Park the playhead at an operation MOTION end, so its result is visible. */
  parkAtOperationEnd: (id: string) => void;

  addOperation: (partial?: Partial<Operation>) => string | null;
  updateOperation: (id: string, patch: Partial<Operation>) => void;
  removeOperation: (id: string) => void;
  reorderOperation: (from: number, to: number) => void;
  duplicateOperation: (id: string) => void;
  setActiveOperation: (id: string | null) => void;

  addTrack: (operationId: string, parts: string[], to?: Move) => void;
  updateTrack: (operationId: string, trackId: string, patch: Partial<Track>) => void;
  removeTrack: (operationId: string, trackId: string) => void;

  setOperationCamera: (operationId: string, pose: CameraPose | null) => void;
  setHomeCamera: (pose: CameraPose | null) => void;
  addAnnotation: (operationId: string, a: Omit<AnnotationInput, 'id'>) => void;
  updateAnnotation: (
    operationId: string,
    annotationId: string,
    patch: Partial<Omit<Annotation, 'id'>>,
  ) => void;
  removeAnnotation: (operationId: string, annotationId: string) => void;
  /** Arm/disarm click-to-anchor for a specific callout. */
  setAnchorMode: (target: { operationId: string; annotationId: string } | null) => void;
  /** Called by the viewport when a snapped feature is picked in anchor mode. */
  setAnchorFromPick: (
    partId: string,
    kind: 'vertex' | 'edge' | 'face',
    local: Vec3,
    normal: Vec3,
  ) => void;
  setStyle: (operationId: string, style: PartStyle) => void;

  undo: () => void;
  redo: () => void;
}

const HISTORY_LIMIT = 100;

export const useStore = create<State & Actions>()(
  immer((set, get) => {
    /** Snapshot current doc into the undo stack before a mutation. */
    const checkpoint = (label: string) => {
      const seq = get().sequence;
      if (!seq) return;
      set((s) => {
        s.past.push({ sequence: JSON.parse(JSON.stringify(seq)), label });
        if (s.past.length > HISTORY_LIMIT) s.past.shift();
        s.future = [];
      });
    };

    const findOp = (s: State, id: string): Operation | undefined =>
      s.sequence?.operations.find((o) => o.id === id);

    return {
      sequence: null,
      selection: [],
      activeOperationId: null,
      time: 0,
      playing: false,
      playbackRate: 1,
      loading: false,
      warnings: [],
      past: [],
      future: [],
      snap: 5,
      axisLock: true,
      pickEnabled: true,
      anchorMode: null,

      loadSequence: (sequence) =>
        set((s) => {
          s.sequence = sequence;
          s.activeOperationId = sequence.operations[0]?.id ?? null;
          s.time = 0;
          s.playing = false;
          s.past = [];
          s.future = [];
          s.selection = [];
        }),

      loadFromJson: (raw) => get().loadSequence(parseSequence(raw)),

      newFromAssembly: (assembly, warnings = []) =>
        set((s) => {
          s.sequence = emptySequence(assembly);
          s.activeOperationId = null;
          s.time = 0;
          s.playing = false;
          s.warnings = warnings;
          s.past = [];
          s.future = [];
          s.selection = [];
        }),

      setWarnings: (w) =>
        set((s) => void (s.warnings = typeof w === 'function' ? w(s.warnings) : w)),
      setLoading: (v) => set((s) => void (s.loading = v)),

      select: (ids, additive = false) =>
        set((s) => {
          s.selection = additive
            ? Array.from(new Set([...s.selection, ...ids]))
            : ids;
        }),

      clearSelection: () => set((s) => void (s.selection = [])),

      pickPart: (clickedId, opts = {}) =>
        set((s) => {
          if (!s.sequence) return;
          const target = resolveSelectionTarget(s.sequence.assembly, clickedId, {
            deep: opts.deep,
          });
          if (!target) return;
          // Expand groups to their posable meshes: authors think in parts,
          // the evaluator needs geometry.
          const ids = selectableParts(s.sequence.assembly, [target]);
          s.selection = opts.additive
            ? Array.from(new Set([...s.selection, ...ids]))
            : ids;
        }),

      setSnap: (mm) => set((s) => void (s.snap = Math.max(0, mm))),
      setAxisLock: (v) => set((s) => void (s.axisLock = v)),
      setPickEnabled: (v) => set((s) => void (s.pickEnabled = v)),

      commitDrag: (partId, position, rotation) => {
        const state = get();
        const sequence = state.sequence;
        if (!sequence) return;

        const node = sequence.assembly.parts[partId];
        if (!node) return;

        // Pivot at the part's REST POSITION, not the world origin. A rotate
        // gizmo leaves the handle in place, so an origin pivot turns a pure
        // spin into a large translate — which axis lock then flattens onto
        // one axis and snap quantizes, flinging the part across the scene.
        let move: Move = moveFromDrag(
          node.restTranslate,
          node.restRotate,
          position,
          rotation,
          node.restTranslate,
        );

        // Shared with the live preview (applyDragPolicy is the single source
        // of truth), so the part lands exactly where the preview showed it.
        move = applyDragPolicy(move, { snap: state.snap, axisLock: state.axisLock });

        // A drag that ends where it started should not create a dead track —
        // nor an empty step. Bail BEFORE auto-creating an operation.
        const existing = state.activeOperationId
          ? sequence.operations
              .find((o) => o.id === state.activeOperationId)
              ?.tracks.find((t) => t.parts.includes(partId))
          : undefined;

        if (isIdentityMove(move) && !existing) return;

        // Auto-create a step rather than silently discarding the drag. The
        // gizmo is visible whenever a part is selected, so a user can drag
        // before ever clicking "+ Step"; that must do something sensible.
        let opId = state.activeOperationId;
        if (!opId) opId = get().addOperation() ?? null;
        if (!opId) return;

        checkpoint('Drag part');
        set((s) => {
          const op = findOp(s, opId);
          if (!op) return;
          const track = op.tracks.find((t) => t.parts.includes(partId));
          if (track) {
            track.to = move;
          } else {
            op.tracks.push({
              id: uid(),
              parts: [partId],
              from: IDENTITY_MOVE,
              to: move,
              start: 0,
              end: 1,
              easing: 'easeInOut',
            });
          }
        });

        // Park the playhead at this step's end state. Without it the part
        // snaps back to rest the instant you release the gizmo: a new track
        // runs IDENTITY -> dragged, and at time 0 the evaluator correctly
        // renders IDENTITY while the gizmo sits where you dropped it. You
        // author the end pose, so that is what the viewport should show.
        get().parkAtOperationEnd(opId);
      },

      commitGroupDrag: (partIds, gizmoStart, gizmoEnd, gizmoRotation) => {
        const state = get();
        const sequence = state.sequence;
        if (!sequence || !partIds.length) return;

        // Same reasoning as commitDrag: never discard a drag for want of a step.
        let opId = state.activeOperationId;
        if (!opId) opId = get().addOperation() ?? null;
        if (!opId) return;

        const parts = selectableParts(sequence.assembly, partIds);
        if (!parts.length) return;

        const op = get().sequence?.operations.find((o) => o.id === opId);
        // Reuse the track only if it drives EXACTLY this group, so dragging a
        // sub-assembly never silently rewrites an unrelated part's motion.
        const existing = op?.tracks.find(
          (t) =>
            t.parts.length === parts.length &&
            t.parts.every((p) => parts.includes(p)),
        );

        let move = groupMoveFromDrag(
          existing?.to ?? null,
          gizmoStart,
          gizmoEnd,
          gizmoRotation,
        );

        // Same shared policy as the live preview — see applyDragPolicy.
        move = applyDragPolicy(move, { snap: state.snap, axisLock: state.axisLock });

        if (isIdentityMove(move) && !existing) return;

        checkpoint('Drag group');
        set((s) => {
          const target = findOp(s, opId);
          if (!target) return;
          const track = target.tracks.find(
            (t) => t.parts.length === parts.length && t.parts.every((p) => parts.includes(p)),
          );
          if (track) {
            track.to = move;
          } else {
            target.tracks.push({
              id: uid(),
              parts,
              from: IDENTITY_MOVE,
              to: move,
              start: 0,
              end: 1,
              easing: 'easeInOut',
            });
          }
        });

        // See commitDrag: show the authored end state, not the rest pose.
        get().parkAtOperationEnd(opId);
      },

      selectSubassemblyOf: (partId, additive = false) =>
        set((s) => {
          if (!s.sequence) return;
          const node = s.sequence.assembly.parts[partId];
          if (!node) return;
          // Climb to the highest ancestor below the root, then take everything.
          const rootId = resolveSelectionTarget(s.sequence.assembly, partId) ?? partId;
          const ancestor = s.sequence.assembly.parts[rootId];
          const groupId = ancestor?.parentId ?? rootId;
          const ids = selectableParts(s.sequence.assembly, [groupId]);
          s.selection = additive
            ? Array.from(new Set([...s.selection, ...ids]))
            : ids;
        }),

      explodeSelection: (factor) => {
        const state = get();
        const sequence = state.sequence;
        const opId = state.activeOperationId;
        if (!sequence || !opId || !state.selection.length) return;

        const parts = selectableParts(sequence.assembly, state.selection);
        const center = centroidOf(sequence.assembly, parts);
        const moves = radialExplode(sequence.assembly, parts, center, factor);
        if (!moves.size) return;

        checkpoint('Explode selection');
        set((s) => {
          const op = findOp(s, opId);
          if (!op) return;
          for (const [id, move] of moves) {
            const track = op.tracks.find((t) => t.parts.includes(id));
            if (track) track.to = move;
            else
              op.tracks.push({
                id: uid(),
                parts: [id],
                from: IDENTITY_MOVE,
                to: move,
                start: 0,
                end: 1,
                easing: 'easeInOut',
              });
          }
        });
      },

      setTime: (t) =>
        set((s) => {
          const max = s.sequence ? totalDuration(s.sequence) : 0;
          s.time = Math.max(0, Math.min(t, max));
        }),

      play: () => set((s) => void (s.playing = true)),
      pause: () => set((s) => void (s.playing = false)),
      togglePlay: () => set((s) => void (s.playing = !s.playing)),
      setPlaybackRate: (r) => set((s) => void (s.playbackRate = r)),

      seekToOperation: (id) =>
        set((s) => {
          if (!s.sequence) return;
          let cursor = 0;
          for (const op of s.sequence.operations) {
            if (op.id === id) break;
            cursor += op.duration + op.dwell;
          }
          s.time = cursor;
          s.activeOperationId = id;
          s.playing = false;
        }),

      parkAtOperationEnd: (id) =>
        set((s) => {
          if (!s.sequence) return;
          let cursor = 0;
          for (const op of s.sequence.operations) {
            cursor += op.duration;
            if (op.id === id) break;
            cursor += op.dwell;
          }
          // Motion end, not step end: the dwell holds the same pose, and
          // landing on the boundary would read as the NEXT step's start.
          s.time = cursor;
          s.activeOperationId = id;
          s.playing = false;
        }),

      addOperation: (partial = {}) => {
        if (!get().sequence) return null;
        checkpoint('Add operation');
        const id = uid();
        set((s) => {
          const count = s.sequence!.operations.length;
          s.sequence!.operations.push({
            id,
            title: partial.title ?? `Step ${count + 1}`,
            description: '',
            duration: 1.5,
            dwell: 0.4,
            tracks: [],
            camera: null,
            annotations: [],
            styles: [],
            meta: {},
            ...partial,
          } as Operation);
          s.activeOperationId = id;
        });
        return id;
      },

      updateOperation: (id, patch) => {
        checkpoint('Edit operation');
        set((s) => {
          const op = findOp(s, id);
          if (op) Object.assign(op, patch);
        });
      },

      removeOperation: (id) => {
        checkpoint('Delete operation');
        set((s) => {
          if (!s.sequence) return;
          s.sequence.operations = s.sequence.operations.filter((o) => o.id !== id);
          if (s.activeOperationId === id) {
            s.activeOperationId = s.sequence.operations[0]?.id ?? null;
          }
        });
      },

      reorderOperation: (from, to) => {
        checkpoint('Reorder operations');
        set((s) => {
          if (!s.sequence) return;
          const ops = s.sequence.operations;
          if (from < 0 || from >= ops.length || to < 0 || to >= ops.length) return;
          const [moved] = ops.splice(from, 1);
          ops.splice(to, 0, moved);
        });
      },

      duplicateOperation: (id) => {
        checkpoint('Duplicate operation');
        set((s) => {
          if (!s.sequence) return;
          const i = s.sequence.operations.findIndex((o) => o.id === id);
          if (i < 0) return;
          const clone: Operation = JSON.parse(JSON.stringify(s.sequence.operations[i]));
          clone.id = uid();
          clone.title = `${clone.title} (copy)`;
          clone.tracks = clone.tracks.map((t) => ({ ...t, id: uid() }));
          clone.annotations = clone.annotations.map((a) => ({ ...a, id: uid() }));
          s.sequence.operations.splice(i + 1, 0, clone);
          s.activeOperationId = clone.id;
        });
      },

      setActiveOperation: (id) => set((s) => void (s.activeOperationId = id)),

      addTrack: (operationId, parts, to) => {
        if (!parts.length) return;
        checkpoint('Add motion');
        set((s) => {
          const op = findOp(s, operationId);
          if (!op) return;
          op.tracks.push({
            id: uid(),
            parts: [...parts],
            from: IDENTITY_MOVE,
            to: to ?? IDENTITY_MOVE,
            start: 0,
            end: 1,
            easing: 'easeInOut',
          });
        });
      },

      updateTrack: (operationId, trackId, patch) => {
        checkpoint('Edit motion');
        set((s) => {
          const track = findOp(s, operationId)?.tracks.find((t) => t.id === trackId);
          if (track) Object.assign(track, patch);
        });
      },

      removeTrack: (operationId, trackId) => {
        checkpoint('Delete motion');
        set((s) => {
          const op = findOp(s, operationId);
          if (op) op.tracks = op.tracks.filter((t) => t.id !== trackId);
        });
      },

      setOperationCamera: (operationId, pose) => {
        checkpoint('Set camera');
        set((s) => {
          const op = findOp(s, operationId);
          if (op) op.camera = pose;
        });
      },

      setHomeCamera: (pose) => {
        checkpoint('Set home camera');
        set((s) => {
          if (s.sequence) s.sequence.homeCamera = pose;
        });
      },

      addAnnotation: (operationId, a) => {
        checkpoint('Add annotation');
        set((s) => {
          const op = findOp(s, operationId);
          // Parse so schema defaults (leader, offset) are applied.
          if (op) op.annotations.push(AnnotationSchema.parse({ ...a, id: uid() }));
        });
      },

      updateAnnotation: (operationId, annotationId, patch) => {
        checkpoint('Edit annotation');
        set((s) => {
          const a = findOp(s, operationId)?.annotations.find((x) => x.id === annotationId);
          if (a) Object.assign(a, patch);
        });
      },

      removeAnnotation: (operationId, annotationId) => {
        checkpoint('Delete annotation');
        set((s) => {
          const op = findOp(s, operationId);
          if (op) op.annotations = op.annotations.filter((x) => x.id !== annotationId);
        });
      },

      setAnchorMode: (target) => set((s) => void (s.anchorMode = target)),

      setAnchorFromPick: (partId, kind, local, normal) => {
        const target = get().anchorMode;
        if (!target) return;

        checkpoint('Set callout anchor');
        set((s) => {
          const a = findOp(s, target.operationId)?.annotations.find(
            (x) => x.id === target.annotationId,
          );
          if (!a) return;
          a.anchor = { kind: 'part', partId, feature: { kind, local, normal } };
          // One-shot: disarm so the next click selects normally again.
          s.anchorMode = null;
        });
      },

      setStyle: (operationId, style) => {
        checkpoint('Set appearance');
        set((s) => {
          const op = findOp(s, operationId);
          if (!op) return;
          op.styles = op.styles.filter(
            (x) => !x.parts.some((p) => style.parts.includes(p)),
          );
          op.styles.push(style);
        });
      },

      undo: () =>
        set((s) => {
          const prev = s.past.pop();
          if (!prev || !s.sequence) return;
          s.future.push({ sequence: JSON.parse(JSON.stringify(s.sequence)), label: prev.label });
          s.sequence = prev.sequence;
        }),

      redo: () =>
        set((s) => {
          const next = s.future.pop();
          if (!next || !s.sequence) return;
          s.past.push({ sequence: JSON.parse(JSON.stringify(s.sequence)), label: next.label });
          s.sequence = next.sequence;
        }),
    };
  }),
);

// Expose the store for headless browser verification (scripts/smoke.mjs).
// Dev-only: production builds must not carry a global mutation handle.
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as { __store: typeof useStore }).__store = useStore;
}
