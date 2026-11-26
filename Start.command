#!/bin/bash

cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

# Finder may not load the shell profile that selects an nvm installation.
if ! command -v node >/dev/null 2>&1; then
  nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$nvm_dir/nvm.sh" ]; then
    export NVM_DIR="$nvm_dir"
    . "$NVM_DIR/nvm.sh" --no-use
    nvm use 24 >/dev/null 2>&1 || nvm use default >/dev/null 2>&1
  fi
fi

if command -v node >/dev/null 2>&1; then
  node scripts/start.mjs "$@"
  status=$?
else
  echo "Install Node.js 24.11 or later from https://nodejs.org/ and open Start.command again."
  status=1
fi
if [ "$status" -ne 0 ]; then
  read -r -n 1 -p "Press any key to close..."
  echo
fi
exit "$status"
