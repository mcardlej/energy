/*
 * Home Assistant → the `site`, `battery`, `vehicle` and `today` blocks.
 *
 * A Worker cannot open a Modbus TCP socket and cannot reach your LAN, so the
 * inverter is not talked to directly. Home Assistant does that locally (the
 * `sigenergy-local-modbus` and `polestar_api` integrations) and the Worker
 * reaches Home Assistant over a Cloudflare Tunnel — see the README.
 *
 * Credentials: HA_BASE_URL + HA_TOKEN (secrets), plus the optional
 * Cloudflare Access service-token pair HA_ACCESS_CLIENT_ID /
 * HA_ACCESS_CLIENT_SECRET when the tunnel hostname is behind Access.
 */
import { str, json } from "./env.js";

const DEFAULT_ENTITIES = {
  solar: "sensor.sigen_plant_pv_power",
  load: "sensor.sigen_plant_consumed_power",
  grid: "sensor.sigen_plant_grid_sensor_active_power",
  batteryPower: "sensor.sigen_plant_battery_power",
  car: "sensor.sigen_plant_ev_charger_power",
  soc: "sensor.sigen_plant_battery_state_of_charge",
  capacity: "sensor.sigen_plant_rated_energy_capacity",
  modeSelect: "select.sigen_plant_remote_ems_control_mode",
  todaySolar: "sensor.sigen_plant_daily_pv_energy",
  todayExported: "sensor.sigen_plant_daily_export_energy",
  todayImported: "sensor.sigen_plant_daily_import_energy",
  todayConsumed: "sensor.sigen_plant_daily_consumed_energy",
  vehicleSoc: "sensor.polestar_battery_level",
  vehicleRange: "sensor.polestar_estimated_range",
  vehicleCharging: "binary_sensor.polestar_charging",
  vehiclePluggedIn: "binary_sensor.polestar_charger_connected",
  vehiclePower: "sensor.polestar_charging_power",
};

/** Contract mode id → the option string the HA select entity expects. */
const DEFAULT_MODE_OPTIONS = {
  sigen_ai: "Sigen AI Mode",
  max_self_powered: "Maximum Self Consumption",
  time_of_use: "Time of Use",
  fully_fed_to_grid: "Fully Fed to Grid",
};

const MODE_LABELS = {
  sigen_ai: "Sigen AI",
  max_self_powered: "Max self powered",
  time_of_use: "Time of use",
  fully_fed_to_grid: "Fully fed to grid",
};

export function entityMap(env) {
  return { ...DEFAULT_ENTITIES, ...json(env, "HA_ENTITIES", {}) };
}

export function modeOptions(env) {
  return { ...DEFAULT_MODE_OPTIONS, ...json(env, "HA_MODE_OPTIONS", {}) };
}

function headers(env) {
  const h = {
    Authorization: `Bearer ${str(env, "HA_TOKEN")}`,
    Accept: "application/json",
  };
  const id = str(env, "HA_ACCESS_CLIENT_ID");
  const secret = str(env, "HA_ACCESS_CLIENT_SECRET");
  if (id && secret) {
    // Service token for a tunnel hostname protected by Cloudflare Access.
    h["CF-Access-Client-Id"] = id;
    h["CF-Access-Client-Secret"] = secret;
  }
  return h;
}

function base(env) {
  return str(env, "HA_BASE_URL", "").replace(/\/+$/, "");
}

/**
 * Fetch several entity states in one go. Unknown/unavailable states become
 * null rather than an error — the page renders "—" around holes by design.
 */
async function states(env, fetchJson, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const results = await Promise.all(
    unique.map(async (id) => {
      try {
        const s = await fetchJson(`${base(env)}/api/states/${encodeURIComponent(id)}`, {
          headers: headers(env),
        });
        const raw = s && s.state;
        return [id, {
          raw: raw ?? null,
          value: raw === "unavailable" || raw === "unknown" || raw === undefined
            ? null
            : Number(raw),
          options: (s && s.attributes && s.attributes.options) || null,
          updatedAt: (s && s.last_updated) || null,
        }];
      } catch (e) {
        console.warn(`ENERGY: ${id}: ${e.message}`);
        return [id, null];
      }
    })
  );
  return Object.fromEntries(results);
}

const val = (m, id) => (m[id] && Number.isFinite(m[id].value) ? m[id].value : null);
const at = (m, id) => (m[id] ? m[id].updatedAt : null);
const on = (m, id) => (m[id] ? m[id].raw === "on" || m[id].raw === "true" : null);

/** Newest of a set of timestamps, so a block's age reflects its stalest input. */
function newest(list) {
  const t = list.filter(Boolean).map((x) => Date.parse(x)).filter(Number.isFinite);
  return t.length ? new Date(Math.max(...t)).toISOString() : new Date().toISOString();
}

export async function getTelemetry(env, fetchJson) {
  const E = entityMap(env);
  const m = await states(env, fetchJson, Object.values(E));

  // Sign conventions are the contract's, not the meter's: grid positive =
  // importing, battery positive = charging. Flip either with a *_SIGN var if
  // your entities report the opposite.
  const gridSign = str(env, "HA_GRID_SIGN", "1") === "-1" ? -1 : 1;
  const batterySign = str(env, "HA_BATTERY_SIGN", "1") === "-1" ? -1 : 1;

  const signed = (v, s) => (v === null ? null : Number((v * s).toFixed(3)));

  const site = {
    solar: val(m, E.solar),
    load: val(m, E.load),
    battery: signed(val(m, E.batteryPower), batterySign),
    grid: signed(val(m, E.grid), gridSign),
    car: val(m, E.car),
    updatedAt: newest([at(m, E.solar), at(m, E.load), at(m, E.grid), at(m, E.batteryPower)]),
    source: "sigen",
  };

  const soc = val(m, E.soc);
  const capacity = val(m, E.capacity);
  const selected = m[E.modeSelect] ? m[E.modeSelect].raw : null;
  const options = modeOptions(env);
  const currentMode =
    Object.keys(options).find((id) => options[id] === selected) ?? null;

  const battery = {
    soc,
    energy: soc !== null && capacity !== null
      ? Number(((soc / 100) * capacity).toFixed(1))
      : null,
    capacity,
    power: site.battery,
    mode: currentMode,
    modes: Object.keys(options).map((id) => ({ id, label: MODE_LABELS[id] || id })),
    updatedAt: newest([at(m, E.soc), at(m, E.batteryPower), at(m, E.modeSelect)]),
    source: "sigen",
  };

  const vSoc = val(m, E.vehicleSoc);
  const vehicle = vSoc === null
    ? null
    : {
        name: str(env, "VEHICLE_NAME", "Polestar 2"),
        soc: vSoc,
        rangeKm: val(m, E.vehicleRange),
        pluggedIn: on(m, E.vehiclePluggedIn),
        charging: on(m, E.vehicleCharging),
        power: val(m, E.vehiclePower),
        // No supported way to start or stop charging from the car's API.
        readOnly: true,
        updatedAt: newest([at(m, E.vehicleSoc), at(m, E.vehicleCharging)]),
        source: "polestar",
      };

  const today = {
    solar: val(m, E.todaySolar),
    exported: val(m, E.todayExported),
    imported: val(m, E.todayImported),
    consumed: val(m, E.todayConsumed),
  };

  return { site, battery, vehicle, today };
}

/** Write the running mode. Returns the mode id the inverter ended up in. */
export async function setMode(env, fetchJson, modeId) {
  const options = modeOptions(env);
  const option = options[modeId];
  if (!option) throw new Error(`no HA option mapped for mode "${modeId}"`);

  const E = entityMap(env);
  await fetchJson(`${base(env)}/api/services/select/select_option`, {
    method: "POST",
    headers: { ...headers(env), "Content-Type": "application/json" },
    body: JSON.stringify({ entity_id: E.modeSelect, option }),
  });

  // Report what the inverter actually settled on, not what was asked for.
  const after = await states(env, fetchJson, [E.modeSelect]);
  const raw = after[E.modeSelect] ? after[E.modeSelect].raw : null;
  return Object.keys(options).find((id) => options[id] === raw) ?? modeId;
}
