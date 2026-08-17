/*
 * Home Energy — Cloudflare Worker.
 *
 * One deployment serves everything:
 *
 *   GET  /                      static assets (index.html, app.js, styles.css, mock/)
 *   GET  /config.js             front-end settings, generated from the environment
 *   GET  /api/state             the normalised snapshot (see README, "The data contract")
 *   POST /api/battery/mode      writes the inverter running mode
 *
 * Every setting and every credential comes from the Cloudflare environment:
 * settings from `[vars]` in wrangler.toml, credentials from
 * `wrangler secret put`. Nothing sensitive is committed to this repo, and
 * nothing sensitive reaches the browser.
 */
import { num, str, isDemo, sources, writesAllowed } from "./env.js";
import { configResponse } from "./config.js";
import { getPrice } from "./amber.js";
import { getTelemetry, setMode, modeOptions } from "./homeassistant.js";

/* ----------------------------------------------------------------- caching */

// Per-isolate memo for upstream calls. Cloudflare may run several isolates,
// so treat this as "at most one call per TTL per isolate" — with Amber's
// ~50 requests / 5 min budget and a 90 s TTL there is plenty of headroom.
const memo = new Map();

async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

/* --------------------------------------------------------------- upstreams */

/** fetch + JSON + timeout, with the upstream status surfaced in the error. */
function makeFetchJson(timeoutMs) {
  return async function fetchJson(url, options = {}) {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

/**
 * Assemble the snapshot. One dead upstream must never blank the page, so each
 * source is settled independently and failures become `errors[]` entries.
 */
async function buildSnapshot(env) {
  const fetchJson = makeFetchJson(num(env, "UPSTREAM_TIMEOUT_MS", 8000));
  const available = sources(env);
  const errors = [];

  const settle = async (source, fn) => {
    try {
      return await fn();
    } catch (e) {
      console.warn(`ENERGY: ${source}: ${e.message}`);
      errors.push({ source, message: e.message });
      return null;
    }
  };

  const [price, telemetry] = await Promise.all([
    available.amber
      ? settle("amber", () =>
          cached("amber:price", num(env, "AMBER_CACHE_MS", 90_000), () =>
            getPrice(env, fetchJson)
          )
        )
      : null,
    available.ha
      ? settle("sigen", () =>
          cached("ha:telemetry", num(env, "HA_CACHE_MS", 10_000), () =>
            getTelemetry(env, fetchJson)
          )
        )
      : null,
  ]);

  const readOnly = !writesAllowed(env);
  const battery = telemetry && telemetry.battery
    ? { ...telemetry.battery, readOnly }
    : null;

  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    price,
    site: telemetry ? telemetry.site : null,
    battery,
    vehicle: telemetry ? telemetry.vehicle : null,
    today: telemetry ? telemetry.today : null,
    errors,
  };
}

/* ---------------------------------------------------------------- handlers */

const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function handleState(env, ctx, request) {
  // With no upstream secrets set, serve the bundled sample so a fresh deploy
  // shows something rather than an error.
  if (isDemo(env)) {
    const mock = await env.ASSETS.fetch(new URL("/mock/state.json", request.url));
    return new Response(mock.body, {
      status: mock.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const ttl = Math.max(0, num(env, "SNAPSHOT_CACHE_MS", 15_000));
  const key = "snapshot";
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return jsonResponse(hit.value);

  try {
    const snapshot = await buildSnapshot(env);
    memo.set(key, { at: Date.now(), value: snapshot });
    return jsonResponse(snapshot);
  } catch (e) {
    // Serve stale rather than nothing — the page flags the age itself.
    if (hit) return jsonResponse(hit.value);
    console.error(`ENERGY: snapshot failed: ${e.message}`);
    return jsonResponse({ error: "upstream unavailable" }, 502);
  }
}

async function handleModeWrite(env, request) {
  if (!writesAllowed(env)) {
    return jsonResponse({ error: "read only" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON" }, 400);
  }

  const mode = body && body.mode;
  // Fixed allowlist: writing an unexpected value to an inverter is not a
  // harmless mistake.
  if (!Object.prototype.hasOwnProperty.call(modeOptions(env), mode)) {
    return jsonResponse({ error: "unknown mode" }, 400);
  }

  const fetchJson = makeFetchJson(num(env, "UPSTREAM_TIMEOUT_MS", 8000));
  try {
    const applied = await setMode(env, fetchJson, mode);
    memo.delete("snapshot");
    memo.delete("ha:telemetry");
    console.log(JSON.stringify({ event: "mode_write", requested: mode, applied }));
    return jsonResponse({ mode: applied });
  } catch (e) {
    console.error(`ENERGY: mode write failed: ${e.message}`);
    return jsonResponse({ error: e.message }, 502);
  }
}

/* ------------------------------------------------------------------ router */

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const statePath = str(env, "STATE_PATH", "/api/state");
    const modePath = str(env, "MODE_PATH", "/api/battery/mode");

    let response;

    if (url.pathname === "/config.js") {
      response = configResponse(env);
    } else if (url.pathname === statePath) {
      response = request.method === "GET"
        ? await handleState(env, ctx, request)
        : jsonResponse({ error: "method not allowed" }, 405);
    } else if (url.pathname === modePath) {
      response = request.method === "POST"
        ? await handleModeWrite(env, request)
        : jsonResponse({ error: "method not allowed" }, 405);
    } else {
      response = await env.ASSETS.fetch(request);
    }

    response = new Response(response.body, response);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) response.headers.set(k, v);
    return response;
  },
};
