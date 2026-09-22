# Homeboard: notes for AI coding assistants

Self-hosted DAKboard-style dashboard for a vertical monitor on a Raspberry Pi (Node >= 18, zero npm
dependencies). Everything lives in `homeboard/`: a Node HTTP server (`server.js`, `lib/`) and a plain
HTML/CSS/JS front end (`public/`) — the screen itself and the `/admin` dashboard.

Calendar and tasks need no sign-in: a Google Calendar secret iCal link (`lib/ical.js` for the RRULE
reader, `lib/calendars.js` for the source list) and a Todoist API token (`lib/todoist.js`). There is no
Google OAuth anywhere in this project.

## Standing rules

- The Pi is meant for a home network you trust. **Ease of use and simplicity beat security.** Don't add or
  suggest hardening (extra auth, TLS, lockdown flags) unless asked. The dashboard password is optional and
  off by default.
- The intended reader of any guide or on-screen message is not a programmer: plain language, step by step,
  no jargon.
- Never claim something works if it has only been checked against a fake/mock. Say plainly what is
  verified and what isn't.
- Keep exactly one setup guide: `homeboard/START-HERE.md` (plain-language, non-technical). `README.md` is
  the technical reference. Don't create loose copies or duplicate guides.
- Don't redo everything for a small request; change only what was asked.
- Never use `pkill -f` in a shell you're running in (it can kill the session itself). Use `pkill -x <name>`.
