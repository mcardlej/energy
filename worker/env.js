/*
 * Reading configuration out of the Cloudflare environment.
 *
 * Everything the app needs — settings *and* credentials — arrives here as
 * properties on the Worker's `env` object. Plain settings come from
 * `[vars]` in wrangler.toml; credentials come from `wrangler secret put`
 * (or the dashboard) and are write-only once set. Nothing is read from disk.
 */

/** Trimmed string, or `fallback` when unset/blank. */
export function str(env, key, fallback = null) {
  const v = env[key];
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s === "" ? fallback : s;
}

/** Finite number, or `fallback`. */
export function num(env, key, fallback) {
  const v = str(env, key);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** "1"/"true"/"yes"/"on" are true, "0"/"false"/"no"/"off" are false. */
export function bool(env, key, fallback = false) {
  const v = str(env, key);
  if (v === null) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

/** JSON-valued var, or `fallback` when unset or unparseable. */
export function json(env, key, fallback) {
  const v = str(env, key);
  if (v === null) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    console.warn(`ENERGY: ${key} is not valid JSON; using default`);
    return fallback;
  }
}

/**
 * Which upstreams are usable, decided purely by which secrets are present.
 * Set the Amber secrets and prices go live; set the Home Assistant secrets
 * and telemetry goes live. Neither is required for the page to render.
 */
export function sources(env) {
  return {
    amber: Boolean(str(env, "AMBER_API_TOKEN") && str(env, "AMBER_SITE_ID")),
    ha: Boolean(str(env, "HA_BASE_URL") && str(env, "HA_TOKEN")),
  };
}

/** True when no upstream is configured and the bundled sample should be served. */
export function isDemo(env) {
  const s = sources(env);
  if (s.amber || s.ha) return false;
  return bool(env, "DEMO", true);
}

/** Writes to the inverter are off unless explicitly enabled. */
export function writesAllowed(env) {
  return bool(env, "ALLOW_WRITES", false) && sources(env).ha;
}
