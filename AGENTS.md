# AGENTS.md

Canonical spec for this repo. **Read this before changing anything.** If your change
conflicts with a rule here, change this file first in the same PR, or don't make the change.

---

## 1. What this is

An open-source, browser-based replacement for Creo Illustrate / SolidWorks Composer /
Dirac BuildOS. It authors and plays **assembly and disassembly sequences** for
multi-level CAD models with hundreds of components.

**In scope today:** manual authoring. You pick parts, say where they move, when, and
what the camera does. Export to interactive playback, printable work instructions, or video.

**Explicitly out of scope today:** automatic sequence inference, collision detection,
physics. See §9 — the architecture leaves a seam for these, but do not build them
speculatively.

---

## 2. Non-negotiable rules

These exist because violating them has a specific, known cost.

1. **`src/domain/` never imports a renderer.** No `three`, no `react`, no DOM.
   The evaluator must run in node, in a worker, and in a test. This is what makes
   `pipeline.test.ts` possible without WebGL. Enforced by test + review.

2. **The evaluator is pure.** `resolveFrame(sequence, t)` is a function of its
   arguments only. No caching, no mutation, no reading the clock. Scrubbing, undo,
   and deterministic export all depend on this. If you need memoization, memoize at
   the call site.

3. **Moves are deltas from rest pose, never absolute positions.** When the CAD is
   revised and a part shifts 3mm, authored sequences must still read correctly.
   Absolute poses are exactly why Composer projects rot on ECO. See `Move` in
   `schema.ts`.

4. **Operations accumulate.** A part moved in step 2 stays moved in step 9. The
   evaluator bakes all prior operations at their end state before applying the live
   one. Never "replay from zero" — scrubbing must be O(steps), not O(frames).

5. **Parts must survive glTF export as separate named objects.** The merged-mesh
   guard in `loadGltf.ts` is load-bearing. Never weaken or bypass it. A merged export
   makes the entire app useless and the failure is silent without this check.

6. **All units are millimetres.** CAD is authored in mm. No silent conversion anywhere.
   If you add another unit, it goes in the schema with an explicit migration.

7. **Schema changes require a version bump + migration.** `SCHEMA_VERSION` in
   `schema.ts`. Saved projects must keep opening.

8. **Zero paid/proprietary dependencies.** Whole point of the project. Check the
   license before adding anything. (This is why there is no GSAP — tweening is 30
   lines in `easing.ts`.)

---

## 3. Directory contract

**One purpose per folder. One docs location. No exceptions.**
If you feel the urge to create `docs/notes/` or `src/utils/`, you are about to make
the mess this section exists to prevent.

```
src/
  domain/     Pure data model + evaluator. NO renderer imports. The heart.
  cad/        Loading geometry, extracting assembly trees, export validation.
  state/      Zustand store. Authoring state ONLY, never derived render state.
  viewer/     three.js / R3F. Everything WebGL lives here and nowhere else.
  ui/         React panels: tree, timeline, inspector. Presentation only.
  io/         Serialization: project files, HTML instructions, video capture.
docs/         THE ONLY docs folder. See §4.
public/       Static assets served as-is.
```

**Rules:**
- No `utils/`, `helpers/`, `common/`, `misc/`, `lib/`. These become junk drawers.
  A function belongs to a domain — put it there. If it truly belongs to two, it
  belongs in `domain/`.
- No new top-level folders without updating this file.
- Tests live next to what they test: `evaluate.ts` → `evaluate.test.ts`.
- One React component per file, named the same as the file.

### Dependency direction (strictly one-way)

```
ui/ ──▶ state/ ──▶ domain/
viewer/ ──▶ state/, domain/, cad/
cad/ ──▶ domain/
io/ ──▶ domain/
domain/ ──▶ (nothing)
```

`domain/` importing from anywhere else is a bug. `ui/` reaching into `viewer/`
internals is a bug — go through the store.

---

## 4. Documentation policy

**`docs/` is the only documentation folder. It is flat. It does not get subfolders.**

Exactly four files are permitted:

| File | Contains | When to update |
|---|---|---|
| `docs/ARCHITECTURE.md` | How it works, why decisions were made | Design changes |
| `docs/DATA-MODEL.md` | Schema reference + migration notes | Any schema change |
| `docs/CAD-PIPELINE.md` | STEP → glTF conversion, exporter settings | Pipeline changes |
| `docs/ROADMAP.md` | What's next, what was deliberately deferred | Scope changes |

Plus `README.md` (quick start only) and this file at the root.

**Prohibited, permanently:** `NOTES.md`, `TODO.md`, `CHANGELOG-draft.md`,
`docs/old/`, `docs/archive/`, `docs/design/v2/`, dated files like `2026-08-notes.md`,
per-feature READMEs scattered in `src/`.

Design rationale goes in `ARCHITECTURE.md` under a dated heading. Superseded
decisions get struck through in place, not moved to an archive folder. **Delete
stale content — git history is the archive.**

---

## 5. Comments

Comment **why**, never **what**. The code already says what.

```ts
// BAD:  increment the counter
// GOOD: CAD exports repeat names for instanced fasteners, so dedupe by suffix.
```

Every non-obvious constant needs its reason (see `MERGED_MESH_TRIANGLE_THRESHOLD`).
Every workaround needs the failure it prevents. Comments that restate the code get
deleted on sight.

---

## 6. Testing

Run `npm test` before you claim anything works.

- **`domain/` requires tests.** It is pure; there is no excuse. Anything touching
  interpolation, timing, or accumulation needs a test proving the property.
- **`cad/` requires tests** for tree extraction and export validation.
- **`ui/` and `viewer/` are exempt** from unit tests — verify them in the browser.
  Do not add brittle WebGL snapshot tests.

Every bug fix starts with a failing test that reproduces it.

**If a test fails, fix the code or the test — never delete it or loosen the
assertion to make it pass.** If an assertion was genuinely wrong, say so explicitly
in the commit message and explain why.

---

## 7. Performance budget

Target: **500+ parts at 60fps.**

- No allocation in `useFrame`. Reuse module-level scratch objects (see `SceneBinder`).
- No React state updates per animation frame. The store holds `time`; three.js reads
  it imperatively. Never `setState` from `useFrame`.
- The assembly tree collapses by default. Never render 500 open rows.
- `resolveFrame` is called once per frame — keep it allocation-light.

---

## 8. Working agreements for agents

- **Verify before claiming.** "It builds" means you ran `npm run build`. "It works"
  means you loaded it in a browser and interacted with it. Never report success from
  reading code.
- **Small, complete changes.** A feature includes its test and its doc update in the
  same commit. Do not leave `// TODO: add test`.
- **Don't add dependencies casually.** Check bundle size and license. Prefer 30 lines
  in `domain/` over a package.
- **Don't refactor opportunistically.** If you're fixing the loader, fix the loader.
  Unrelated cleanup goes in its own commit.
- **When you hit something surprising, write it down** in `ARCHITECTURE.md` — the
  double-cover quaternion flip and the merged-mesh failure are both there because
  someone hit them.
- **Leave the repo cleaner than you found it,** but "cleaner" means deleting dead
  code, not adding a folder to organize it.

---

## 9. Deliberate seams for future automation

The current design leaves room for automatic sequence planning without a rewrite.
Do not build these until the manual authoring flow is solid.

- **`Track.from`/`to` are both explicit**, so an operation reverses by swapping them.
  Assembly ⟷ disassembly duality is free.
- **`Operation.meta`** is an open string map, sized to carry torque specs, tool ids,
  and part quantities — the fields a Bill of Process needs.
- **`Operation` granularity == BOP line item**, deliberately. MBOM/BOP export does
  not require restructuring the model.
- **A collision oracle would live in `src/cad/`** and produce candidate `Move`s that
  feed the existing schema. It would not touch `domain/`.
- **The evaluator being pure and renderer-free** means a planner can search over
  sequences headlessly.
