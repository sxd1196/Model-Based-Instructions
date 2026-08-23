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
  applyDragPolicy,
  clusterByParentFrame,
  effectiveDragMove,
  parentWorldTransform,
  radialExplode,
  resolveSelectionTarget,
  selectableParts,
} from '@/domain/authoring';
import { clusterMoveFromDrag } from '@/domain/rigid';

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
  anchorMode: { operationId: string; annotationId: string; phase: 'pick' | 'pull' } | null;
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
  /** Patch every track in a merged lane at once (timing edits move together). */
  updateLaneTracks: (operationId: string, trackIds: string[], patch: Partial<Track>) => void;
  removeLaneTracks: (operationId: string, trackIds: string[]) => void;
  /** Typed-entry path: add an identity motion for the selection at the step tail. */
  addMotionForSelection: (operationId: string) => void;
  /** Same, for an explicit part set — the per-lane "move again" button. */
  addMotionForParts: (operationId: string, partIds: string[]) => void;
  /** Drop one part from a lane; empty tracks are deleted. */
  removePartFromLane: (operationId: string, trackIds: string[], partId: string) => void;
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
  /** Phase-2 drop of the pulled note: world offset (mm) from the anchor. */
  setLabelOffsetFromPull: (offset: Vec3) => void;
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

        // effectiveDragMove: world pose -> parent frame -> inverse pose
        // composition pivoted at rest, shaped by snap/axis-lock policy.
        // Shared with the live preview, so the part lands exactly where the
        // preview showed it. The parent frame matters for nested parts —
        // without it a drag on a part inside an offset sub-assembly lands
        // displaced by the parent's own offset.
        const move: Move = effectiveDragMove(
          node.restTranslate,
          node.restRotate,
          position,
          rotation,
          { snap: state.snap, axisLock: state.axisLock },
          parentWorldTransform(sequence.assembly, partId),
        );

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

        const parts = selectableParts(sequence.assembly, partIds);
        if (!parts.length) return;

        // Bail on a no-op BEFORE auto-creating a step: PivotControls fires a
        // dragEnd even for a plain click on the widget, and an identity drag
        // must not litter the timeline with empty operations. (Same ordering
        // bug as commitDrag once had — the empty-op check lives up here on
        // purpose.)
        const opIdForLookup = state.activeOperationId;
        const opForLookup = opIdForLookup
          ? sequence.operations.find((o) => o.id === opIdForLookup)
          : undefined;

        // ONE TRACK PER PARENT CLUSTER. The gizmo yields one WORLD transform,
        // but a Move is applied in each part's PARENT frame. Feeding the
        // world transform to every part is only correct when all parents sit
        // at the world origin — rotating SUB_Cover scattered its bolt circle
        // because each bolt group spun about its own offset origin.
        const clusters = clusterByParentFrame(sequence.assembly, parts);
        const policy = { snap: state.snap, axisLock: state.axisLock };

        const updates: Array<{ parts: string[]; move: Move }> = [];
        for (const cluster of clusters) {
          const existing = opForLookup?.tracks.find(
            (t) =>
              t.parts.length === cluster.parts.length &&
              t.parts.every((p) => cluster.parts.includes(p)),
          );
          const move = applyDragPolicy(
            clusterMoveFromDrag(
              existing?.to ?? null,
              cluster.frame,
              gizmoStart,
              gizmoEnd,
              gizmoRotation,
            ),
            policy,
          );
          if (!isIdentityMove(move) || existing) {
            updates.push({ parts: cluster.parts, move });
          }
        }
        if (!updates.length) return;

        // Real motion confirmed — NOW auto-create a step if none is active.
        // (Never discard a drag for want of a step; see commitDrag.)
        let opId = state.activeOperationId;
        if (!opId) opId = get().addOperation() ?? null;
        if (!opId) return;

        checkpoint('Drag group');
        set((s) => {
          const target = findOp(s, opId);
          if (!target) return;
          for (const u of updates) {
            const track = target.tracks.find(
              (t) =>
                t.parts.length === u.parts.length &&
                t.parts.every((p) => u.parts.includes(p)),
            );
            if (track) {
              track.to = u.move;
            } else {
              target.tracks.push({
                id: uid(),
                parts: u.parts,
                from: IDENTITY_MOVE,
                to: u.move,
                start: 0,
                end: 1,
                easing: 'easeInOut',
              });
            }
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

      /**
       * Patch every track in a merged LANE at once. A sub-assembly drag is
       * one visual lane over several cluster tracks; editing its timing must
       * move them together or the lane silently splits.
       */
      updateLaneTracks: (operationId, trackIds, patch) => {
        checkpoint('Edit motion');
        set((s) => {
          const op = findOp(s, operationId);
          if (!op) return;
          for (const t of op.tracks) {
            if (trackIds.includes(t.id)) Object.assign(t, patch);
          }
        });
      },

      removeLaneTracks: (operationId, trackIds) => {
        checkpoint('Delete motion');
        set((s) => {
          const op = findOp(s, operationId);
          if (op) op.tracks = op.tracks.filter((t) => !trackIds.includes(t.id));
        });
      },

      /**
       * Drop ONE part out of a lane (its cluster track). The remaining parts
       * keep the motion; a track left empty is deleted. This is how the lane
       * membership list edits "18 parts" down to the 17 you actually meant.
       */
      removePartFromLane: (operationId, trackIds, partId) => {
        checkpoint('Edit motion parts');
        set((s) => {
          const op = findOp(s, operationId);
          if (!op) return;
          for (const t of op.tracks) {
            if (trackIds.includes(t.id)) {
              t.parts = t.parts.filter((p) => p !== partId);
            }
          }
          op.tracks = op.tracks.filter(
            (t) => !trackIds.includes(t.id) || t.parts.length > 0,
          );
        });
      },

      /**
       * Add a typed motion for the selection: one track per parent cluster
       * (same shape a gizmo drag commits), defaulting to the tail of the
       * step so consecutive adds chain naturally.
       */
      addMotionForSelection: (operationId) => {
        get().addMotionForParts(operationId, get().selection);
      },

      addMotionForParts: (operationId, partIds) => {
        const st = get();
        const sequence = st.sequence;
        if (!sequence || !partIds.length) return;

        const parts = selectableParts(sequence.assembly, partIds);
        if (!parts.length) return;

        // Start where this part-set's last lane ends, so a second motion on
        // the same parts begins as "then" rather than overlapping. When the
        // last lane fills the whole step (the default), SPLIT the step:
        // earlier lanes compress to make room and the new one takes the
        // tail. n motions -> n equal windows, which is the choreography an
        // author means by "add another motion".
        const op = sequence.operations.find((o) => o.id === operationId);
        const overlapping = op
          ? op.tracks.filter((t) => t.parts.some((p) => parts.includes(p)))
          : [];
        let start = 0;
        let compress: Map<string, [number, number]> | null = null;

        if (overlapping.length) {
          const tailEnd = Math.max(...overlapping.map((t) => t.end));
          if (tailEnd < 0.98) {
            start = tailEnd;
          } else {
            // Recompute into equal windows — but per LANE, not per track. A
            // merged lane is several cluster tracks sharing one timing
            // window; giving each track its own window would shatter the
            // lane into a stagger the author never wrote.
            const windowKey = (t: Track) => `${t.start.toFixed(6)}:${t.end.toFixed(6)}`;
            const laneKeys = [...new Set(overlapping.map(windowKey))].sort(
              (a, b) => parseFloat(a) - parseFloat(b),
            );
            const n = laneKeys.length + 1;
            compress = new Map();
            for (const t of overlapping) {
              const i = laneKeys.indexOf(windowKey(t));
              compress.set(t.id, [i / n, (i + 1) / n]);
            }
            start = (n - 1) / n;
          }
        }

        checkpoint('Add motion');
        set((s) => {
          const target = findOp(s, operationId);
          if (!target) return;
          if (compress) {
            for (const t of target.tracks) {
              const win = compress.get(t.id);
              if (win) {
                t.start = win[0];
                t.end = win[1];
              }
            }
          }
          for (const cluster of clusterByParentFrame(sequence.assembly, parts)) {
            target.tracks.push({
              id: uid(),
              parts: cluster.parts,
              from: IDENTITY_MOVE,
              to: IDENTITY_MOVE,
              start,
              end: 1,
              easing: 'easeInOut',
            });
          }
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

      setAnchorMode: (target) =>
        set((s) => {
          s.anchorMode = target ? { ...target, phase: 'pick' } : null;
        }),

      setAnchorFromPick: (partId, kind, local, normal) => {
        const target = get().anchorMode;
        if (!target || target.phase !== 'pick') return;

        checkpoint('Set callout anchor');
        set((s) => {
          const a = findOp(s, target.operationId)?.annotations.find(
            (x) => x.id === target.annotationId,
          );
          if (!a) return;
          a.anchor = { kind: 'part', partId, feature: { kind, local, normal } };
          // Phase 2: the note follows the cursor in 3D until the next click
          // drops it — that click sets labelOffset (world mm from anchor).
          s.anchorMode = { ...target, phase: 'pull' };
        });
      },

      /** Phase-2 drop: world-space offset from the anchor to the label. */
      setLabelOffsetFromPull: (offset) => {
        const target = get().anchorMode;
        if (!target || target.phase !== 'pull') return;

        checkpoint('Place callout label');
        set((s) => {
          const a = findOp(s, target.operationId)?.annotations.find(
            (x) => x.id === target.annotationId,
          );
          if (a) a.labelOffset = offset;
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
