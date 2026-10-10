#!/usr/bin/env bash
#
# setup.sh — one-command setup for Recall on Linux.
#
#   ./setup.sh                  # full setup, with real models (~1.5 GB download)
#   ./setup.sh --quick          # no models, fake mode, fast and tiny (~200 MB)
#   ./setup.sh --with-vision    # + Florence-2 vision model (+1.1 GB)
#   ./setup.sh --skip-web       # skip the frontend
#   ./setup.sh --folder <path>  # index your own screenshots, not the fixtures
#   ./setup.sh --no-install-node  # fail instead of installing a missing Node
#   ./setup.sh --help
#
# NODE: if Node is missing or older than 22.5, setup.sh installs it for you via
# scripts/install-node.sh (nvm, no sudo, or NodeSource with sudo). Distribution
# packages are often too old — Ubuntu 24.04 ships Node 18 — so the installer
# avoids `apt install nodejs` unless it is genuinely new enough.
#
# MODELS: weights are downloaded ONCE by scripts/fetch-models.sh. After that
# Recall is fully offline — your images, index and queries never leave the
# machine (GOAL.md C1). Nothing in the index or search path ever makes a network
# call; test/index/offline.test.ts enforces that by poisoning http/https/net/tls.
#
# --quick skips the download entirely and indexes against deterministic fakes.
# Useful on a laptop with no spare disk, or just to see the thing run.

set -euo pipefail

# ---------------------------------------------------------------- configuration

SKIP_WEB=0
NO_VERIFY=0
QUICK=0
WITH_VISION=0
AUTO_INSTALL_NODE=1
INDEX_FOLDER=""
DATA_DIR="${RECALL_DATA_DIR:-$HOME/.localrecall}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=5

# Measured sizes, from scripts/fetch-models.sh against the real repos.
MODEL_MB=180          # bge-small (int8) + tesseract eng
VISION_MB=1100        # Florence-2 fp32; ~190 MB extra with --vision-q8
RUNTIME_MB=450        # onnxruntime-node binaries, pulled by the model deps

# ---------------------------------------------------------------------- output

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; RESET=''
fi

step()  { printf '\n%s==>%s %s%s%s\n' "$BLUE" "$RESET" "$BOLD" "$1" "$RESET"; }
info()  { printf '    %s\n' "$1"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail()  { printf '\n%sERROR:%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

# ------------------------------------------------------------------ arguments

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-web)    SKIP_WEB=1; shift ;;
    --no-verify)   NO_VERIFY=1; shift ;;
    --quick)       QUICK=1; shift ;;
    --install-node) AUTO_INSTALL_NODE=1; shift ;;
    --no-install-node) AUTO_INSTALL_NODE=0; shift ;;
    --with-vision) WITH_VISION=1; shift ;;
    --folder)      INDEX_FOLDER="${2:-}"; [ -n "$INDEX_FOLDER" ] || fail "--folder needs a path"; shift 2 ;;
    --data-dir)    DATA_DIR="${2:-}"; [ -n "$DATA_DIR" ] || fail "--data-dir needs a path"; shift 2 ;;
    -h|--help)     usage ;;
    *)             fail "unknown option: $1  (try --help)" ;;
  esac
done

# --------------------------------------------------------------- preconditions

[ -d "$REPO_ROOT/src" ] || { echo "ERROR: cannot find src/ — run this from inside the Recall repo" >&2; exit 1; }

step "Checking prerequisites"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  # Strip the leading "v" and keep only leading digits. A non-numeric result
  # must become 0, not "0.0.0" — `[ "0.0.0" -gt 22 ]` is an integer-expression
  # error, which is worse than a clean "too old".
  local v='' maj=0 min=0
  v="$(node --version 2>/dev/null | tr -d 'v' || true)"
  maj="$(printf '%s' "$v" | cut -d. -f1)"
  min="$(printf '%s' "$v" | cut -d. -f2)"
  case "$maj" in ''|*[!0-9]*) maj=0 ;; esac
  case "$min" in ''|*[!0-9]*) min=0 ;; esac
  [ "$maj" -gt "$MIN_NODE_MAJOR" ] && return 0
  [ "$maj" -eq "$MIN_NODE_MAJOR" ] && [ "$min" -ge "$MIN_NODE_MINOR" ] && return 0
  return 1
}

# node:sqlite landed in 22.5. Below that, `npm install` succeeds and the app
# then crashes on first DB open — a confusing failure, so it is handled up front
# by installing Node rather than by printing a link and giving up.
if ! node_ok; then
  if command -v node >/dev/null 2>&1; then
    warn "node $(node --version) is too old (need >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR})"
  else
    warn "node not found (need >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR})"
  fi
  if [ "$AUTO_INSTALL_NODE" -eq 1 ]; then
    info "installing Node via scripts/install-node.sh"
    chmod +x "$REPO_ROOT/scripts/install-node.sh"
    "$REPO_ROOT/scripts/install-node.sh" || fail "could not install Node — see the instructions it printed"
    hash -r 2>/dev/null || true
    node_ok || fail "Node is still not usable after installation. Open a new shell and re-run."
  else
    fail "Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required.
    Install it:  ./scripts/install-node.sh
    or re-run with --install-node to do it automatically."
  fi
fi

command -v npm >/dev/null 2>&1 || fail "npm missing even though node is present — reinstall Node."
NODE_VERSION="$(node --version)"
ok "node $NODE_VERSION"

# Parse the version once, here, and validate numerically.
#
# These used to be NODE_MAJOR/NODE_MINOR, assigned inside a check that no longer
# runs — the 22.12 experimental warning below then referenced variables that did
# not exist, which under `set -u` is "unbound variable". One parse, one owner.
NODE_NUMLINE="$(printf '%s' "$NODE_VERSION" | tr -d 'v')"
NODE_MAJOR="$(printf '%s' "$NODE_NUMLINE" | cut -d. -f1)"
NODE_MINOR="$(printf '%s' "$NODE_NUMLINE" | cut -d. -f2)"
case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
case "$NODE_MINOR" in ''|*[!0-9]*) NODE_MINOR=0 ;; esac

# node:sqlite is experimental before 22.12 and warns. Not fatal, but worth saying.
if [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; then
  warn "node:sqlite is experimental before 22.12 and will print a warning. Node 22.12+ is quieter."
fi

AVAIL_KB="$(df -Pk "$REPO_ROOT" | awk 'NR==2 {print $4}')"
AVAIL_MB=$((AVAIL_KB / 1024))

# Work out what this run actually needs, so the warning is not a guess.
NEED_MB=250   # server+web deps
if [ "$QUICK" -eq 0 ]; then
  NEED_MB=$((NEED_MB + RUNTIME_MB + MODEL_MB))
  [ "$WITH_VISION" -eq 1 ] && NEED_MB=$((NEED_MB + VISION_MB))
fi

if [ "$AVAIL_MB" -lt "$NEED_MB" ]; then
  warn "only ${AVAIL_MB} MB free; this needs about ${NEED_MB} MB"
  if [ "$QUICK" -eq 0 ]; then
    info "run './setup.sh --quick' to skip the model download entirely"
  fi
else
  ok "${AVAIL_MB} MB free (need ~${NEED_MB} MB)"
fi

info "repo:    $REPO_ROOT"
info "data:    $DATA_DIR"
info "node:    $NODE_VERSION"

# ------------------------------------------------------------------ install

step "Installing dependencies (server)"
cd "$REPO_ROOT"
if [ "$QUICK" -eq 1 ]; then
  # Skip the optional model runtimes: they pull ~450 MB of onnxruntime binaries
  # that fake mode never loads.
  npm install --no-audit --no-fund --omit=optional
  ok "server dependencies installed (no model runtimes)"
else
  npm install --no-audit --no-fund
  ok "server + model dependencies installed"
fi

if [ "$SKIP_WEB" -eq 0 ]; then
  step "Installing dependencies (web UI)"
  cd "$REPO_ROOT/web"
  npm install --no-audit --no-fund
  ok "web dependencies installed"
else
  warn "skipping web UI (--skip-web)"
fi

# --------------------------------------------------------------------- models

if [ "$QUICK" -eq 1 ]; then
  step "Skipping models (--quick)"
  warn "fake mode: indexing will NOT do real OCR or embeddings"
else
  step "Fetching model weights"
  info "embeddings + OCR, ~${MODEL_MB} MB. This is the only step that touches the network."
  chmod +x "$REPO_ROOT/scripts/fetch-models.sh"
  if [ "$WITH_VISION" -eq 1 ]; then
    RECALL_DATA_DIR="$DATA_DIR" "$REPO_ROOT/scripts/fetch-models.sh" --with-vision --dest "$DATA_DIR/models"
  else
    RECALL_DATA_DIR="$DATA_DIR" "$REPO_ROOT/scripts/fetch-models.sh" --dest "$DATA_DIR/models"
  fi
  ok "models ready in $DATA_DIR/models"
fi

# ------------------------------------------------------------------ fixtures

step "Generating image fixtures"
cd "$REPO_ROOT"
npm run fixtures
ok "fixtures ready"

# --------------------------------------------------------------------- index

if [ -n "$INDEX_FOLDER" ]; then
  step "Indexing $INDEX_FOLDER"
  [ -d "$INDEX_FOLDER" ] || fail "folder not found: $INDEX_FOLDER"
  TARGET="$INDEX_FOLDER"
else
  step "Indexing bundled fixtures"
  TARGET="$REPO_ROOT/test/fixtures/generated"
fi

# --fake forces the deterministic path. Without it the CLI uses whatever real
# models are installed, and refuses if there are none.
if [ "$QUICK" -eq 1 ]; then
  RECALL_DATA_DIR="$DATA_DIR" npm run index -- --folder "$TARGET" --fake
else
  if [ "$WITH_VISION" -eq 1 ]; then
    RECALL_DATA_DIR="$DATA_DIR" npm run index -- --folder "$TARGET" --with-vision
  else
    RECALL_DATA_DIR="$DATA_DIR" npm run index -- --folder "$TARGET"
  fi
fi
ok "index written to $DATA_DIR/index.db"

# ------------------------------------------------------------------- verify

if [ "$NO_VERIFY" -eq 1 ]; then
  step "Setup complete (verification skipped)"
  if [ "$QUICK" -eq 1 ]; then
    printf '\n    %sNote: --quick means fake models. Re-run ./setup.sh without it for real OCR.\n\n' "$BOLD"
  fi
  printf '    Next:  %snpm run serve%s\n\n' "$BOLD" "$RESET"
  exit 0
fi

step "Verifying"

cd "$REPO_ROOT"
if npm run typecheck >/dev/null 2>&1; then
  ok "typecheck clean"
else
  fail "typecheck failed — run 'npm run typecheck' to see the errors"
fi

TEST_OUT="$(npm test 2>&1 || true)"
TEST_LINE="$(printf '%s' "$TEST_OUT" | grep -E '^ +Tests +' | tail -1 || true)"
if printf '%s' "$TEST_OUT" | grep -qE 'failed'; then
  printf '%s\n' "$TEST_OUT" | tail -20
  fail "tests failed"
fi
ok "tests ${TEST_LINE#*Tests }"

if [ "$SKIP_WEB" -eq 0 ]; then
  if (cd "$REPO_ROOT/web" && npm run build >/dev/null 2>&1); then
    ok "web UI builds"
  else
    fail "web build failed — run 'cd web && npm run build' to see the errors"
  fi
fi

if node scripts/docs-audit.mjs >/dev/null 2>&1; then
  ok "documentation matches the code"
else
  warn "docs are stale — run 'npm run docs:audit'"
fi

if bash scripts/lint-scripts.sh --quiet >/dev/null 2>&1; then
  ok "shell scripts lint clean"
else
  warn "shell script lint failed — run 'npm run lint:scripts'"
fi

# Prove the server actually answers, rather than assuming it does.
step "Smoke-testing the API"
cd "$REPO_ROOT"
RECALL_DATA_DIR="$DATA_DIR" npx tsx src/index/serve.ts >/tmp/recall-setup-server.log 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

READY=0
for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:5174/api/health >/dev/null 2>&1; then READY=1; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.25
done

if [ "$READY" -ne 1 ]; then
  cat /tmp/recall-setup-server.log
  fail "server did not become ready on 127.0.0.1:5174"
fi

ok "server responds on 127.0.0.1:5174"

HITS="$(curl -fsS "http://127.0.0.1:5174/api/search?q=lecture" \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).hits.length))}catch{process.stdout.write("?")}})' 2>/dev/null || echo '?')"
if [ "$HITS" != "0" ] && [ "$HITS" != "?" ]; then
  ok "search returns $HITS result(s)"
else
  warn "search returned no results — check that $TARGET contains images"
fi

cleanup
trap - EXIT

# --------------------------------------------------------------------- done

step "Setup complete"
cat <<EOF

    ${BOLD}Start the server:${RESET}
      cd $REPO_ROOT && RECALL_DATA_DIR=$DATA_DIR npm run serve

    ${BOLD}Start the UI${RESET} (in a second terminal):
      cd $REPO_ROOT/web && npm run dev
      then open http://127.0.0.1:5173

    ${BOLD}Re-index a different folder:${RESET}
      npm run index -- --folder ~/Pictures/Screenshots --fake --reset

    Index: $DATA_DIR/index.db

    ${DIM}Models were downloaded once, by scripts/fetch-models.sh. From here on
    Recall is fully offline: your images, index and queries never leave this
    machine. Nothing in the index or search path makes a network call.${RESET}

EOF