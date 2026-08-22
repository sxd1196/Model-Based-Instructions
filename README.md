# Assembly Studio

Open-source assembly & disassembly instruction authoring in the browser.
A free replacement for Creo Illustrate / SolidWorks Composer / Dirac BuildOS.

Load a multi-level CAD assembly, build a sequence of operations, play it back,
export interactive instructions, a printable document, or video.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173 and click **Demo model** — a procedurally-built gearbox
(~30 named parts, nested sub-assemblies) so you can try everything without a CAD file.

## Your own model

Convert STEP / SLDASM → glTF first. See [docs/CAD-PIPELINE.md](docs/CAD-PIPELINE.md).

> **The one rule:** export each part as a **separate named object**. If the exporter
> merges the assembly into one mesh, parts cannot be moved. The app detects this on
> load and tells you.

## Authoring

1. **Open model** (`.glb` / `.gltf`), or **Demo model**
2. Select parts in the tree (ctrl-click for multiple)
3. **+ Step** on the timeline
4. **+ from selection** in the Inspector, then set the offset — the ±X/Y/Z buttons
   nudge 25mm
5. Orbit to a good angle → **Capture view**
6. Add a title, instruction text, callouts, and ghost/hide the context parts
7. Repeat. **Space** plays; drag the scrubber to scan

Ctrl+Z / Ctrl+Shift+Z undo and redo.

## Export

- **Save** — `.assemblyproj.json`, the full document
- **Export doc** — print-ready HTML work instructions (browser → PDF)
- **Record** — WebM video of the viewport via `MediaRecorder`

## Commands

```bash
npm run dev         # dev server
npm test            # 27 tests, no browser needed
npm run build       # typecheck + production build
npm run typecheck   # types only
```

## Docs

- [AGENTS.md](AGENTS.md) — **read first.** Repo rules, directory contract, conventions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it works and why
- [docs/DATA-MODEL.md](docs/DATA-MODEL.md) — schema reference
- [docs/CAD-PIPELINE.md](docs/CAD-PIPELINE.md) — STEP → glTF conversion
- [docs/ROADMAP.md](docs/ROADMAP.md) — what's next, what's deferred

## Stack

React · TypeScript · three.js / react-three-fiber · Zustand · Zod · Vite · Vitest.
No paid or proprietary dependencies.

## License

MIT
