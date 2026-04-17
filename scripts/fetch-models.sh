#!/usr/bin/env bash
# Fetch all 3D assets needed by the Team Office scenes.
# Safe to re-run — it skips anything already downloaded.
# Outputs to:
#   public/models/chars/   — KayKit Adventurers character glbs
#   public/models/env/     — KayKit Dungeon environment glbs
#   public/models/voxel/   — MariaIsMe Voxel Office obj/mtl/png
#
# Prerequisites: git, curl, unzip, python3.
#
# Licenses: KayKit packs are CC0. MariaIsMe Voxel Office is free (name-your-
# own-price) and allows commercial and non-commercial use (no resale of pack).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="${ROOT_DIR}/public/models"
CHARS_DIR="${MODELS_DIR}/chars"
ENV_DIR="${MODELS_DIR}/env"
VOXEL_DIR="${MODELS_DIR}/voxel"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

mkdir -p "${CHARS_DIR}" "${ENV_DIR}" "${VOXEL_DIR}"

log() { printf '\033[36m[fetch-models]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[fetch-models]\033[0m %s\n' "$*"; }

# ────────────────────────────────────────────────────────────────
# 1. KayKit Adventurers — characters (CC0, GitHub mirror)
# ────────────────────────────────────────────────────────────────
if ls "${CHARS_DIR}"/*.glb >/dev/null 2>&1; then
  log "Characters already present in ${CHARS_DIR}, skipping."
else
  log "Cloning KayKit Character Pack: Adventurers…"
  git clone --depth 1 --quiet \
    https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0.git \
    "${TMP_DIR}/kaykit-chars"
  cp "${TMP_DIR}/kaykit-chars/addons/kaykit_character_pack_adventures/Characters/gltf/"*.glb "${CHARS_DIR}/"
  cp "${TMP_DIR}/kaykit-chars/addons/kaykit_character_pack_adventures/Characters/gltf/"*.png "${CHARS_DIR}/" 2>/dev/null || true
  log "→ $(ls "${CHARS_DIR}" | wc -l) character files"
fi

# ────────────────────────────────────────────────────────────────
# 2. KayKit Dungeon Remastered — environment (CC0, GitHub mirror)
# ────────────────────────────────────────────────────────────────
if ls "${ENV_DIR}"/*.glb >/dev/null 2>&1; then
  log "Environment already present in ${ENV_DIR}, skipping."
else
  log "Cloning KayKit Dungeon Remastered…"
  git clone --depth 1 --quiet \
    https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0.git \
    "${TMP_DIR}/kaykit-dungeon"
  SRC="${TMP_DIR}/kaykit-dungeon/addons/kaykit_dungeon_remastered/Assets/gltf"
  declare -A RENAMES=(
    [floor_tile_large.gltf.glb]=floor_tile.glb
    [floor_wood_large.gltf.glb]=floor_wood.glb
    [floor_dirt_large.gltf.glb]=floor_dirt.glb
    [wall.gltf.glb]=wall.glb
    [wall_corner.gltf.glb]=wall_corner.glb
    [chair.gltf.glb]=chair.glb
    [table_medium.gltf.glb]=table_medium.glb
    [torch_mounted.gltf.glb]=torch_mounted.glb
    [torch_lit.gltf.glb]=torch_lit.glb
    [banner_shield_green.gltf.glb]=banner_green.glb
    [banner_thin_blue.gltf.glb]=banner_blue.glb
    [banner_triple_red.gltf.glb]=banner_red.glb
    [shelf_large.gltf.glb]=shelf_large.glb
    [shelf_small.gltf.glb]=shelf_small.glb
    [barrel_large.gltf.glb]=barrel_large.glb
    [barrel_small.gltf.glb]=barrel_small.glb
    [crates_stacked.gltf.glb]=crates.glb
    [candle_triple.gltf.glb]=candle_triple.glb
    [candle_lit.gltf.glb]=candle_lit.glb
    [chest_gold.glb]=chest_gold.glb
    [pillar.gltf.glb]=pillar.glb
    [pillar_decorated.gltf.glb]=pillar_decorated.glb
  )
  for src_name in "${!RENAMES[@]}"; do
    if [[ -f "${SRC}/${src_name}" ]]; then
      cp "${SRC}/${src_name}" "${ENV_DIR}/${RENAMES[$src_name]}"
    fi
  done
  log "→ $(ls "${ENV_DIR}" | wc -l) environment glbs"
fi

# ────────────────────────────────────────────────────────────────
# 3. MariaIsMe 3D Voxel Office Pack (itch.io — free tier)
# ────────────────────────────────────────────────────────────────
if ls "${VOXEL_DIR}"/*.obj >/dev/null 2>&1; then
  log "Voxel office already present in ${VOXEL_DIR}, skipping."
else
  log "Downloading MariaIsMe 3D Voxel Office Pack from itch.io…"
  COOKIES="${TMP_DIR}/itch.cookies"
  PAGE="$(curl -sL -c "${COOKIES}" 'https://mariaisme.itch.io/3d-voxel-office' --max-time 20)"
  CSRF="$(printf '%s' "${PAGE}" | grep -oE 'csrf_token"\s*value="[^"]+"' | head -1 | sed 's/.*value="\([^"]*\)".*/\1/')"
  if [[ -z "${CSRF}" ]]; then
    warn "Could not extract itch.io CSRF token — you'll need to download manually from:"
    warn "  https://mariaisme.itch.io/3d-voxel-office"
    warn "Extract the OBJ zip into ${VOXEL_DIR}/ and re-run to resolve."
  else
    DL_JSON="$(curl -s -b "${COOKIES}" -H "X-CSRF-Token: ${CSRF}" -X POST \
      'https://mariaisme.itch.io/3d-voxel-office/download_url' --max-time 20)"
    DL_URL="$(printf '%s' "${DL_JSON}" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("url",""))')"
    if [[ -z "${DL_URL}" ]]; then
      warn "itch.io download_url endpoint did not return a URL. Falling back to manual."
    else
      curl -sL -b "${COOKIES}" "${DL_URL}" --max-time 20 > "${TMP_DIR}/dl_page.html"
      UPLOAD_ID="$(grep -oE 'data-upload_id="[0-9]+"' "${TMP_DIR}/dl_page.html" | head -1 | grep -oE '[0-9]+')"
      if [[ -z "${UPLOAD_ID}" ]]; then
        warn "Could not locate upload ID on itch.io download page. Manual download required."
      else
        FILE_JSON="$(curl -s -b "${COOKIES}" -H "X-CSRF-Token: ${CSRF}" -X POST \
          "https://mariaisme.itch.io/3d-voxel-office/file/${UPLOAD_ID}?source=game_download&key=" --max-time 20)"
        R2_URL="$(printf '%s' "${FILE_JSON}" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("url",""))')"
        if [[ -z "${R2_URL}" ]]; then
          warn "itch.io file endpoint did not return a URL."
        else
          curl -sL "${R2_URL}" --max-time 120 -o "${TMP_DIR}/voxel-office.zip"
          unzip -q "${TMP_DIR}/voxel-office.zip" -d "${TMP_DIR}/voxel-office"
          # Reference the set of Office_* bases used in the scene
          USED_BASES="$(python3 - <<'PYEOF'
import re
with open('src/components/team-office/team-office-canvas.tsx') as f:
    s = f.read()
refs = set(re.findall(r'VoxelObj base="([^"]+)"', s))
refs.update(re.findall(r"'(Office_[A-Za-z0-9_]+)'", s))
print('\n'.join(sorted(refs)))
PYEOF
)"
          for base in ${USED_BASES}; do
            for ext in obj mtl png; do
              found="$(find "${TMP_DIR}/voxel-office" -name "${base}.${ext}" | head -1)"
              [[ -n "${found}" ]] && cp "${found}" "${VOXEL_DIR}/${base}.${ext}"
            done
          done
          log "→ $(ls "${VOXEL_DIR}" | wc -l) voxel office files"
        fi
      fi
    fi
  fi
fi

log "Done. Models ready in ${MODELS_DIR}"
