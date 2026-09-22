# Homeboard Setup Guide

Follow this from top to bottom. It takes about 30 minutes. There is no Google sign-in to set up — just two things to copy and paste into the dashboard.

## Before you start

The whole setup is four parts: prepare the Raspberry Pi, copy Homeboard onto it and run one command, finish setting up in the dashboard (your weather city, calendar link, Todoist token, pictures), then reboot.

You need:

- A Raspberry Pi 3, 4 or 5, its power supply, and a microSD card of 16 GB or more (a Pi 3 runs Homeboard fine — it's what this guide's own dashboard has been running the whole time)
- Your vertical monitor and the right HDMI cable (the Pi 4 and 5 use micro-HDMI). For the automatic power on and off, the monitor should support **HDMI-CEC**, which most TVs do and many computer monitors do not (see "Turning the monitor off at night" in Part 5).
- A keyboard and mouse for the Pi, just for the first setup
- A PC, Mac or phone on the same Wi-Fi network as the Pi (for Option C in Part 2, it can be on any network)
- The Google account that holds your calendar, and a (free) Todoist account for your to-do list
- The file **homeboard.zip** (this guide came inside it)

When it works, the Pi boots straight into the screen: calendar on top, tasks in the middle, weather on the bottom. You then control it from any device on your home network with an **admin dashboard** (no password needed): change how often the pictures rotate, add pictures from your PC, check your calendar link and Todoist token, see the weather data, switch the monitor off at night, and more (Part 5). By default the monitor turns itself off at 10:00 PM and back on at 7:00 AM, by the Pi telling it over the HDMI cable (HDMI-CEC); you can change that in the dashboard. If the monitor is plugged into a Philips Hue smart plug, Homeboard can cut its power too (Part 5). Part 6 is optional: it lets the Hue app switch the monitor even without a smart plug, by running diyHue (a Hue Bridge lookalike) on this same Pi or on another computer.

Two things to know. Tasks come from **Todoist**, not Google Tasks or Google Keep — you move your to-dos to Todoist yourself (Part 3 has a note on this). And this was not tested on real Pi hardware, so if a step does not match what you see, ask Claude to fix it.

---

## Part 1: Set up the Raspberry Pi

You will put the operating system on the SD card, start the Pi once, and turn the screen sideways.

### Step 1. Write the SD card

On your PC, install **Raspberry Pi Imager** from raspberrypi.com/software and open it. Choose your Pi model, then choose the operating system **Raspberry Pi OS (64-bit)**, the version **with desktop**. Choose your SD card and click **Next**.

When it offers to customize settings (called "Edit settings" or "Customisation", depending on the version), fill in:

- **Hostname:** `homeboard`
- **Username and password:** pick them and write them down; you need them in Part 2
- **Wi-Fi:** your network name, password, and country
- **Time zone and keyboard layout:** your own. A wrong time zone shows the wrong time and the wrong "today".
- **Services:** turn on **SSH** and allow password login

Save, confirm, and let it write the card. This takes a few minutes. (If you will use Option C in Part 2, copy homeboard.zip onto the card now: see Option C, Step 1.)

### Step 2. Start the Pi

Put the card in the Pi. Connect the monitor to the HDMI port **next to the Pi's power port** (called HDMI 0). Homeboard uses that port's HDMI-CEC connection to switch the monitor on and off. Connect the keyboard and mouse, then plug in the power. The first start takes a few minutes and may restart once. Wait until you see the desktop.

### Step 3. Turn the screen sideways

Click the menu at the top left, then **Preferences**, then **Control Centre**. Click **Screens**, select your monitor, and set **Orientation** to **Left** or **Right**, whichever makes the picture upright on your monitor. Apply the change and keep it. (On an older Raspberry Pi OS this tool is called **Screen Configuration**: right-click the monitor rectangle and choose **Orientation**.)

This setting survives reboots, which is why you do it here and not in Homeboard.

---

## Part 2: Copy Homeboard to the Pi and install it

You run a few commands. Everywhere you see `YOUR-USERNAME`, type the username you chose in Part 1. Type each command exactly, then press Enter. There are three ways to get the file onto the Pi: from your PC's terminal (Option A), with a USB stick (Option B), or through Raspberry Pi Connect in your web browser, with no terminal on your PC (Option C). Pick one.

### Option A: from your PC (recommended)

Open a terminal on your PC (Terminal on a Mac, PowerShell on Windows). Go to the folder that holds homeboard.zip, for example `cd Downloads`, then send the file to the Pi:

```
scp homeboard.zip YOUR-USERNAME@homeboard.local:~
```

If it asks whether to continue connecting, type `yes`. Then type the Pi password. Nothing shows while you type it, which is normal. Now log in to the Pi and install:

```
ssh YOUR-USERNAME@homeboard.local
unzip homeboard.zip
bash homeboard/deploy/install.sh
```

If `homeboard.local` is not found, see the fix table at the end of this guide. If it says `unzip` is missing, run `sudo apt install -y unzip` and repeat.

### Option B: with a USB stick (no PC terminal needed)

Copy homeboard.zip onto a USB stick and plug it into the Pi. On the Pi, open the **Terminal** (the black icon in the top bar) and run:

```
unzip /media/$USER/*/homeboard.zip -d ~
bash ~/homeboard/deploy/install.sh
```

### Option C: with Raspberry Pi Connect (control the Pi from your PC's web browser)

Raspberry Pi Connect is Raspberry Pi's free remote-access service. It shows the Pi's desktop (or a terminal) in a web page on your PC, so you do not need to type commands on your PC or use `ssh`. It works from any PC, Mac or phone browser, even away from home. It needs Raspberry Pi OS **Bookworm or newer with the desktop** (the default in Part 1), and screen sharing only works on the current Wayland desktop, not the older X11 one. Connect cannot send files, so in this option the zip goes onto the SD card before the Pi's first start (Step 1).

**Step 1. Put homeboard.zip on the SD card (do this during Part 1, Step 1, right after Raspberry Pi Imager finishes writing the card and before the card goes into the Pi).** If your PC ejected the card when Imager finished, unplug the card reader and plug it in again. A small drive named **bootfs** appears. Drag homeboard.zip onto it, then eject the card the normal way. Windows may also say another drive needs formatting: click **Cancel**, that is the part of the card only the Pi can read. If you already started the Pi, shut it down and take the card out to do this on your PC, or use Option A or B instead. Then carry on with Part 1, Steps 2 and 3.

**Step 2. Turn on Connect (once, while you are at the Pi).** With the Pi on the desktop and connected to the internet, click the **Raspberry Pi Connect** icon in the top bar (it sits near the clock and Wi-Fi symbol), then **Turn On Raspberry Pi Connect**. A browser window opens and asks you to sign in with a **Raspberry Pi ID**; if you do not have one, choose to create it (it is free, and you confirm it by email). If it asks for a name for the Pi, use something like `homeboard`, then finish. The icon then shows it is connected. If you cannot find the icon, open a Terminal on the Pi, run `rpi-connect on`, then `rpi-connect signin`, and open the web address it prints on your PC.

**Step 3. Open the Pi from your PC.** On your PC, go to **connect.raspberrypi.com** and sign in with the same Raspberry Pi ID. Click your Pi's name in the list, then **Connect via**, then **Screen sharing**. The Pi's desktop appears in the browser tab and your mouse and keyboard control it. (**Remote shell**, in the same menu, gives you a plain terminal instead, and also works with the Pi's screen switched off.)

**Step 4. Install.** In the screen-sharing window, open the **Terminal** (the black icon in the top bar) and run:

```
unzip /boot/firmware/homeboard*.zip -d ~
bash ~/homeboard/deploy/install.sh
```

On an older Raspberry Pi OS the file is in `/boot` instead of `/boot/firmware`. The Connect toolbar has a clipboard button: copy the two lines on your PC, use that button to send them to the Pi, then paste them into the Terminal (Ctrl+Shift+V). If you would rather use the **Remote shell** page, the same two lines work there too. Then read "What the installer asks" below. When the installer finishes, go on with Part 3 and Part 4. You can do all of Part 3 on your PC's own browser, and when Part 4 restarts the Pi, the Connect page disconnects; wait about a minute, reload connect.raspberrypi.com and connect again.

If Connect ever asks you to sign in again on the Pi, use its icon in the top bar, or run `rpi-connect signin` in a Terminal. This option follows Raspberry Pi's own Connect documentation, and Raspberry Pi changes the button names now and then, so they may differ a little from what you see. Copying the zip onto the card has not been tried on a real card either.

### What the installer asks

If it asks for a password, type the Pi's login password (nothing shows while you type). When it asks for your city, type just the city name (for example `Fort Worth`), then pick the right match from the list and choose Fahrenheit or Celsius. You can press Enter to skip that and do it in the dashboard instead. It then asks how many seconds to wait after login before opening the screen — just press Enter to keep the default of 60, which is what a Pi 3 needs (a Pi 4 or 5 can often use less, but 60 is safe for any of them). The installer then sets up everything else by itself, which takes a few minutes. It ends with a message that begins **Done. What is left** and prints your dashboard address.

Want to preview first without changing anything? Run `bash ~/homeboard/deploy/install.sh --dry-run`. You can run the installer again at any time; it is safe.

---

## Part 3: Finish setting up in the dashboard

The installer printed your dashboard address (`bash ~/homeboard/deploy/status.sh` shows it again, and after the reboot in Part 4 the Pi's own screen shows it until a calendar link and Todoist token are added). It looks like `http://192.168.1.50:3000/admin` or `http://homeboard.local:3000/admin`. Open it in a web browser on your PC or phone. It opens straight away, with no password. The address starts with **http**, not https. That is normal for a home network.

The **Overview** tab starts with a box called **Finish setting up**. Work down it. The box disappears when you are done.

### Step 1. Choose your weather location

Click **Set location** (or the **Weather** tab), type your city, press **Search**, and click **Use this** next to the right match. Skip it if you already did this in the installer.

### Step 2. Get your calendar's secret link

Open the **Calendar & Tasks** tab. Google Calendar can hand out a private address that shows your events with no sign-in and no expiry.

1. On a computer, open **Google Calendar** (calendar.google.com), click the gear icon, then **Settings**.
2. Under "Settings for my calendars" (left side), click the calendar you want to show.
3. Click **Integrate calendar**, then copy **Secret address in iCal format**.
4. Back in the dashboard, paste it into **Secret calendar link**, type a name (for example "Home"), and press **Add calendar**. Repeat for more calendars — each gets its own colour automatically.

A school or work Google account sometimes hides this option. Treat the link like a password: anyone who has it can see your events. If it ever leaks, click **Reset** next to it in Google Calendar, then paste the new link into the dashboard the same way.

### Step 3. Get your Todoist token

Tasks come from **Todoist**, not Google Tasks or Google Keep. If you have not already, move your to-dos to a free Todoist account (todoist.com) — Homeboard only reads from it, so add your tasks there first.

1. Open **Todoist** in a browser, click your picture (top right), then **Settings**.
2. Click **Integrations**, then **Developer**.
3. Copy the API token.
4. Back in the dashboard's **Calendar & Tasks** tab, paste it into **Todoist API token** and press **Save token**.

Press the **Test** button next to each calendar and next to Todoist: it reports plainly what it found, for example "Calendar 'Home': found 23 events in the next 5 weeks (first: Dentist, Tue 9:00 am)". If a Test shows something odd, send Claude the exact message. Finally, use **Which projects to show** to tick which Todoist projects appear (leave all ticked to show every project).

### Step 4. Add your pictures (optional)

Open the **Pictures** tab and drag pictures (or a whole folder) from your PC onto the dashed box. Portrait (tall) photos around 1080 by 1920 look best. Three plain backgrounds are included until you add your own.

---

## Part 4: Reboot and check that it works

Restart the Pi. In the terminal on the Pi (or in a new Terminal window on the Pi's desktop), run:

```
sudo reboot
```

After about a minute the desktop appears, then the dashboard opens full screen by itself. Your events, tasks, and weather fill in within a few seconds. If the Wi-Fi is slow to connect, the screen keeps retrying on its own.

To run a health check, run this on the Pi (through `ssh`, or in its Terminal):

```
bash ~/homeboard/deploy/status.sh
```

Every line should look healthy. The one to look at is **Calendar & tasks**, which should say both are working. The status check also prints your dashboard address.

---

## Part 5: Using the dashboard

Open the dashboard address in any browser on your home network. Changes take effect at once and the screen reloads itself. The tabs across the top are:

- **Overview**: a live preview of the screen and a status line for everything: the screen itself, calendars, tasks, weather, pictures, and the Pi's health. The small badge at the top says **All good** or how many things need a look. The buttons here reload the screen, refresh the data, or jump to the next picture.
- **Pictures**: set **Change the picture every** (from 10 seconds up to 24 hours), shuffle or in-order, and how much to darken the pictures, then **Save changes**. To add pictures from your PC's desktop, drag them (or a whole folder) onto the dashed box, or use **Choose pictures** or **Choose a folder**. Portrait (tall) photos around 1080 by 1920 look best on a vertical screen; wide photos get cropped. JPG, PNG and WebP work. Very large photos are shrunk automatically. Under the box you can **Show now** or **Delete** any picture (Delete asks you to click twice).
- **Calendar & Tasks**: add, rename or remove calendar links (each with its own colour) and test any of them; add, replace or remove your Todoist token and test it; tick which Todoist projects show.
- **Weather**: today's numbers and the 5-day forecast, **Refresh now**, and a search box to change your city.
- **Screen power**: the monitor switches off at 10:00 PM and back on at 7:00 AM until you change it. Set your own on and off times (with different times for Saturday and Sunday if you like), turn the schedule off, or press **Turn off now** and **Turn on now**. You can also link a Philips Hue smart plug here (see below), or let the Hue app switch the monitor without a plug (Part 6).
- **Settings**: 12 or 24-hour clock, weeks on the calendar, how many tasks show, how often each thing is checked, and a time zone box if the clock or "today" is ever wrong.
- **System**: the Pi's temperature, memory, storage and power. If it reports **under-voltage**, your power supply is too weak, which can cause glitches. Here you can also restart the server, add an optional dashboard password, and read recent server messages.

### Turning the monitor off at night

The **Screen power** tab handles this, and it uses **HDMI-CEC**: the Pi sends a "standby" message down the HDMI cable at the off time and a "power on" message at the on time, so the monitor itself switches off and on, just like pressing its power button. The Pi keeps running, so everything is up to date when the monitor wakes. The times follow the Pi's clock, which shows at the top of the tab (if it is wrong, fix the time zone as in Part 1, Step 1).

For this to work you need three things. First, the monitor must support HDMI-CEC. Most TVs do; many computer monitors do not, and nothing in the Pi can add it. Second, HDMI-CEC must be switched on in the monitor's own menu (it may be called HDMI Control, Anynet+, Simplink, EasyLink or Bravia Sync). Third, the monitor must be plugged into the HDMI port next to the Pi's power port. Then press **Check HDMI-CEC** on the tab: it asks the monitor if it is on, and a green message means it works. Press **Turn off now** and **Turn on now** to see the monitor react.

If the monitor does not answer over HDMI-CEC, Homeboard switches the picture off instead, which makes most monitors put themselves to sleep, and the tab shows a yellow note saying so. If your monitor simply does not support HDMI-CEC, press **This monitor doesn't support HDMI-CEC** on the Screen power tab to clear that note for good (there's a **Show it again** link if you change your mind). If the tab says a tool is missing, it shows the one command to run on the Pi, usually `sudo apt install -y cec-utils`.

Pressing **Turn off now** or **Turn on now** overrides the schedule until its next change. **Go back to the schedule** cancels that.

Optional: a Philips Hue smart plug can cut the monitor's power as well, in addition to HDMI-CEC. Plug **only the monitor** into it (never the Pi). On the **Screen power** tab, scroll to **Philips Hue**, press **Find my Hue Bridge** (or type the bridge's address), press **Link Hue**, and press the round button on top of the bridge within 30 seconds. Tick the plug, press **Save chosen devices**, then press **Test the plug**: the monitor should lose power for five seconds and come back. At night the monitor is told to switch itself off first and the plug is cut three seconds later; in the morning the plug comes on first, Homeboard waits about seven seconds for the monitor to start, then wakes it. Some monitors stay dark after power returns until you press their own button, and the picture may come back turned the wrong way on some desktops after a power cut; if yours does either, skip the plug, because HDMI-CEC alone already puts the monitor to sleep.

You can also copy pictures straight into the folder on the Pi: the installer put a **Homeboard pictures** shortcut on the Pi's desktop. In the dashboard press **Refresh list** on the Pictures tab to see them.

The dashboard is meant for your home network only. Do not set up port forwarding on your router to reach it from the internet.

---

## Part 6: Optional: switch the monitor from the Hue app

You do not need a smart plug for this. **diyHue** (diyhue.org) is a free program that pretends to be a Philips Hue Bridge. Homeboard can tell it that the monitor is a Hue smart plug, and then the Hue app can switch the monitor on and off. Voice assistants are a maybe (see the end of Step 4).

Please read this first, because it is more work than the rest of this guide:

- diyHue runs in Docker and must always be on. You can run it **on this same Pi** (Option A, one command) or **on another computer** such as a second Pi, a mini PC or a NAS (Option B).
- diyHue is a second bridge next to your real Hue Bridge. Your real bridge, bulbs and Hue routines stay exactly as they are. Routines on your real bridge cannot switch the monitor, because it lives on the other bridge. (Routines made on the diyHue bridge itself might work, but that has not been tried.) Use Homeboard's own schedule for the daily on and off, and use the Hue app for the extra "off now" and "on now". A Hue smart plug on your real bridge (Part 5) works alongside this: a switch from the Hue app then also switches the plug.
- The Pi switches the monitor over HDMI-CEC, exactly as the daily schedule does, so everything said about HDMI-CEC in Part 5 applies here too. If your monitor cannot do HDMI-CEC, only its picture is switched off (or the plug, if you have one).
- This is written from diyHue's public instructions. It has not been tried with a real diyHue, Hue app or voice assistant, and diyHue's screens change now and then, so the button names below may differ a little. Option A is the least proven part: diyHue's own instructions prefer a different Docker network mode, and this Pi's setup uses the "bridge" mode that its documentation also lists. If Option A gives you trouble, Option B is the safer way.

### Option A: on this same Pi

Both programs want port 80 on the Pi, and they can share it because each uses a different address. Homeboard answers diyHue only on Docker's private address (usually `172.17.0.1`), and diyHue's Docker container is published only on the Pi's network address. Nothing needs to be worked out by hand: run this on the Pi.

```
bash ~/homeboard/deploy/install-diyhue.sh
```

It installs Docker if needed, tells Homeboard to answer on Docker's address (the dashboard's diyHue card then says **On this same Pi, in Docker**), restarts Homeboard, and starts diyHue. The first start downloads diyHue, which can take a few minutes. At the end it prints the two addresses you need: the Pi's own address, where diyHue's web page is (`http://` and that address), and Docker's address for Step 3. Give the Pi a fixed address in your router's settings (often called an address reservation), because diyHue remembers the address it saw. If diyHue is not running after a reboot, run `sudo docker start diyHue`. The Pi's address is fixed inside diyHue, so if your router gives the Pi a new address, run the script with `--remove` and then again. If you turned on a firewall (ufw) on the Pi, allow Docker to reach Homeboard with `sudo ufw allow in on docker0 to any port 80`. Add `--dry-run` to see what it would do without changing anything. To undo it, run the script with `--remove` (diyHue's settings stay in the `diyhue-config` folder in your home folder).

Then continue with Step 3 below. If diyHue's page asks you to sign in, its documentation lists `admin@diyhue.org` and `changeme` as the first login.

### Option B: on another computer

1. Open the dashboard, go to the **Screen power** tab and scroll to **Hue app control (diyHue, optional)**. Tick **Let diyHue see this Pi as a Hue smart plug**, leave **Where does diyHue run?** on **On another computer**, type the name you want to see in the Hue app (for example "Kitchen monitor"), and press **Save**. The card should say **Listening on port 80** and show the Pi's address (for example `192.168.1.50`). Keep that address handy, and give the Pi a fixed address in your router's settings, because diyHue remembers the address it saw. If the card says the Pi is not allowed to use port 80, run the installer again (`bash homeboard/deploy/install.sh`), then run `sudo systemctl restart homeboard`.
2. On the other computer, install Docker (docs.docker.com/engine/install), then run this one command. Replace `XX:XX:XX:XX:XX:XX` with that computer's own network address: run `cat /sys/class/net/eth0/address` on it (use `wlan0` instead of `eth0` if it is on Wi-Fi).

```
docker run -d --name diyHue --restart=always --network=host \
  -e MAC=XX:XX:XX:XX:XX:XX \
  -v /mnt/hue-emulator/config:/opt/hue-emulator/config \
  diyhue/core:latest
```

Then open `http://` and that computer's address in a browser. If diyHue asks you to sign in, its documentation lists `admin@diyhue.org` and `changeme` as the first login.

### Step 3. Add the monitor to diyHue

In diyHue's web page open **Lights**, then press **Scan for lights** (it can take a few minutes) or **Add light** and type the address the Homeboard card shows under **Address to give diyHue** (with Option A that is Docker's address, for example `172.17.0.1`; with Option B it is the Pi's own address). Typing it is more reliable than scanning. The monitor should appear under the name you chose (diyHue may add a number after it). Add it only once: adding it again makes a second light, which you can delete in diyHue. Back in Homeboard, press **Refresh** on the diyHue card: it should now say when diyHue last asked.

### Step 4. Connect the Hue app

In diyHue's web page click **Link Button**. On your phone, open the Hue app and add a bridge (the Hue app's Help option lets you type the diyHue computer's address, which speeds it up; with Option A that is the Pi's own address). When the app asks you to press the button on the bridge, click **Link App** on the diyHue page instead. The monitor then appears in the Hue app as a smart plug. Tap it and the screen should switch. The Hue app can show more than one bridge, so your real lights stay there too.

Voice assistants are a maybe. Alexa may find diyHue the way it finds a real Hue Bridge. diyHue's own documentation says Google Home and Apple Home need its remote-access feature, which it says is not currently available. I could not confirm any of this.

### Good to know

DiyHue only re-checks the light every five minutes, so the Hue app can show the wrong on or off for a while after you switch the screen some other way (the schedule or the dashboard). If you rename the monitor in Homeboard, the light already in diyHue keeps its old name; delete it there and add it again. The Hue app answers at once, but the monitor itself takes a few seconds to react (up to about twenty seconds with a Hue plug linked), because the Pi waits for it to confirm.

### How it fits with the schedule

A switch from the Hue app or a voice assistant works like **Turn off now** or **Turn on now** on the dashboard: it holds until the schedule's next change, then the schedule takes over again. Homeboard's card shows **Last switch from diyHue** so you can see it arrived.

---

## If something goes wrong

Start with `bash ~/homeboard/deploy/status.sh` on the Pi. It shows which piece is missing. Then find your symptom below.

| What you see | What to do |
| --- | --- |
| `homeboard.local` is not found | Use the Pi's address instead. On the Pi, open a terminal and run `hostname -I`, or look for "homeboard" in your router's device list. Then use `ssh YOUR-USERNAME@THAT-ADDRESS`. |
| Desktop shows, but no dashboard | Reboot once. If it is still missing, run the status check. If **Server answering** says NO, run `journalctl -u homeboard -n 30 --no-pager` and send the output to Claude. |
| The installer prints `!! The installer stopped at line ...` | Run the command it shows you (starts with `bash -x`) and send Claude everything it prints, plus `node -v`. That pinpoints exactly which step failed. |
| The Pi's own screen is plain gray | Normal for about the first minute after boot or reboot — the Pi waits for everything to be ready before it opens the screen. If it is still gray after a couple of minutes, run `bash ~/homeboard/deploy/status.sh` and look at **Screen schedule**: if it says Homeboard wants the screen off, that is working as designed (it is past your off time, or the Pi's time zone is wrong — check Part 1, Step 1); press **Turn on now** on the dashboard's Screen power tab to test, or wait for the on time. If it says the screen should be on, look at **Chromium last exit**: if it shows a crash, send Claude the full log it points to (`cat` that file, over `ssh` or the Pi's Terminal). To bring the screen back right now without rebooting, open a terminal **on the Pi's own screen** (not over ssh) and run `bash ~/homeboard/deploy/kiosk.sh &`. |
| The monitor does not turn off or on at the set times | Open the dashboard's **Screen power** tab and press **Check HDMI-CEC**. If it says the monitor did not answer: switch HDMI-CEC on in the monitor's menu, use the HDMI port next to the Pi's power port, and remember that some monitors do not support it at all (then only the picture is switched off — press **This monitor doesn't support HDMI-CEC** on that tab to stop the yellow warning). If it says a tool is missing, run the command it shows. To test by hand on the Pi, run `echo 'pow 0' \| cec-client -s -d 1`: it should print the monitor's power status. If the clock on the tab is wrong, fix the time zone (Part 1, Step 1, or the Settings tab's Time zone box). |
| diyHue does not find the monitor (Part 6) | On the **Screen power** tab, the diyHue card must say **Listening on port 80**. In diyHue use **Add light** and type the address the card shows instead of scanning. If the card says port 80 is not allowed, run the installer again and restart (Part 6, Option B). If it says port 80 is in use and diyHue is on this same Pi, choose **On this same Pi, in Docker** on the card, or run `bash deploy/install-diyhue.sh`; otherwise diyHue has to run on a different computer. If the card says Docker is not running, run `sudo systemctl start docker`. On the same Pi, `sudo docker ps` should list diyHue and `sudo docker logs diyHue` shows what it says. |
| The monitor stays black after the morning wake-up | Press **Turn on now** on the **Screen power** tab. If it only comes back that way, check that the monitor's input setting is fixed to the HDMI port the Pi uses (some monitors search other inputs after waking). With a Hue plug, some monitors also stay dark when power returns until you press their own button; then skip the plug. The wake-up message also tells the monitor to show the Pi's input, but not every monitor obeys it. |
| "Add a calendar link and a Todoist token" on the screen | Do Part 3, Steps 2 and 3 (the screen shows the dashboard address to open). |
| The dashboard address does not open on my PC | Try the number address (for example `http://192.168.1.50:3000/admin`) that `bash deploy/status.sh` prints. Make sure it starts with **http**, and that your PC is on the same Wi-Fi as the Pi. |
| The dashboard asks for a password I forgot | Only happens if you added one. On the Pi, over `ssh`, run `cd ~/homeboard && node deploy/set-password.js --remove`. |
| A Pictures upload fails | Only JPG, PNG and WebP work, up to 30 MB each. A file that is really a different type renamed to `.jpg` is refused. |
| A line at the bottom of the screen: "Calendar link not working" or "Todoist token rejected" | Open the dashboard's **Calendar & Tasks** tab and press **Test** next to the one it names; the message says what is wrong. A rejected Todoist token usually means it was copied wrong — copy it again from Todoist, Settings, Integrations, Developer. |
| Weather or calendar empty right after boot | Wait a minute. It retries every 15 to 60 seconds until the Wi-Fi is up. |
| Wrong time or wrong date | Dashboard, **Settings** tab, **Time zone** box. (Or on the Pi run `sudo raspi-config`, choose **Localisation Options**, then **Timezone**.) |
| Screen is sideways or upside down | Redo Part 1, Step 3 and pick the other orientation. |
| Choppy on a Pi 3 | Turn on **Low-power mode** on the dashboard's Settings tab. Smaller background photos also help. |
| Still stuck | Run the status check and tell Claude what each line says, plus which Raspberry Pi OS version you installed. |
