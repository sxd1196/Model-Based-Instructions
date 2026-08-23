# Architecture

## The one idea

The timeline is a **pure function**, not an animation engine.

```
resolveFrame(sequence, time) → { poses, styles, camera, annotations }
```

Same inputs, same output, always. No hidden state, no accumulated drift, no
`.play()` / `.pause()` on a library object that owns the truth.

Everything else falls out of this:

- **Scrubbing** is just calling it with a different `t`. No rewind logic.
- **Undo** is swapping the document. The frame follows automatically.
- **Video export** replays the same function at fixed timesteps — identical output
  to the interactive view, by construction.
- **Testing** runs in plain node with no WebGL (`src/cad/pipeline.test.ts`).
- **A future auto-planner** can search over sequences headlessly.

This is why there is no GSAP or tween.js. Those libraries mutate objects over
wall-clock time — the opposite of what we need. Interpolation is ~30 lines
(`domain/easing.ts`), and owning it keeps the evaluator pure.

## Layers

```
ui/         React panels. Presentation only.
   ↓
state/      Zustand. Authoring state: document, selection, playhead.
   ↓
domain/     Schema + evaluator. Pure. No three.js, no React, no DOM.

viewer/     three.js. Reads the evaluated frame, writes to the scene graph.
cad/        Geometry loading, tree extraction, export validation.
io/         Serialization: project JSON, HTML instructions, WebM capture.
```

`domain/` sits at the bottom and imports nothing. That constraint is the reason the
rest of the design holds together — see AGENTS.md §2.

## Decisions and the reasons behind them

### Moves are deltas, not absolute poses

A `Move` is an offset from the part's rest pose as it came from the CAD.

The alternative — storing absolute world positions — is what makes Composer projects
rot. Revise the model, a part's origin shifts 3mm, and every authored view is subtly
wrong with no indication. With deltas, "the cover lifts 90mm in +Z" stays true
regardless of where the cover now sits.

Cost: you cannot author by dragging a part to an absolute point and recording it.
You author by expressing intent. That is the right trade for a tool meant to survive
engineering change.

### Operations accumulate

`resolveFrame` bakes every operation *before* the current one at its final state,
then applies the live operation partially.

Without this, scrubbing to step 9 shows a part that was removed in step 2 back in
place. With it, any point on the timeline is reachable in O(steps) with no replay.

### Camera walks backward

An operation with `camera: null` holds the previous authored shot. Resolution scans
backward to find it, falling back to `homeCamera`.

The naive alternative — snapping to a default when unset — forces you to re-author
the camera on every step just to keep it still.

### The camera is only driven during playback

`CameraBinder` returns early when paused. While authoring you own the camera; if the
evaluator drove it every frame, orbiting to inspect a part would fight the timeline.

### Gizmo drags invert the pose composition

`moveFromDrag` in `domain/authoring.ts` is the exact algebraic inverse of
`composePartTransform`. The gizmo reports a world pose; the schema stores a
delta from rest. Getting that inverse even slightly wrong means every drag
introduces error that compounds across a sequence, so it is tested as a
round-trip property over five transform cases plus a 50-drag chain.

### The gizmo drives a proxy object, not the mesh

`SceneBinder` rewrites every part's transform each frame from the evaluated
timeline. A gizmo attached directly to geometry would fight it — the part would
snap back mid-drag. Instead `DragGizmo` attaches to a free-floating proxy
`Object3D`, parks it on the selection, and commits the proxy's pose on mouseUp.

### Picking climbs to a meaningful unit

Clicking a bolt head selects the whole bolt, not the head mesh. Authoring a
500-part teardown by clicking 3000 sub-meshes is not a workflow. The climb stops
below the root container so a single click can never select the entire assembly;
alt-click takes the literal mesh when you really do need it.

### Picking is bound to pointerup with a movement threshold

Anything beyond ~4px of pointer travel is treated as a camera orbit, not a
click. Selection changing every time you rotate the view is maddening during
authoring.

### Axis lock and snapping default ON

Most assembly motions are pure axial pulls — a bolt comes straight out, a cover
lifts straight up. Free 3D dragging essentially never produces a clean axis, and
`24.9873mm` reads as sloppy in a work instruction. Both are defeatable in the
toolbar, but the common case should be correct without thinking about it.

### Group drags compose in affine form, not Move form

A `Move` is stored as "rotate about pivot, then translate" — good for expressing
authoring intent, awkward to compose. `domain/rigid.ts` converts to plain affine
form (`x -> R*x + d`), composes there in two lines, and converts back.

This is what lets a multi-part drag produce **one shared Move on one track**
rather than N independent tracks. `Track.parts` being a list is the schema
already anticipating this.

The load-bearing property is rigidity: after a group drag, all pairwise
distances and relative orientations must be unchanged. Tested directly, and
again across 20 chained drags, because a sub-assembly that visibly deforms while
you drag it reads as a physics glitch rather than a math error.

### Snap and axis lock are skipped for rotating group drags

Quantizing the translation of a rotated rigid transform breaks the rigidity
guarantee — the parts would shear apart. Both are applied only when the drag is
a pure translation.

### The group gizmo sits at the selection centroid

Parking it on one arbitrary member makes a group drag feel like dragging that
part and having the others follow. The centroid reads as grabbing the whole
thing. The proxy's orientation resets after each group commit so the next drag
composes from a clean handle rather than accumulating gizmo rotation.

### Part-anchored callouts resolve the animated position

`partPositionAt` recomputes a part's current position from its rest pose plus
the evaluated Move, so a label sticks to its part through the whole animation —
including displacement accumulated in earlier operations. Previously these
rendered at the origin.

The annotation layer redraws on a `requestAnimationFrame` tick rather than
per-frame React state, which would violate the no-setState-in-useFrame rule.

### Quaternion double-cover

`slerpQuat` flips the sign of one input when their dot product is negative. `q`
and `-q` represent the same rotation, but naive interpolation between them
travels the long way around — a 359° spin instead of 1°. This is the classic CAD
animation artifact and the fix is three lines.

Nearly-parallel quaternions fall back to normalized lerp to avoid dividing by
`sin(θ) ≈ 0`.

### Pivot is not interpolated

`lerpMove` takes the source pivot rather than interpolating it. A pivot defines a
frame of reference, not an animated quantity — interpolating it makes the rotation
axis drift mid-motion, which looks like a physics glitch.

### Flat part map, not a nested tree

`Assembly.parts` is `Record<id, PartNode>` with `parentId`, not nested children.

With hundreds of parts, nested arrays make every store update a deep clone. Flat
maps keep pose lookup, selection, and styling O(1). The tree UI reconstructs
hierarchy once, memoized.

### Ids are deduplicated at load

CAD exports repeat names constantly — eight instances of `Bolt_M8` is normal. The
loader assigns unique ids with a `__n` suffix on collision.

Consequence: **unnamed geometry gets synthetic ids that change on re-export**, which
breaks saved sequences. The loader warns about this loudly.

### The merged-mesh guard

The single most dangerous failure mode: an exporter that flattens the assembly into
one mesh. Individual parts become unmovable and the whole app is useless — but
nothing *looks* broken until you try to author a motion.

`loadGltf.ts` detects it at load (one mesh + >5000 triangles) and says so in plain
language with the fix. Never weaken this check.

### No allocation in the frame loop

`SceneBinder` reuses module-level `THREE.Vector3` / `Quaternion` scratch objects.
At 500 parts × 60fps, per-frame allocation is thousands of objects a second and the
GC pauses are visible. Parts with no authored move take a cheap early-out.

### Store holds authoring state only

The Zustand store never holds derived render state. Poses come from `resolveFrame`
on demand. Stores that accumulate derived data become the dumping ground every
feature writes into, and then nobody can tell what is source of truth.

### HTML export, not PDF

`exportInstructionsHtml` emits a print-styled HTML document. Browsers print to PDF
perfectly, and this avoids a heavyweight PDF dependency for zero real benefit.

### WebM via MediaRecorder

Video capture uses the browser's built-in `MediaRecorder` on the canvas stream. No
ffmpeg, no server, no dependency. Output is WebM.

## Direct manipulation (2026-08-23: combined gizmo + live preview)

The drag widget is drei's `PivotControls` — translate arrows and rotate rings
in ONE widget, no mode state. ~~The original `TransformControls` needed a
LOOK/MOVE/ROTATE toolbar because it renders one personality at a time.~~
Replaced: the mode buttons were the app's biggest discoverability failure
(a user could not find rotation at all).

Three rules keep every part-tracking visual honest, each learned from a
shipped bug:

1. **Anything that follows a part must re-sync EVERY FRAME.** SceneBinder
   rewrites part transforms per frame, so a gizmo handle, selection outline
   (`BoxHelper.update()`), or callout positioned once at selection time is
   stranded by the next commit, scrub, or undo. Three separate bugs shipped
   from this one mistake before the rule was written down.

2. **Drags preview live through `viewer/dragPreview.ts`.** During a drag the
   provisional Move overrides the evaluated frame for the dragged parts inside
   SceneBinder's `applyPoses`, so the geometry follows the mouse in real time.
   It is a mutable module singleton, NOT React state (per-frame setState is
   banned, AGENTS.md §7) and NOT the store (a drag would flood undo). On
   release the same Move commits through the store normally.

3. **Preview and commit share one code path** — `applyDragPolicy` /
   `effectiveDragMove` in `domain/authoring.ts`. Snap and axis lock shape the
   preview identically to the commit, so the part lands exactly where the
   user watched it go. If these diverge the part jumps on release; a
   regression test pins them equal.

## Motion lanes (2026-08-23)

The bottom bar owns everything TEMPORAL; the Inspector owns what the step
SAYS (title, instruction, camera, appearance, callouts). The boundary rule:
a step is one work-instruction card — one image, one instruction, one camera
— and its choreography (N motions) lives in lanes under the chip strip.

- `domain/lanes.ts` is the pure layer: axis+angle <-> quaternion (near-
  cardinal display snap ~1°), track->lane merging (identical motion+timing
  collapses cluster tracks into one lane), the "↑ Z 120mm · ⟳ Z 90°"
  sentence, fraction<->seconds, and magnetic edge snap.
- Timing DISPLAYS in seconds but is STORED as fractions of the step, so
  stretching a step's duration stretches its choreography proportionally.
- Easing is deliberately absent from the UI (defaults easeInOut, still in
  the schema).
- Multiple tracks on one part CHAIN in the evaluator (see chaining.test.ts):
  leg i runs from leg i-1's `to`; stored `from` seeds only the first leg.
  Editing an earlier leg re-bases later ones by construction.
- `addMotionForSelection` is the typed-entry path: + Motion appends an
  identity lane at the step tail; when the step is full it SPLITS existing
  lanes for that part-set into equal windows (n motions = n windows).

## Callouts and the instruction note (2026-08-23, schema v4)

THE INSTRUCTION IS THE NOTE. The old separate 'screen note' annotation type
is gone (v4 migration folds saved ones into their step's instruction). The
instruction renders in a viewport corner (noteCorner per step), supports
rich text (descriptionRich), and appears in the exported doc. Empty
instructions render nothing.

CALLOUT PLACEMENT is a guided two-phase flow driven by anchorMode.phase:
'pick' (click a vertex/edge/face — feature snap) then 'pull' (the note rides
the cursor on a camera-facing plane through the anchor; a click drops it and
stores labelOffset). An on-screen guide window narrates each phase; Esc
cancels. labelOffset is a WORLD-SPACE mm vector — the label is a scene
object at a real distance from the part, so it orbits with the camera and
follows the animated part. The leader line is a true anchor-to-label segment.

RICH TEXT IS RANGE-AWARE: toggleMarkInRange/setColorInRange in
domain/richtext.ts split spans at textarea selection offsets (newline = 1
char). A collapsed selection formats the whole label. RichTextEditor.tsx is
the one shared editing surface (instruction + callouts).

## Lane membership + popped-out viewport (2026-08-23)

Lane expansion now lists EVERY member part as a chip: click a name to select
that exact part in the viewport (raw select, not pickPart — the chip means
that part, not its selection unit), ✕ removes it from the lane (empty tracks
are deleted), and '⟳ move again' chains a new motion for the lane's own
parts without needing a viewport selection. When the step is full, adding
compresses windows PER LANE (per timing-group), never per track — per-track
windows shattered a merged 9-track lane into a stagger (regression-tested).

'Pop out 3D' moves the viewport <main> into a child window via a React
portal into window.open (usePopout.tsx). Same JS context: the store, scene,
and handlers keep working with no message passing; the WebGL context
survives because React never unmounts the subtree. The main window becomes
tree | expanded timeline/lanes | inspector at full width. Stylesheets are
cloned into the child head; closing either window re-docks cleanly.

## Known limitations

- ~~**Selection highlight uses `BoxHelper`**, not a true outline pass. Cheap and~~
  Replaced 2026-08-23: selection now TINTS the part amber (material swap in
  SceneBinder, same mechanism as ghost/highlight styles). One less per-frame
  helper to keep in sync, and unambiguous on instanced parts where a
  wireframe box was easy to mis-attribute. Selection wins over ghost, never
  over hidden.
  robust; a postprocessing outline would look better.
- **Rotation has no numeric UI.** The gizmo rotates and the schema/evaluator
  fully support rotation about a pivot, but the Inspector exposes only
  translation fields. Precise rotations require editing project JSON.
- **Opening a saved project does not reload geometry.** Model files are
  referenced by name, not embedded. Re-open the `.glb` after loading a project.
- **Group drags always pivot about the gizmo handle.** There is no UI to pick a
  different pivot for a group, though the schema stores one per Move.
- **No collision detection.** Deliberate — see AGENTS.md §9.
