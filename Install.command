#!/bin/bash
set -u
pocket_root="$(cd "$(dirname "$0")" && pwd -P)"
"$pocket_root/install.sh" "$@"
pocket_status=$?
if [ -t 0 ]; then
  printf '\nPress Return to close this installer.\n'
  read -r
fi
exit "$pocket_status"
