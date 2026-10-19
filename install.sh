#!/bin/bash
set -euo pipefail
umask 077

case "${1:-}" in
  --help|-h)
    printf 'Install Pocket on this Mac: ./install.sh [--yes]\n\n--yes keeps saved settings and uses defaults without setup questions.\n'
    exit 0
    ;;
esac

if [ "$(/usr/bin/uname -s)" != Darwin ]; then
  printf 'This installer requires macOS.\n' >&2
  exit 1
fi

pocket_root="$(cd "$(dirname "$0")" && pwd -P)"
pocket_runtime="$pocket_root/.local/node"
pocket_node_version=24.22.0
mkdir -p "$pocket_root/.local"

if ! "$pocket_runtime/bin/node" -e 'if (process.versions.node !== process.argv[1]) process.exit(1)' "$pocket_node_version" 2>/dev/null || [ ! -x "$pocket_runtime/bin/npm" ]; then
  case "$(/usr/bin/uname -m)" in
    arm64) pocket_arch=arm64 ;;
    x86_64) pocket_arch=x64 ;;
    *) printf 'Unsupported Mac architecture.\n' >&2; exit 1 ;;
  esac
  pocket_download="$(mktemp -d "$pocket_root/.local/node-download.XXXXXX")"
  trap 'rm -rf "${pocket_download:?}"' EXIT
  printf 'Downloading the private Node.js 24 runtime…\n'
  curl --fail --silent --show-error --location --proto '=https' --retry 3 \
    "https://nodejs.org/dist/v$pocket_node_version/SHASUMS256.txt" -o "$pocket_download/SHASUMS256.txt"
  pocket_archive="node-v$pocket_node_version-darwin-$pocket_arch.tar.gz"
  curl --fail --silent --show-error --location --proto '=https' --retry 3 \
    "https://nodejs.org/dist/v$pocket_node_version/$pocket_archive" -o "$pocket_download/$pocket_archive"
  pocket_expected="$(awk -v name="$pocket_archive" '$2 == name {print $1}' "$pocket_download/SHASUMS256.txt")"
  pocket_actual="$(/usr/bin/shasum -a 256 "$pocket_download/$pocket_archive" | awk '{print $1}')"
  if [ "$pocket_actual" != "$pocket_expected" ]; then
    printf 'Node.js download checksum did not match. Run the installer again.\n' >&2
    exit 1
  fi
  mkdir "$pocket_download/runtime"
  /usr/bin/tar -xzf "$pocket_download/$pocket_archive" --strip-components=1 -C "$pocket_download/runtime"
  if [ -e "$pocket_runtime" ]; then
    mv "$pocket_runtime" "$pocket_runtime.previous.$(/bin/date +%s)"
  fi
  mv "$pocket_download/runtime" "$pocket_runtime"
  rm -rf "${pocket_download:?}"
  trap - EXIT
fi

export PATH="$pocket_runtime/bin:$PATH"
cd "$pocket_root"
exec "$pocket_runtime/bin/node" "$pocket_root/scripts/install.mjs" "$@"
