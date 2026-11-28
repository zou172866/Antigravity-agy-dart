#!/usr/bin/env sh
# One-command installer for agy-dart (supports both `curl -fsSL .../install.sh | sh` and local repo runs)
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 22.16+ (22.x) or 24+ with built-in SQLite FTS5: https://nodejs.org/" >&2
  exit 1
fi

SCRIPT_DIR=""
case "${0:-}" in
  */*)
    if [ -f "$0" ]; then
      SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
    fi
    ;;
esac

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/scripts/install.mjs" ]; then
  if [ "$#" -eq 0 ]; then
    exec node "$SCRIPT_DIR/scripts/install.mjs" install
  else
    exec node "$SCRIPT_DIR/scripts/install.mjs" "$@"
  fi
fi

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t 'agy-dart-install')"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

REPO_DIR="$TMP_DIR/repo"
if command -v git >/dev/null 2>&1; then
  echo "[agy-dart] Fetching latest release from GitHub..."
  git clone --depth 1 --branch v1.10.1 --quiet "https://github.com/zou172866/Antigravity-agy-dart.git" "$REPO_DIR"
elif command -v curl >/dev/null 2>&1; then
  echo "[agy-dart] Downloading archive from GitHub..."
  mkdir -p "$REPO_DIR"
  curl -fsSL "https://github.com/zou172866/Antigravity-agy-dart/archive/refs/tags/v1.10.1.tar.gz" | tar -xz --strip-components=1 -C "$REPO_DIR"
elif command -v wget >/dev/null 2>&1; then
  echo "[agy-dart] Downloading archive from GitHub..."
  mkdir -p "$REPO_DIR"
  wget -qO- "https://github.com/zou172866/Antigravity-agy-dart/archive/refs/tags/v1.10.1.tar.gz" | tar -xz --strip-components=1 -C "$REPO_DIR"
elif command -v tar >/dev/null 2>&1; then
  echo "[agy-dart] Downloading archive from GitHub via Node.js..."
  mkdir -p "$REPO_DIR"
  node -e 'fetch("https://github.com/zou172866/Antigravity-agy-dart/archive/refs/tags/v1.10.1.tar.gz").then(r=>{if(!r.ok)process.exit(1);return r.arrayBuffer()}).then(b=>process.stdout.write(Buffer.from(b))).catch(()=>process.exit(1))' | tar -xz --strip-components=1 -C "$REPO_DIR"
else
  echo "Error: git, curl, wget, or tar is required for remote installation." >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  node "$REPO_DIR/scripts/install.mjs" install
else
  node "$REPO_DIR/scripts/install.mjs" "$@"
fi
