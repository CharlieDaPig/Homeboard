# Homeboard

> **New here? Follow [START-HERE.md](START-HERE.md)**, a step-by-step guide from an empty SD card to a working screen. This README is the reference.

A self-hosted, DAKboard-style screen for a **vertical monitor**: clock and date on top, a rolling month calendar (from a secret Google Calendar link), your to-dos (Todoist), and the weather (Open-Meteo) along the bottom, over rotating background photos. An **admin dashboard** (`/admin`) lets you watch the screen and change how it behaves from your PC or phone: picture timing, uploads, calendar links, your Todoist token, weather, and more.

It is a small Node server plus a plain HTML/CSS/JS page. **No `npm install` and no dependencies** — just Node 18 or newer.

## Try it in 30 seconds (no accounts needed)

```
node -v          # must be 18 or newer
npm run mock     # or: MOCK=1 node server.js
```

Open http://localhost:3000 in a browser. Mock mode shows sample events, tasks and weather so you can see the layout. The dashboard is at http://localhost:3000/admin.

## Connect your calendar and tasks (one time)

No sign-in, no OAuth app, nothing that can expire. Two steps, both from the dashboard's **Calendar & Tasks** tab.

**Calendar**, from Google Calendar's own secret link:

1. On a computer, open Google Calendar, click the gear icon, then **Settings**.
2. Under "Settings for my calendars" (left side), click the calendar you want.
3. Click **Integrate calendar**, then copy **Secret address in iCal format**.
4. Paste it into the dashboard's Calendar & Tasks tab, give it a name, and press **Add calendar**. Repeat for more calendars — each gets its own colour automatically.

This link is read-only and does not expire. A school or work Google account sometimes hides this option. If a link ever leaks, press **Reset** next to it in Google Calendar and paste the new one in.

**Tasks**, from Todoist (move your to-dos there yourself first — Google gives personal accounts no API for Google Keep, and this avoids OAuth expiry entirely):

1. Open Todoist in a browser, click your picture (top right), then **Settings**.
2. Click **Integrations**, then **Developer**.
3. Copy the API token and paste it into the dashboard's Calendar & Tasks tab.

Both have a **Test** button that reports plainly what it found. Which Todoist projects show up (all, by default) is also chosen on that tab.

## The admin dashboard

Open `http://<pi-address>:3000/admin` from any device on your home network (for example `http://homeboard.local:3000/admin`). There is no password by default: anyone on your home network can open it. That keeps things simple on a network you trust. If you would like one, add it on the **System** tab (or run `node deploy/set-password.js`).

| Tab | What you can do |
| --- | --- |
| **Overview** | A first-run **Finish setting up** checklist (it disappears when done), a live preview of the screen, a status line for the screen, calendars, tasks, weather, pictures and the Pi, plus buttons to reload the screen, refresh data, or jump to the next picture. |
| **Pictures** | Set how often pictures change (10 seconds to 24 hours), shuffle or file-name order, and how much to darken them. Drag pictures or a whole folder from your PC to upload them; see them all, show one right now, or delete one. |
| **Calendar & Tasks** | Add, rename or remove calendar links (each with its own colour), test any of them; add or remove your Todoist token, test it, and choose which Todoist projects appear. |
| **Weather** | Current conditions and 5-day forecast, refresh on demand, search for your city, or type coordinates; switch units. |
| **Screen power** | Turn the monitor off and on automatically over HDMI-CEC (default: off at 10:00 PM, on at 7:00 AM), optional different weekend times, **Turn on now** / **Turn off now** buttons, **Check HDMI-CEC**, an optional Philips Hue smart plug that cuts the monitor's power too, and an optional link that lets diyHue (a Hue Bridge emulator) list the monitor as a Hue smart plug for the Hue app |
| **Settings** | Clock format, language, weeks on the calendar, tasks title and count, how often each source is checked, and the Pi's time zone. Reset everything back to `config.json` in one click. |
| **System** | Pi temperature, memory, storage, power/throttling flags, restart the server, add, change or remove a dashboard password, and recent server messages. |

### Screen on/off schedule

The **Screen power** tab keeps the monitor off at night, and it does so with **HDMI-CEC**: at the off time the Pi sends `standby` to the monitor over the HDMI cable, at the on time `on` followed by `as` (make the Pi the active input), and each time asks the monitor for its power status to confirm. The screen reloads after a wake-up. The Pi itself keeps running, so calendar, tasks and weather are current the moment the monitor wakes. Times follow the Pi's clock and time zone. An on time later than the off time (for example 6:00 PM to 2:00 AM) runs through midnight; equal times mean it never turns off. **Turn off now** and **Turn on now** override the schedule until its next change; **Go back to the schedule** cancels the override. While the screen should be off, the Pi re-sends the off command every ten minutes, so anything that wakes it (on the older X11 desktop a key press does) is put back to sleep. The schedule is saved in `data/power.json`.

HDMI-CEC goes through `cec-client` (package `cec-utils`, installed by the installer): `echo 'standby 0' | cec-client -s -d 1`, `on 0`, `as`, and `pow 0` to read the status. The monitor must support CEC and have it enabled in its menu (HDMI Control, Anynet+, Simplink, EasyLink, Bravia Sync), and be plugged into the HDMI port next to the Pi's power port (HDMI 0, the CEC connection Homeboard uses). Many computer monitors do not support CEC at all. **Check HDMI-CEC** on the tab asks the monitor for its power status, and the **Switch the monitor with HDMI-CEC** box turns the whole feature off. If the monitor does not confirm a command, the picture is switched off as a backup (and the tab says so in a yellow note); the Pi's screen output is otherwise left alone.

The backup that switches the picture (the tab shows which one it found): `wlopm` on current Raspberry Pi OS (Wayland: labwc or Wayfire), with `wlr-randr` as the fallback (the installer adds both if missing), `xset dpms` on the older X11 desktop, or `vcgencmd display_power` on old firmware. The server finds the desktop by itself, even though it starts as a background service. The screen's rotation is remembered and restored when it wakes. If the desktop is not up yet at boot (or the tool is missing), it retries quietly and the tab says what is wrong.

**Philips Hue smart plug (optional).** If the monitor is plugged into a Hue smart plug, Homeboard can cut its power in addition to HDMI-CEC: on the tab press **Find my Hue Bridge** (or type its address), press **Link Hue**, then press the round button on the bridge within 30 seconds. Tick the plug (a Hue light works as well) and save. At night the monitor is put in standby over HDMI-CEC and the plug switches off three seconds later; in the morning the plug comes on, Homeboard waits about seven seconds for the monitor to start, then wakes it over HDMI-CEC. The ten-minute off re-check only repeats the plug command while a plug is used, so there is no repeated CEC traffic on a monitor that is already unpowered. With a plug, a monitor that does not confirm CEC standby is not treated as a problem, since the plug cuts its power anyway. **Test the plug** switches it off for five seconds and back on, without touching the schedule. If you untick the Hue option, change the chosen devices or unlink Hue while the screen is asleep, the plug is switched back on first, so the monitor is never left without power. The link key is stored in `data/hue.json` (readable only by the Pi's user). Talks to the bridge over your home network with the local Hue API (a self-signed certificate, which is why it is not checked). Do not plug the Pi itself into that plug. Some monitors stay dark after power returns until you press their own button, and the picture may come back rotated differently on some desktops after a power cut (not tried on real hardware); test before relying on it, or leave the plug out and rely on HDMI-CEC. The wake-up is retried a few times after the plug comes on, in case the monitor is still starting. The schedule is kept in `data/power.json`.

**Hue app control through diyHue (optional).** [diyHue](https://diyhue.org) is an open-source Hue Bridge emulator that the Hue app talks to like a real bridge (voice assistants may work too, but that is unconfirmed). It adds "native" lights by fetching `http://<address>/detect` and then reading and setting `/state` (port 80 only). Tick **Let diyHue see this Pi as a Hue smart plug** on the Screen power tab (card **Hue app control (diyHue, optional)**) and Homeboard answers those requests (`GET /detect`, `GET /state`, `PUT /state` with `{"1":{"on":false}}`, and the older `GET /set?light=1&on=false`) as one Hue smart plug (model `LOM001`). `on` and `off` switch the monitor over HDMI-CEC, exactly like the **Turn on now** / **Turn off now** buttons (the override lasts until the schedule's next change). diyHue waits only three seconds for an answer, so the reply is sent at once and the switching happens in the background (a request that arrives while the screen is busy waits its turn; the latest request wins). The identifier diyHue sees (the Pi's network address) is saved in `data/huelight.json` so it stays the same if the network changes. The listener uses port 80, which the systemd unit written by `deploy/install.sh` allows through `AmbientCapabilities=CAP_NET_BIND_SERVICE`; it is off until ticked, keeps its settings in `data/huelight.json`, and has no password (home network only). diyHue is a second bridge, and both it and Homeboard want port 80. There are two ways to fit them together. Set **Where does diyHue run?** to **On another computer** (Homeboard listens on every address, diyHue runs elsewhere), or to **On this same Pi, in Docker** (`address: "docker"` in `data/huelight.json`): then Homeboard listens only on Docker's private address `docker0` (usually `172.17.0.1`) and the diyHue container is published only on the Pi's network address (`-p <Pi address>:80:80`), so the two never collide. `bash deploy/install-diyhue.sh` sets up the second way in one go (installs Docker, saves the setting, restarts Homeboard, runs `diyhue/core` in bridge mode; `--dry-run` shows the steps, `--remove` deletes the container). Homeboard has to be listening before the container starts, which the script takes care of; if `docker0` does not exist yet (Docker still starting at boot) Homeboard retries every 30 seconds. diyHue itself prefers Docker's host network mode, so the bridge-mode setup is the less proven of the two. START-HERE.md, Part 6 has the steps. The protocol follows diyHue's public documentation and source; it has not been tried against a real diyHue install. Notes for the same-Pi setup: the script adds a systemd drop-in so Docker starts after the network is up (the container is published on the Pi's network address, which has to exist first; if diyHue is not running after a reboot, `sudo docker start diyHue`); the address is fixed inside the container, so if the Pi's address changes run the script with `--remove` and then again; a firewall such as ufw needs `sudo ufw allow in on docker0 to any port 80`; the light diyHue lists may get a number appended to its name, and adding it twice makes two.

Changes apply immediately and the screen reloads itself. They are saved in `data/settings.json`, separately from `config.json`, so your hand-edited file is never rewritten.

**About security.** Homeboard assumes a home network you trust, so it is open by default. The dashboard uses plain HTTP, so do not expose port 3000 to the internet (no port forwarding). If you want a lock, set a password on the System tab: other devices then type it once and each browser stays signed in (even after restarts). To remove it again, use **Remove password** on the System tab, or run `node deploy/set-password.js --remove` on the Pi. Set `"admin": { "enabled": false }` in `config.json` to switch the dashboard off entirely.

## Configure

You can change most things in the dashboard. Everything is also in `config.json` (copy `config.example.json` if you do not have one). Anything you leave out uses the default. A value changed in the dashboard wins over `config.json` until you reset it there.

| Setting | What it does |
| --- | --- |
| `port`, `host` | Where the server listens. `host` defaults to `0.0.0.0` so the dashboard works from other devices on your network. Use `127.0.0.1` to allow only the Pi itself (then there is no remote dashboard). |
| `admin.enabled` | `false` turns the dashboard off. |
| `backgrounds.folder` | Folder the pictures live in. Default `backgrounds` inside this project. Can be any path on the Pi, e.g. `~/Desktop/Backgrounds` or a USB drive. Not editable from the dashboard. |
| `locale` | Date language/format, e.g. `en-US`, `en-GB`. |
| `display.timeFormat` | `12h` or `24h`. |
| `display.showSeconds` | Small seconds counter next to the clock. |
| `display.backgroundIntervalSeconds` | How often the picture changes (10 to 86400). |
| `display.backgroundOrder` | `shuffle` or `sequential` (by file name). |
| `display.backgroundDim` | 0 to 0.9. Extra darkening over the photo for readability. |
| `display.lowPower` | `true` turns off fades and soft shadows for slower Raspberry Pis. |
| `refresh.calendarMinutes`, `tasksMinutes`, `weatherMinutes` | How often each source is checked (default 5, 2 and 15). |
| `calendar.weeks` | Number of week rows (5 fits a 1080x1920 screen well; 6 is fine too). |
| `calendar.weekStartsOn` | `0` = Sunday, `1` = Monday, `6` = Saturday. |
| `calendar.maxEventsPerDay` | Events shown per day before "+N more". |
| `tasks.title`, `tasks.lists`, `tasks.maxItems` | Heading, which Todoist project names to show (empty = all) and the most tasks to display. Easier to set on the dashboard's Calendar & Tasks tab. |
| `weather.latitude`, `weather.longitude` | Your location. **Set this**; the default is only a placeholder. |
| `weather.units` | `imperial` (F, mph) or `metric` (C, km/h). |
| `weather.label` | Text shown at the bottom left, e.g. `Dallas, TX`. |
| `weather.confirmed` | Set to `true` automatically when you choose your city with `node deploy/set-location.js`; it only marks the dashboard's setup checklist item as done. |

Your calendar links and Todoist token are not in `config.json` (they are secrets): they live in `data/calendars.json` and `data/todoist.json`, managed from the dashboard's Calendar & Tasks tab.

Restart the server after editing `config.json` (`sudo systemctl restart homeboard` on the Pi). Changes made in the dashboard need no restart. To change your city from a terminal, run `node deploy/set-location.js` and then restart the server; it also clears any location you had saved from the dashboard, so the new one wins.

## Background photos

Pictures live in one folder on the Pi (default: the `backgrounds/` folder inside the project). The screen cross-fades between them: shuffled or in file-name order, at the interval you choose. Portrait photos around 1080x1920 look best; JPG, PNG and WebP can be uploaded (SVG works if you copy it in yourself).

**From your PC's desktop:** open the dashboard, choose **Pictures**, and drag files or a whole folder onto the box (or use the two buttons). Big photos are shrunk in your browser first (longest side 2880 pixels) so they upload fast and the Pi has less to decode. Each file can be up to 30 MB.

**On the Pi:** the installer puts a shortcut called "Homeboard pictures" on the Pi's desktop that opens the folder. Anything you copy in appears after you press **Refresh list** (the screen picks it up on its next change or reload). To use a different folder, such as a USB stick or `~/Desktop/Backgrounds`, set `backgrounds.folder` in `config.json` and restart.

Three simple gradients are included so it works out of the box; delete them once you add your own photos.

## Running on a Raspberry Pi

**What you need:** a Raspberry Pi 4 or 5 is ideal (a Pi 3 works, set `display.lowPower` to `true`; a Pi Zero is too slow for a browser this size), a microSD card, and the vertical monitor.

### 1. Set up the Pi

1. In **Raspberry Pi Imager**, choose **Raspberry Pi OS (with desktop)**. Before writing, click *Edit settings* and set a hostname, your username and password, your Wi-Fi, your **time zone**, and turn on **SSH**. (A wrong time zone shows the wrong time and the wrong "today".)
2. Boot the Pi and let it reach the desktop.
3. Rotate the screen for portrait (see *Rotate the screen* below).

### 2. Install

From your PC, copy the project over and run the installer (replace `pi` and `raspberrypi.local` with your username and hostname):

```
scp homeboard.zip pi@raspberrypi.local:~
ssh pi@raspberrypi.local
unzip homeboard.zip && bash homeboard/deploy/install.sh
```

No PC terminal? Copy homeboard.zip to a USB stick, plug it into the Pi, open a terminal on the Pi and run `unzip /media/$USER/*/homeboard.zip -d ~ && bash ~/homeboard/deploy/install.sh`.

The installer, safe to run again at any time:

- makes sure Node 18+, Chromium and curl are installed,
- asks for your city (looks up the weather coordinates for you) and units. Press Enter to skip; the dashboard's checklist covers it. This prompt only appears when you run it from a terminal, such as over `ssh`,
- if an older `config.json` says `"host": "127.0.0.1"`, changes it to `0.0.0.0` on the first install so the dashboard can be reached from your PC (edit it back afterwards if you want the Pi only),
- installs a background service that starts the server at every boot and restarts it if it stops,
- makes the dashboard open full screen at login (it detects the desktop in use: labwc, LXDE, or a generic fallback),
- adds a "Homeboard pictures" shortcut to the Pi's desktop,
- installs `cec-utils` (HDMI-CEC, the real power switch for the monitor) plus `wlopm` and `wlr-randr` (or `xset` on the older desktop) as the backup that only switches the picture,
- turns off screen blanking so the display never sleeps by itself (the schedule still switches the monitor off at night).

Preview it first with `bash deploy/install.sh --dry-run`. Undo it with `bash deploy/install.sh --uninstall` (your settings, pictures, calendar links and Todoist token are kept).

### 3. Finish in the dashboard

The installer prints the dashboard address, and the Pi's screen shows it too until a calendar and Todoist are set up. Open it from your PC or phone (for example `http://homeboard.local:3000/admin`). The **Overview** tab starts with a **Finish setting up** checklist: set your city, add a calendar link, add your Todoist token, and add pictures. The box disappears when you are done.

Add both on the **Calendar & Tasks** tab: paste the secret calendar link (see "Connect your calendar and tasks" above) and your Todoist API token, then press the **Test** buttons to confirm each one works.

### 4. Reboot

`sudo reboot`. After a minute the dashboard should appear by itself. Check on things any time with `bash deploy/status.sh`.

### Rotate the screen

Do this in the desktop's own settings so it survives reboots: **Preferences → Control Centre → Screens**, select the monitor, **Orientation → Left or Right** (pick whichever puts the top of the picture at the top), then Apply. Older Raspberry Pi OS calls this tool **Screen Configuration**.

### If something is off

| Symptom | What to try |
| --- | --- |
| Blank screen or desktop but no dashboard | `bash deploy/status.sh`. If "Server answering" says NO: `journalctl -u homeboard -n 30 --no-pager`. |
| "Add a calendar link and a Todoist token" on the screen | Step 3 above. The message includes the address to open. |
| Dashboard does not open from my PC | Use the Pi's IP address instead of `homeboard.local`. Check `host` in `config.json` is not `127.0.0.1`, then restart the server. `bash deploy/status.sh` prints the address. |
| Dashboard asks for a password I forgot | On the Pi run `node deploy/set-password.js --remove` (or set a new one with `node deploy/set-password.js`). |
| A warning at the bottom of the screen ("Calendar link not working" or similar) | Open the dashboard's Calendar & Tasks tab and press Test next to the one it names. |
| Weather or calendar empty right after boot | Normal for a few seconds; it retries by itself until the Wi-Fi is up. |
| diyHue does not find the monitor | The diyHue card on the Screen power tab must say Listening on port 80 (run the installer again and restart if it says port 80 is not allowed). If it says port 80 is in use and diyHue runs on this same Pi, choose **On this same Pi, in Docker** on the card (or run `bash deploy/install-diyhue.sh`); otherwise diyHue has to run on a different computer. Add the light by the address the card shows instead of scanning. On the same Pi, `sudo docker ps` should list diyHue and `sudo docker logs diyHue` shows its messages. |
| Monitor does not turn off or on at the set times | Open the dashboard's **Screen power** tab and press **Check HDMI-CEC**. No answer means: CEC is off in the monitor's menu, the monitor is not on the HDMI port next to the power port, or the monitor does not support CEC. On the Pi, `cec-client -l` should say `Found devices: 1` and `echo 'pow 0' \| cec-client -s -d 1` should print a power status. Install the tool the tab names if one is missing, and check the time zone (next row). |
| Wrong time | Set the time zone on the dashboard's **Settings** tab (or `sudo raspi-config` → Localisation Options → Timezone). Changing it restarts the server so the screen-power schedule uses the new zone right away. |
| Choppy or slow on a Pi 3 | Set `"lowPower": true` under `display` in `config.json`, restart, and use smaller (about 1080×1920) background photos. |
| Want to close the dashboard | `Alt+F4` (it stays closed until next login). To bring it back, restart the Pi (`sudo reboot`), or run `bash deploy/kiosk.sh &` in a terminal on the Pi's own screen (not over `ssh`, which has no screen). |
| Need to change settings | Use the dashboard (no restart needed), or edit `config.json` and run `sudo systemctl restart homeboard`. |
| Updating to a new version | Unzip the new files over the folder without touching your pictures (`unzip -o homeboard.zip -x 'homeboard/backgrounds/*'`; your `config.json` and `data/` folder are not in the zip), then `bash deploy/install.sh`. |

This setup assumes the current Raspberry Pi OS desktop (labwc, with the older LXDE/X11 desktop also handled). I could not run it on real Pi hardware while building it, so if the installer's startup step does not work on your desktop, tell me which Pi OS version you have and what `bash deploy/status.sh` shows.

## Notes

- **The calendar link is read-only and does not expire.** It is a secret, though: anyone who has it can see your calendar's events (not edit them). Treat it like a password, and reset it in Google Calendar if it ever leaks.
- **Tasks come from Todoist, not Google Tasks.** Move your to-dos over yourself; Homeboard only reads Todoist's open tasks, it never writes back.
- Completed tasks disappear on the next refresh. The screen is display-only, so it cannot check tasks off.
- Weather data is from [Open-Meteo](https://open-meteo.com) (free for non-commercial use, no key). Keep the attribution in the footer.
- If the screen ever shows a warning about the calendar or Todoist, open the dashboard's Calendar & Tasks tab and press the relevant Test button to see why.

## Project layout

```
server.js            HTTP server, screen API, live-update stream
lib/admin.js         The /admin/api routes behind the dashboard
lib/config.js        Defaults and config.json loading
lib/data.js          Fetches and caches calendar, tasks and weather for the screen
lib/cache.js         Small cache used by data.js
lib/state.js         Live connections, screen check-ins and the log shown in the dashboard
lib/auth.js          Optional dashboard password (scrypt hash, long-lived sign-in cookie)
lib/settings.js      Validated settings saved by the dashboard (data/settings.json)
lib/backgrounds.js   Picture folder: listing, safe upload, path checks
lib/calendars.js     The list of calendar links (data/calendars.json), fetching and merging them
lib/ical.js          The iCal/RRULE reader (parsing and recurrence expansion), no dependencies
lib/todoist.js       Todoist API client and the Todoist token (data/todoist.json)
lib/weather.js       Open-Meteo client
lib/system.js        Pi temperature, memory, storage, power flags
lib/power.js         Screen on/off schedule, manual override, retry logic (data/power.json)
lib/hue.js           Philips Hue Bridge client for the optional smart plug (data/hue.json)
lib/huelight.js      Answers diyHue on port 80 so the monitor appears as a Hue smart plug (data/huelight.json)
lib/display.js       Switches the monitor: HDMI-CEC (cec-client), with wlopm / wlr-randr, xset or vcgencmd as the picture-only backup
lib/mock.js          Sample data for `npm run mock`
public/              The screen (index.html, style.css, app.js, icons.js)
public/admin/        The dashboard (index.html, admin.css, admin.js)
backgrounds/         Your background photos (default folder)
data/                Dashboard settings, calendar links, Todoist token and the optional password hash (created on first use)
config.example.json  Copy to config.json to change settings by hand
deploy/              install.sh (Pi installer), install-diyhue.sh (diyHue on the same Pi), status.sh, set-location.js, set-password.js, kiosk.sh
```
