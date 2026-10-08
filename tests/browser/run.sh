#!/bin/sh
# Real-browser smoke test. It loads the extension from this repository into a Chromium
# browser that still accepts --load-extension (Microsoft Edge, Chromium, Chrome for
# Testing; Google Chrome 137+ does not), points de.scalable.capital to a local fake
# server and drives an export over the DevTools protocol. Needs node, python3, openssl.
#
#   BROWSER=/path/to/browser CDP_PORT=9333 HTTPS_PORT=9443 sh tests/browser/run.sh
set -eu

BROWSER=${BROWSER:-"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"}
CDP_PORT=${CDP_PORT:-9333}
HTTPS_PORT=${HTTPS_PORT:-9443}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
SERVER_PID=""
BROWSER_PID=""

cleanup() {
  if [ -n "$BROWSER_PID" ]; then kill "$BROWSER_PID" 2>/dev/null || true; fi
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  sleep 1
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -days 1 \
  -subj "/CN=de.scalable.capital" -addext "subjectAltName=DNS:de.scalable.capital" >/dev/null 2>&1
mkdir -p "$WORK/downloads" "$WORK/profile/Default"
# chrome.downloads saves into the profile's download directory, without asking.
printf '{"download":{"default_directory":"%s","prompt_for_download":false,"directory_upgrade":true}}' "$WORK/downloads" \
  >"$WORK/profile/Default/Preferences"

python3 "$ROOT/tests/browser/fake_scalable.py" "$WORK/requests.jsonl" "$WORK/cert.pem" "$WORK/key.pem" "$HTTPS_PORT" &
SERVER_PID=$!

"$BROWSER" --headless=new --user-data-dir="$WORK/profile" --remote-debugging-port="$CDP_PORT" \
  --load-extension="$ROOT" --disable-extensions-except="$ROOT" \
  --host-resolver-rules="MAP de.scalable.capital 127.0.0.1" --ignore-certificate-errors \
  --window-size=1280,1000 --no-first-run --no-default-browser-check --disable-sync about:blank >"$WORK/browser.log" 2>&1 &
BROWSER_PID=$!

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then break; fi
  sleep 1
done

node "$ROOT/tests/browser/e2e.mjs" "$CDP_PORT" "$HTTPS_PORT" "$WORK"
