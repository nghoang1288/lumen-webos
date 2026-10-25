#!/bin/sh
# Builds the .ipk and installs it on the TV over SSH, then launches it: npm run deploy
# Needs LUMEN_TV_HOST in .env (an ssh alias, or root@<tv-ip>; the TV is rooted with SSH on). Uses webOS's developer install service, the same
# one the Homebrew Channel and ares-install use. Nothing outside the app's own directory is touched.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/tools/env.sh"
[ -n "$LUMEN_TV_HOST" ] || { echo "LUMEN_TV_HOST is not set. Copy .env.example to .env and set it." >&2; exit 1; }
LUMEN_BUILD_DIR=${LUMEN_BUILD_DIR:-$ROOT/build}
export LUMEN_BUILD_DIR
sh "$ROOT/tools/build_ipk.sh"

APP_ID=$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' "$ROOT/app/dist/appinfo.json" | head -1)
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/app/dist/appinfo.json" | head -1)
IPK="$LUMEN_BUILD_DIR/${APP_ID}_${VERSION}_all.ipk"
[ -f "$IPK" ] || { echo "Not found: $IPK" >&2; exit 1; }

REMOTE_IPK="/tmp/$(basename "$IPK")"
echo "Copying $(basename "$IPK") to $LUMEN_TV_HOST..."
scp -q "$IPK" "$LUMEN_TV_HOST:$REMOTE_IPK"

echo "Closing $APP_ID before install to prevent webOS 5 SAM deadlock..."
ssh -tt "$LUMEN_TV_HOST" "touch /tmp/allow_lg_home; luna-send -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"com.webos.app.home\"}' >/dev/null 2>&1 || true; luna-send -n 1 luna://com.webos.applicationManager/closeByAppId '{\"id\":\"$APP_ID\"}' >/dev/null 2>&1 || true; sleep 2" | tr -d '\r'

echo "Installing $APP_ID..."
INSTALL_OUTPUT=$(ssh -tt "$LUMEN_TV_HOST" "luna-send -w 60000 -i luna://com.webos.appInstallService/dev/install '{\"id\":\"com.ares.defaultName\",\"ipkUrl\":\"$REMOTE_IPK\",\"subscribe\":true}'; rm -f '$REMOTE_IPK'" | tr -d '\r')
echo "$INSTALL_OUTPUT" | grep -oE '"state"[[:space:]]*:[[:space:]]*"[^"]*"|"errorText"[[:space:]]*:[[:space:]]*"[^"]*"' | uniq || true

if echo "$INSTALL_OUTPUT" | grep -qiE 'INSTALL_COMPLETED|"state"[[:space:]]*:[[:space:]]*"(SUCCESS|installed)"' && ! echo "$INSTALL_OUTPUT" | grep -qiE '"errorText"|"state"[[:space:]]*:[[:space:]]*"FAILED"'; then
  echo "Installed $APP_ID successfully."
else
  echo "Installation of $APP_ID failed!" >&2
  exit 1
fi

echo "Launching $APP_ID..."
ssh -tt "$LUMEN_TV_HOST" "luna-send -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"$APP_ID\"}'" | tr -d '\r'
