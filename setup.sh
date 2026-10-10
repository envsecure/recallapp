#!/usr/bin/env bash
#
# setup.sh — one-command setup for Recall on Linux.
#
# Installs dependencies, generates fixtures, runs the index, and verifies the
# whole thing works. Safe to re-run: every step is idempotent.
#
#   ./setup.sh                    # full setup + verification
#   ./setup.sh --skip-web         # skip the frontend (saves ~150 MB)
#   ./setup.sh --no-verify         # set up without running the checks
#   ./setup.sh --folder <path>     # index your own screenshots instead of fixtures
#   ./setup.sh --help
#
# Everything runs locally. No model weights are downloaded, ever (GOAL.md C1/C2) —
# this box cannot run them, so the indexer runs against deterministic fakes and
# says so.

set -euo pipefail

# ---------------------------------------------------------------- configuration

SKIP_WEB=0
NO_VERIFY=0
INDEX_FOLDER=""
DATA_DIR="${RECALL_DATA_DIR:-$HOME/.localrecall}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=5

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
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

# ------------------------------------------------------------------ arguments

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-web)  SKIP_WEB=1; shift ;;
    --no-verify) NO_VERIFY=1; shift ;;
    --folder)    INDEX_FOLDER="${2:-}"; [ -n "$INDEX_FOLDER" ] || fail "--folder needs a path"; shift 2 ;;
    --data-dir)  DATA_DIR="${2:-}"; [ -n "$DATA_DIR" ] || fail "--data-dir needs a path"; shift 2 ;;
    -h|--help)   usage ;;
    *)           fail "unknown option: $1  (try --help)" ;;
  esac
done

# --------------------------------------------------------------- preconditions

step "Checking prerequisites"

command -v node >/dev/null 2>&1 || fail "node not found. Install Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} first: https://nodejs.org"
command -v npm  >/dev/null 2>&1 || fail "npm not found. It ships with Node.js."

NODE_VERSION="$(node --version)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v\([0-9]*\)\..*/\1/')"
NODE_MINOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v[0-9]*\.\([0-9]*\).*/\1/')"

# node:sqlite landed in 22.5. Below that, install succeeds and the app crashes
# on first DB open — a confusing failure, so it is checked up front.
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  fail "Node $NODE_VERSION is too old. Recall needs >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} for the built-in node:sqlite module.
    Install a newer Node (nvm, apt, or https://nodejs.org) and re-run."
fi
ok "node $NODE_VERSION"

# node:sqlite is experimental before 22.12 and warns. Not fatal, but worth saying.
if [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; then
  warn "node:sqlite is experimental before 22.12 and will print a warning. Node 22.12+ is quieter."
fi

[ -d "$REPO_ROOT/src" ] || fail "cannot find src/ — run this script from inside the Recall repo"

AVAIL_KB="$(df -Pk "$REPO_ROOT" | awk 'NR==2 {print $4}')"
AVAIL_MB=$((AVAIL_KB / 1024))
if [ "$AVAIL_MB" -lt 500 ]; then
  warn "only ${AVAIL_MB} MB free — a full setup needs roughly 200 MB (70 MB deps + 150 MB web)"
else
  ok "${AVAIL_MB} MB free"
fi

info "repo:    $REPO_ROOT"
info "data:    $DATA_DIR"
info "node:    $NODE_VERSION"

# ------------------------------------------------------------------ install

step "Installing dependencies (server)"
cd "$REPO_ROOT"
npm install --no-audit --no-fund
ok "server dependencies installed"

if [ "$SKIP_WEB" -eq 0 ]; then
  step "Installing dependencies (web UI)"
  cd "$REPO_ROOT/web"
  npm install --no-audit --no-fund
  ok "web dependencies installed"
else
  warn "skipping web UI (--skip-web)"
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

# --fake is mandatory: this build has no runnable model adapters, by design.
RECALL_DATA_DIR="$DATA_DIR" npm run index -- --folder "$TARGET" --fake
ok "index written to $DATA_DIR/index.db"

# ------------------------------------------------------------------- verify

if [ "$NO_VERIFY" -eq 1 ]; then
  step "Setup complete (verification skipped)"
  printf '\n    Next:  %snpm run serve%s\n\n' "$BOLD" "$RESET"
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

# Prove the server actually answers, rather than assuming it does.
step "Smoke-testing the API"
cd "$REPO_ROOT"
RECALL_DATA_DIR="$DATA_DIR" npx tsx src/index/dev.ts >/tmp/recall-setup-server.log 2>&1 &
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

    ${DIM}Note: the indexer ran against deterministic fakes. This machine cannot
    download or run AI models (GOAL.md C1/C2), so no model weights were fetched
    and search quality is unverified. See docs/runbook.md §6.${RESET}

EOF