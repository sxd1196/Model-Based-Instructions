# Assembly Studio

Open-source assembly & disassembly instruction authoring in the browser.
A free replacement for Creo Illustrate / SolidWorks Composer / Dirac BuildOS.

Load a multi-level CAD assembly, build a sequence of operations, play it back,
export interactive instructions, a printable document, or video.

## Quick start

```bash
npm install
npm run fetch:models    # demo CAD (~2MB; add -- --all for the 36MB arms)
npm run dev
```

Open http://localhost:5173 and use **Demo model ▾**:

| Model | Solids | Notes |
|---|---|---|
| Gearbox | ~30 | Procedural, no file needed — always available |
| Camera Mount | 9 | Real STEP: 2020 extrusion + printed adapters. Fast — use this one daily |
| reBot B601 Arm (DM / RS) | 133 / 136 | Real STEP: full 6-axis robot arm, nested BOM. 36MB, slow to parse |

The STEP assemblies are genuine B-rep industrial CAD — thousands of cylindrical
and conical faces, real `NEXT_ASSEMBLY_USAGE_OCCURRENCE` hierarchy — not mesh
conversions. They are **not stored in this repo**: `fetch:models` pulls them from
their upstream project at a pinned commit and verifies checksums. See
[docs/CAD-PIPELINE.md](docs/CAD-PIPELINE.md) for provenance and licensing.

## Branches

- **`main`** — the stable app: manual authoring, STEP/glTF import, export. Start here.
- **`feature/sequence-planner`** — automatic disassembly-sequence planning
  (experimental). Geometric peel + contact-normal direction inference. It runs,
  but the algorithm is still wrong in known ways — read
  [docs/ROADMAP.md](docs/ROADMAP.md) before touching it.

## Your own model

Drop a `.step` / `.stp` file straight in — parsed in-browser with OpenCascade
(WASM), no conversion needed. `.glb` / `.gltf` also work.

> **The one rule:** export each part as a **separate named object**. If the exporter
> merges the assembly into one mesh, parts cannot be moved. The app detects this on
> load and tells you.

SolidWorks, Inventor and Fusion native files are closed formats — export STEP from
the CAD tool first. The app says so rather than failing silently.

## Authoring

1. **Open model** (`.step` / `.glb`), or **Demo model ▾**
2. **Click a part in the viewport** to select it (shift-click adds, alt-click
   picks the exact sub-mesh). Or use the tree.
3. **+ Step** on the timeline
4. **Drag the gizmo** to move the part where it should go. Select several parts
   (or hit **⛓ Sub-asm**) and they move together as one rigid group — full
   6-DOF, translate or rotate. Snapping (5mm) and axis lock are on by default;
   toggle them in the viewport toolbar, or type exact values in the Inspector.
5. Orbit to a good angle → **Capture view**
6. Add a title, instruction text, callouts, and ghost/hide the context parts
7. Repeat. **Space** plays; drag the scrubber to scan

**✷ Explode** seeds the current step with a radial explode of the selection —
a starting point to hand-edit, not sequence inference.

Callouts pin to a part and follow it as it moves — use **pin to selection** in
the Inspector to re-anchor one, or **unpin** to freeze it in space.

Ctrl+Z / Ctrl+Shift+Z undo and redo.

## Export

- **Save** — `.assemblyproj.json`, the full document
- **Export doc** — print-ready HTML work instructions (browser → PDF)
- **Record** — WebM video of the viewport via `MediaRecorder`

## Commands

```bash
npm run dev           # dev server
npm test              # 388 tests, no browser needed
npm run build         # typecheck + production build
npm run typecheck     # types only
npm run lint          # oxlint
npm run fetch:models  # demo CAD; `-- --all` for the large arms
npm run smoke         # headless smoke test (isolated Playwright, not your browser)
```

## Docs

- [AGENTS.md](AGENTS.md) — **read first.** Repo rules, directory contract, conventions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it works and why
- [docs/DATA-MODEL.md](docs/DATA-MODEL.md) — schema reference
- [docs/CAD-PIPELINE.md](docs/CAD-PIPELINE.md) — CAD import, demo-model provenance
- [docs/ROADMAP.md](docs/ROADMAP.md) — what's next, what's deferred

## Stack

React · TypeScript · three.js / react-three-fiber · Zustand · Zod · Vite · Vitest.
STEP parsing via `occt-import-js` (OpenCascade compiled to WASM).
No paid or proprietary dependencies.

## License

MIT — see [LICENSE](LICENSE). Demo CAD models are third-party and separately
licensed; they are fetched, not redistributed here.
