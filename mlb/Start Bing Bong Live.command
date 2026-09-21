#!/bin/bash
# Double-click to launch Bing Bong Live, then it opens in your browser.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Bing Bong Live needs Node.js 18 or newer: https://nodejs.org"
  read -r -p "Press Return to close."
  exit 1
fi
PORT="${PORT:-4747}"
( sleep 2; open "http://localhost:$PORT" ) &
PORT="$PORT" node server.js
