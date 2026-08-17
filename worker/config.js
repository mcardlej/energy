/*
 * Generates the front end's `config.js` from the Cloudflare environment.
 *
 * `index.html` loads `/config.js` with a plain <script> tag before `app.js`,
 * so whatever this returns becomes `window.ENERGY_CONFIG`. The checked-in
 * `public/config.js` is excluded from the uploaded assets (see
 * `public/.assetsignore`) and exists only for local `python3 -m http.server`
 * runs — in production this function is the config.
 *
 * SECURITY: this response is public. Only non-secret display settings may
 * appear here. Never read AMBER_API_TOKEN, HA_TOKEN or any other credential
 * into this object — they stay server-side in the Worker.
 */
import { str, num, bool, json, isDemo, writesAllowed } from "./env.js";

const DEFAULT_STALE = { site: 300, battery: 300, price: 900, vehicle: 5400 };

export function buildConfig(env) {
  const demo = isDemo(env);

  return {
    // Same origin: the Worker serves both the page and the API.
    apiBaseUrl: str(env, "API_BASE_URL", ""),
    statePath: str(env, "STATE_PATH", "/api/state"),
    modePath: str(env, "MODE_PATH", "/api/battery/mode"),

    // Demo is decided by the Worker, not the browser: with no upstream
    // secrets configured there is nothing real to show.
    demo,
    demoPath: str(env, "DEMO_PATH", "mock/state.json"),

    refreshSeconds: num(env, "REFRESH_SECONDS", 30),
    requestTimeoutMs: num(env, "REQUEST_TIMEOUT_MS", 10000),

    staleAfterSeconds: json(env, "STALE_AFTER_SECONDS", DEFAULT_STALE),

    // Buttons are disabled unless the Worker would actually accept a write,
    // so the UI can never offer a control that is going to 403.
    readOnly: bool(env, "READ_ONLY", false) || !writesAllowed(env),

    locale: str(env, "LOCALE", "en-AU"),
    timeZone: str(env, "TIME_ZONE", "Australia/Melbourne"),
    priceUnit: str(env, "PRICE_UNIT", "c/kWh"),
  };
}

export function configResponse(env) {
  const body = `window.ENERGY_CONFIG = ${JSON.stringify(buildConfig(env), null, 2)};\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Never cache: this is how you change environments.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
