# Watcher Office Asset Slots

This folder is reserved for **licensed** office scene assets.

- Put production-ready `.glb`/`.gltf` files in `public/assets/office/gltf/`.
- Put private local-only converted TS1 assets in `public/assets/office/private/`.
- Do not commit proprietary game assets unless the license explicitly allows redistribution.
- Current scene uses legal procedural placeholders wired through manifest slots.

## Public/Licensed Path

The public manifest path remains `public/assets/office/gltf/` via:

- `withOfficeAssetPath(...)`
- `OFFICE_ASSET_MANIFEST` in `src/components/team-office/office-asset-pipeline.tsx`

## Private Local Overrides

Use a local manifest file at:

- `public/assets/office/private/manifest.local.json` (git-ignored)

Shape:

- key = office slot id (`desk`, `deskChair`, `breakSofa`, `breakTable`, `plant`, `hubCore`, `wallFrame`, `ceilingLamp`, `coffeeMachine`)
- value = either a filename string (relative to `public/assets/office/private/`) or an object with:
  - `file` or `url`
  - optional `scale`, `position`, `rotation`

Example starter: `public/assets/office/private/manifest.local.example.json`.

When present, local overrides are loaded at runtime and merged on top of the public/procedural manifest.
