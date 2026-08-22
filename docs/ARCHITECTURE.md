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

### Quaternion double-cover

`slerpQuat` flips the sign of one input when their dot product is negative. `q` and
`-q` represent the same rotation, but naive interpolation between them travels the
long way around — a 359° spin instead of 1°. This is the classic CAD animation
artifact and the fix is three lines.

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

## Known limitations

- **Part-anchored annotations render at the origin.** The anchor is stored correctly
  in the schema; the viewer does not yet resolve part position for `kind: 'part'`.
  World-anchored callouts work.
- **Selection highlight uses `BoxHelper`**, not a true outline pass. Cheap and
  robust; a postprocessing outline would look better.
- **Rotation authoring has no UI.** The schema and evaluator fully support rotation
  about a pivot; the Inspector only exposes translation. Rotations can be authored by
  editing project JSON.
- **Opening a saved project does not reload geometry.** Model files are referenced by
  name, not embedded. Re-open the `.glb` after loading a project.
- **No collision detection.** Deliberate — see AGENTS.md §9.
