# Home Energy

A single-page dashboard for a house with solar, a home battery, an EV and an
[Amber Electric](https://www.amber.com.au/) wholesale energy plan. It shows the
live power flow, the current buy/feed-in price, battery state of charge and
operating mode, and the car's state of charge.

The page ships with sample data so it runs out of the box. Pointing it at your
real house is a matter of standing up a small backend that returns one JSON
document — that is what most of this README is about.

---

## Contents

- [Files](#files)
- [Running it](#running-it)
- [Architecture](#architecture)
- [The data contract](#the-data-contract)
- [Getting real data in](#getting-real-data-in)
  - [Amber Electric (prices)](#1-amber-electric-prices)
  - [Sigenergy (solar, battery, grid)](#2-sigenergy-solar-battery-grid)
  - [Polestar (vehicle)](#3-polestar-vehicle)
  - [The shortcut: Home Assistant as the aggregator](#the-shortcut-home-assistant-as-the-aggregator)
- [A reference backend](#a-reference-backend)
- [Configuration](#configuration)
- [Deploying](#deploying)
- [Security checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)

---

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup only. No data, no inline logic. |
| `styles.css` | All presentation, including loading/stale/error states. |
| `app.js` | Fetches state, renders it, polls, handles failures, writes battery mode. |
| `config.js` | Deployment settings. The only file you should need to edit. |
| `mock/state.json` | Sample payload used in demo mode; also the schema reference. |

No build step, no framework, no dependencies. It is five static files that can be
served from anything — nginx, Caddy, S3, a Raspberry Pi, GitHub Pages.

## Running it

```bash
# any static server; the page fetches JSON, so file:// will not work
python3 -m http.server 8000
# → http://localhost:8000
```

It starts in demo mode (`demo: true` in `config.js`) and reads
`mock/state.json`, with the sample timestamps shifted onto the current clock so
freshness labels read sensibly. A "Sample data" pill appears in the header and
mode buttons do nothing but toast.

To go live, set `demo: false` and point `apiBaseUrl` at your backend.

## Architecture

```
  Browser (these files)
        │  GET  /api/state          every 30 s
        │  POST /api/battery/mode   on click
        ▼
  Your backend  ── caches, holds credentials, normalises ──┐
        │                                                  │
        ├─ Amber REST API            (cloud, token)         │
        ├─ Sigenergy inverter        (local Modbus TCP)     │
        └─ Polestar                  (cloud, unofficial)    │
                                                            ▼
                                              one normalised JSON document
```

**The browser must not talk to Amber, Sigenergy or Polestar directly.** Three
independent reasons, any one of which is fatal:

1. **Credentials.** Anything the page can read, a visitor can read. An Amber
   token or a Polestar password in front-end code is a published credential.
2. **CORS.** None of these APIs send `Access-Control-Allow-Origin` for your
   site, so the browser blocks the response even when the request succeeds.
3. **Rate limits.** Amber allows roughly 50 requests per 5 minutes per token.
   One browser tab per family member polling directly will exhaust that; a
   backend that caches for 60 s serves any number of tabs from one upstream call.

So the backend is not optional ceremony — it is the thing that makes this
workable. It can be tiny: ~150 lines of Node, or a Home Assistant template
sensor plus a two-line proxy.

## The data contract

`GET /api/state` returns the document below. Every field is optional except
`updatedAt`; anything missing, null or non-numeric renders as `—` rather than
breaking the page, so a partial payload during an upstream outage is fine.

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": "2026-07-12T02:41:00Z",   // when the backend assembled this

  "price": {
    "descriptor": "low",        // extremelyLow | veryLow | low | neutral | high | spike
    "buy": 9.4,                 // c/kWh, signed — negative means you are paid to consume
    "feedIn": 3.8,              // c/kWh you receive for exporting (see sign note below)
    "renewables": 64,           // % of grid generation that is renewable
    "spike": false,
    "forecast": {               // cheapest upcoming window; omit if unknown
      "start": "2026-07-12T03:00:00Z",
      "end":   "2026-07-12T05:00:00Z",
      "perKwh": 4.1
    },
    "updatedAt": "2026-07-12T02:35:00Z",
    "source": "amber"           // shown in the footer
  },

  "site": {                     // instantaneous power, kW
    "solar": 4.2,               // ≥ 0, generation
    "load": 1.1,                // ≥ 0, house consumption
    "battery": 2.6,             // + charging, − discharging
    "grid": -0.5,               // + importing, − exporting
    "car": 0,                   // ≥ 0, EV charger draw
    "updatedAt": "…", "source": "sigen"
  },

  "battery": {
    "soc": 76,                  // %
    "energy": 12.2,             // kWh stored
    "capacity": 16,             // kWh usable
    "power": 2.6,               // + charging, − discharging
    "mode": "time_of_use",      // must match one of the ids below
    "modes": [                  // drives the buttons; empty array hides the control
      { "id": "sigen_ai",          "label": "Sigen AI" },
      { "id": "max_self_powered",  "label": "Max self powered" },
      { "id": "time_of_use",       "label": "Time of use" },
      { "id": "fully_fed_to_grid", "label": "Fully fed to grid" }
    ],
    "secondsToFull": 5100,      // shown while charging
    "secondsToEmpty": null,     // shown while discharging
    "readOnly": false,          // true → buttons render disabled
    "updatedAt": "…", "source": "sigen"
  },

  "vehicle": {                  // omit the whole object to hide the card
    "name": "Polestar 2",
    "soc": 68,
    "rangeKm": 340,
    "pluggedIn": true,
    "charging": false,
    "power": 0,
    "readOnly": true,
    "updatedAt": "…", "source": "polestar"
  },

  "today": {                    // kWh since local midnight
    "solar": 28.4, "exported": 9.1, "imported": 2.3, "consumed": 14.7
  },

  "errors": [                   // optional; each entry raises the warning banner
    { "source": "polestar", "message": "auth token expired" }
  ]
}
```

**Sign conventions matter.** `grid` positive means importing, negative means
exporting; `battery`/`battery.power` positive means charging. The flow diagram
reverses its animation and recolours the grid leg (blue export → red import)
purely from those signs, so if the arrows point the wrong way, your adapter has
the sign backwards, not the page.

Timestamps are ISO 8601 with a timezone. Per-section `updatedAt` values drive
the "updated 2 min ago" labels and the stale warning, with different thresholds
per source (see `staleAfterSeconds`) — a car that has not reported for 40
minutes is asleep and normal; an inverter that has not reported for 5 minutes is
a problem.

### Writing the battery mode

```http
POST /api/battery/mode
Content-Type: application/json

{ "mode": "time_of_use" }
```

- `200 {"mode": "time_of_use"}` — applied. The page confirms, then re-fetches
  after 3 s because the inverter takes a moment to reflect the change.
- `403` or `405` — treated as "read only"; the UI reverts the button and says so.
- Anything else — reverts and shows the error.

The button is optimistic but reverts on failure, and is disabled while the
request is in flight. Return the mode the inverter actually ended up in, not the
one that was requested.

---

## Getting real data in

Three upstreams, three very different levels of support. Read this before
picking an approach — one of them (Home Assistant) does most of the work for you.

### 1. Amber Electric (prices)

The only one of the three with a real, documented, supported API.

1. Sign in at [app.amber.com.au/developers](https://app.amber.com.au/developers)
   and generate a personal API token.
2. Find your site id once, then cache it:

```bash
curl -s https://api.amber.com.au/v1/sites \
  -H "Authorization: Bearer $AMBER_TOKEN"
# → [{ "id": "01ABC…", "nmi": "…", "channels": [...] }]
```

3. Poll current + forecast prices. One call covers the banner *and* the
   cheapest-window forecast:

```bash
curl -s "https://api.amber.com.au/v1/sites/$SITE_ID/prices/current?next=16&resolution=30" \
  -H "Authorization: Bearer $AMBER_TOKEN"
```

Each interval looks like:

```jsonc
{
  "type": "CurrentInterval",      // or ActualInterval / ForecastInterval
  "channelType": "general",       // general | controlledLoad | feedIn
  "perKwh": 9.42,                 // c/kWh including network + retail
  "spotPerKwh": 4.11,
  "renewables": 63.8,
  "descriptor": "low",            // extremelyLow | veryLow | low | neutral | high | spike
  "spikeStatus": "none",
  "startTime": "…", "endTime": "…", "nemTime": "…"
}
```

Mapping to the contract:

- `price.buy` ← the `general` channel interval where `type == "CurrentInterval"`.
- `price.feedIn` ← the `feedIn` channel interval for the same period. **Check
  the sign against the Amber app on your first run.** The feed-in channel is
  reported from the customer-cost perspective, so what you earn is usually the
  negation of `perKwh`; getting this wrong silently shows earnings as a cost.
- `price.descriptor` ← `descriptor` (the page accepts `extremelyLow`,
  `extremely_low` or `Extremely Low`).
- `price.spike` ← `spikeStatus !== "none"`.
- `price.renewables` ← `renewables`.
- `price.forecast` ← scan the `ForecastInterval` entries on the `general`
  channel for the cheapest run of consecutive intervals:

```js
function cheapestWindow(intervals, slots = 4) {   // 4 × 30 min = 2 hours
  const f = intervals
    .filter(i => i.type === "ForecastInterval" && i.channelType === "general")
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  if (f.length < slots) return null;
  let best = null;
  for (let i = 0; i + slots <= f.length; i++) {
    const win = f.slice(i, i + slots);
    const avg = win.reduce((s, x) => s + x.perKwh, 0) / slots;
    if (!best || avg < best.perKwh) {
      best = { start: win[0].startTime, end: win[slots - 1].endTime, perKwh: +avg.toFixed(1) };
    }
  }
  return best;
}
```

**Rate limits.** Roughly 50 requests per 5 minutes per token. Prices only change
every 5 minutes anyway, so cache the response for 60–120 s in the backend and
never let the browser drive an upstream call. On `429`, back off and keep
serving the cached value — the page will show the price ageing rather than
disappearing.

**Usage totals.** `GET /v1/sites/{id}/usage?startDate=…&endDate=…` returns
per-interval kWh and cost for the `today` block, but it settles with a delay of
up to a day. Prefer the inverter's own daily counters for `today` and use Amber
usage only for billing-accurate history.

### 2. Sigenergy (solar, battery, grid)

There is **no public, documented Sigenergy cloud API** — mySigen/SigenCloud is a
closed app backend, and scraping it tends to break without notice. The reliable
route is local:

**Modbus TCP on your LAN.** Sigenergy publishes a Modbus register map ("Sigen
Energy Modbus Protocol", available through installer/partner channels or your
installer) and the gateway exposes Modbus TCP on port 502 once it is enabled in
the installer settings. You need registers for: PV power, load power, grid
active power, battery power, battery SoC, rated capacity, daily energy counters,
and the running-mode register — the one that selects Sigen AI / Maximum Self
Consumption / Time of Use / Fully Fed to Grid, which is exactly the four-button
control in the UI.

Read it with any Modbus client; from Node, `modbus-serial`:

```js
const ModbusRTU = require("modbus-serial");
const client = new ModbusRTU();
await client.connectTCP("192.168.1.50", { port: 502 });
client.setID(247);                       // unit id per Sigenergy's map
const soc = (await client.readHoldingRegisters(ADDR_SOC, 1)).data[0] / 10;
```

Notes from the register map that bite people:

- Values are scaled integers (÷10, ÷100 or ÷1000) — confirm each one.
- Power values are signed 16- or 32-bit; check the sign convention for grid and
  battery power and normalise to *this* contract's convention, not the meter's.
- Do not poll faster than ~2–5 s; the gateway will start dropping connections.
- **Writes.** The running-mode register is writable, and that is what backs
  `POST /api/battery/mode`. Writing to the wrong register on an inverter is not
  a harmless mistake: gate the write behind an allowlist of exactly the four
  mode values, log every write, and test against the mySigen app before wiring
  the button up. Until then, set `readOnly: true` in the payload (or
  `readOnly: true` in `config.js`) and the buttons render disabled.

The community Home Assistant integration
[`sigenergy-local-modbus`](https://github.com/TypQxQ/Sigenergy-Local-Modbus)
(installable via HACS) has already done this register mapping and is the fastest
way to a working system — see the Home Assistant section below.

### 3. Polestar (vehicle)

Also no official public API. Polestar's own app talks to a GraphQL endpoint
(`pc-api.polestar.com`) behind a Polestar ID OAuth login. The practical option
is the community Home Assistant integration
[`polestar_api`](https://github.com/leeyuentuen/polestar_api), which handles the
login flow and exposes battery level, estimated range, charging status and
plug status.

Whatever you use, treat this source as best-effort:

- **Poll rarely** — every 15–30 minutes. The car wakes for API calls; aggressive
  polling drains the 12 V battery and can get the account throttled.
- **Expect it to break.** Unofficial endpoints change. That is why `vehicle` is
  optional in the contract, why the card hides entirely when it is absent, and
  why `errors[]` exists: report `{ "source": "polestar", "message": "…" }` and
  the rest of the dashboard carries on.
- The card is marked "Read only" because there is no supported way to start or
  stop charging. Charging control belongs at the charger (OCPP) or the
  inverter's EV mode, not the car.

### The shortcut: Home Assistant as the aggregator

If you already run Home Assistant — or are willing to — it is by a wide margin
the least work, and it is what the three-integration path above converges on:

| Source | Integration |
| --- | --- |
| Amber | `amberelectric` (official, built in) |
| Sigenergy | `sigenergy-local-modbus` via HACS (Modbus TCP, local) |
| Polestar | `polestar_api` via HACS |

Home Assistant then owns the polling, retries, credential storage and history,
and your backend collapses into one call that maps entity ids to the contract:

```js
// GET /api/state, backed by Home Assistant
const HA = process.env.HA_URL;                 // http://homeassistant.local:8123
const TOKEN = process.env.HA_TOKEN;            // long-lived access token

async function ha(entityId) {
  const r = await fetch(`${HA}/api/states/${entityId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) throw new Error(`${entityId}: HTTP ${r.status}`);
  const s = await r.json();
  return {
    value: s.state === "unavailable" || s.state === "unknown" ? null : Number(s.state),
    updatedAt: s.last_updated,
  };
}

const solar = await ha("sensor.sigen_plant_pv_power");
// → site.solar = solar.value, site.updatedAt = solar.updatedAt
```

Mode changes become a service call:

```js
await fetch(`${HA}/api/services/select/select_option`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    entity_id: "select.sigen_plant_remote_ems_control_mode",
    option: "Time of Use",
  }),
});
```

Two things to keep straight: entity ids differ between integration versions, so
check them in Developer Tools → States rather than copying names; and the HA
long-lived token stays on the server — never in `config.js`.

---

## A reference backend

Minimal but production-shaped: one cached snapshot, upstream failures degrade
into `errors[]` instead of a blank page, and no upstream call is ever driven
directly by a page load.

```js
// server.js — node >= 18, `npm i express`
import express from "express";

const app = express();
app.use(express.json());
app.use(express.static("public"));            // index.html, app.js, styles.css, config.js

const CACHE_MS = 15_000;
let snapshot = null;
let building = null;                          // single-flight guard

async function build() {
  const errors = [];
  const settle = async (source, fn) => {
    try { return await fn(); }
    catch (e) { errors.push({ source, message: e.message }); return null; }
  };

  const [price, site, battery, vehicle, today] = await Promise.all([
    settle("amber",    getAmberPrice),        // cache 60–120 s internally
    settle("sigen",    getSitePower),         // Modbus, ~5 s
    settle("sigen",    getBattery),
    settle("polestar", getVehicle),           // cache 15–30 min internally
    settle("sigen",    getTodayTotals),
  ]);

  return { schemaVersion: 1, updatedAt: new Date().toISOString(),
           price, site, battery, vehicle, today, errors };
}

app.get("/api/state", async (_req, res) => {
  try {
    if (!snapshot || Date.now() - snapshot.at > CACHE_MS) {
      building ??= build().finally(() => { building = null; });
      snapshot = { at: Date.now(), data: await building };
    }
    res.set("Cache-Control", "no-store").json(snapshot.data);
  } catch (e) {
    // Serve stale rather than nothing — the page flags the age itself.
    if (snapshot) return res.set("Cache-Control", "no-store").json(snapshot.data);
    res.status(502).json({ error: "upstream unavailable" });
  }
});

const MODES = new Set(["sigen_ai", "max_self_powered", "time_of_use", "fully_fed_to_grid"]);

app.post("/api/battery/mode", async (req, res) => {
  const { mode } = req.body ?? {};
  if (!MODES.has(mode)) return res.status(400).json({ error: "unknown mode" });
  if (process.env.ALLOW_WRITES !== "1") return res.status(403).json({ error: "read only" });
  try {
    const applied = await setInverterMode(mode);   // Modbus write / HA service call
    snapshot = null;                               // force a fresh read next poll
    console.log(JSON.stringify({ event: "mode_write", mode, applied, at: new Date() }));
    res.json({ mode: applied });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(8080);
```

Worth keeping when you flesh this out:

- **Cache per upstream, not just per response.** Amber 60–120 s, Modbus 5 s,
  Polestar 15–30 min. The 15 s response cache sits on top of those.
- **Single-flight.** Ten tabs refreshing at once must produce one upstream call,
  which is what the `building ??=` guard does.
- **Never fail the whole payload for one dead source.** `settle()` is the whole
  trick — the page is built to render around holes.
- **`ALLOW_WRITES` off by default.** Turn it on only once you have verified the
  mode register against the vendor app.
- **Log every write** with the requested and applied mode.

## Configuration

All of it lives in `config.js`, which is plain JavaScript so it can be swapped at
deploy time (ConfigMap, bind mount, `envsubst`) without a rebuild.

| Key | Default | Meaning |
| --- | --- | --- |
| `apiBaseUrl` | `""` | Backend origin. Empty = same origin as the page. |
| `statePath` | `/api/state` | Snapshot endpoint. |
| `modePath` | `/api/battery/mode` | Mode write endpoint. |
| `demo` | `true` | Serve `mock/state.json` and disable writes. **Set to `false` in production.** |
| `refreshSeconds` | `30` | Poll interval; polling pauses while the tab is hidden. |
| `requestTimeoutMs` | `10000` | Per-request abort timeout. |
| `staleAfterSeconds` | `{site:300, battery:300, price:900, vehicle:5400}` | Per-source stale thresholds. A number applies one value to all. |
| `readOnly` | `false` | Force-disable the mode buttons regardless of payload. |
| `locale` / `timeZone` | `en-AU` / `Australia/Melbourne` | Formatting. `null` = use the browser's. |
| `priceUnit` | `c/kWh` | Label next to prices. |

Behaviour worth knowing:

- Polling stops when the tab is hidden and fires immediately on return, so a
  phone left on the counter overnight makes zero requests and is current the
  moment you pick it up.
- Failures back off exponentially from `refreshSeconds` to a 5-minute ceiling,
  and reset on success, on `online`, or on the banner's Retry button.
- The last good render stays on screen during an outage, dimmed, with a banner —
  a dashboard that blanks out is worse than one showing data it admits is old.

## Deploying

Static files plus a reverse proxy so the page and the API share an origin (no
CORS, and a `SameSite` cookie just works):

```nginx
server {
  listen 443 ssl http2;
  server_name energy.example.com;

  root /srv/energy;                    # index.html, app.js, styles.css, config.js, mock/

  # config.js must never be cached — it is how you change environments.
  location = /config.js { add_header Cache-Control "no-store"; }

  location /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_read_timeout 15s;
  }

  add_header Content-Security-Policy
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" always;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
}
```

There is no inline script or style in the page, so that CSP holds with no
`unsafe-inline`. If you would rather not depend on Google Fonts at all —
worthwhile for a dashboard on a home network that may not have internet during
an outage — download the three families into `fonts/`, replace the `<link>` in
`index.html` with local `@font-face` rules, and tighten CSP to `'self'`. The
CSS already falls back to system fonts, so a blocked font request degrades
rather than breaks.

For a wall tablet, also consider: `display: standalone` via a web manifest,
kiosk mode in the browser, and the fact that `refreshSeconds: 30` on a 24/7
screen is ~2,900 requests a day against your backend cache, not upstream.

## Security checklist

- [ ] No upstream credential in `config.js`, `app.js`, or any file under the web root.
- [ ] Backend reachable only over HTTPS, and only from where you need it — a
      home dashboard rarely needs to be on the public internet at all. Prefer
      Tailscale/WireGuard over port forwarding.
- [ ] Authentication in front of `/api/*` if it is exposed: a session cookie
      (`HttpOnly`, `Secure`, `SameSite=Lax`) set by your reverse proxy or an
      identity proxy. `app.js` sends cookies with `credentials: "same-origin"`
      and surfaces a 401 as "your session may have expired" — it deliberately
      does not implement token auth, because the token would have to live in
      front-end code.
- [ ] `POST /api/battery/mode` validated against a fixed allowlist, off by
      default, logged, and rate limited.
- [ ] Modbus reachable only on the LAN/VLAN the backend sits on. It is
      unauthenticated by design — anything that can reach port 502 can control
      the inverter.
- [ ] Amber token stored as an environment variable or in a secret store,
      rotatable from the Amber developer page if it leaks.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Everything reads `—`, red "Cannot load data" banner | Backend down or wrong `apiBaseUrl`; the banner names the status code, and the console has the raw error. |
| Values render but "Data is stale" | The backend is answering from a cache while an upstream is dead. Check `errors[]` in the raw payload. |
| Grid arrows point the wrong way | Sign convention flipped in your adapter: `grid` positive = importing, `battery` positive = charging. |
| Feed-in price shown as a cost (or vice versa) | Amber's `feedIn` channel sign — see the Amber section. |
| Mode buttons disabled | `demo: true`, `readOnly: true` in config or payload, an empty `modes` array, or the backend returning 403. |
| Prices stop updating, backend log shows 429 | Amber rate limit. Increase the upstream cache; the page's poll interval is not the problem. |
| Everything works, fonts look wrong | Google Fonts unreachable. Harmless — system fallbacks. Self-host to fix permanently. |

Useful checks:

```bash
curl -s localhost:8080/api/state | jq '{updatedAt, errors, price, site}'
curl -s -X POST localhost:8080/api/battery/mode \
  -H 'content-type: application/json' -d '{"mode":"time_of_use"}'
```

To exercise the UI's failure paths without breaking anything real, edit
`mock/state.json`: negative `price.buy`, `descriptor: "spike"`, a negative
`site.battery` (discharging), a positive `site.grid` (importing), a removed
`vehicle` block, or a populated `errors[]` array all render distinctly.
