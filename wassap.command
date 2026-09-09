#!/bin/bash
# Double-click this on macOS to open the wassap dashboard.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org"
  read -r -p "Press return to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing dependencies. This takes a few minutes..."
  npm install || { echo "Install failed."; read -r -p "Press return to close."; exit 1; }
fi

echo "Starting wassap. Close this window when you are done."
node bin/wassap.js ui --open
