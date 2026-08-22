# Roadmap

Ordered by what unblocks the most. Things below the line are deliberately deferred —
that is a decision, not an oversight.

## Now — finish manual authoring

The bar: author a complete teardown of a real 200+ part assembly without touching JSON.

- [ ] **Part-anchored callouts** — schema is right, viewer renders them at origin
- [ ] **Rotation UI** — evaluator fully supports rotation about a pivot; Inspector
      only exposes translation. Needs an axis + angle + pivot picker
- [ ] **Click-to-select in the viewport** — raycast to part; today selection is
      tree-only
- [ ] **Drag-to-author** — move a part with a gizmo, capture the delta as a Move.
      The single biggest authoring speedup
- [ ] **Embed geometry in project files** — opening a project should not require
      re-opening the `.glb`
- [ ] **Auto-explode helper** — radial explode from assembly centroid as a starting
      point, then hand-edit. Not sequencing, just a better blank page

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
