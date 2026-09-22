#!/usr/bin/env bash
# Quick health check:  bash deploy/status.sh
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="$(node -e 'try{console.log(require(process.argv[1]).port||3000)}catch(e){console.log(3000)}' "$DIR/config.json" 2>/dev/null || echo 3000)"
URL="http://localhost:$PORT"
line() { printf '  %-22s %s\n' "$1" "$2"; }
yes_no() { if [ -e "$1" ]; then echo "found"; else echo "MISSING"; fi; }

echo "Homeboard status"
line "Node.js" "$(node -v 2>/dev/null || echo 'NOT INSTALLED (need 18+)')"
svc="$(systemctl is-active homeboard 2>/dev/null)"
line "Server service" "${svc:-not installed}"
if curl -sf "$URL/api/config" >/dev/null 2>&1; then line "Server answering" "yes ($URL)"; else line "Server answering" "NO"; fi
line "config.json" "$(yes_no "$DIR/config.json")"
if [ -s "$DIR/data/calendars.json" ] && grep -q '"id"' "$DIR/data/calendars.json" 2>/dev/null; then line "Calendar links" "added"; else line "Calendar links" "none yet (dashboard, Calendar & Tasks tab)"; fi
if [ -e "$DIR/data/todoist.json" ]; then line "Todoist token" "added"; else line "Todoist token" "not added yet (dashboard, Calendar & Tasks tab)"; fi
if [ -f "$DIR/data/admin.json" ]; then line "Dashboard password" "set"; else line "Dashboard password" "none (open to your home network)"; fi
power="$(curl -sf "$URL/admin/api/power" 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const j=JSON.parse(s);const t=j.settings;
    const sched=t.enabled?"on "+t.onTime+", off "+t.offTime+(t.weekendDifferent?" (weekends "+t.weekendOnTime+" to "+t.weekendOffTime+")":""):"schedule is off";
    console.log(sched+"; "+(j.display.method?"switched with "+(j.display.label||j.display.method):"NO WAY TO SWITCH THE SCREEN ("+(j.display.reason||"unknown")+")")+"; right now Homeboard wants the screen "+j.wanted+(j.applied&&j.applied!==j.wanted?" but last managed to switch it "+j.applied:"")+(j.hue&&j.hue.linked?"; Hue plug linked"+(j.hue.targets&&j.hue.targets.length?" ("+j.hue.targets.length+" chosen)":", none chosen yet"):""));
  }catch(e){console.log("unknown (dashboard password set?)")}})' 2>/dev/null)"
line "Screen schedule" "${power:-unknown}"
hl="$(curl -sf "$URL/admin/api/power/huelight" 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const j=JSON.parse(s);
    console.log(!j.enabled?"off":j.listening?"answering on "+(j.address==="docker"?(j.dockerAddress||"Docker")+":":"port ")+j.port+" as \""+j.name+"\""+(j.seen?"; diyHue last asked "+new Date(j.seen.at).toLocaleString():"; diyHue has not asked yet"):"ON but NOT listening: "+(j.error||"starting"));
  }catch(e){console.log("unknown")}})' 2>/dev/null)"
line "Hue light (diyHue)" "${hl:-unknown}"
PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
line "Dashboard address" "http://$(hostname 2>/dev/null || echo homeboard).local:$PORT/admin${PI_IP:+ or http://$PI_IP:$PORT/admin}"

calstatus="$(curl -sf "$URL/api/status" 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const j=JSON.parse(s);
    console.log("calendar "+(j.calendar.ok?"working":"PROBLEM: "+j.calendar.error)+"; tasks "+(j.tasks.ok?"working":"PROBLEM: "+j.tasks.error));
  }catch(e){console.log("unknown (add a calendar link and a Todoist token first)")}})' 2>/dev/null)"
line "Calendar & tasks" "${calstatus:-unknown}"

if command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then line "Chromium" "installed"; else line "Chromium" "NOT INSTALLED"; fi
auto="none"
grep -qsF "deploy/kiosk.sh" "$HOME/.config/labwc/autostart" && auto="labwc"
grep -qsF "deploy/kiosk.sh" "$HOME/.config/lxsession/LXDE-pi/autostart" && auto="$auto LXDE"
[ -f "$HOME/.config/autostart/homeboard.desktop" ] && auto="$auto xdg"
line "Opens at login" "$auto"
if pgrep -x chromium >/dev/null 2>&1 || pgrep -x chromium-browser >/dev/null 2>&1; then line "Screen running" "yes"; else line "Screen running" "no (starts at next login)"; fi
KLOG="${XDG_RUNTIME_DIR:-/tmp}/homeboard-kiosk.log"
if [ -f "$KLOG" ]; then
  klast="$(grep -F 'Chromium exited' "$KLOG" 2>/dev/null | tail -1)"
  [ -n "$klast" ] && line "Chromium last exit" "$klast"
  line "Chromium log" "$KLOG (send this to Claude if the screen is gray)"
fi
echo
echo "Server log:  journalctl -u homeboard -n 30 --no-pager"
