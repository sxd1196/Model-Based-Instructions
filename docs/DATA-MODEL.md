# Data Model

Defined and validated in `src/domain/schema.ts` (Zod). Project files are JSON and
carry `schemaVersion`.

## Hierarchy

```
Sequence                 the saved document
├── Assembly             the CAD model + part tree
│   └── PartNode         one node, flat map keyed by id
└── Operation[]          ordered instruction steps
    ├── Track[]          which parts move, and how
    ├── CameraPose?      where to look (null = hold previous)
    ├── Annotation[]     callouts
    └── PartStyle[]      ghost / hide / highlight
```

## Sequence

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `1` | Bump requires a migration |
| `id` | string | UUID |
| `name` | string | |
| `intent` | `assembly` \| `disassembly` | Authoring direction |
| `assembly` | `Assembly` | |
| `operations` | `Operation[]` | Order **is** the sequence |
| `homeCamera` | `CameraPose?` | Fallback pose |
| `units` | `'mm'` | Always mm (AGENTS.md §2.6) |

## Operation

One instruction step — the unit an operator sees. Granularity deliberately matches a
Bill of Process line item so BOP export needs no restructuring.

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `title` | string | |
| `description` | string | Operator-facing text |
| `duration` | number | Seconds of motion |
| `dwell` | number | Seconds held after motion, for readability |
| `tracks` | `Track[]` | |
| `camera` | `CameraPose?` | `null` holds the previous shot |
| `annotations` | `Annotation[]` | |
| `styles` | `PartStyle[]` | |
| `meta` | `Record<string,string>` | Open map — torque, tool id, qty |

## Track

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `parts` | `string[]` | Part ids moving rigidly together |
| `from` | `Move` | Usually identity |
| `to` | `Move` | |
| `start` | 0–1 | Window within the operation |
| `end` | 0–1 | |
| `easing` | see below | |

Both `from` and `to` are explicit so an operation reverses by swapping them —
assembly ⟷ disassembly duality is free.

Easing: `linear` · `easeIn` · `easeOut` · `easeInOut` · `step`.

## Move

**A delta from the part's rest pose, never an absolute position.** This is the most
important decision in the schema — see ARCHITECTURE.md.

| Field | Type | Notes |
|---|---|---|
| `translate` | `[x,y,z]` | mm, parent frame |
| `rotate` | `[x,y,z,w]` | Quaternion, XYZW (three.js order) |
| `pivot` | `[x,y,z]` | Rotation center, parent frame |

Identity = no translation, identity quaternion, origin pivot.

## PartNode

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique; deduped `__n` suffix on name collision |
| `name` | string | From CAD; must match the glTF object name |
| `parentId` | string \| null | Flat map + parentId, not nested children |
| `isGroup` | boolean | Assembly container with no geometry |
| `restTranslate` | `[x,y,z]` | Rest pose from CAD |
| `restRotate` | `[x,y,z,w]` | |

## CameraPose

`position` · `target` · `fov` (degrees). Plain numbers, so playback is a pure tween.

## Annotation

`text`, plus a discriminated `anchor`:

- `{ kind: 'part', partId }` — follows the part
- `{ kind: 'world', point }` — fixed in space

`offset` is a screen-space `[x,y]` px nudge.

> **Known gap:** the viewer currently renders part-anchored callouts at the origin.
> The data is stored correctly; the viewer needs to resolve part position.

## PartStyle

`parts: string[]` + `mode: 'normal' | 'ghost' | 'hidden' | 'highlight'`.

Styles carry forward through accumulation — ghosting in step 2 persists into step 9
until overridden.

---

## Migrations

Bump `SCHEMA_VERSION` and add a migration in `parseSequence`. **Saved projects must
keep opening.** Add fields with defaults rather than making them required.

## Example

```json
{
  "schemaVersion": 1,
  "id": "…",
  "name": "Gearbox teardown",
  "intent": "disassembly",
  "units": "mm",
  "assembly": {
    "id": "…",
    "name": "Gearbox",
    "sourceFile": "gearbox.step",
    "modelUrl": "gearbox.glb",
    "parts": {
      "Cover_Plate": {
        "id": "Cover_Plate", "name": "Cover_Plate",
        "parentId": "SUB_Cover", "isGroup": false,
        "restTranslate": [0, 0, 67], "restRotate": [0, 0, 0, 1]
      }
    }
  },
  "operations": [
    {
      "id": "op1",
      "title": "Remove cover bolts",
      "description": "Loosen in a star pattern. 12 N·m.",
      "duration": 1.5, "dwell": 0.4,
      "tracks": [{
        "id": "t1",
        "parts": ["Bolt_M8_01", "Bolt_M8_02"],
        "from": { "translate": [0,0,0], "rotate": [0,0,0,1], "pivot": [0,0,0] },
        "to":   { "translate": [0,0,120], "rotate": [0,0,0,1], "pivot": [0,0,0] },
        "start": 0, "end": 1, "easing": "easeInOut"
      }],
      "camera": null,
      "annotations": [],
      "styles": [{ "parts": ["Housing_Body"], "mode": "ghost" }],
      "meta": { "torque": "12 Nm", "tool": "T-30 Torx" }
    }
  ],
  "homeCamera": null
}
```
