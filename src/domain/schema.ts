/**
 * The canonical data model. Everything else in the app is a projection of this.
 *
 * Design rule: this file has ZERO imports from three.js, react, or any renderer.
 * A sequence must be fully meaningful as JSON on disk with no viewer present.
 */
import { z } from 'zod';

/** Millimetres. CAD is authored in mm; we never silently convert. */
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

/** Quaternion, XYZW order (three.js convention). */
export const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Quat = z.infer<typeof Quat>;

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
export const ZERO_VEC: Vec3 = [0, 0, 0];

export const Easing = z.enum([
  'linear',
  'easeInOut',
  'easeIn',
  'easeOut',
  'step', // no interpolation: hold, then snap at the end
]);
export type Easing = z.infer<typeof Easing>;

/**
 * A Move is a delta applied to a part's REST pose, not an absolute position.
 *
 * This is the single most important decision in the schema. Deltas mean that
 * when the CAD is revised and a part's rest pose shifts by 3mm, every authored
 * animation still reads correctly instead of snapping the part back to a stale
 * absolute coordinate. Absolute poses are what make Composer projects rot.
 */
export const Move = z.object({
  /** Offset from rest pose, in mm, in the part's parent frame. */
  translate: Vec3.default(ZERO_VEC),
  /** Rotation applied about `pivot`, relative to rest orientation. */
  rotate: Quat.default(IDENTITY_QUAT),
  /** Pivot for rotation, in parent frame. Defaults to part origin. */
  pivot: Vec3.default(ZERO_VEC),
});
export type Move = z.infer<typeof Move>;

export const IDENTITY_MOVE: Move = {
  translate: ZERO_VEC,
  rotate: IDENTITY_QUAT,
  pivot: ZERO_VEC,
};

/**
 * A Track animates one set of parts within a single Operation.
 *
 * `from`/`to` are both Moves. Most tracks go IDENTITY -> somewhere (disassembly)
 * or somewhere -> IDENTITY (assembly). Keeping both explicit means an operation
 * is reversible by swapping them, which is how assembly/disassembly duality works.
 */
export const Track = z.object({
  id: z.string(),
  /** Part IDs this track drives. Multiple parts move rigidly together. */
  parts: z.array(z.string()).min(1),
  from: Move.default(IDENTITY_MOVE),
  to: Move.default(IDENTITY_MOVE),
  /** Normalized [0,1] window within the parent operation. */
  start: z.number().min(0).max(1).default(0),
  end: z.number().min(0).max(1).default(1),
  easing: Easing.default('easeInOut'),
});
export type Track = z.infer<typeof Track>;

/** A saved camera pose. Stored as numbers so playback is a pure tween. */
export const CameraPose = z.object({
  position: Vec3,
  target: Vec3,
  /** Vertical FOV in degrees. */
  fov: z.number().default(45),
});
export type CameraPose = z.infer<typeof CameraPose>;

/**
 * Rich text as STRUCTURED DATA, never raw HTML.
 *
 * Storing HTML in a project file would mean either an injection hole in the
 * exported work instructions or a sanitizer dependency. A closed set of marks
 * covers what CAD annotation actually needs — Ø25, 12 N·m, M8x1.25 — and is
 * safe by construction because the renderer only ever emits known tags.
 */
export const TextMark = z.enum(['bold', 'italic', 'underline', 'sup', 'sub', 'code']);
export type TextMark = z.infer<typeof TextMark>;

export const TextSpan = z.object({
  text: z.string(),
  marks: z.array(TextMark).default([]),
  /** CSS colour. Restricted to hex at parse time so it cannot smuggle url(). */
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
});
export type TextSpan = z.infer<typeof TextSpan>;

/** A paragraph is a run of spans; the array of paragraphs is the document. */
export const RichText = z.array(z.array(TextSpan));
export type RichText = z.infer<typeof RichText>;

/** Plain string -> RichText, for migrating v1 callouts. */
export function plainToRich(text: string): RichText {
  return text.split('\n').map((line) => (line ? [{ text: line, marks: [] }] : []));
}

/** RichText -> plain string, for exports and accessibility labels. */
export function richToPlain(rich: RichText): string {
  return rich.map((para) => para.map((s) => s.text).join('')).join('\n');
}

/**
 * Where on a part a callout's leader line attaches.
 *
 * Stored in the part's LOCAL frame so the anchor stays welded to the feature
 * as the part animates away. A world-space point would drift immediately.
 */
export const FeatureAnchor = z.object({
  kind: z.enum(['vertex', 'edge', 'face', 'origin']),
  /** Local-frame position on the part. */
  local: Vec3,
  /** Surface normal where known; used to offset the label off the material. */
  normal: Vec3.optional(),
});
export type FeatureAnchor = z.infer<typeof FeatureAnchor>;

/** An HTML callout pinned to a part or a fixed world point. */
export const Annotation = z.object({
  id: z.string(),
  text: z.string(),
  /** Formatted text. When absent, `text` is rendered plain. */
  rich: RichText.optional(),
  /** Anchor to a part so the label follows it, or to a world point. */
  anchor: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('part'),
      partId: z.string(),
      /** Attach point on the part. Omitted means the part origin. */
      feature: FeatureAnchor.optional(),
    }),
    z.object({ kind: z.literal('world'), point: Vec3 }),
  ]),
  /** Screen-space nudge in px so labels don't sit on top of the geometry. */
  offset: z.tuple([z.number(), z.number()]).default([12, -12]),
  /** Draw a line from the anchor to the label. */
  leader: z.boolean().default(true),
});
export type Annotation = z.infer<typeof Annotation>;
/** What a caller must supply to create an annotation; defaults fill the rest. */
export type AnnotationInput = z.input<typeof Annotation>;

/**
 * Visibility / appearance overrides that apply for the duration of an operation.
 * Used for ghosting context parts and hiding fixtures.
 */
export const PartStyle = z.object({
  parts: z.array(z.string()),
  mode: z.enum(['normal', 'ghost', 'hidden', 'highlight']),
});
export type PartStyle = z.infer<typeof PartStyle>;

/**
 * An Operation is one instruction step — the unit a shop-floor operator sees.
 * This is deliberately the same granularity as a Bill of Process line item,
 * so the model can export to a BOP later without restructuring.
 */
export const Operation = z.object({
  id: z.string(),
  title: z.string().default('Untitled operation'),
  description: z.string().default(''),
  /** Seconds. Real duration of the animation, not the shop-floor cycle time. */
  duration: z.number().positive().default(1.5),
  /** Seconds of held still-frame after the motion, for readability. */
  dwell: z.number().min(0).default(0.4),
  tracks: z.array(Track).default([]),
  /** Camera flies to this pose over the operation. Null = hold previous. */
  camera: CameraPose.nullable().default(null),
  annotations: z.array(Annotation).default([]),
  styles: z.array(PartStyle).default([]),
  /** Free-form, for later BOP/MBOM export: torque specs, tool IDs, part qty. */
  meta: z.record(z.string(), z.string()).default({}),
});
export type Operation = z.infer<typeof Operation>;

/**
 * One node of the CAD assembly tree, flattened.
 *
 * Flat + parentId (rather than nested children) is intentional: hundreds of
 * parts with nested arrays make every store update a deep clone. Flat maps
 * keep selection, styling, and pose lookup O(1).
 */
export const PartNode = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  /** True for assembly containers that carry no geometry of their own. */
  isGroup: z.boolean().default(false),
  /** Rest pose relative to parent, straight from the CAD. */
  restTranslate: Vec3.default(ZERO_VEC),
  restRotate: Quat.default(IDENTITY_QUAT),
});
export type PartNode = z.infer<typeof PartNode>;

export const Assembly = z.object({
  id: z.string(),
  name: z.string(),
  /** Source file this was converted from, for provenance. */
  sourceFile: z.string().default(''),
  /** Path to the glTF, relative to the project file. */
  modelUrl: z.string(),
  /** partId -> node. Keys must match glTF object names exactly. */
  parts: z.record(z.string(), PartNode),
});
export type Assembly = z.infer<typeof Assembly>;

/**
 * Schema version history:
 *   1 — initial
 *   2 — Annotation gains `rich` (structured formatting), `leader`, and an
 *       optional per-part `feature` attach point for leader lines.
 *       v1 files migrate cleanly: plain `text` is preserved verbatim and
 *       leaders default on.
 */
export const SCHEMA_VERSION = 2;

export const Sequence = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: z.string(),
  name: z.string().default('Untitled sequence'),
  /** 'assembly' plays operations forward; 'disassembly' is authored in reverse. */
  intent: z.enum(['assembly', 'disassembly']).default('disassembly'),
  assembly: Assembly,
  operations: z.array(Operation).default([]),
  /** Pose used on load and when nothing else is specified. */
  homeCamera: CameraPose.nullable().default(null),
  units: z.literal('mm').default('mm'),
});
export type Sequence = z.infer<typeof Sequence>;

/**
 * Bring an older document up to the current schema.
 *
 * Runs BEFORE validation, so it works on raw JSON. Keep each step small and
 * additive; saved projects must keep opening (AGENTS.md §2.7).
 */
export function migrate(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const doc = { ...(raw as Record<string, unknown>) };
  const version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 1;

  // v1 -> v2: annotations gain rich/leader/feature. Nothing to rewrite —
  // the new fields are optional or defaulted — but stamp the version so the
  // literal check passes.
  if (version < 2) {
    doc.schemaVersion = 2;
  }

  return doc;
}

/** Parse + migrate an unknown blob into a valid Sequence, or throw. */
export function parseSequence(raw: unknown): Sequence {
  return Sequence.parse(migrate(raw));
}
