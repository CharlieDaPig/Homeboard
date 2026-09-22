#!/usr/bin/env bash
# Homeboard installer for Raspberry Pi OS (the version with the desktop).
#
#   bash deploy/install.sh              install or update (safe to run again)
#   bash deploy/install.sh --dry-run    show what it would do, change nothing
#   bash deploy/install.sh --uninstall  remove the startup entries (keeps your config and sign-in)
#
# Run it as your normal user, not with sudo. It asks for sudo only where needed.
set -Eeuo pipefail

# If anything below fails without one of our own plain-English messages, show exactly
# which line and command it was, so the error can be reported precisely instead of guessed at.
trap 'if [ -z "${HANDLED:-}" ]; then
  echo >&2
  echo "!! The installer stopped at line $LINENO, running: $BASH_COMMAND" >&2
  echo "!! Please send Claude this: run  bash -x \"$0\" 2>&1 | tail -40  and paste what it prints, plus  node -v" >&2
fi' ERR

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIOSK="$DIR/deploy/kiosk.sh"
MARK="deploy/kiosk.sh" # how we recognise our own autostart lines
UNIT=/etc/systemd/system/homeboard.service
LABWC_DIR="$HOME/.config/labwc"
LXDE_DIR="$HOME/.config/lxsession/LXDE-pi"
XDG_FILE="$HOME/.config/autostart/homeboard.desktop"
DRY=0
UNINSTALL=0

usage() { sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; HANDLED=1; exit 1 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
ok() { if [ "$DRY" = 1 ]; then printf "    (dry-run, nothing changed) %s\n" "$*"; else printf "    ok: %s\n" "$*"; fi; }
warn() { printf '    !! %s\n' "$*" >&2; }
run() { if [ "$DRY" = 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }

if [ "$(id -u)" -eq 0 ] && [ -z "${HOMEBOARD_ALLOW_ROOT:-}" ]; then
  echo "Run this as your normal user (not root / not with sudo): the dashboard must start for that user's desktop." >&2
  HANDLED=1; exit 1
fi
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"
USER_NAME="$(id -un)"

case "$DIR" in *" "*) echo "The folder path contains a space ($DIR). Move it somewhere like /home/$USER_NAME/homeboard and try again." >&2; HANDLED=1; exit 1 ;; esac

# Add a line to a file once (matched by our marker), making sure the file ends with a newline first.
append_once() {
  local file="$1" line="$2"
  if [ -f "$file" ] && grep -qxF "$line" "$file"; then ok "already set up in $file"; return; fi
  # An older line from a folder that has since moved: replace it rather than leave a dead path behind.
  if [ -f "$file" ] && grep -qF "$MARK" "$file"; then remove_line "$file"; fi
  if [ "$DRY" = 1 ]; then printf '    [dry-run] add to %s: %s\n' "$file" "$line"; return; fi
  mkdir -p "$(dirname "$file")"
  if [ -s "$file" ] && [ -n "$(tail -c1 "$file")" ]; then echo >>"$file"; fi
  echo "$line" >>"$file"
  ok "added to $file"
}

# A user-level autostart file replaces the system one, so start from a copy of the system file
# (keeps the desktop panel and wallpaper starting as usual).
seed_from() {
  local user_file="$1" system_file="$2"
  [ -f "$user_file" ] && return 0
  if [ -f "$system_file" ]; then
    run mkdir -p "$(dirname "$user_file")"
    run cp "$system_file" "$user_file"
  fi
}

remove_line() {
  local file="$1"
  [ -f "$file" ] || return 0
  grep -qF "$MARK" "$file" || return 0
  local tmp
  tmp="$(mktemp)"
  grep -vF "$MARK" "$file" >"$tmp" || true
  run cp "$tmp" "$file"
  rm -f "$tmp"
  ok "removed from $file"
}

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" = 1 ]; then
  say "Removing Homeboard startup entries"
  if command -v systemctl >/dev/null 2>&1 && [ -f "$UNIT" ]; then
    run $SUDO systemctl disable --now homeboard || true
    run $SUDO rm -f "$UNIT"
    run $SUDO systemctl daemon-reload
    ok "server service removed"
  fi
  remove_line "$LABWC_DIR/autostart"
  remove_line "$LXDE_DIR/autostart"
  run rm -f "$XDG_FILE"
  [ -f /etc/sudoers.d/homeboard-timezone ] && run $SUDO rm -f /etc/sudoers.d/homeboard-timezone
  [ -L "$HOME/Desktop/Homeboard pictures" ] && run rm -f "$HOME/Desktop/Homeboard pictures"
  ok "Left your config.json, credentials.json, token.json and pictures in place."
  exit 0
fi

# ---------------------------------------------------------------- install
node_major() {
  if command -v node >/dev/null 2>&1; then node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; else echo 0; fi
}

say "Node.js (needs version 18 or newer)"
if [ "$(node_major)" -lt 18 ] && command -v apt-get >/dev/null 2>&1; then
  run $SUDO apt-get update
  run $SUDO apt-get install -y nodejs
fi
if [ "$DRY" = 0 ] && [ "$(node_major)" -lt 18 ]; then
  cat >&2 <<'MSG'
    !! Node.js 18 or newer is required, and this system's package is too old (or missing).
       Install a current version from NodeSource, then run this installer again:
         https://github.com/nodesource/distributions#installation-instructions
MSG
  HANDLED=1; exit 1
fi
ok "Node $(node -v 2>/dev/null || echo '(will be installed)')"
NODE_BIN="$(command -v node || echo /usr/bin/node)"

say "Settings (config.json)"
if [ ! -f "$DIR/config.json" ]; then
  run cp "$DIR/config.example.json" "$DIR/config.json"
  if [ "$DRY" = 0 ] && [ -t 0 ]; then
    HOMEBOARD_INSTALLER=1 "$NODE_BIN" "$DIR/deploy/set-location.js" || warn "Location not set. Run:  node deploy/set-location.js"
  else
    warn "Set your weather location later with:  node deploy/set-location.js"
  fi
else
  ok "config.json already exists (change the location any time with: node deploy/set-location.js)"
fi

say "Chromium and curl"
if ! command -v curl >/dev/null 2>&1; then run $SUDO apt-get install -y curl; fi
if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  run $SUDO apt-get install -y chromium || run $SUDO apt-get install -y chromium-browser
fi
ok "browser ready"

# Older versions only listened on the Pi itself; the dashboard needs the home network too.
if [ -f "$DIR/config.json" ] && grep -q '"host"[[:space:]]*:[[:space:]]*"127.0.0.1"' "$DIR/config.json"; then
  run sed -i 's/"host"[[:space:]]*:[[:space:]]*"127.0.0.1"/"host": "0.0.0.0"/' "$DIR/config.json"
  ok "config.json said host 127.0.0.1 (this Pi only); changed to 0.0.0.0 so the dashboard opens from your PC."
fi

say "Starting the server at every boot (systemd)"
if command -v systemctl >/dev/null 2>&1 && { [ -d /run/systemd/system ] || [ "$DRY" = 1 ]; }; then
  tmp="$(mktemp)"
  cat >"$tmp" <<UNITFILE
[Unit]
Description=Homeboard dashboard server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$DIR
ExecStart=$NODE_BIN $DIR/server.js
# Lets the server use port 80, which the optional diyHue (Hue app) link needs.
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITFILE
  run $SUDO install -m 644 "$tmp" "$UNIT"
  rm -f "$tmp"
  run $SUDO systemctl daemon-reload
  run $SUDO systemctl enable homeboard
  run $SUDO systemctl restart homeboard
  ok "service installed: $UNIT"
else
  warn "systemd not available. Start the server yourself with:  node $DIR/server.js"
fi

say "Opening the dashboard full screen at login"
chmod +x "$KIOSK" 2>/dev/null || true
if [ -d /etc/xdg/labwc ] || [ -d "$LABWC_DIR" ] || command -v labwc >/dev/null 2>&1; then
  seed_from "$LABWC_DIR/autostart" /etc/xdg/labwc/autostart
  append_once "$LABWC_DIR/autostart" "$KIOSK &"
fi
if [ -d /etc/xdg/lxsession/LXDE-pi ] || [ -d "$LXDE_DIR" ]; then
  seed_from "$LXDE_DIR/autostart" /etc/xdg/lxsession/LXDE-pi/autostart
  append_once "$LXDE_DIR/autostart" "@$KIOSK"
fi
# Generic fallback for other desktops. If several of these fire, the launcher only lets one run.
if [ "$DRY" = 1 ]; then
  printf '    [dry-run] write %s\n' "$XDG_FILE"
else
  mkdir -p "$(dirname "$XDG_FILE")"
  cat >"$XDG_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Homeboard
Exec=$KIOSK
X-GNOME-Autostart-enabled=true
DESKTOP
  ok "wrote $XDG_FILE"
fi

say "Shortcut to the pictures folder on the Pi's desktop"
BG_DIR="$("$NODE_BIN" -e 'const c=require(process.argv[1]+"/lib/config"),b=require(process.argv[1]+"/lib/backgrounds");console.log(b.resolveFolder(c.loadConfig().backgrounds.folder))' "$DIR" 2>/dev/null || echo "$DIR/backgrounds")"
SHORTCUT="$HOME/Desktop/Homeboard pictures"
if [ -d "$HOME/Desktop" ]; then
  run mkdir -p "$BG_DIR"
  if [ -e "$SHORTCUT" ] || [ -L "$SHORTCUT" ]; then ok "shortcut already there"; else run ln -s "$BG_DIR" "$SHORTCUT" && ok "Desktop shortcut \"Homeboard pictures\" -> $BG_DIR"; fi
else
  ok "no Desktop folder here; your pictures folder is $BG_DIR"
fi

say "Tools for switching the monitor on and off (daily schedule)"
# HDMI-CEC: tells the monitor itself to switch off and on. The picture tools below are the backup for monitors without CEC.
if ! command -v cec-client >/dev/null 2>&1; then
  run $SUDO apt-get install -y cec-utils || warn "Could not install cec-utils (HDMI-CEC). The dashboard's Screen power tab will show what is missing."
fi
# The CEC adapter (/dev/cec0) belongs to the "video" group; the background service runs as this user.
if ! id -nG "$USER_NAME" 2>/dev/null | tr ' ' '\n' | grep -qx video; then
  run $SUDO usermod -aG video "$USER_NAME" || warn "Could not add $USER_NAME to the video group (needed for HDMI-CEC)."
fi
if [ -d /etc/xdg/labwc ] || [ -d "$LABWC_DIR" ] || command -v labwc >/dev/null 2>&1 || command -v wayfire >/dev/null 2>&1; then
  for tool in wlopm wlr-randr; do
    if ! command -v "$tool" >/dev/null 2>&1; then run $SUDO apt-get install -y "$tool" || warn "Could not install $tool. The dashboard's Screen power tab will show what is missing."; fi
  done
fi
if [ -d /etc/xdg/lxsession/LXDE-pi ] || [ -d "$LXDE_DIR" ]; then
  if ! command -v xset >/dev/null 2>&1; then run $SUDO apt-get install -y x11-xserver-utils || warn "Could not install xset. The dashboard's Screen power tab will show what is missing."; fi
fi
ok "screen switching tools checked"

say "Keeping the screen awake"
if command -v raspi-config >/dev/null 2>&1; then
  run $SUDO raspi-config nonint do_blanking 1 && ok "screen blanking off" || warn "Could not change blanking. Turn it off in Raspberry Pi Configuration > Display."
else
  warn "raspi-config not found. Turn off screen blanking/sleep in your system settings."
fi

say "Letting the dashboard change the time zone"
if command -v timedatectl >/dev/null 2>&1; then
  TZFILE=/etc/sudoers.d/homeboard-timezone
  TZLINE="$USER_NAME ALL=(root) NOPASSWD: /usr/bin/timedatectl set-timezone *"
  if [ -f "$TZFILE" ] && grep -qxF "$TZLINE" "$TZFILE" 2>/dev/null; then
    ok "already set up"
  elif [ "$DRY" = 1 ]; then
    printf '    [dry-run] add to %s: %s\n' "$TZFILE" "$TZLINE"
  else
    tmp="$(mktemp)"
    echo "$TZLINE" >"$tmp"
    # A broken sudoers file can lock everyone out of sudo, so this is checked before it is installed
    # anywhere - not optional hardening, just making sure the Pi still works afterwards.
    if $SUDO visudo -c -f "$tmp" >/dev/null 2>&1; then
      run $SUDO install -m 440 -o root -g root "$tmp" "$TZFILE"
      ok "the dashboard's Settings tab can now change the time zone"
    else
      warn "Could not set this up safely; the dashboard's time zone box will not work. Change the time zone with:  sudo raspi-config"
    fi
    rm -f "$tmp"
  fi
else
  warn "timedatectl not found; the dashboard's time zone box will not work. Change it with:  sudo raspi-config"
fi

# ---------------------------------------------------------------- wrap up
PORT="$("$NODE_BIN" -e 'try{console.log(require(process.argv[1]).port||3000)}catch(e){console.log(3000)}' "$DIR/config.json" 2>/dev/null || echo 3000)"
if [ "$DRY" = 0 ]; then
  up=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if curl -sf "http://localhost:$PORT/api/config" >/dev/null 2>&1; then up=1; break; fi
    sleep 2
  done
  if [ "$up" = 1 ]; then ok "server is running on port $PORT"; else warn "server did not answer yet. Check:  sudo systemctl status homeboard"; fi
fi

say "Done. What is left"
HOST_NAME="$(hostname 2>/dev/null || echo homeboard)"
PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "  1) On your PC or phone (same Wi-Fi), open the dashboard:"
echo "        http://${PI_IP:-$HOST_NAME.local}:$PORT/admin${PI_IP:+     or     http://$HOST_NAME.local:$PORT/admin}"
echo "     Its \"Finish setting up\" box walks you through the rest: weather city, calendar link, Todoist token, pictures."
echo "     The monitor switches off at 10:00 PM and back on at 7:00 AM (over HDMI-CEC). Change that on the \"Screen power\" tab."
echo "     (After the reboot, the Pi's own screen shows this address until a calendar link and Todoist token are added.)"
echo "  2) If the screen is sideways, rotate it: Preferences > Control Centre > Screens (START-HERE.md, Part 1, Step 3)."
echo "  3) Reboot to test the full startup:  sudo reboot"
echo "  Check on things any time with:  bash $DIR/deploy/status.sh"
