/*
 * LOCAL DEVELOPMENT FALLBACK ONLY.
 *
 * In production this file is not used. The Cloudflare Worker generates
 * /config.js per request from the Cloudflare environment (`[vars]` in
 * wrangler.toml plus Cloudflare Secrets) — see worker/config.js — and this
 * file is excluded from the uploaded assets by .assetsignore so it cannot
 * shadow that route.
 *
 * It exists so `python3 -m http.server` still serves a working demo without
 * Cloudflare. Change deployed settings with `wrangler deploy` or in the
 * Cloudflare dashboard, not here.
 *
 * SECURITY: everything in here is public — it is downloaded by every browser
 * that loads the page. Never put an Amber token, a Home Assistant token, or
 * any other upstream credential in this file. Those belong in Cloudflare
 * Secrets, which only the Worker can read.
 */
window.ENERGY_CONFIG = {
  apiBaseUrl: "",
  statePath: "/api/state",
  modePath: "/api/battery/mode",

  // Demo mode: serve the bundled sample payload instead of a real backend.
  demo: true,
  demoPath: "mock/state.json",

  refreshSeconds: 30,
  requestTimeoutMs: 10000,

  // Per-source stale thresholds (seconds). A car that sleeps for an hour is
  // normal; an inverter silent for five minutes is not.
  staleAfterSeconds: { site: 300, battery: 300, price: 900, vehicle: 5400 },

  readOnly: false,

  locale: "en-AU",
  timeZone: "Australia/Melbourne",
  priceUnit: "c/kWh",
};
