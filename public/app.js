/*
 * Home Energy dashboard — front end.
 *
 * The page renders one normalised JSON document (see README, "The data
 * contract"). It knows nothing about Amber, Sigenergy or Polestar; a backend
 * you control fetches those, normalises them, and serves the result at
 * `${apiBaseUrl}${statePath}`.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ config */

  var DEFAULTS = {
    apiBaseUrl: "",
    statePath: "/api/state",
    modePath: "/api/battery/mode",
    demo: false,
    demoPath: "mock/state.json",
    refreshSeconds: 30,
    requestTimeoutMs: 10000,
    // Per-source staleness thresholds, in seconds. Telemetry should be
    // seconds-fresh; prices move on 5-minute intervals; a car is polled rarely
    // so it stays asleep. Pass a plain number to use one threshold for all.
    staleAfterSeconds: { site: 300, battery: 300, price: 900, vehicle: 5400 },
    readOnly: false,
    locale: null,
    timeZone: null,
    priceUnit: "c/kWh",
  };

  var CFG = Object.assign({}, DEFAULTS, window.ENERGY_CONFIG || {});
  CFG.refreshSeconds = Math.max(5, Number(CFG.refreshSeconds) || 30);

  var STALE = (function (v) {
    if (typeof v === "number" && isFinite(v)) {
      return { site: v, battery: v, price: v, vehicle: v };
    }
    return Object.assign({}, DEFAULTS.staleAfterSeconds, v || {});
  })(CFG.staleAfterSeconds);

  var STATE_URL = CFG.demo ? CFG.demoPath : CFG.apiBaseUrl + CFG.statePath;
  var MODE_URL = CFG.apiBaseUrl + CFG.modePath;

  /* --------------------------------------------------------------- utilities */

  var $ = function (id) { return document.getElementById(id); };

  /** Number or null — anything non-finite becomes null so the UI shows "—". */
  function num(v) {
    var n = typeof v === "string" ? parseFloat(v) : v;
    return typeof n === "number" && isFinite(n) ? n : null;
  }

  /**
   * Signed, for values where the sign carries meaning — Amber prices go
   * negative regularly and "−2.4 c/kWh" must never render as "2.4".
   */
  function fmt(v, digits) {
    if (v === null || v === undefined) return "—";
    var d = digits === undefined ? 1 : digits;
    var s = v.toFixed(d);
    return s.charAt(0) === "-" ? "−" + s.slice(1) : s; // U+2212, not a hyphen
  }

  /** Magnitude only, for flows where a label already states the direction. */
  function fmtAbs(v, digits) {
    if (v === null || v === undefined) return "—";
    return Math.abs(v).toFixed(digits === undefined ? 1 : digits);
  }

  function signedFmt(v, digits) {
    if (v === null || v === undefined) return "—";
    var s = v > 0.05 ? "+" : v < -0.05 ? "−" : "";
    return s + Math.abs(v).toFixed(digits === undefined ? 1 : digits);
  }

  function text(el, value) {
    if (el && el.textContent !== value) el.textContent = value;
  }

  var timeFmt = new Intl.DateTimeFormat(CFG.locale || undefined, {
    weekday: "short", day: "numeric", month: "short",
    hour: "numeric", minute: "2-digit",
    timeZone: CFG.timeZone || undefined,
  });
  var hourFmt = new Intl.DateTimeFormat(CFG.locale || undefined, {
    hour: "numeric", minute: "2-digit",
    timeZone: CFG.timeZone || undefined,
  });

  function parseTime(v) {
    if (!v) return null;
    var t = Date.parse(v);
    return isNaN(t) ? null : t;
  }

  /** "just now" / "4 min ago" / "2 hr ago" */
  function relative(ts) {
    if (!ts) return "unknown";
    var secs = Math.round((Date.now() - ts) / 1000);
    if (secs < 0) return "just now";
    if (secs < 45) return "just now";
    if (secs < 5400) return Math.round(secs / 60) + " min ago";
    if (secs < 86400) return Math.round(secs / 3600) + " hr ago";
    return Math.round(secs / 86400) + " d ago";
  }

  function duration(secs) {
    if (secs === null || secs === undefined || secs < 0) return "—";
    var h = Math.floor(secs / 3600);
    var m = Math.round((secs % 3600) / 60);
    if (m === 60) { h += 1; m = 0; }
    if (h === 0) return m + " min";
    return m ? h + " hr " + m + " min" : h + " hr";
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* ------------------------------------------------------------------- toast */

  var toastEl = $("toast");
  var toastTimer;
  function showToast(msg, level) {
    toastEl.textContent = msg;
    toastEl.dataset.level = level || "info";
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 3600);
  }

  function announce(msg) { text($("liveRegion"), msg); }

  /* ------------------------------------------------------------------ banner */

  var bannerEl = $("banner");
  function showBanner(title, detail, level) {
    text($("bannerTitle"), title);
    text($("bannerDetail"), detail || "");
    bannerEl.dataset.level = level || "warn";
    bannerEl.hidden = false;
  }
  function hideBanner() { bannerEl.hidden = true; }

  /* -------------------------------------------------------------- networking */

  function request(url, options) {
    var opts = options || {};
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, CFG.requestTimeoutMs);

    return fetch(url, {
      method: opts.method || "GET",
      headers: Object.assign(
        { Accept: "application/json" },
        opts.body ? { "Content-Type": "application/json" } : {}
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      // Send the session cookie to our own origin. Never ship bearer tokens
      // in this file — see README, "Authentication".
      credentials: "same-origin",
      cache: "no-store",
      signal: ctrl.signal,
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error("HTTP " + res.status);
        err.status = res.status;
        return res.text().then(function (body) {
          err.body = body && body.slice(0, 300);
          throw err;
        }, function () { throw err; });
      }
      return res.status === 204 ? null : res.json();
    }).catch(function (err) {
      if (err.name === "AbortError") {
        var t = new Error("Request timed out after " + CFG.requestTimeoutMs + " ms");
        t.kind = "timeout";
        throw t;
      }
      throw err;
    }).finally(function () { clearTimeout(timer); });
  }

  function describeError(err) {
    if (err.kind === "timeout") return "The backend did not respond in time.";
    if (err.status === 401 || err.status === 403) return "Not authorised — your session may have expired.";
    if (err.status === 404) return "Endpoint not found at " + STATE_URL + ".";
    if (err.status === 429) return "Rate limited by the backend. Backing off.";
    if (err.status >= 500) return "Backend error (" + err.status + ").";
    if (err.status) return "Backend returned " + err.status + ".";
    if (!navigator.onLine) return "This device is offline.";
    return "Could not reach the backend. " + (err.message || "");
  }

  /* -------------------------------------------------------------- normalising */

  var DESCRIPTORS = {
    extremely_low: "Extremely low", extremelylow: "Extremely low", extremelyLow: "Extremely low",
    very_low: "Very low", verylow: "Very low", veryLow: "Very low",
    low: "Low", neutral: "Neutral", high: "High", spike: "Spike",
  };

  function descriptorKey(d) {
    if (!d) return "neutral";
    return String(d).replace(/([a-z])([A-Z])/g, "$1_$2").replace(/\s+/g, "_").toLowerCase();
  }

  function normalise(raw) {
    if (!raw || typeof raw !== "object") throw new Error("Malformed payload");
    var price = raw.price || {};
    var site = raw.site || {};
    var batt = raw.battery || {};
    var car = raw.vehicle || {};
    var today = raw.today || {};

    return {
      updatedAt: parseTime(raw.updatedAt) || Date.now(),
      errors: Array.isArray(raw.errors) ? raw.errors : [],
      price: {
        descriptor: descriptorKey(price.descriptor),
        buy: num(price.buy),
        feedIn: num(price.feedIn),
        renewables: num(price.renewables),
        spike: !!price.spike,
        forecast: price.forecast
          ? {
              start: parseTime(price.forecast.start),
              end: parseTime(price.forecast.end),
              perKwh: num(price.forecast.perKwh),
            }
          : null,
        updatedAt: parseTime(price.updatedAt) || parseTime(raw.updatedAt),
        source: price.source || null,
      },
      site: {
        solar: num(site.solar),
        load: num(site.load),
        battery: num(site.battery),   // + charging, − discharging
        grid: num(site.grid),         // + importing, − exporting
        car: num(site.car),
        updatedAt: parseTime(site.updatedAt) || parseTime(raw.updatedAt),
        source: site.source || null,
      },
      battery: {
        soc: num(batt.soc),
        energy: num(batt.energy),
        capacity: num(batt.capacity),
        power: num(batt.power),
        mode: batt.mode || null,
        modes: Array.isArray(batt.modes)
          ? batt.modes.filter(function (m) { return m && m.id; })
          : [],
        secondsToFull: num(batt.secondsToFull),
        secondsToEmpty: num(batt.secondsToEmpty),
        readOnly: !!batt.readOnly,
        updatedAt: parseTime(batt.updatedAt) || parseTime(raw.updatedAt),
        source: batt.source || null,
      },
      vehicle: {
        name: car.name || "Vehicle",
        soc: num(car.soc),
        rangeKm: num(car.rangeKm),
        pluggedIn: !!car.pluggedIn,
        charging: !!car.charging,
        power: num(car.power),
        readOnly: car.readOnly !== false,
        updatedAt: parseTime(car.updatedAt) || parseTime(raw.updatedAt),
        source: car.source || null,
        present: !!(car.name || car.soc !== undefined),
      },
      today: {
        solar: num(today.solar),
        exported: num(today.exported),
        imported: num(today.imported),
        consumed: num(today.consumed),
      },
    };
  }

  /**
   * Demo only: shift the sample timestamps onto today's clock so freshness
   * labels read sensibly. Never runs against a real backend.
   */
  function rebaseDemo(raw) {
    var base = parseTime(raw.updatedAt);
    if (!base) return raw;
    var offset = Date.now() - base - 60000; // pretend the snapshot is a minute old
    var walk = function (o) {
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (v && typeof v === "object") return walk(v);
        if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
          var t = parseTime(v);
          if (t) o[k] = new Date(t + offset).toISOString();
        }
      });
    };
    walk(raw);
    return raw;
  }

  /* --------------------------------------------------------------- rendering */

  var current = null;      // last successfully rendered, normalised state
  var pendingMode = null;  // mode id awaiting backend confirmation

  function renderPrice(p) {
    var key = p.spike ? "spike" : p.descriptor;
    var tint = "var(--amber-" + (DESCRIPTORS[key] ? key : "neutral") + ")";
    $("amberCard").style.setProperty("--tint", tint);
    text($("priceDescriptor"), DESCRIPTORS[key] || "Unknown");
    text($("priceBuy"), fmt(p.buy));
    text($("priceFeedIn"), fmt(p.feedIn));
    text($("priceBuyUnit"), CFG.priceUnit);
    text($("priceFeedInUnit"), CFG.priceUnit);
    text($("priceRenewables"), p.renewables === null ? "—" : Math.round(p.renewables).toString());

    if (p.forecast && p.forecast.start && p.forecast.perKwh !== null) {
      text(
        $("priceForecast"),
        hourFmt.format(p.forecast.start) +
          (p.forecast.end ? " – " + hourFmt.format(p.forecast.end) : "") +
          " · ~" + fmt(p.forecast.perKwh) + "c"
      );
    } else {
      text($("priceForecast"), "No forecast available");
    }
  }

  function renderFlow(s) {
    var solar = s.solar || 0;
    var grid = s.grid || 0;
    var batt = s.battery || 0;
    var car = s.car || 0;
    var EPS = 0.05;

    text($("flowSolar"), fmtAbs(s.solar) + " kW");
    text($("flowHome"), "Home · " + fmtAbs(s.load) + " kW");
    text($("flowBattery"), signedFmt(s.battery) + " kW");
    text($("flowGrid"), fmtAbs(s.grid) + " kW");
    text($("flowGridLabel"), grid > EPS ? "Import" : grid < -EPS ? "Export" : "Grid");

    var importing = grid > EPS;
    var gridColour = importing ? "var(--grid-in)" : "var(--grid-out)";
    $("wireGrid").setAttribute("stroke", gridColour);
    $("flowGrid").setAttribute("fill", gridColour);
    $("gridBolt").setAttribute("fill", Math.abs(grid) > EPS ? gridColour : "var(--ink-faint)");
    Array.prototype.forEach.call($("dotsGrid").children, function (d) {
      d.setAttribute("fill", gridColour);
    });

    text($("flowCar"), car > EPS ? "Car · " + fmtAbs(s.car) + " kW" : "Car · idle");

    // wire: [element, dots group, active, reversed, magnitude]
    setWire("wireSolar", "dotsSolar", solar > EPS, false, solar);
    setWire("wireBatt", "dotsBatt", Math.abs(batt) > EPS, batt < 0, Math.abs(batt));
    setWire("wireGrid", "dotsGrid", Math.abs(grid) > EPS, importing, Math.abs(grid));
    setWire("wireCar", "dotsCar", car > EPS, false, car);

    $("nodeCar").dataset.active = car > EPS ? "true" : "false";
    $("nodeSolar").dataset.active = solar > EPS ? "true" : "false";

    var desc =
      "Solar " + fmtAbs(s.solar) + " kilowatts, home load " + fmtAbs(s.load) + " kilowatts, battery " +
      (batt > EPS ? "charging at " + fmtAbs(batt) : batt < -EPS ? "discharging at " + fmtAbs(batt) : "idle at 0") +
      " kilowatts, " + (importing ? "importing " : "exporting ") + fmtAbs(grid) +
      " kilowatts, car " + (car > EPS ? "charging at " + fmtAbs(car) + " kilowatts" : "idle") + ".";
    text(document.getElementById("flowDesc"), desc);
  }

  function setWire(wireId, dotsId, active, reversed, kw) {
    var wire = $(wireId);
    var dots = $(dotsId);
    wire.dataset.active = active ? "true" : "false";
    dots.style.setProperty("--dir", reversed ? "reverse" : "normal");
    // Faster dots for more power, bounded so it never looks frantic or frozen.
    dots.style.setProperty("--speed", clamp(3.4 / Math.max(kw, 0.1), 0.7, 3.4).toFixed(2) + "s");
    Array.prototype.forEach.call(dots.children, function (d) {
      d.dataset.active = active ? "true" : "false";
    });
  }

  function renderBattery(b) {
    var soc = b.soc === null ? null : clamp(b.soc, 0, 100);
    text($("battSoc"), soc === null ? "—" : Math.round(soc).toString());
    text(
      $("battCap"),
      b.energy !== null && b.capacity !== null
        ? fmtAbs(b.energy) + " / " + fmtAbs(b.capacity, b.capacity % 1 ? 1 : 0) + " kWh"
        : "—"
    );

    var CIRCUMFERENCE = 2 * Math.PI * 50; // r=50 in the ring SVG
    $("ringFill").setAttribute(
      "stroke-dashoffset",
      (CIRCUMFERENCE * (1 - (soc === null ? 0 : soc) / 100)).toFixed(2)
    );

    var p = b.power;
    var statusEl = $("battStatus");
    statusEl.classList.remove("charging", "discharging");
    if (p === null) {
      text(statusEl, "Unknown");
    } else if (p > 0.05) {
      text(statusEl, "Charging");
      statusEl.classList.add("charging");
    } else if (p < -0.05) {
      text(statusEl, "Discharging");
      statusEl.classList.add("discharging");
    } else {
      text(statusEl, "Idle");
    }
    text($("battPower"), signedFmt(p) + " kW");

    if (p !== null && p > 0.05 && b.secondsToFull !== null) {
      text($("battEtaLabel"), "Full in approx");
      text($("battEta"), duration(b.secondsToFull));
    } else if (p !== null && p < -0.05 && b.secondsToEmpty !== null) {
      text($("battEtaLabel"), "Empty in approx");
      text($("battEta"), duration(b.secondsToEmpty));
    } else {
      text($("battEtaLabel"), "Full in approx");
      text($("battEta"), "—");
    }

    renderModes(b);
  }

  function renderModes(b) {
    var group = $("modeGroup");
    var writable = !CFG.readOnly && !b.readOnly && b.modes.length > 0;

    // Rebuild only when the option list itself changes.
    var signature = b.modes.map(function (m) { return m.id; }).join("|");
    if (group.dataset.signature !== signature) {
      group.textContent = "";
      b.modes.forEach(function (m) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "seg";
        btn.dataset.mode = m.id;
        btn.setAttribute("aria-pressed", "false");
        var tick = document.createElement("span");
        tick.className = "tick";
        btn.appendChild(tick);
        btn.appendChild(document.createTextNode(m.label || m.id));
        btn.addEventListener("click", function () { setMode(m.id, m.label || m.id); });
        group.appendChild(btn);
      });
      group.dataset.signature = signature;
    }

    var active = pendingMode || b.mode;
    Array.prototype.forEach.call(group.children, function (btn) {
      btn.setAttribute("aria-pressed", btn.dataset.mode === active ? "true" : "false");
      btn.dataset.pending = pendingMode && btn.dataset.mode === pendingMode ? "true" : "false";
      btn.disabled = !writable || pendingMode !== null;
    });

    text(
      $("modeLabel"),
      b.modes.length === 0
        ? "Operating mode · not reported"
        : writable ? "Operating mode" : "Operating mode · read only"
    );
  }

  function renderVehicle(v) {
    var card = $("vehicleCard");
    card.hidden = !v.present;
    if (!v.present) return;

    text($("carTitle"), v.name);
    $("carReadOnly").hidden = !v.readOnly;
    text($("carSoc"), v.soc === null ? "—" : Math.round(v.soc) + "%");
    text($("carRange"), v.rangeKm === null ? "" : "≈ " + Math.round(v.rangeKm) + " km range");
    $("carFill").style.width = (v.soc === null ? 0 : clamp(v.soc, 0, 100)) + "%";

    var status = v.charging
      ? "Charging" + (v.power ? " · " + fmtAbs(v.power) + " kW" : "")
      : v.pluggedIn ? "Plugged in · not charging" : "Not plugged in";
    text($("carStatusText"), status);
    $("carStatus").dataset.charging = v.charging ? "true" : "false";
  }

  function renderToday(t) {
    text($("todaySolar"), fmtAbs(t.solar));
    text($("todayExported"), fmtAbs(t.exported));
    text($("todayImported"), fmtAbs(t.imported));
    text($("todayConsumed"), fmtAbs(t.consumed));
  }

  function isStale(ts, kind) {
    return !!ts && Date.now() - ts > STALE[kind] * 1000;
  }

  function titleCase(s) {
    return String(s).charAt(0).toUpperCase() + String(s).slice(1);
  }

  /** Freshness labels — re-run every 15 s without a network call. */
  function renderFreshness() {
    if (!current) return;
    var mark = function (el, ts, kind) {
      if (!el) return;
      text(el, "updated " + relative(ts));
      el.dataset.stale = isStale(ts, kind) ? "true" : "false";
    };
    mark($("flowFresh"), current.site.updatedAt, "site");
    mark($("battFresh"), current.battery.updatedAt, "battery");

    var sources = [
      [titleCase(current.price.source || "Amber"), current.price.updatedAt, "price"],
      [titleCase(current.battery.source || "Battery"), current.battery.updatedAt, "battery"],
      current.vehicle.present
        ? [titleCase(current.vehicle.source || current.vehicle.name), current.vehicle.updatedAt, "vehicle"]
        : null,
    ].filter(Boolean);

    var host = $("sources");
    if (host.dataset.count !== String(sources.length)) {
      host.textContent = "";
      sources.forEach(function () { host.appendChild(document.createElement("span")); });
      host.dataset.count = String(sources.length);
    }
    sources.forEach(function (s, i) {
      var el = host.children[i];
      text(el, s[0] + " · " + relative(s[1]));
      el.dataset.stale = isStale(s[1], s[2]) ? "true" : "false";
    });

    // A hard banner (fetch failure / degraded sources) outranks the stale hint.
    if (bannerEl.dataset.hard) return;

    var stale = sources.filter(function (s) { return isStale(s[1], s[2]); });
    if (stale.length) {
      showBanner(
        "Data is stale",
        stale.map(function (s) { return s[0] + " last updated " + relative(s[1]); }).join(" · ") +
          ". The backend may have lost an upstream connection.",
        "warn"
      );
    } else {
      hideBanner();
    }
  }

  function render(state) {
    current = state;
    renderPrice(state.price);
    renderFlow(state.site);
    renderBattery(state.battery);
    renderVehicle(state.vehicle);
    renderToday(state.today);
    renderFreshness();
    document.body.dataset.phase = "ready";
    text($("footNote"), CFG.demo ? "Sample data · nothing connected" : "Live data");
  }

  /* ---------------------------------------------------------------- polling */

  var failures = 0;
  var timer = null;
  var inFlight = false;

  function scheduleNext() {
    clearTimeout(timer);
    if (document.hidden) return; // resumed by the visibilitychange handler
    // Exponential backoff on repeated failure, capped at 5 minutes.
    var delay = failures === 0
      ? CFG.refreshSeconds * 1000
      : Math.min(CFG.refreshSeconds * 1000 * Math.pow(2, failures), 300000);
    timer = setTimeout(function () { load(false); }, delay);
  }

  function load(manual) {
    if (inFlight) return Promise.resolve();
    inFlight = true;
    var btn = $("refreshBtn");
    var icon = btn.querySelector("svg");
    icon.classList.add("spinning");
    btn.disabled = true;

    return request(STATE_URL)
      .then(function (raw) {
        var state = normalise(CFG.demo ? rebaseDemo(raw) : raw);
        failures = 0;
        delete bannerEl.dataset.hard;
        hideBanner();
        render(state);

        if (state.errors.length) {
          bannerEl.dataset.hard = "1";
          showBanner(
            "Some sources are unavailable",
            state.errors.map(function (e) {
              return (e.source || "unknown") + ": " + (e.message || "error");
            }).join(" · "),
            "warn"
          );
        }
        if (manual) showToast("Refreshed");
      })
      .catch(function (err) {
        failures += 1;
        bannerEl.dataset.hard = "1";
        showBanner(
          current ? "Showing last known data" : "Cannot load data",
          describeError(err) + " Retrying automatically.",
          current ? "warn" : "error"
        );
        document.body.dataset.phase = "error";
        if (manual) showToast(describeError(err), "error");
        // Console keeps the raw detail for whoever is debugging the backend.
        console.error("[energy] state fetch failed", err);
      })
      .finally(function () {
        inFlight = false;
        icon.classList.remove("spinning");
        btn.disabled = false;
        scheduleNext();
      });
  }

  /* ------------------------------------------------------------ mode writing */

  function setMode(id, label) {
    if (pendingMode || !current) return;
    if (CFG.demo) {
      showToast("Sample data · mode changes are not sent anywhere");
      return;
    }
    var previous = current.battery.mode;
    pendingMode = id;
    renderModes(current.battery);
    announce("Setting battery mode to " + label);

    request(MODE_URL, { method: "POST", body: { mode: id } })
      .then(function (res) {
        pendingMode = null;
        current.battery.mode = (res && res.mode) || id;
        renderModes(current.battery);
        showToast("Mode set to " + label);
        announce("Battery mode is now " + label);
        // Pull a fresh snapshot: the inverter may take a moment to react.
        setTimeout(function () { load(false); }, 3000);
      })
      .catch(function (err) {
        pendingMode = null;
        current.battery.mode = previous;
        renderModes(current.battery);
        var msg = err.status === 403 || err.status === 405
          ? "Backend is read only — mode not changed"
          : "Could not set mode: " + describeError(err);
        showToast(msg, "error");
        announce(msg);
        console.error("[energy] mode change failed", err);
      });
  }

  /* -------------------------------------------------------------- lifecycle */

  function tickClock() { text($("clock"), timeFmt.format(new Date())); }

  function init() {
    $("demoPill").hidden = !CFG.demo;
    $("refreshBtn").addEventListener("click", function () { load(true); });
    $("bannerRetry").addEventListener("click", function () {
      failures = 0;
      load(true);
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        // Catch up immediately — the page may have been hidden for hours.
        load(false);
      } else {
        clearTimeout(timer);
      }
    });
    window.addEventListener("online", function () { failures = 0; load(false); });
    window.addEventListener("offline", function () {
      bannerEl.dataset.hard = "1";
      showBanner("Offline", "This device has no network connection.", "warn");
    });

    tickClock();
    setInterval(tickClock, 10000);
    setInterval(renderFreshness, 15000);
    load(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
