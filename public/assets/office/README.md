# Watcher Office Asset Slots

This folder is reserved for **licensed** office scene assets.

- Put production-ready `.glb`/`.gltf` files in `public/assets/office/gltf/`.
- Do not commit proprietary game assets unless the license explicitly allows redistribution.
- Current scene uses legal procedural placeholders wired through manifest slots.

## Suggested filenames

- `desk.glb`
- `desk-chair.glb`
- `floor-plant.glb`
- `hub-console.glb`
- `wall-frame.glb`
- `ceiling-lamp.glb`
- `coffee-machine.glb`

To activate a model, update `src/components/team-office/office-asset-pipeline.tsx` and set a slot to `kind: 'gltf'` with the matching URL.
