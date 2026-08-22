# CAD Pipeline: STEP / SLDASM → glTF

Everything here is free and open source.

## The one thing that will ruin your day

**Each part must survive export as a separate, named object.**

If the exporter merges the assembly into a single mesh, you cannot move parts
individually and the app is useless. Nothing looks broken — the model displays fine —
until you try to author a motion and discover there is only one object.

The app checks for this on load and refuses quietly to pretend otherwise. If you see:

> CRITICAL: this file contains ONE merged mesh (…) — individual parts cannot be moved.

…re-export. Do not proceed.

**Verify before authoring:** load the file, open the assembly tree, confirm you see
your parts by name. Thirty seconds now saves an afternoon.

---

## Route A — FreeCAD (recommended, scriptable)

1. Install [FreeCAD](https://www.freecad.org/) (1.0+).
2. **File → Open** your `.step` / `.stp`. Choose the import mode that keeps the
   assembly hierarchy — not "single part".
3. In the model tree, confirm each solid is its own item with a real name.
4. Select the top-level assembly → **File → Export** → `glTF (*.glb *.gltf)`.
5. **Do not enable any "merge", "join", "fuse", or "single object" option.**

### Batch conversion

FreeCAD ships a Python console; this converts without opening the GUI:

```python
# freecadcmd convert.py
import FreeCAD, Import, ImportGui

doc = FreeCAD.newDocument("conv")
ImportGui.insert("C:/path/to/assembly.step", doc.Name)
doc.recompute()

objs = [o for o in doc.Objects if hasattr(o, "Shape")]
ImportGui.export(objs, "C:/path/to/assembly.glb")   # list, not fused
```

Run with `freecadcmd convert.py`. Passing the object *list* is what keeps parts
separate — fusing first is the mistake.

---

## Route B — CAD Assistant (zero code, fastest)

From the OpenCascade team. Free, no account.

1. Download [CAD Assistant](https://www.opencascade.com/products/cad-assistant/).
2. Drag your STEP file in.
3. **Save as → glTF (.glb)**.
4. In export options, keep the node hierarchy. Do not merge faces or objects.

Generally the highest-fidelity STEP reader of the free options, since it is the
reference OpenCascade implementation.

---

## Route C — In-browser (future)

`occt-import-js` is already a dependency. It compiles OpenCascade to WASM and can
read STEP directly in the browser, removing the conversion step entirely.

Not yet wired up. When it is, it belongs in `src/cad/` behind the same
`buildAssemblyFromScene` interface the glTF path uses.

---

## SolidWorks specifics

SolidWorks cannot export glTF directly. Two hops:

1. **File → Save As → STEP AP242** (or AP214). In options, enable
   **"Export assembly as multiple bodies"** or the equivalent that preserves
   component structure.
2. Run that STEP through Route A or B.

**Name your parts in SolidWorks before exporting.** Component names carry through to
glTF and become the part ids you author against. `Part1`, `Part2`, `Part3` is
technically functional and practically miserable at 200 components.

---

## Naming rules that matter

Part names become identifiers. The loader deduplicates collisions with a `__n`
suffix, but **unnamed geometry gets synthetic ids that change on re-export** — which
silently breaks saved sequences.

- Name every part. The loader warns about unnamed nodes, and the warning is real.
- Avoid renaming parts after authoring. Renaming breaks the id binding.
- Repeated names for instanced fasteners are fine — `Bolt_M8` × 8 is normal and
  handled.

---

## Size and performance

Target: 500+ parts at 60fps.

| Problem | Fix |
|---|---|
| Very large file | Coarsen tessellation on export — CAD defaults are far finer than a viewer needs |
| Still large | Enable Draco compression (the loader already supports it) |
| Slow with many parts | Check part count vs. triangle count; a few dense meshes beat many tiny ones |
| Model invisible | Check the units — the app assumes mm. A model in metres appears 1000× too small |

Tessellation is the big lever. A bracket that needs 200k triangles for CAM analysis
needs 5k for a work instruction.

---

## Units

**Everything is millimetres.** STEP files usually carry mm natively.

If your model imports at the wrong scale, fix it at export rather than compensating
in the app — the app has no scale factor by design (AGENTS.md §2.6).

---

## Quick verification checklist

- [ ] Assembly tree shows parts by their real names, not `mesh_0`, `mesh_1`
- [ ] No CRITICAL warning on load
- [ ] Part count roughly matches the CAD BOM
- [ ] Selecting a part in the tree highlights the right geometry
- [ ] Model appears at a sane size relative to the grid
