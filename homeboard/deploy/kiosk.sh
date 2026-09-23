#!/usr/bin/env bash
# Opens the dashboard full screen in Chromium. The installer sets this to run at login.
# Only one copy runs at a time, and Chromium is restarted if it crashes.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec 9>"${XDG_RUNTIME_DIR:-/tmp}/homeboard-kiosk.lock"
flock -n 9 || exit 0

PORT="$(cd "$DIR" && node -e 'try{console.log(require("./config.json").port||3000)}catch(e){console.log(3000)}' 2>/dev/null)"
URL="${HOMEBOARD_URL:-http://localhost:${PORT:-3000}}"
DELAY="$(cd "$DIR" && node -e 'try{console.log(require("./config.json").display.startupDelaySeconds||60)}catch(e){console.log(60)}' 2>/dev/null)"

# The server starts in parallel at boot, so wait until it answers.
until curl -sf "$URL/api/config" >/dev/null 2>&1; do sleep 1; done

# The server answering only means the server is ready, not that the desktop itself has finished settling
# (screen rotation, output setup) right after login. Launching the kiosk browser too early can leave it
# showing a gray, never-repainted window even though opening Chromium by hand a bit later works fine.
# A pause here (only on this first launch, not on crash-restarts below) gives the desktop time to catch up.
# The installer asks for this number (config.json: display.startupDelaySeconds); 60 is what a Pi 3 needs,
# a Pi 4 or 5 can often get away with less.
sleep "${DELAY:-60}"

# X11 only: stop the screen sleeping. (On Wayland the installer uses raspi-config instead.)
if command -v xset >/dev/null 2>&1 && [ -n "${DISPLAY:-}" ]; then
  xset s off; xset s noblank; xset -dpms
fi

BROWSER="$(command -v chromium-browser || command -v chromium)"
if [ -z "$BROWSER" ]; then echo "Chromium is not installed." >&2; exit 1; fi

# A mouse cursor left untouched since boot can sit visible on screen (e.g. over the clock) until moved at
# least once - Chromium only hides it via CSS once it sees real pointer activity. The installer sets up a
# labwc keybind (rc.xml) that hides and parks the cursor off-screen; this fires it once, a few seconds
# after Chromium opens, so nobody has to touch the mouse for it to disappear. Does nothing if wtype (or the
# keybind) is not set up, e.g. on a non-labwc desktop.
command -v wtype >/dev/null 2>&1 && (sleep 5 && wtype -M alt -M logo -P h >/dev/null 2>&1) &

# If the screen stays gray, this is what Chromium itself printed. Kept only for this login (cleared on reboot).
LOG="${XDG_RUNTIME_DIR:-/tmp}/homeboard-kiosk.log"
: >"$LOG"

while true; do
  echo "=== $(date -Is 2>/dev/null || date) starting Chromium ===" >>"$LOG"
  # On this Pi, Chromium's GPU/EGL context creation is broken (tried --use-gl=egl, --use-gl=angle,
  # --use-gl=egl-angle, and --use-angle=gl on their own; all still left the screen gray, either from a
  # refused ES 3.0 context or the flag itself being rejected). Rather than keep guessing at GPU backend
  # names, --disable-gpu turns hardware acceleration off entirely so Chromium paints in software instead -
  # slower for animations, but this dashboard is mostly static text and photos, and it actually renders.
  "$BROWSER" \
    --kiosk "$URL" \
    --incognito --no-first-run --noerrdialogs --disable-infobars \
    --disable-session-crashed-bubble --disable-translate \
    --password-store=basic --ozone-platform-hint=auto \
    --disable-gpu \
    --check-for-update-interval=31536000 \
    --overscroll-history-navigation=0 \
    >>"$LOG" 2>&1
  code=$?
  echo "=== $(date -Is 2>/dev/null || date) Chromium exited with code $code ===" >>"$LOG"
  [ "$code" -eq 0 ] && break   # closed on purpose (Alt+F4): stay closed
  sleep 5                      # crashed: start again
done
