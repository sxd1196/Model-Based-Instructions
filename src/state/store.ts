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
  Assembly,
  CameraPose,
  Move,
  Operation,
  PartStyle,
  Sequence,
  Track,
} from '@/domain/schema';
import {
  IDENTITY_MOVE,
  SCHEMA_VERSION,
  parseSequence,
} from '@/domain/schema';
import { totalDuration } from '@/domain/evaluate';

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
}

interface Actions {
  loadSequence: (s: Sequence) => void;
  loadFromJson: (raw: unknown) => void;
  newFromAssembly: (a: Assembly, warnings?: string[]) => void;
  setWarnings: (w: string[]) => void;
  setLoading: (v: boolean) => void;

  select: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;

  setTime: (t: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setPlaybackRate: (r: number) => void;
  seekToOperation: (id: string) => void;

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
  addAnnotation: (operationId: string, a: Omit<Annotation, 'id'>) => void;
  removeAnnotation: (operationId: string, annotationId: string) => void;
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

      setWarnings: (w) => set((s) => void (s.warnings = w)),
      setLoading: (v) => set((s) => void (s.loading = v)),

      select: (ids, additive = false) =>
        set((s) => {
          s.selection = additive
            ? Array.from(new Set([...s.selection, ...ids]))
            : ids;
        }),

      clearSelection: () => set((s) => void (s.selection = [])),

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
          if (op) op.annotations.push({ ...a, id: uid() });
        });
      },

      removeAnnotation: (operationId, annotationId) => {
        checkpoint('Delete annotation');
        set((s) => {
          const op = findOp(s, operationId);
          if (op) op.annotations = op.annotations.filter((x) => x.id !== annotationId);
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
