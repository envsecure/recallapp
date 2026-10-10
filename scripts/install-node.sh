#!/usr/bin/env bash
#
# install-node.sh — get Node.js >= 22.5 with npm, on Linux.
#
# Recall needs Node >= 22.5 because it uses the built-in node:sqlite module.
# Most distributions' own repositories ship something older — Ubuntu 24.04
# offers Node 18, which is not enough — so this prefers a source that actually
# carries a new enough version.
#
#   ./scripts/install-node.sh              # pick the best available method
#   ./scripts/install-node.sh --check      # report status, change nothing
#   ./scripts/install-node.sh --method nvm # force: nvm | nodesource | apt | skip
#   ./scripts/install-node.sh --method nodesource
#
# Methods, in the order they are tried:
#   nvm        installs into $HOME, no sudo, per-user. Safest default.
#   nodesource apt repo, system-wide. Needs sudo.
#   apt        distribution packages. Only used if they are new enough.
#
# Nothing here is Recall-specific; it is a careful Node installer.

set -euo pipefail

MIN_MAJOR=22
MIN_MINOR=5
METHOD=""
CHECK_ONLY=0
LOG="/tmp/recall-node-install.$$"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else BOLD=''; GREEN=''; YELLOW=''; RED=''; BLUE=''; RESET=''; fi

step() { printf '\n%s==>%s %s%s%s\n' "$BLUE" "$RESET" "$BOLD" "$1" "$RESET"; }
info() { printf '    %s\n' "$1"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --method)  METHOD="${2:?--method needs a value}"; shift 2 ;;
    --check)   CHECK_ONLY=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown option: $1" ;;
  esac
done

trap 'rm -f "$LOG"' EXIT

# ------------------------------------------------------------------ detection

have_node() { command -v node >/dev/null 2>&1; }

node_version() { node --version 2>/dev/null || echo "0.0.0"; }

# Is the installed Node new enough? Compares major/minor numerically.
node_is_current() {
  have_node || return 1
  local v maj min
  v="$(node_version)"
  maj="$(printf '%s' "$v" | sed 's/^v\([0-9]*\)\..*/\1/')"
  min="$(printf '%s' "$v" | sed 's/^v[0-9]*\.\([0-9]*\).*/\1/')"
  [ "$maj" -gt "$MIN_MAJOR" ] && return 0
  [ "$maj" -eq "$MIN_MAJOR" ] && [ "$min" -ge "$MIN_MINOR" ] && return 0
  return 1
}

# Where did this node come from? A node on PATH from a tool directory is not
# the user's system node — telling them "you already have Node" because of a
# private toolchain is how you end up with a node that disappears on logout.
node_origin() {
  have_node || { echo "none"; return; }
  local p
  p="$(command -v node)"
  case "$p" in
    /usr/bin/*|/usr/local/bin/*) echo "system" ;;
    *) echo "other ($p)" ;;
  esac
}

distro_id() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "${ID:-unknown}"
  else
    echo "unknown"
  fi
}

need_sudo() { [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; }

# --------------------------------------------------------------------- report

step "Checking Node.js"
if have_node; then
  ok "node $(node_version) at $(command -v node)"
  info "origin: $(node_origin)"
else
  info "node not found on PATH"
fi
if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm --version 2>/dev/null || echo '?')"
else
  info "npm not found"
fi
info "distro:  $(distro_id)   required: >= ${MIN_MAJOR}.${MIN_MINOR} (for node:sqlite)"

if node_is_current; then
  ok "Node is new enough — nothing to do"
  exit 0
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  warn "Node is missing or too old. Re-run without --check to install it."
  exit 1
fi

# ------------------------------------------------------------------- install

install_nvm() {
  info "installing nvm (no sudo, per-user)"
  local version="0.40.1"
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${version}/install.sh" -o "$LOG" \
    || { warn "could not download nvm"; return 1; }
  bash "$LOG" >>"$LOG.out" 2>&1 || { warn "nvm installer failed"; return 1; }

  # shellcheck disable=SC1091
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] || { warn "nvm did not install into \$NVM_DIR"; return 1; }
  . "$NVM_DIR/nvm.sh"

  nvm install "$MIN_MAJOR" >>"$LOG.out" 2>&1 || { warn "nvm install failed"; return 1; }
  nvm alias default "$MIN_MAJOR" >>"$LOG.out" 2>&1 || true
  nvm use "$MIN_MAJOR" >>"$LOG.out" 2>&1 || { warn "nvm use failed"; return 1; }

  node_is_current || { warn "nvm finished but node is still too old"; return 1; }
  ok "installed via nvm: node $(node_version), npm $(npm --version)"
  warn "nvm is per-user. Add this to your ~/.bashrc:"
  warn "    export NVM_DIR=\"\$HOME/.nvm\""
  warn "    [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\""
  return 0
}

install_nodesource() {
  need_sudo || { warn "nodesource needs sudo and it is not available"; return 1; }
  local major="$MIN_MAJOR"
  info "adding the NodeSource repository for Node ${major}.x"

  local tmp
  tmp="$(mktemp -d)"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${major}.x" -o "$tmp/setup.sh" \
      || { warn "could not fetch the NodeSource setup script"; rm -rf "$tmp"; return 1; }
    sudo bash "$tmp/setup.sh" >"$tmp/out" 2>&1 \
      || { warn "NodeSource setup failed:"; tail -5 "$tmp/out" | sed 's/^/      /'; rm -rf "$tmp"; return 1; }
  else
    warn "curl is required for the nodesource method"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"

  sudo apt-get install -y nodejs >>"$LOG.out" 2>&1 \
    || { warn "apt-get install nodejs failed; see $LOG.out"; return 1; }

  # apt's nodejs can shadow an older node earlier in PATH.
  hash -r 2>/dev/null || true
  node_is_current || { warn "node is still too old after install (something earlier in PATH?)"; return 1; }
  ok "installed via NodeSource: node $(node_version), npm $(npm --version)"
  return 0
}

install_apt() {
  need_sudo || { warn "apt needs sudo and it is not available"; return 1; }
  command -v apt-get >/dev/null 2>&1 || { warn "apt-get not found"; return 1; }
  info "checking whether the distribution ships Node >= ${MIN_MAJOR}.${MIN_MINOR}"

  local candidate
  candidate="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ {print $2}' | head -1)"
  local cmaj cmin
  if [ -n "${candidate:-}" ] && [ "$candidate" != "(none)" ]; then
    cmaj="$(printf '%s' "$candidate" | sed 's/[^0-9]*\([0-9]*\).*/\1/')"
    cmin="$(printf '%s' "$candidate" | sed 's/^[0-9]*\.\([0-9]*\).*/\1/')"
    info "distribution candidate: $candidate"
    if [ "${cmaj:-0}" -lt "$MIN_MAJOR" ]; then
      warn "too old (${candidate} < ${MIN_MAJOR}.${MIN_MINOR}). Use --method nodesource instead."
      return 1
    fi
  else
    warn "could not determine the candidate version"
    return 1
  fi

  sudo apt-get update >"$LOG.out" 2>&1 || true
  sudo apt-get install -y nodejs npm >>"$LOG.out" 2>&1 \
    || { warn "apt-get install failed; see $LOG.out"; return 1; }
  hash -r 2>/dev/null || true
  node_is_current || { warn "node is still too old after install"; return 1; }
  ok "installed via apt: node $(node_version), npm $(npm --version)"
  return 0
}

# Pick a method: an explicit request wins, otherwise try in order of safety.
run_method() {
  case "$METHOD" in
    nvm)        install_nvm ;;
    nodesource) install_nodesource ;;
    apt)        install_apt ;;
    skip)       warn "--method skip: not installing anything"; return 1 ;;
    "")         install_nvm || install_nodesource || install_apt ;;
    *)          die "unknown method: $METHOD (nvm | nodesource | apt | skip)" ;;
  esac
}

case "${METHOD:-}" in
  "")     warn "no sudo found — will try nvm, which needs none" ;;
  skip)   die "cannot skip: Node >= ${MIN_MAJOR}.${MIN_MINOR} is required" ;;
esac

step "Installing Node.js >= ${MIN_MAJOR}.${MIN_MINOR}"
if run_method; then
  step "Done"
  ok "node $(node_version), npm $(npm --version)"
  info "If a new terminal still cannot find node, reload your shell:"
  info "    source ~/.bashrc"
else
  step "Automatic install failed"
  cat <<EOF

    Install Node manually, then re-run ./setup.sh. Any of these works:

      ${BOLD}nvm${RESET} (recommended, no sudo)
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
        nvm install 22 && nvm alias default 22

      ${BOLD}NodeSource${RESET} (system-wide, needs sudo)
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs

      ${BOLD}Distribution packages${RESET} (needs sudo, may be too old)
        sudo apt-get install -y nodejs npm
        node --version   # must be >= ${MIN_MAJOR}.${MIN_MINOR}

    Why the version matters: Recall uses Node's built-in node:sqlite module,
    which does not exist before Node ${MIN_MAJOR}.${MIN_MINOR}. A Node that is merely
    present but too old will fail when the index is opened, not at install time.

EOF
  exit 1
fi