#!/usr/bin/env bash
# Runs diyHue (the free Hue Bridge lookalike) on this same Pi, next to Homeboard, so the Hue app can switch the monitor.
#
#   bash deploy/install-diyhue.sh              set everything up (safe to run again)
#   bash deploy/install-diyhue.sh --dry-run    show what it would do, change nothing
#   bash deploy/install-diyhue.sh --ip=192.168.1.50   use this network address (only if the automatic one is wrong)
#   bash deploy/install-diyhue.sh --remove     stop and delete the diyHue container (keeps its settings folder)
#
# How both fit on one Pi: both want port 80. Homeboard listens only on Docker's private address (usually 172.17.0.1)
# and diyHue's container is published only on the Pi's network address, so they never meet.
# Run it as your normal user, not with sudo. It asks for sudo only where needed.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME=diyHue
CONF="$HOME/diyhue-config"
DATA="$DIR/data"
UNIT=/etc/systemd/system/homeboard.service
DRY=0
REMOVE=0
IP_ARG=""

usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --remove) REMOVE=1 ;;
    --ip=*) IP_ARG="${arg#--ip=}" ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 1 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
ok() { if [ "$DRY" = 1 ]; then printf "    (dry-run, nothing changed) %s\n" "$*"; else printf "    ok: %s\n" "$*"; fi; }
warn() { printf '    !! %s\n' "$*" >&2; }
run() { if [ "$DRY" = 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }

if [ "$(id -u)" -eq 0 ] && [ -z "${HOMEBOARD_ALLOW_ROOT:-}" ]; then
  echo "Run this as your normal user (not root / not with sudo)." >&2
  exit 1
fi
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "Node.js is missing. Run  bash deploy/install.sh  first." >&2; exit 1; }
[ -f "$DIR/lib/huelight.js" ] || { echo "This is the Homeboard version without Hue. This script needs the Hue version." >&2; exit 1; }

# ---------------------------------------------------------------- remove
if [ "$REMOVE" = 1 ]; then
  say "Removing the diyHue container"
  if command -v docker >/dev/null 2>&1 && $SUDO docker inspect "$NAME" >/dev/null 2>&1; then
    run $SUDO docker rm -f "$NAME"
    ok "diyHue container removed. Its settings are still in $CONF"
  else
    ok "no diyHue container found"
  fi
  echo "  Homeboard keeps answering on Docker's address. To stop that too, untick it on the dashboard (Screen power tab)."
  exit 0
fi

# ---------------------------------------------------------------- the Pi's network address
say "This Pi's network address"
LAN="$("$NODE_BIN" -e '
const want = process.argv[1];
const list = require(process.argv[2] + "/lib/huelight").lanInterfaces();
const pick = want ? list.find((i) => i.address === want) : list[0];
if (!pick) process.exit(1);
console.log(pick.address + " " + pick.mac.toUpperCase());
' "$IP_ARG" "$DIR" 2>/dev/null || true)"
if [ -z "$LAN" ]; then
  echo "Could not find the Pi's network address${IP_ARG:+ $IP_ARG}. Connect it to your network, or pass  --ip=<its address>." >&2
  exit 1
fi
LAN_IP="${LAN% *}"
LAN_MAC="${LAN#* }"
ok "address $LAN_IP, network card $LAN_MAC"

# ---------------------------------------------------------------- Docker
say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  run $SUDO apt-get update
  run $SUDO apt-get install -y docker.io
fi
if [ "$DRY" = 0 ] && ! command -v docker >/dev/null 2>&1; then
  echo "Docker could not be installed. See https://docs.docker.com/engine/install/debian/ and run this again." >&2
  exit 1
fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  # diyHue is published on the Pi's network address, so at boot Docker has to wait until the network is up.
  tmp="$(mktemp)"
  printf '[Unit]\nAfter=network-online.target\nWants=network-online.target\n' >"$tmp"
  run $SUDO mkdir -p /etc/systemd/system/docker.service.d
  run $SUDO install -m 644 "$tmp" /etc/systemd/system/docker.service.d/homeboard-network.conf
  rm -f "$tmp"
  run $SUDO systemctl daemon-reload
  run $SUDO systemctl enable --now docker || warn "Could not start Docker with systemctl."
fi
ok "Docker ready"

DOCKER_IP=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  DOCKER_IP="$("$NODE_BIN" -e 'console.log(require(process.argv[1] + "/lib/huelight").dockerAddress() || "")' "$DIR" 2>/dev/null || true)"
  if [ -z "$DOCKER_IP" ] && [ "$DRY" = 0 ]; then
    DOCKER_IP="$($SUDO docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
  fi
  [ -n "$DOCKER_IP" ] && break
  [ "$DRY" = 1 ] && break
  sleep 1
done
if [ -z "$DOCKER_IP" ]; then
  if [ "$DRY" = 1 ]; then
    DOCKER_IP="172.17.0.1"
    ok "Docker's own address will appear once it runs (normally $DOCKER_IP)"
  else
    echo "Docker is installed, but its network (docker0) did not appear. Try:  sudo systemctl restart docker  and run this again." >&2
    exit 1
  fi
else
  ok "Docker's own address is $DOCKER_IP"
fi

# ---------------------------------------------------------------- Homeboard first (so its address is taken before diyHue starts)
say "Homeboard answers diyHue on Docker's address"
run mkdir -p "$DATA"
if [ "$DRY" = 1 ]; then
  printf '    [dry-run] set "enabled": true and "address": "docker" in %s/huelight.json\n' "$DATA"
else
  "$NODE_BIN" -e '
const fs = require("fs"), path = require("path");
const file = path.join(process.argv[1], "huelight.json");
let j = {};
try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
j.enabled = true;
j.address = "docker";
if (!j.name) j.name = "Homeboard Monitor";
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
fs.writeFileSync(file, JSON.stringify(j, null, 2), { mode: 0o600 });
' "$DATA"
  ok "saved data/huelight.json"
fi
if command -v systemctl >/dev/null 2>&1 && [ -f "$UNIT" ]; then
  run $SUDO systemctl restart homeboard
  ok "Homeboard restarted"
else
  warn "Homeboard is not running as a service here. Restart it yourself (node server.js) before going on."
fi
if [ "$DRY" = 0 ] && command -v curl >/dev/null 2>&1; then
  up=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf -m 2 "http://$DOCKER_IP/detect" >/dev/null 2>&1; then up=1; break; fi
    sleep 2
  done
  if [ "$up" = 1 ]; then ok "Homeboard answers on http://$DOCKER_IP/"; else warn "Homeboard is not answering on http://$DOCKER_IP/ yet. Look at the \"Hue app control\" card on the dashboard for the reason. Going on anyway."; fi
fi

# ---------------------------------------------------------------- diyHue
say "diyHue"
if [ "$DRY" = 0 ] && $SUDO docker inspect "$NAME" >/dev/null 2>&1; then
  ok "a diyHue container already exists (remove it with  --remove  to start over)"
else
  run mkdir -p "$CONF"
  run $SUDO docker run -d --name "$NAME" --restart=always --network=bridge \
    -e "MAC=$LAN_MAC" -e "IP=$LAN_IP" \
    -p "$LAN_IP:80:80/tcp" -p "$LAN_IP:443:443/tcp" \
    -p 1900:1900/udp -p 2100:2100/udp -p 1982:1982/udp \
    -v "$CONF:/opt/hue-emulator/config" \
    diyhue/core:latest
  ok "diyHue started (first start downloads it, which can take a few minutes)"
fi

say "Done. What is left"
echo "  1) On your PC or phone, open  http://$LAN_IP  and sign in to diyHue (first login: admin@diyhue.org / changeme)."
echo "  2) In diyHue, add a light by its address:  $DOCKER_IP   (this is Homeboard; the dashboard shows it too)."
echo "     The light list in diyHue may be under \"Lights\": \"Add light\" / \"Scan for lights\"."
echo "  3) In diyHue press \"Link Button\" > \"Link App\", then in the Hue app add the bridge at $LAN_IP."
echo "  Details and troubleshooting: START-HERE.md, Part 6."
