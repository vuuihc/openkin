#!/usr/bin/env bash
# Bootstrap Kin's local development tools and JavaScript dependencies.
#
# Usage:
#   ./scripts/setup-dev.sh
#   make setup-dev
#
# Environment:
#   KIN_SETUP_NO_INSTALL=1  only check tools; do not install with Homebrew
#   KIN_SETUP_SKIP_NPM=1    skip ui/ and desktop/ npm dependency install

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GO_REQUIRED="$(awk '/^go[[:space:]]+[0-9]/{print $2; exit}' "$ROOT/go.mod")"
NODE_REQUIRED_MAJOR=20
NO_INSTALL="${KIN_SETUP_NO_INSTALL:-0}"
SKIP_NPM="${KIN_SETUP_SKIP_NPM:-0}"

info() {
  echo "==> $*"
}

warn() {
  echo "warning: $*" >&2
}

fail() {
  echo "error: $*" >&2
  exit 1
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

version_ge() {
  # Numeric dotted version compare: version_ge CURRENT REQUIRED
  local current="$1" required="$2"
  local current_parts required_parts i c r

  IFS=. read -r -a current_parts <<<"$current"
  IFS=. read -r -a required_parts <<<"$required"

  for i in 0 1 2; do
    c="${current_parts[$i]:-0}"
    r="${required_parts[$i]:-0}"
    c="${c//[^0-9]/}"
    r="${r//[^0-9]/}"
    c="${c:-0}"
    r="${r:-0}"
    if ((10#$c > 10#$r)); then
      return 0
    fi
    if ((10#$c < 10#$r)); then
      return 1
    fi
  done
  return 0
}

brew_install() {
  local formula="$1"
  if [[ "$NO_INSTALL" == "1" ]]; then
    fail "$formula is missing and KIN_SETUP_NO_INSTALL=1 is set"
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    fail "$formula is missing. Automatic install is only supported on macOS with Homebrew."
  fi
  if ! have_cmd brew; then
    fail "Homebrew is required to install $formula. Install it from https://brew.sh, then rerun this script."
  fi

  info "installing $formula with Homebrew"
  brew install "$formula"
  hash -r
}

check_xcode_tools() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi
  if xcode-select -p >/dev/null 2>&1; then
    info "Xcode command line tools found"
    return 0
  fi

  warn "Xcode command line tools are not installed"
  warn "macOS may prompt for installation; rerun this script after it completes"
  xcode-select --install >/dev/null 2>&1 || true
}

go_version() {
  go version 2>/dev/null | sed -nE 's/^go version go([0-9]+(\.[0-9]+){1,2}).*/\1/p'
}

ensure_go() {
  local current toolchain
  if ! have_cmd go; then
    brew_install go
  fi
  if ! have_cmd go; then
    fail "go is still not available on PATH after installation"
  fi

  current="$(go_version)"
  if [[ -z "$current" ]]; then
    fail "unable to parse Go version from: $(go version 2>/dev/null || true)"
  fi

  if version_ge "$current" "$GO_REQUIRED"; then
    info "Go $current found (required >= $GO_REQUIRED)"
    return 0
  fi

  warn "Go $current found; go.mod requires $GO_REQUIRED"
  if ! version_ge "$current" "1.21.0"; then
    fail "Go $current is too old to auto-download toolchains. Install Go $GO_REQUIRED or newer."
  fi

  toolchain="$(go env GOTOOLCHAIN 2>/dev/null || true)"
  case "$toolchain" in
    ""|auto|path|go*+auto|go*+path)
      warn "Go will use GOTOOLCHAIN=${toolchain:-auto} to resolve the required toolchain"
      ;;
    *)
      fail "GOTOOLCHAIN=$toolchain may block Go $GO_REQUIRED. Run: go env -w GOTOOLCHAIN=auto"
      ;;
  esac
}

node_major() {
  node --version 2>/dev/null | sed -nE 's/^v([0-9]+).*/\1/p'
}

ensure_node() {
  local major
  if ! have_cmd node || ! have_cmd npm; then
    brew_install node
  fi
  if ! have_cmd node; then
    fail "node is still not available on PATH after installation"
  fi
  if ! have_cmd npm; then
    fail "npm is still not available on PATH after installation"
  fi

  major="$(node_major)"
  if [[ -z "$major" ]]; then
    fail "unable to parse Node version from: $(node --version 2>/dev/null || true)"
  fi
  if ((major < NODE_REQUIRED_MAJOR)); then
    fail "Node $(node --version) found; Kin requires Node ${NODE_REQUIRED_MAJOR}+"
  fi

  info "Node $(node --version) and npm $(npm --version) found"
}

install_npm_deps() {
  local dir="$1"
  local label="$2"

  if [[ "$SKIP_NPM" == "1" ]]; then
    info "skipping $label npm dependencies"
    return 0
  fi

  info "installing $label npm dependencies"
  (
    cd "$ROOT/$dir"
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
  )
}

verify_desktop_rebuild_inputs() {
  local missing=()
  for cmd in go node npm; do
    if ! have_cmd "$cmd"; then
      missing+=("$cmd")
    fi
  done
  if ((${#missing[@]})); then
    fail "desktop rebuild prerequisites are still missing: ${missing[*]}"
  fi
}

check_xcode_tools
ensure_go
ensure_node
install_npm_deps ui "UI"
install_npm_deps desktop "desktop"
verify_desktop_rebuild_inputs

info "development environment is ready"
echo "Next: ./scripts/desktop-rebuild.sh"
