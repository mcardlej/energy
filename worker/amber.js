/*
 * Amber Electric → the `price` block of the data contract.
 *
 * Credentials: AMBER_API_TOKEN (secret) and AMBER_SITE_ID (var or secret).
 * Both are read from the Cloudflare environment and never leave the Worker.
 */
import { str, num } from "./env.js";

const API = "https://api.amber.com.au/v1";

/**
 * Cheapest run of consecutive forecast intervals on the general channel.
 * `slots` of 4 at 30-minute resolution is a two-hour window.
 */
export function cheapestWindow(intervals, slots = 4) {
  const f = intervals
    .filter((i) => i.type === "ForecastInterval" && i.channelType === "general")
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  if (f.length < slots) return null;

  let best = null;
  for (let i = 0; i + slots <= f.length; i++) {
    const win = f.slice(i, i + slots);
    const avg = win.reduce((s, x) => s + Number(x.perKwh || 0), 0) / slots;
    if (!best || avg < best.perKwh) {
      best = {
        start: win[0].startTime,
        end: win[slots - 1].endTime,
        perKwh: Number(avg.toFixed(1)),
      };
    }
  }
  return best;
}

export async function getPrice(env, fetchJson) {
  const token = str(env, "AMBER_API_TOKEN");
  const siteId = str(env, "AMBER_SITE_ID");
  if (!token || !siteId) return null;

  const next = num(env, "AMBER_FORECAST_INTERVALS", 16);
  const url = `${API}/sites/${encodeURIComponent(siteId)}/prices/current?next=${next}&resolution=30`;

  const intervals = await fetchJson(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!Array.isArray(intervals)) throw new Error("unexpected response shape");

  const current = (ch) =>
    intervals.find((i) => i.type === "CurrentInterval" && i.channelType === ch);

  const general = current("general");
  const feed = current("feedIn");

  if (!general) throw new Error("no current general-channel interval");

  // Amber reports the feed-in channel from the customer-cost perspective, so
  // what you earn is normally the negation of perKwh. Flip with
  // AMBER_FEED_IN_SIGN=1 if your account reports it the other way — check
  // once against the Amber app.
  const feedSign = num(env, "AMBER_FEED_IN_SIGN", -1) >= 0 ? 1 : -1;

  return {
    descriptor: general.descriptor ?? null,
    buy: Number(general.perKwh),
    feedIn: feed ? Number((feedSign * Number(feed.perKwh)).toFixed(2)) : null,
    renewables: general.renewables ?? null,
    spike: Boolean(general.spikeStatus && general.spikeStatus !== "none"),
    forecast: cheapestWindow(intervals, num(env, "AMBER_FORECAST_SLOTS", 4)),
    updatedAt: general.startTime || new Date().toISOString(),
    source: "amber",
  };
}
