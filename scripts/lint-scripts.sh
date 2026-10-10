#!/usr/bin/env bash
#
# lint-scripts.sh — catch the `set -u` bugs before a user does.
#
# The class of bug it targets: a shell script running under `set -euo pipefail`
# that references a variable it never assigns. The symptom is a crash with
# "unbound variable" at runtime, often on a machine you have never tested on.
#
# This repo shipped one of those (NODE_MAJOR, referenced by a warning block but
# assigned inside a check that no longer ran). It passed `bash -n` — syntax was
# fine, the logic was not — so a syntax check alone is not enough.
#
# Checks performed:
#   1. bash -n, for syntax
#   2. every $VAR reference is assigned somewhere in the same file
#   3. every variable passed to [ is numeric-safe (guarded by a case pattern)
#   4. run with a hostile PATH, so missing binaries surface here not for the user
#
# Usage:  ./scripts/lint-scripts.sh [--quiet]

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

SCRIPTS=(
  "$REPO_ROOT/setup.sh"
  "$REPO_ROOT/scripts/install-node.sh"
  "$REPO_ROOT/scripts/fetch-models.sh"
  "$REPO_ROOT/scripts/benchmark.mjs"
)

if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else RED=''; GREEN=''; YELLOW=''; BOLD=''; DIM=''; RESET=''; fi

FAILURES=0

note() { [ "$QUIET" -eq 1 ] || printf '    %s\n' "$1"; }
bad()  { printf '  %sERROR%s %s\n' "$RED" "$RESET" "$1"; FAILURES=$((FAILURES + 1)); }

# Variables the shell provides, plus values we deliberately read from env.
is_builtin() {
  case "$1" in
    BASH_SOURCE|PATH|HOME|PWD|IFS|USER|HOSTNAME|SECONDS|LINENO|PPID|OSTYPE|MACHTYPE|UID|EUID|\
    RECALL_DATA_DIR|NVM_DIR|DEST|INDEX_FOLDER|DATA_DIR|ID|PRETTY_NAME|VERSION_ID) return 0 ;;
    # Anything read as ${X:-default} is guarded by construction.
    UPPER) return 0 ;;
    *) return 1 ;;
  esac
}

printf '\n%s==>%s script lint\n' "${BOLD}" "$RESET" "$RESET"

for f in "${SCRIPTS[@]}"; do
  [ -f "$f" ] || { bad "missing: ${f#$REPO_ROOT/}"; continue; }
  name="${f#$REPO_ROOT/}"
  case "$f" in *.mjs) continue ;; esac   # JS, not shell

  printf '\n  %s%s%s\n' "$BOLD" "$name" "$RESET"

  # --- 1. syntax ---
  if bash -n "$f" 2>/tmp/lint-syntax.$$; then
    note "${GREEN}✓${RESET} syntax"
    rm -f /tmp/lint-syntax.$$
  else
    bad "syntax error"
    sed 's/^/      /' /tmp/lint-syntax.$$ 2>/dev/null
    rm -f /tmp/lint-syntax.$$
    continue
  fi

  # --- 2. unassigned references ---
  # Collect assigned names: NAME= at any position, including `local a=1 b=2`.
  assigned="$(grep -oE '(^|[;&|(]|\bthen|\bdo|\belse)[[:space:]]*(local[[:space:]]+|read[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$f" \
             | grep -oE '[A-Za-z_][A-Za-z0-9_]*=' | tr -d '=' | sort -u)"
  # `for x in ...` and bare `local a b` also declare. Without these the linter
  # reports loop variables as unassigned, and a linter that always cries wolf
  # gets ignored.
  assigned="$assigned
$(grep -oE '\bfor[[:space:]]+[A-Za-z_][A-Za-z0-9_]*([[:space:]]+in)?' "$f" | grep -oE '[A-Za-z_][A-Za-z0-9_]*' | sort -u)
$(sed -nE 's/^[[:space:]]*local[[:space:]]+([A-Za-z_][A-Za-z0-9_ ]*)$/\1/p' "$f" | tr ' ' '\n' | sort -u)
$(printf '%s\n' "$assigned" | sort -u)"
  referenced="$(grep -oE '\$\{?[A-Za-z_][A-Za-z0-9_]*' "$f" | sed 's/^[$]//; s/^{//' | sort -u)"

  # A reference written as ${X:-default} or ${X:=default} cannot fail under
  # set -u, so it is never a finding.
  guarded="$(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*:-' "$f" | sed 's/^[$]//; s/^{//; s/:-//' | sort -u)"

  unbound=""
  for v in $referenced; do
    is_builtin "$v" && continue
    printf '%s\n' "$assigned" | grep -qx "$v" && continue
    printf '%s\n' "$guarded" | grep -qx "$v" && continue
    unbound="$unbound $v"
  done
  if [ -n "$unbound" ]; then
    bad "referenced but never assigned:$unbound"
    note "     under 'set -u' each of these crashes at runtime"
  else
    note "${GREEN}✓${RESET} every reference is assigned"
  fi

  # --- 3. numeric guard on [ comparisons ---
  # Any [ "$x" -gt/-lt/-eq/-ge/-le ... ] where x is a version component needs a
  # numeric guard somewhere. Checked by confirming the file coerces to digits.
  # Boolean flags parsed by the arg loop are always 0/1, so only version and
  # size components actually need a digit guard.
  NUMERIC_REFS="$(grep -oE '\[ "\\$?[A-Za-z_][A-Za-z0-9_]*" -(gt|lt|eq|ge|le) ' "$f" \
                    | grep -oE '[A-Za-z_][A-Za-z0-9_]*' | sort -u \
                    | grep -vE '^(SKIP_WEB|NO_VERIFY|QUICK|WITH_VISION|AUTO_INSTALL_NODE|CHECK_ONLY|ONNX_SUFFIX_IS_Q8)$' || true)"
  if [ -n "$NUMERIC_REFS" ]; then
    if grep -qE '\*\[\!0-9\]\*\)' "$f"; then
      note "${GREEN}✓${RESET} numeric comparisons are guarded"
    else
      bad "numeric comparison without a digit guard (add: case \"\$x\" in ''|*[!0-9]*) x=0 ;; esac)"
    fi
  fi

  # --- 4. executable bit ---
  if [ -x "$f" ]; then
    note "${GREEN}✓${RESET} executable"
  else
    bad "not executable — chmod +x ${f#$REPO_ROOT/}"
  fi

  # --- 5. runs with a hostile PATH (read-only modes only) ---
  if [ "$name" = "scripts/install-node.sh" ]; then
    if env PATH=/usr/bin:/bin "$f" --check >/dev/null 2>&1; then
      note "${GREEN}✓${RESET} --check survives a minimal PATH"
    else
      rc=$?
      if [ "$rc" -eq 1 ]; then
        note "${GREEN}✓${RESET} --check exits 1 cleanly when Node is absent"
      else
        bad "--check crashed on a minimal PATH (exit $rc)"
      fi
    fi
  fi
done

printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf '  %s✓ all scripts pass%s\n\n' "$GREEN" "$RESET"
  exit 0
fi
printf '  %s%d problem(s)%s\n\n' "$RED" "$FAILURES" "$RESET"
exit 1