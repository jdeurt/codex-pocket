#!/bin/bash
set -euo pipefail
umask 077

case "${1:-}" in
  --help|-h)
    printf 'Install or update Pocket on this Mac: bash install.sh [--yes|--update]\n\n--yes keeps saved settings and uses defaults without setup questions.\n--update also skips installation when the accepted release is current.\n'
    exit 0
    ;;
esac
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --yes ] && [ "$1" != --update ]; }; then
  printf 'Usage: install.sh [--yes|--update]\n' >&2
  exit 1
fi
pocket_update_only=false
if [ "${1:-}" = --update ]; then
  pocket_update_only=true
  set -- --yes
fi

if [ "$(/usr/bin/uname -s)" != Darwin ]; then
  printf 'This installer requires macOS.\n' >&2
  exit 1
fi

pocket_home="$HOME/.pocket"
pocket_root="$pocket_home/source"
pocket_node_version=24.22.0
pocket_runtime="$pocket_home/runtimes/node-$pocket_node_version"
pocket_download=""
mkdir -p "$pocket_home/runtimes"
if ! mkdir "$pocket_home/bootstrap.lock" 2>/dev/null; then
  printf 'Another Pocket update is active. If it was interrupted, remove ~/.pocket/bootstrap.lock and retry.\n' >&2
  exit 1
fi
pocket_cleanup() {
  if [ -n "$pocket_download" ]; then rm -rf "${pocket_download:?}"; fi
  rmdir "$pocket_home/bootstrap.lock"
}
trap pocket_cleanup EXIT

if [ -d "$pocket_root/.git" ]; then
  if [ -n "$(git -C "$pocket_root" status --porcelain)" ]; then
    printf 'The managed ~/.pocket/source checkout has local changes. Save them elsewhere before updating.\n' >&2
    exit 1
  fi
  git -C "$pocket_root" fetch origin main
  if [ "$pocket_update_only" = true ] && [ -f "$pocket_home/current/.pocket-source-revision" ] &&
    [ "$(cat "$pocket_home/current/.pocket-source-revision")" = "$(git -C "$pocket_root" rev-parse FETCH_HEAD)" ]; then
    printf 'Pocket is already up to date.\n'
    exit 0
  fi
  git -C "$pocket_root" checkout --detach FETCH_HEAD
elif [ -e "$pocket_root" ]; then
  printf '~/.pocket/source exists but is not a Git checkout. Move it aside before installing.\n' >&2
  exit 1
else
  git clone --branch main --single-branch https://github.com/jdeurt/codex-pocket.git "$pocket_root"
fi

if ! "$pocket_runtime/bin/node" -e 'if (process.versions.node !== process.argv[1]) process.exit(1)' "$pocket_node_version" 2>/dev/null || [ ! -x "$pocket_runtime/bin/npm" ]; then
  case "$(/usr/bin/uname -m)" in
    arm64) pocket_arch=arm64 ;;
    x86_64) pocket_arch=x64 ;;
    *) printf 'Unsupported Mac architecture.\n' >&2; exit 1 ;;
  esac
  pocket_download="$(mktemp -d "$pocket_home/node-download.XXXXXX")"
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
  pocket_download=""
fi

export PATH="$pocket_runtime/bin:$PATH"
cd "$pocket_root"
if [ -t 1 ] && [ -r /dev/tty ]; then
  "$pocket_runtime/bin/node" "$pocket_root/scripts/install.mjs" "$@" </dev/tty
else
  "$pocket_runtime/bin/node" "$pocket_root/scripts/install.mjs" "$@"
fi
