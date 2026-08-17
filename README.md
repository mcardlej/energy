# Home Energy

A single-page dashboard for a house with solar, a home battery, an EV and an
[Amber Electric](https://www.amber.com.au/) wholesale energy plan. It shows the
live power flow, the current buy/feed-in price, battery state of charge and
operating mode, and the car's state of charge.

It deploys to Cloudflare as a single Worker that serves the page *and* talks to
your upstreams, so **every setting and every credential lives in Cloudflare** —
nothing sensitive is committed to this repository and nothing sensitive reaches
the browser. It ships with sample data, so a fresh deploy works before you have
configured a single token.

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
- [Putting it all in Cloudflare](#putting-it-all-in-cloudflare)
  - [What goes where](#what-goes-where)
  - [Reaching Home Assistant from a Worker](#reaching-home-assistant-from-a-worker)
  - [Deploy walkthrough](#deploy-walkthrough)
  - [Rotating, listing and removing secrets](#rotating-listing-and-removing-secrets)
- [Configuration reference](#configuration-reference)
- [Locking it down](#locking-it-down)
- [Security checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)

---

## Files

| File | Purpose |
| --- | --- |
| `public/index.html` | Markup only. No data, no inline logic. |
| `public/styles.css` | All presentation, including loading/stale/error states. |
| `public/app.js` | Fetches state, renders it, polls, handles failures, writes battery mode. |
| `public/mock/state.json` | Sample payload used in demo mode; also the schema reference. |
| `public/config.js` | **Local-development fallback only.** In production the Worker generates `/config.js` from the Cloudflare environment, and `.assetsignore` keeps this file from being uploaded. |
| `public/.assetsignore` | Files excluded from Cloudflare's static asset store. |
| `wrangler.toml` | How to deploy — name, entry point, assets. Deliberately holds no settings. |
| `.dev.vars.example` | Template for local secrets; copy to `.dev.vars` (git-ignored). |
| `worker/index.js` | Worker entry point: routing, caching, security headers. |
| `worker/env.js` | Reads settings and secrets off the Cloudflare `env` object. |
| `worker/config.js` | Builds the public `/config.js` — settings only, never secrets. |
| `worker/amber.js` | Amber Electric → the `price` block. |
| `worker/homeassistant.js` | Home Assistant → the `site`, `battery`, `vehicle`, `today` blocks. |

The front end has no build step, no framework and no dependencies — it is four
static files that could be served from anything. The Worker is what turns those
files into a working dashboard: it holds the credentials, calls the upstreams,
and hands the browser one JSON document. Both halves deploy together as a
single `wrangler deploy`.

## Running it

Two ways, depending on whether you want the Worker in the loop.

**Static only — demo data, no Cloudflare:**

```bash
# any static server; the page fetches JSON, so file:// will not work
cd public && python3 -m http.server 8000
# → http://localhost:8000
```

This uses the checked-in `public/config.js`, which sets `demo: true` and reads
`mock/state.json` with the sample timestamps shifted onto the current clock so
freshness labels read sensibly. A "Sample data" pill appears in the header and
mode buttons do nothing but toast.

**With the Worker — the real thing, locally:**

```bash
npm install
cp .dev.vars.example .dev.vars     # fill in your tokens; git-ignored
npx wrangler dev
# → http://localhost:8787
```

`wrangler dev` serves the static files, generates `/config.js` from
`.dev.vars`, and runs the real `/api/state` against your
upstreams. With no secrets in `.dev.vars` it stays in demo mode, so it is safe
to run before you have any tokens.

## Architecture

```
  Browser
     │  GET  /                    public/ — index.html, app.js, styles.css
     │  GET  /config.js           settings, generated from the Cloudflare environment
     │  GET  /api/state           every 30 s
     │  POST /api/battery/mode    on click
     ▼
  Cloudflare Worker  ── holds the secrets, caches, normalises ──┐
     │   (assets pass through the Worker too, so the CSP and    │
     │    other security headers apply on every route)          │
     │                                                          │
     ├─ Amber REST API        (cloud, AMBER_API_TOKEN)          │
     └─ Home Assistant        (your house, via Cloudflare Tunnel)│
            ├─ Sigenergy      (local Modbus TCP)                 │
            └─ Polestar       (cloud, unofficial)                │
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
   backend that caches for 90 s serves any number of tabs from one upstream call.

The Worker is that backend. It is also where every setting lives: it generates
`/config.js` per request from the Cloudflare environment, so changing the poll
interval or the timezone is a dashboard edit that takes effect on the next
request — not a code change, and not a redeploy.

**One thing a Worker cannot do:** open a Modbus TCP socket, or reach anything on
your home LAN. Workers speak HTTP to the public internet only. That is why the
inverter is reached through Home Assistant over a Cloudflare Tunnel rather than
directly — see [Reaching Home Assistant from a
Worker](#reaching-home-assistant-from-a-worker).

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
every 5 minutes anyway, so the Worker caches the response for `AMBER_CACHE_MS`
(90 s by default) and never lets the browser drive an upstream call. On `429`, back off and keep
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

**Modbus TCP on your LAN.** Note up front that a Cloudflare Worker cannot do
this itself — Workers have no raw TCP to your house. Something on your LAN has
to speak Modbus, and Home Assistant is the obvious candidate (see below). The
protocol details still matter, because they are what the integration is doing on
your behalf. Sigenergy publishes a Modbus register map ("Sigen
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
  the button up. That allowlist is in `worker/homeassistant.js`, and the whole
  path is off until you set `ALLOW_WRITES` to `true` in the dashboard. Until
  then the Worker reports `readOnly: true` and the buttons render disabled.

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

Home Assistant then owns the polling, retries, local protocol work and history,
and the Worker collapses into one call that maps entity ids to the contract —
which is what `worker/homeassistant.js` already implements:

```js
// GET /api/state, backed by Home Assistant. In the Worker these come off the
// `env` object (Cloudflare Secrets), not from a file or a process environment.
const HA = env.HA_BASE_URL;                    // https://ha.example.com (tunnel)
const TOKEN = env.HA_TOKEN;                    // long-lived access token

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

That is exactly what `worker/homeassistant.js` does, so you do not have to write
it — you only supply the entity ids if yours differ from the defaults.

Two things to keep straight: entity ids differ between integration versions, so
check them in Developer Tools → States rather than copying names (override them
with the `HA_ENTITIES` var); and the long-lived token stays server-side — it goes
into Cloudflare Secrets as `HA_TOKEN`, never into `config.js`.

---

## Putting it all in Cloudflare

Everything — the page, the API, the settings and the secrets — lives in one
Cloudflare Worker. There is no server to patch, no `.env` file on a box
somewhere, and no credential in this repository.

### What goes where

Open *Workers & Pages → home-energy → Settings → Variables and Secrets*. Every
setting and every credential is added there, and each entry is one of two
types:

| Type | Visible afterwards | Use for |
| --- | --- | --- |
| **Text** | yes — readable and editable in the dashboard | poll interval, timezone, entity ids, feature flags |
| **Secret** | no — write-only once saved, never shown again | tokens, passwords, tunnel hostnames |

That is the whole configuration model. Nothing lives in `wrangler.toml`, so
there is no second place to check and no way for a committed value to
contradict a deployed one. `wrangler.toml` describes only *how* to deploy.

**Everything is optional.** Every setting has a default in `worker/env.js`, so
a Worker with an empty Variables screen deploys and runs — it just serves the
bundled sample data. Add only the entries you actually want to change.

**Secrets** — the credentials, added as type *Secret*:

| Secret | Required | What it is |
| --- | --- | --- |
| `AMBER_API_TOKEN` | for prices | Personal token from [app.amber.com.au/developers](https://app.amber.com.au/developers). |
| `AMBER_SITE_ID` | for prices | Your site id — `GET /v1/sites`, fetched once. Not strictly secret, but there is no reason to publish it. |
| `HA_BASE_URL` | for telemetry | Public hostname of the Cloudflare Tunnel in front of Home Assistant, e.g. `https://ha.example.com`. Secret because it is an attack surface, not because it is unguessable. |
| `HA_TOKEN` | for telemetry | Home Assistant long-lived access token (profile → Security → Long-lived access tokens). |
| `HA_ACCESS_CLIENT_ID` | optional | Cloudflare Access service-token id, if that hostname is behind an Access policy. |
| `HA_ACCESS_CLIENT_SECRET` | optional | The matching service-token secret. |

**The Worker decides what it can do from which secrets exist.** No secrets at
all → it serves the bundled sample and the header shows "Sample data". Amber
secrets only → real prices, `—` for the power figures. Add the Home Assistant
secrets → the whole dashboard goes live. You never edit `demo` by hand; it is
derived.

**Text variables** are the tunables — the full list is in
[Configuration reference](#configuration-reference). In practice most people
set two or three (`TIME_ZONE`, `ALLOW_WRITES`, maybe a sign flip) and leave
the rest alone.

> **Why `keep_vars = true` is in `wrangler.toml`.** By default `wrangler
> deploy` deletes every variable on the Worker and replaces them with the set
> defined in the config file — so with no `[vars]` block, a deploy would wipe
> everything you typed into the dashboard. `keep_vars = true` turns that off.
> Secrets are never touched by a deploy either way. Do not remove that line
> unless you move your settings back into `wrangler.toml`.

### Reaching Home Assistant from a Worker

A Worker runs in Cloudflare's network. It cannot reach `192.168.1.50`, and it
cannot speak Modbus. Home Assistant does both from inside your house; the Worker
needs an HTTPS door into it. Use a Cloudflare Tunnel — it is outbound-only, so
nothing is port-forwarded and your home IP is never exposed:

```bash
# on the machine running Home Assistant (or the HA "Cloudflared" add-on)
cloudflared tunnel login
cloudflared tunnel create home-assistant
cloudflared tunnel route dns home-assistant ha.example.com

# config.yml
# tunnel: <tunnel-id>
# credentials-file: /root/.cloudflared/<tunnel-id>.json
# ingress:
#   - hostname: ha.example.com
#     service: http://localhost:8123
#   - service: http_status:404

cloudflared tunnel run home-assistant
```

Home Assistant sits behind a proxy now, so tell it so — in `configuration.yaml`:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 172.16.0.0/12      # the cloudflared container/host, adjust to yours
```

Then put that hostname behind Cloudflare Access so it is not open to the
internet, and give the Worker a service token to get through:

1. *Zero Trust → Access → Applications → Add* a self-hosted app for
   `ha.example.com`.
2. *Zero Trust → Access → Service Auth* → create a service token.
3. Add a policy on the app: *Service Auth* → include that token. Add a second
   policy for your own email if you want to open Home Assistant in a browser.
4. `wrangler secret put HA_ACCESS_CLIENT_ID` and
   `wrangler secret put HA_ACCESS_CLIENT_SECRET`.

The Worker sends those as `CF-Access-Client-Id` / `CF-Access-Client-Secret` on
every call. Skip steps 1–4 if you would rather rely on the HA token alone — the
Worker works either way — but Access means an unauthenticated request never
reaches Home Assistant at all.

### Deploy walkthrough

From a clean checkout:

```bash
npm install
npx wrangler login                      # opens a browser, once per machine

# Deploy with nothing configured. Sample data, but it confirms the page and
# routing work before you wire anything real up.
npx wrangler deploy
# → https://home-energy.<your-subdomain>.workers.dev
```

Then add the credentials in the dashboard — *Workers & Pages → home-energy →
Settings → Variables and Secrets → Add*, type **Secret**:

- `AMBER_API_TOKEN`, `AMBER_SITE_ID` → prices go live.
- `HA_BASE_URL`, `HA_TOKEN` → the rest of the dashboard goes live, once the
  tunnel from the previous section is up.
- `HA_ACCESS_CLIENT_ID`, `HA_ACCESS_CLIENT_SECRET` → only if that hostname is
  behind an Access policy.

Same thing from the CLI if you prefer, one prompt each so the value never
lands in your shell history:

```bash
npx wrangler secret put AMBER_API_TOKEN
npx wrangler secret put AMBER_SITE_ID
npx wrangler secret put HA_BASE_URL
npx wrangler secret put HA_TOKEN
```

Either way they take effect on the next request — no redeploy needed. Check:

```bash
curl -s https://home-energy.<subdomain>.workers.dev/config.js
curl -s https://home-energy.<subdomain>.workers.dev/api/state | jq '{updatedAt, errors, price, site}'
npx wrangler tail                       # live logs, including upstream failures
```

`errors[]` in the response names any upstream that failed and why; the page
renders around the hole rather than blanking.

**Enable writes last.** Verify the mode entity from Home Assistant's Developer
Tools first, then add a **Text** variable `ALLOW_WRITES` = `true`. Until then
`POST /api/battery/mode` returns 403 and the Worker reports `readOnly: true`,
so the buttons render disabled rather than failing on click.

**A custom domain** is optional. Add a route in `wrangler.toml` for a zone you
have on Cloudflare:

```toml
routes = [
  { pattern = "energy.example.com", custom_domain = true }
]
```

### Rotating, listing and removing secrets

```bash
npx wrangler secret list                # names and types only — never values
npx wrangler secret put AMBER_API_TOKEN # overwrite in place; takes effect immediately
npx wrangler secret delete HA_TOKEN     # telemetry falls back to sample data
```

Cloudflare cannot show you a secret's value after it is set — that is the point.
If you lose one, generate a new token upstream and `put` it again. If one leaks,
revoke it at the source (Amber's developer page, Home Assistant's token list)
*and* replace it here; deleting it from Cloudflare alone does not invalidate it.

---

## Configuration reference

Every value below is read from the Cloudflare environment by `worker/env.js`,
and **every one is optional** — the default in brackets applies when the
variable is absent. Add them as **Text** variables under *Settings → Variables
and Secrets*; changes take effect on the next request, with no redeploy.

Locally, put the same names in `.dev.vars` (git-ignored) and `wrangler dev`
picks them up.

### Sent to the browser in `/config.js`

Public by definition — these are downloaded by every visitor, so they must be
added as **Text**, never as Secret.

| Var | Default | Meaning |
| --- | --- | --- |
| `API_BASE_URL` | `""` | Backend origin. Empty = same origin, which is what you want when the Worker serves both. |
| `STATE_PATH` | `/api/state` | Snapshot endpoint. Changing it moves the Worker route too. |
| `MODE_PATH` | `/api/battery/mode` | Mode write endpoint. |
| `REFRESH_SECONDS` | `30` | Poll interval; polling pauses while the tab is hidden. |
| `REQUEST_TIMEOUT_MS` | `10000` | Browser-side per-request abort timeout. |
| `STALE_AFTER_SECONDS` | `{"site":300,"battery":300,"price":900,"vehicle":5400}` | Per-source stale thresholds, as a JSON string. A plain number applies one value to all. |
| `READ_ONLY` | `false` | Force-disable the mode buttons. Writes are *also* disabled whenever `ALLOW_WRITES` is off, so this is belt-and-braces. |
| `LOCALE` | `en-AU` | Number and date formatting. |
| `TIME_ZONE` | `Australia/Melbourne` | Timezone for all times shown. |
| `PRICE_UNIT` | `c/kWh` | Label next to prices. |
| `VEHICLE_NAME` | `Polestar 2` | Name on the vehicle card. |

`demo` is not a var you set: the Worker derives it from whether upstream secrets
exist, and `DEMO = "false"` only lets you turn the sample data *off* when
nothing is configured.

### Worker behaviour

Read by the Worker only, never sent to the browser. You are unlikely to need
any of these beyond `ALLOW_WRITES` and possibly a sign flip.

| Var | Default | Meaning |
| --- | --- | --- |
| `DEMO` | `true` | Serve `mock/state.json` when no upstream secret is set. |
| `ALLOW_WRITES` | `false` | Master switch for `POST /api/battery/mode`. Requires the Home Assistant secrets too. **The one Text variable most people need to set.** |
| `UPSTREAM_TIMEOUT_MS` | `8000` | Worker-side timeout per upstream call. |
| `SNAPSHOT_CACHE_MS` | `15000` | How long an assembled snapshot is reused. |
| `AMBER_CACHE_MS` | `90000` | Amber cache. Prices move every 5 minutes and the limit is ~50 requests / 5 min, so do not lower this much. |
| `HA_CACHE_MS` | `10000` | Home Assistant cache. |
| `AMBER_FORECAST_INTERVALS` | `16` | Forecast intervals requested (`next=`), 30 min each. |
| `AMBER_FORECAST_SLOTS` | `4` | Width of the cheapest-window scan; 4 = 2 hours. |
| `AMBER_FEED_IN_SIGN` | `-1` | `-1` negates Amber's feed-in `perKwh` so exporting reads as earnings. Flip to `1` if yours reports it the other way. |
| `HA_GRID_SIGN` | `1` | `-1` if your grid entity reports export as positive. |
| `HA_BATTERY_SIGN` | `1` | `-1` if your battery entity reports charging as negative. |
| `HA_ENTITIES` | *(defaults in `worker/homeassistant.js`)* | JSON object overriding individual entity ids, e.g. `'{"solar":"sensor.my_pv_power"}'`. Merged over the defaults, so list only what differs. |
| `HA_MODE_OPTIONS` | *(defaults in `worker/homeassistant.js`)* | JSON object mapping contract mode ids to the option strings your `select` entity accepts. |

Behaviour worth knowing:

- Polling stops when the tab is hidden and fires immediately on return, so a
  phone left on the counter overnight makes zero requests and is current the
  moment you pick it up.
- Failures back off exponentially from `REFRESH_SECONDS` to a 5-minute ceiling,
  and reset on success, on `online`, or on the banner's Retry button.
- The last good render stays on screen during an outage, dimmed, with a banner —
  a dashboard that blanks out is worse than one showing data it admits is old.
- One dead upstream never blanks the page. Each source is settled
  independently and failures become `errors[]` entries.
- Ten tabs refreshing at once produce one upstream call: the snapshot cache
  sits on top of a per-upstream cache.

---

## Locking it down

A `workers.dev` URL is public. Anyone who finds it can read your house's power
data, so put an identity check in front of the whole thing — Cloudflare Access
does this without a line of code and without the page ever handling a token:

1. *Zero Trust → Access → Applications → Add an application → Self-hosted.*
2. Application domain: your Worker's hostname (a custom domain makes this
   tidier than `*.workers.dev`).
3. Policy: *Allow* → *Emails* → your household's addresses. One-time PIN needs
   no identity provider at all.

Access sets a signed cookie, `app.js` already sends cookies with
`credentials: "same-origin"`, and an expired session surfaces as "your session
may have expired" rather than a blank page. There is deliberately no token auth
in the front end — a token there would be a published credential.

The Worker sets a strict Content-Security-Policy (`default-src 'self'`, no
`unsafe-inline`), `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer` on every response. The only external origins are
Google Fonts; if you would rather not depend on them — worthwhile for a
dashboard that should work during an internet outage — download the three
families into `public/fonts/`, replace the `<link>` in `public/index.html` with local
`@font-face` rules, and tighten the CSP in `worker/index.js` to `'self'`. The
CSS already falls back to system fonts, so a blocked font request degrades
rather than breaks.

For a wall tablet, also consider: `display: standalone` via a web manifest,
kiosk mode in the browser, and the fact that `REFRESH_SECONDS` of 30 on a 24/7
screen is ~2,900 requests a day against the Worker's cache, not upstream. That
is comfortably inside the Workers free tier.

## Security checklist

- [ ] Every credential added as a Cloudflare **Secret**, never as a Text
      variable and never in `wrangler.toml`, `config.js`, `app.js` or any file
      under the web root. `git grep -iE 'psk_|Bearer |token *[:=]'` should come
      back clean, and `npx wrangler secret list` should name every credential.
- [ ] `.dev.vars` git-ignored and never committed. `.dev.vars.example` holds
      placeholders only.
- [ ] `keep_vars = true` still in `wrangler.toml`, or a deploy will wipe every
      setting you added in the dashboard.
- [ ] `config.js` listed in `public/.assetsignore`, so the committed fallback
      cannot shadow the Worker-generated one in production.
- [ ] Cloudflare Access (or equivalent) in front of the Worker — a home
      dashboard rarely needs to be open to the internet.
- [ ] Home Assistant reached over a Cloudflare Tunnel, not a forwarded port,
      and ideally behind an Access policy with a service token.
- [ ] `POST /api/battery/mode` validated against the fixed allowlist in
      `worker/homeassistant.js`, off by default (`ALLOW_WRITES`), and logged —
      `wrangler tail` shows every write with requested and applied mode.
- [ ] Modbus reachable only on the LAN/VLAN Home Assistant sits on. It is
      unauthenticated by design — anything that can reach port 502 can control
      the inverter.
- [ ] Amber token rotatable from the Amber developer page if it leaks; the HA
      long-lived token revocable from its profile page. Revoke at the source,
      not just in Cloudflare.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Everything reads `—`, red "Cannot load data" banner | Worker erroring or wrong `API_BASE_URL`; the banner names the status code, `npx wrangler tail` has the raw error. |
| "Sample data" pill still showing after deploy | No upstream secret is set. `npx wrangler secret list` — the Worker only leaves demo mode once `AMBER_*` or `HA_*` are present. |
| Prices live, all power values `—` | The Home Assistant secrets are missing or the tunnel is down. Check `errors[]` in `/api/state`. |
| `/config.js` shows your committed defaults, not your vars | `public/config.js` got uploaded as an asset and is shadowing the Worker route. Confirm it is listed in `public/.assetsignore` and redeploy. |
| `/api/state` returns `HTTP 403` from Home Assistant | Access policy is rejecting the Worker. Check the service token secrets, and that the Service Auth policy is attached to that application. |
| HA returns `400 Bad Request` about a proxy | `use_x_forwarded_for` / `trusted_proxies` not set in `configuration.yaml` for the cloudflared host. |
| Values render but "Data is stale" | The backend is answering from a cache while an upstream is dead. Check `errors[]` in the raw payload. |
| Grid arrows point the wrong way | Sign convention flipped in your adapter: `grid` positive = importing, `battery` positive = charging. |
| Feed-in price shown as a cost (or vice versa) | Amber's `feedIn` channel sign — see the Amber section. |
| Mode buttons disabled | Demo mode, `ALLOW_WRITES` not set to `true`, `READ_ONLY` set to `true`, or an unmapped mode entity. |
| A setting you added in the dashboard reverted after deploying | `keep_vars = true` is missing from `wrangler.toml` — Wrangler clears all vars on deploy without it. Secrets are unaffected. |
| Prices stop updating, backend log shows 429 | Amber rate limit. Increase the upstream cache; the page's poll interval is not the problem. |
| Everything works, fonts look wrong | Google Fonts unreachable. Harmless — system fallbacks. Self-host to fix permanently. |

Useful checks:

```bash
npx wrangler tail                       # live Worker logs
npx wrangler secret list                # which credentials are actually set

BASE=https://home-energy.<subdomain>.workers.dev
curl -s $BASE/config.js                 # exactly what the browser is configured with
curl -s $BASE/api/state | jq '{updatedAt, errors, price, site}'
curl -s -X POST $BASE/api/battery/mode \
  -H 'content-type: application/json' -d '{"mode":"time_of_use"}'
```

Against a local `npx wrangler dev`, use `http://localhost:8787` as `BASE`.

To exercise the UI's failure paths without breaking anything real, edit
`mock/state.json`: negative `price.buy`, `descriptor: "spike"`, a negative
`site.battery` (discharging), a positive `site.grid` (importing), a removed
`vehicle` block, or a populated `errors[]` array all render distinctly.
