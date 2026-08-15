#!/usr/bin/env bash
# Shared helpers for the Cursor Cloud environment scripts.
#
# Source this file; do not execute it directly. It provides deterministic Node
# resolution (honouring .nvmrc / package.json engines), version reporting, and a
# non-destructive artifact directory resolver. It never hides warnings globally
# and fails early when the active Node version does not satisfy the engine range.
#
# shellcheck shell=bash

# Repository root (directory containing this script's parent).
CC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CC_ROOT

# Read the canonical Node version from .nvmrc (the repository source of truth).
cc_required_node() {
  tr -d ' \t\r\n' <"$CC_ROOT/.nvmrc"
}

# True when version $1 is >= version $2 (dot-separated, numeric).
cc_ver_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

# True when a `node` is on PATH and satisfies the required version.
cc_node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local cur
  cur="$(node -v 2>/dev/null | sed 's/^v//')"
  [ -n "$cur" ] && cc_ver_ge "$cur" "$1"
}

# Ensure a compliant Node is on PATH. Prefer an already-compliant node; otherwise
# use nvm (part of the standard Cursor base image) to install/use the .nvmrc
# version and prepend its bin dir. Never relies on interactive `nvm use`.
cc_ensure_node() {
  local required
  required="$(cc_required_node)"

  if cc_node_ok "$required"; then
    return 0
  fi

  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$nvm_dir/nvm.sh" ]; then
    # nvm.sh is not clean under `set -eu`; relax while sourcing/using it.
    set +eu
    # shellcheck disable=SC1091
    . "$nvm_dir/nvm.sh"
    nvm install "$required" >/dev/null 2>&1 || nvm install >/dev/null 2>&1 || true
    local bindir
    bindir="$(nvm which "$required" 2>/dev/null | xargs -r dirname 2>/dev/null || true)"
    set -eu
    if [ -n "$bindir" ] && [ -x "$bindir/node" ]; then
      PATH="$bindir:$PATH"
      export PATH
    fi
  fi
}

# Fail early with a clear message when the active Node is incompatible.
cc_assert_node() {
  local required
  required="$(cc_required_node)"
  if ! cc_node_ok "$required"; then
    local engines
    engines="$(node -e "process.stdout.write(require('$CC_ROOT/package.json').engines.node)" 2>/dev/null || echo '>='"$required")"
    {
      echo "ERROR: incompatible Node version."
      echo "  required : $required (package.json engines.node: $engines)"
      echo "  active   : $(command -v node >/dev/null 2>&1 && node -v || echo 'none on PATH')"
      echo "  fix      : install Node $required (e.g. 'nvm install' using .nvmrc) and retry."
    } >&2
    exit 1
  fi
}

# Print the runtime versions relevant to this project to stdout.
cc_print_versions() {
  echo "timestamp   : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "os          : $(uname -srm)"
  echo "node        : $(command -v node >/dev/null 2>&1 && node -v || echo 'none')"
  echo "npm         : $(command -v npm >/dev/null 2>&1 && npm -v || echo 'none')"
  echo "engines.node: $(node -e "process.stdout.write(require('$CC_ROOT/package.json').engines.node)" 2>/dev/null || echo 'unknown')"
  echo ".nvmrc      : $(cc_required_node)"
  local bin="$CC_ROOT/node_modules/.bin"
  [ -x "$bin/tsc" ] && echo "typescript  : $("$bin/tsc" -v 2>/dev/null)"
  [ -x "$bin/vitest" ] && echo "vitest      : $("$bin/vitest" -v 2>/dev/null | head -n1)"
  [ -x "$bin/biome" ] && echo "biome       : $("$bin/biome" --version 2>/dev/null)"
  if [ -f "$CC_ROOT/node_modules/@earendil-works/pi-coding-agent/package.json" ]; then
    echo "pi-host     : $(node -p "require('$CC_ROOT/node_modules/@earendil-works/pi-coding-agent/package.json').version" 2>/dev/null)"
  fi
}

# Refresh Debian packages and ensure Google Chrome stable is installed/updated.
# Runs only when passwordless sudo is available (Cursor Cloud image). Safe to
# skip on developer laptops without sudo so local installs stay fast.
cc_refresh_system_packages() {
  if ! command -v sudo >/dev/null 2>&1; then
    echo "apt refresh: skipped (sudo not available)"
    return 0
  fi
  if ! sudo -n true 2>/dev/null; then
    echo "apt refresh: skipped (passwordless sudo not available)"
    return 0
  fi

  echo "apt refresh: updating package indexes"
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -y

  echo "apt refresh: upgrading installed packages"
  sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends

  if apt-cache show google-chrome-stable >/dev/null 2>&1; then
    echo "apt refresh: ensuring google-chrome-stable"
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends google-chrome-stable
  else
    echo "apt refresh: google-chrome-stable not in apt sources (skipped)"
  fi

  if command -v google-chrome-stable >/dev/null 2>&1; then
    echo "chrome      : $(google-chrome-stable --version 2>/dev/null || echo unknown)"
  elif command -v google-chrome >/dev/null 2>&1; then
    echo "chrome      : $(google-chrome --version 2>/dev/null || echo unknown)"
  else
    echo "chrome      : not installed"
  fi
}

# Ensure the Pi.dev host CLI (`pi`) is on PATH and matches the repo's locked
# @earendil-works/pi-coding-agent version after npm ci. Prefers an already-correct
# PATH binary (Dockerfile install). Reinstalls with sudo when available, otherwise
# into ~/.local (user-writable) so Cloud install never hits EACCES on /usr/local.
cc_ensure_pi_cli() {
  local wanted wanted_pkg active npm_bin user_prefix
  if [ ! -f "$CC_ROOT/node_modules/@earendil-works/pi-coding-agent/package.json" ]; then
    echo "ERROR: local @earendil-works/pi-coding-agent missing; run npm ci first." >&2
    exit 1
  fi
  wanted="$(node -p "require('$CC_ROOT/node_modules/@earendil-works/pi-coding-agent/package.json').version")"
  wanted_pkg="@earendil-works/pi-coding-agent@$wanted"
  user_prefix="${HOME}/.local"
  npm_bin="$(npm prefix -g)/bin"

  # User-local npm bin first so a prior user install wins over a stale root one.
  if [ -d "$user_prefix/bin" ]; then
    case ":$PATH:" in
      *":$user_prefix/bin:"*) ;;
      *)
        PATH="$user_prefix/bin:$PATH"
        export PATH
        ;;
    esac
  fi
  case ":$PATH:" in
    *":$npm_bin:"*) ;;
    *)
      PATH="$npm_bin:$PATH"
      export PATH
      ;;
  esac
  hash -r 2>/dev/null || true

  active=""
  if command -v pi >/dev/null 2>&1; then
    active="$(pi --version 2>/dev/null | head -n1 | tr -d ' \t\r\n' || true)"
  fi
  if [ "$active" = "$wanted" ]; then
    echo "pi         : $(command -v pi) ($active)"
    return 0
  fi

  echo "pi ensure  : installing $wanted_pkg (have: ${active:-none})"
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo npm install -g --ignore-scripts "$wanted_pkg"
  else
    mkdir -p "$user_prefix"
    npm install -g --prefix "$user_prefix" --ignore-scripts "$wanted_pkg"
    PATH="$user_prefix/bin:$PATH"
    export PATH
  fi
  hash -r 2>/dev/null || true

  if ! command -v pi >/dev/null 2>&1; then
    echo "ERROR: pi CLI still not on PATH after install (npm bin: $npm_bin, user: $user_prefix/bin)." >&2
    exit 1
  fi

  active="$(pi --version 2>/dev/null | head -n1 | tr -d ' \t\r\n' || true)"
  if [ "$active" != "$wanted" ]; then
    echo "ERROR: pi version mismatch (active=$active wanted=$wanted path=$(command -v pi))." >&2
    exit 1
  fi
  echo "pi         : $(command -v pi) ($active)"
}

# Resolve a writable artifact directory. Prefers Cursor's artifact dir, falls
# back to a git-ignored local directory for non-Cursor environments.
cc_artifact_dir() {
  if [ -n "${CURSOR_ARTIFACTS_DIR:-}" ] && mkdir -p "$CURSOR_ARTIFACTS_DIR" 2>/dev/null; then
    echo "$CURSOR_ARTIFACTS_DIR"
    return 0
  fi
  if mkdir -p /opt/cursor/artifacts 2>/dev/null && [ -w /opt/cursor/artifacts ]; then
    echo /opt/cursor/artifacts
    return 0
  fi
  local d="$CC_ROOT/.cloud-artifacts"
  mkdir -p "$d"
  echo "$d"
}
