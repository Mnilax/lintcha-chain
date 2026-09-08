#!/usr/bin/env bash
# Console clean at load: serve a built tree, open every built page in headless Chrome or Edge with no interaction, and
# report every page error or console error. A page that only navigates is not a page that ran.
#   bash tests/console_check.sh [served-dir]      default site/dist
# Exit 1 when any page logs an error. Needs Chrome or Edge on the machine; no npm dependency.
set -u
DIR="${1:-site/dist}"
cd "$(dirname "$0")/.."
BROWSER=""
for c in "/c/Program Files/Google/Chrome/Application/chrome.exe" "/c/Program Files/Microsoft/Edge/Application/msedge.exe" "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "$(command -v google-chrome 2>/dev/null)" "$(command -v chromium 2>/dev/null)"; do
  [ -n "$c" ] && [ -x "$c" ] && { BROWSER="$c"; break; }
done
[ -z "$BROWSER" ] && { echo "no Chrome or Edge found"; exit 2; }
PORT=8799
python -m http.server $PORT --directory "$DIR" >/dev/null 2>&1 &
SRV=$!
sleep 1
pages=$(cd "$DIR" && find . -name "*.html" | sed 's#^\./##' | sort)
total=0; bad=0
for p in $pages; do
  total=$((total+1))
  url="http://localhost:$PORT/$p"
  log=$("$BROWSER" --headless=new --disable-gpu --no-first-run --no-default-browser-check --user-data-dir="$TEMP/lintcha-console-$$" --enable-logging=stderr --v=0 --virtual-time-budget=4000 --run-all-compositor-stages-before-draw "$url" 2>&1 >/dev/null | grep -E "CONSOLE\(|Uncaught|pageerror" | grep -viE "INFO:CONSOLE.*\"(i18n:|preview text)" | grep -E "Uncaught|ERROR|error" || true)
  if [ -n "$log" ]; then bad=$((bad+1)); echo "ERROR  /$p"; echo "$log" | sed 's/^/       /' | head -5; else echo "clean  /$p"; fi
done
kill $SRV 2>/dev/null
rm -rf "$TEMP/lintcha-console-$$" 2>/dev/null
echo "console check: $total pages, $bad with errors"
[ $bad -eq 0 ]
