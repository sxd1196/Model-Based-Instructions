# Roadmap

Ordered by what unblocks the most. Things below the line are deliberately deferred —
that is a decision, not an oversight.

## Now — finish manual authoring

The bar: author a complete teardown of a real 200+ part assembly without touching JSON.

- [x] **Click-to-select in the viewport** — raycast picking, climbs to a
      meaningful unit, shift adds, alt takes the exact mesh
- [x] **Drag-to-author** — TransformControls gizmo on a proxy object; the drag is
      inverted back into a schema Move, with snap and axis lock
- [x] **Auto-explode helper** — radial explode from the selection centroid as a
      starting point, then hand-edit
- [ ] **Rotation UI in the Inspector** — the gizmo can rotate, but there is no
      numeric axis/angle/pivot entry
- [ ] **Multi-part gizmo** — dragging needs exactly one selected part today;
      moving a sub-assembly rigidly needs a shared frame and a group commit
- [ ] **Part-anchored callouts** — schema is right, viewer renders them at origin
- [ ] **Embed geometry in project files** — opening a project should not require
      re-opening the `.glb`

## Next — output quality

- [ ] Screenshots per step in the exported HTML (offscreen render at each step's end)
- [ ] MP4 alongside WebM (WebCodecs, still no ffmpeg)
- [ ] Standalone viewer export — single HTML file, playback only, no editor
- [ ] Print stylesheet tuning for shop-floor paper

## Later — scale and structure

- [ ] STEP directly in-browser via `occt-import-js` (already a dependency)
- [ ] Instanced rendering for repeated fasteners
- [ ] LOD for very large assemblies
- [ ] BOM panel driven by `Operation.meta`
- [ ] MBOM / Bill of Process export — the format is already compatible

---

## Deferred deliberately

**Automatic sequence planning.** The interesting problem, and the wrong thing to
build first. A planner that proposes bad sequences into a tool with no good manual
editor is worse than no planner. Get authoring solid, then automate.

When it happens, the seams are already there (AGENTS.md §9): a collision oracle in
`src/cad/` producing candidate `Move`s that feed the existing schema. `domain/` does
not change.

**Physics simulation.** Parts should move exactly where told. Gravity and contact
dynamics are the wrong model for an instruction — you want a deterministic,
repeatable motion, not a plausible one.

**Real-time collaboration.** Large scope, unclear demand. The document is plain JSON,
so it is not blocked architecturally.

**PLM integration.** Enterprise plumbing. Would need a real user with a real
Teamcenter/Windchill instance to design against.
