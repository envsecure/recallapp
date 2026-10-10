#!/usr/bin/env bash
#
# fetch-models.sh — download the AI model weights Recall needs.
#
# Run ONCE, on a machine with internet, before indexing for real.
#
# This is the ONLY step in the whole project that touches the network to fetch
# anything large. After it finishes, Recall runs fully offline: your images,
# your queries and your index never leave the machine (GOAL.md C1).
#
#   ./scripts/fetch-models.sh                  # embedder + OCR  (~150 MB)
#   ./scripts/fetch-models.sh --with-vision    # + Florence-2 vision (~1.1 GB)
#   ./scripts/fetch-models.sh --vision-q8      # + vision, int8     (~192 MB)
#   ./scripts/fetch-models.sh --dest <dir>     # custom destination
#
# Existing files are skipped, so re-running after a partial failure resumes.

set -euo pipefail

DEST="${RECALL_DATA_DIR:-$HOME/.localrecall}/models"
WITH_VISION=0
VISION_VARIANT="fp32"

while [ $# -gt 0 ]; do
  case "$1" in
    --with-vision)   WITH_VISION=1; shift ;;
    --vision-q8)     WITH_VISION=1; VISION_VARIANT="q8"; shift ;;
    --dest)          DEST="${2:?--dest needs a path}"; shift 2 ;;
    -h|--help)       sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else BOLD=''; GREEN=''; YELLOW=''; RED=''; RESET=''; fi

info() { printf '    %s\n' "$1"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl not found — install it, e.g. 'apt install curl'"

BGE="https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main"
FLORENCE="https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main"
TESSDATA="https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main"

# fetch <url> <dest-file> — skips if already present, resumes if partial.
fetch() {
  url="$1"; out="$2"
  mkdir -p "$(dirname "$out")"
  if [ -s "$out" ]; then
    info "have $(basename "$out")"
    return 0
  fi
  curl -fL --progress-bar --retry 3 --retry-delay 2 -o "$out.part" "$url" || {
    rm -f "$out.part"
    die "download failed: $url"
  }
  mv "$out.part" "$out"
}

echo
printf '%sFetching Recall model weights%s\n' "$BOLD" "$RESET"
info "destination: $DEST"

AVAIL_KB="$(df -Pk "$(dirname "$DEST" 2>/dev/null || echo .)" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)"
AVAIL_MB=$(( ${AVAIL_KB:-0} / 1024 ))
NEED_MB=400
[ "$WITH_VISION" -eq 1 ] && { [ "$VISION_VARIANT" = q8 ] && NEED_MB=700 || NEED_MB=1800; }
if [ "${AVAIL_MB:-0}" -lt "$NEED_MB" ]; then
  warn "only ${AVAIL_MB} MB free; this needs about ${NEED_MB} MB"
else
  ok "${AVAIL_MB} MB free"
fi

# ------------------------------------------------------------ embedding model
echo
printf '%sEmbedding model (bge-small-en-v1.5)%s\n' "$BOLD" "$RESET"
# model_quantized is 34 MB vs 133 MB fp32, with negligible quality loss for
# retrieval. Full precision is available in the unquantized model.onnx.
fetch "$BGE/onnx/model_quantized.onnx" "$DEST/bge-small-en-v1.5/onnx/model_quantized.onnx"
for f in config.json tokenizer.json tokenizer_config.json; do
  fetch "$BGE/$f" "$DEST/bge-small-en-v1.5/$f"
done
ok "embedding model ready"

# ------------------------------------------------------------------- OCR data
echo
printf '%sOCR language data (tesseract, eng)%s\n' "$BOLD" "$RESET"
fetch "$TESSDATA/eng.traineddata" "$DEST/tessdata-eng/eng.traineddata"
ok "OCR data ready"

# --------------------------------------------------------------- vision model
if [ "$WITH_VISION" -eq 1 ]; then
  echo
  printf '%sVision model (Florence-2-base-ft)%s\n' "$BOLD" "$RESET"
  if [ "$VISION_VARIANT" = q8 ]; then
    info "int8 variant — smaller download, slightly lower caption quality"
    ONNX_SUFFIX="_quantized"
  else
    info "fp32 variant — best quality, ~1.1 GB"
    ONNX_SUFFIX=""
  fi

  fetch "$FLORENCE/onnx/vision_encoder${ONNX_SUFFIX}.onnx" "$DEST/florence2-base-ft/onnx/vision_encoder${ONNX_SUFFIX}.onnx"
  fetch "$FLORENCE/onnx/encoder_model${ONNX_SUFFIX}.onnx" "$DEST/florence2-base-ft/onnx/encoder_model${ONNX_SUFFIX}.onnx"
  fetch "$FLORENCE/onnx/decoder_model_merged${ONNX_SUFFIX}.onnx" "$DEST/florence2-base-ft/onnx/decoder_model_merged${ONNX_SUFFIX}.onnx"
  fetch "$FLORENCE/onnx/embed_tokens.onnx" "$DEST/florence2-base-ft/onnx/embed_tokens.onnx"
  for f in config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json vocab.json added_tokens.json special_tokens_map.json; do
    fetch "$FLORENCE/$f" "$DEST/florence2-base-ft/$f"
  done
  ok "vision model ready"

  cat <<EOF

    ${YELLOW}Florence-2 is the highest-risk component in this project.${RESET}
    It needs remote code execution under transformers.js and its ONNX export
    does not behave identically on every platform. If captioning fails, the
    index and search still work — OCR carries them, and vision only covers the
    low-confidence subset (GOAL.md C6).

EOF
fi

# --------------------------------------------------------------------- report
echo
printf '%sDone%s\n' "$BOLD" "$RESET"
if [ -d "$DEST" ]; then
  du -sh "$DEST" 2>/dev/null | awk '{printf "    total on disk: %s\n", $1}'
fi
info "models: $DEST"
echo
info "Recall now runs fully offline. Nothing you index or search for ever"
info "leaves this machine."
echo