/*
 * Deployment configuration for the Home Energy dashboard.
 *
 * This file is loaded before app.js and is the ONLY file you should need to
 * edit when deploying. It is plain JavaScript so it can be swapped at deploy
 * time (ConfigMap, volume mount, envsubst, ...) without rebuilding anything.
 *
 * SECURITY: everything in here is public — it is downloaded by every browser
 * that loads the page. Never put an Amber token, a Polestar password, or any
 * other upstream credential in this file. Authentication to your own backend
 * should be done with a session cookie (see README).
 */
window.ENERGY_CONFIG = {
  // Base URL of your backend. Empty string = same origin as this page.
  // The app calls `${apiBaseUrl}${statePath}` and `${apiBaseUrl}${modePath}`.
  apiBaseUrl: "",

  // Endpoints on that backend.
  statePath: "/api/state",
  modePath: "/api/battery/mode",

  // Demo mode: serve the bundled sample payload instead of a real backend.
  // Set to false in production. When true, the header shows a "Sample data" pill.
  demo: true,
  demoPath: "mock/state.json",

  // Polling. The backend is expected to cache upstream calls — see README.
  refreshSeconds: 30,
  requestTimeoutMs: 10000,

  // Treat data older than this (seconds) as stale and flag it in the UI.
  // Per source, because a car that sleeps for an hour is normal but an
  // inverter that has not reported for five minutes is not.
  // A plain number here applies one threshold to everything.
  staleAfterSeconds: { site: 300, battery: 300, price: 900, vehicle: 5400 },

  // Set true to hide/disable every control that writes back to the battery.
  readOnly: false,

  // Locale + timezone used for all formatting. null = use the browser's.
  locale: "en-AU",
  timeZone: "Australia/Melbourne",

  // Currency unit shown next to prices.
  priceUnit: "c/kWh",
};
