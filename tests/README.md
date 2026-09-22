# Tests

Plain Node, no framework, no dependencies, no network access needed. Run each one with `node tests/<file>`
from the project root (or from inside `tests/`; the paths inside each file are relative to itself).

- `ical_test.js` — unit tests for `lib/ical.js` (the calendar/RRULE reader): line folding and text escapes,
  all-day/UTC/floating/TZID times (checked across a real US daylight-saving change), `RRULE` DAILY/WEEKLY/
  MONTHLY/YEARLY with `INTERVAL`/`COUNT`/`UNTIL`/`BYDAY` (including `2TU`/`-1FR`)/`BYMONTHDAY`/`BYMONTH`/
  `BYSETPOS`/`WKST`, `EXDATE`, `RDATE`, `RECURRENCE-ID` overrides (moved/renamed/cancelled), declined-invite
  filtering, and a feed that isn't really an ICS file. One case is checked directly against RFC 5545's own
  worked example.
- `calendars_test.js` — `lib/calendars.js` (the calendar source manager: add/rename/remove/test, never
  exposes the raw secret link) against `fake_calendar_server.js`, a tiny local HTTP server that serves
  canned `.ics` text.
- `todoist_test.js` — `lib/todoist.js` (the Todoist client and token storage) against
  `fake_todoist_server.js`, a tiny local HTTP server implementing enough of `GET /projects` and
  `GET /tasks` (cursor pagination, auth, a rate-limited mode) to exercise the client. `lib/todoist.js`
  reads its base URL from the `TODOIST_BASE` environment variable, which is how these tests point it at
  the fake instead of the real API.

All of the above pass on every run and don't touch the network, a real Pi, or any real account. What they
do **not** cover: HDMI-CEC, the Hue plug, diyHue, and the screen-power schedule (`lib/display.js`,
`lib/hue.js`, `lib/huelight.js`, `lib/power.js`) have no automated tests here — they were checked by
reading the code carefully and, for the parts a real user could try, by hand against real hardware. Nor is
there a check against a real Google Calendar feed or a real Todoist account, only the fakes above.
