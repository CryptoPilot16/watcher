# Private TS1 Office Asset Pipeline (Local Only)

This project supports local-only TS1 office replacements without committing proprietary files.

## Source and target paths

- Raw TS1 NPC source files (already ignored): `tmp/private-assets/ts1-npcs/`
- Converted local office assets (git-ignored): `public/assets/office/private/`
- Optional local override manifest (git-ignored): `public/assets/office/private/manifest.local.json`
- Public/licensed asset path (tracked): `public/assets/office/gltf/`

## How overrides work

1. Keep the base public/procedural manifest in `src/components/team-office/office-asset-pipeline.tsx` unchanged.
2. Drop converted `.glb` files into `public/assets/office/private/`.
3. Create/update `public/assets/office/private/manifest.local.json` to map scene slots to your local files.
4. Reload `/watch` and matching slots render `.glb` assets instead of procedural placeholders.

No application code edits are required for per-slot remapping after this setup.

## Local manifest format

Use either shorthand string values or an object with transform overrides.

```json
{
  "desk": "desk.glb",
  "deskChair": "desk-chair.glb",
  "breakSofa": {
    "file": "lounge-sofa.glb",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": 1
  }
}
```

- String value: filename relative to `public/assets/office/private/`
- Object value:
  - `file`: filename relative to `public/assets/office/private/`
  - `url`: optional explicit URL (if not using `file`)
  - `position`, `rotation`: `[x, y, z]`
  - `scale`: number or `[x, y, z]`

Example template: `public/assets/office/private/manifest.local.example.json`

## Scene slot map

- `desk`: worker desk unit
- `deskChair`: desk chair
- `breakSofa`: break area sofa
- `breakTable`: break area side table
- `hubCore`: front PILOT handoff hub
- `plant`, `wallFrame`, `ceilingLamp`, `coffeeMachine`: reserved slots in manifest for future office props

## Git safety

`.gitignore` intentionally ignores everything in `public/assets/office/private/` except:

- `.gitkeep`
- `manifest.local.example.json`

This prevents raw/proprietary TS1 assets and local converted outputs from being committed.
