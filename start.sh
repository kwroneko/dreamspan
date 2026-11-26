#!/bin/sh

cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 24.11 or later from https://nodejs.org/ and run ./start.sh again." >&2
  exit 1
fi
exec node scripts/start.mjs "$@"
