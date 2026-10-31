const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");

const METAR_API = "https://aviationweather.gov/api/data/metar";
const TAF_API = "https://aviationweather.gov/api/data/taf";
const HEADERS = { "User-Agent": "MMM-MetarTaf (MagicMirror module)" };

// OurAirports (public domain) runway database
const RUNWAY_CSV = "https://davidmegginson.github.io/ourairports-data/runways.csv";
const RUNWAY_CACHE = path.join(__dirname, "runway-cache.json");
const RUNWAY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // runways rarely change

// Minimal CSV line parser (handles quoted fields and escaped quotes)
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function bearing(lat1, lon1, lat2, lon2) {
  const R = Math.PI / 180;
  const dy = lat2 - lat1;
  const dx = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * R);
  return (Math.atan2(dx, dy) / R + 360) % 360;
}

module.exports = NodeHelper.create({
  start() {
    this.timers = {};
    this.runwayQueue = Promise.resolve();
  },

  socketNotificationReceived(notification, payload) {
    if (notification !== "METAR_INIT") return;

    const { identifier } = payload;
    console.log(`[MMM-MetarTaf] Starting for ${payload.stations.join(", ")}`);
    if (this.timers[identifier]) clearInterval(this.timers[identifier]);

    this.fetchAll(payload);
    this.timers[identifier] = setInterval(
      () => this.fetchAll(payload),
      Math.max(payload.updateInterval, 60 * 1000) // never poll faster than 1/min
    );

    if (payload.showRunways) {
      // serialised so several module instances don't download the CSV at once
      this.runwayQueue = this.runwayQueue
        .then(() => this.sendRunways(payload))
        .catch((err) => console.error("[MMM-MetarTaf] Runways:", err.message));
    }
  },

  /* ---------- weather ---------- */

  async fetchAll({ identifier, stations, hoursBack, showTAF }) {
    let reports;
    try {
      reports = await this.fetchMetars(stations, hoursBack);
    } catch (err) {
      console.error("[MMM-MetarTaf] METAR:", err.message);
      this.sendSocketNotification("METAR_ERROR", { identifier, message: err.message });
      return;
    }

    // TAF failure must not take down the METAR display
    let tafs = null;
    if (showTAF) {
      try {
        tafs = await this.fetchTafs(stations);
      } catch (err) {
        console.error("[MMM-MetarTaf] TAF:", err.message);
      }
    }

    this.sendSocketNotification("METAR_DATA", { identifier, reports, tafs });
  },

  async fetchMetars(stations, hoursBack) {
    const url = `${METAR_API}?ids=${encodeURIComponent(stations.join(","))}&format=json&hours=${hoursBack}`;
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (res.status === 204) return {};
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const latest = {};
    for (const m of data) {
      const id = m.icaoId;
      if (!latest[id] || m.obsTime > latest[id].obsTime) latest[id] = m;
    }
    const missing = stations.filter((s) => !latest[s]);
    if (missing.length) {
      console.log(`[MMM-MetarTaf] No METAR returned for: ${missing.join(", ")} (got ${Object.keys(latest).length} of ${stations.length})`);
    }
    return latest;
  },

  async fetchTafs(stations) {
    const url = `${TAF_API}?ids=${encodeURIComponent(stations.join(","))}&format=json`;
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (res.status === 204) return {};
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const latest = {};
    for (const t of data) {
      const id = t.icaoId;
      if (!latest[id] || t.validTimeFrom > latest[id].validTimeFrom) latest[id] = t;
    }
    return latest;
  },

  /* ---------- runways ---------- */

  readRunwayCache() {
    try {
      const c = JSON.parse(fs.readFileSync(RUNWAY_CACHE, "utf8"));
      return { updated: c.updated || {}, runways: c.runways || {} };
    } catch (e) {
      return { updated: {}, runways: {} };
    }
  },

  writeRunwayCache(cache) {
    try {
      fs.writeFileSync(RUNWAY_CACHE, JSON.stringify(cache));
    } catch (err) {
      console.error("[MMM-MetarTaf] Could not write runway cache:", err.message);
    }
  },

  async sendRunways({ identifier, stations }) {
    const cache = this.readRunwayCache();
    const now = Date.now();
    const need = stations.filter((s) => !cache.updated[s] || now - cache.updated[s] > RUNWAY_MAX_AGE_MS);

    if (need.length) {
      try {
        const found = await this.downloadRunways(need);
        need.forEach((s) => {
          cache.runways[s] = found[s] || [];
          cache.updated[s] = now;
        });
        this.writeRunwayCache(cache);
      } catch (err) {
        // fall back to whatever is cached (possibly stale)
        console.error("[MMM-MetarTaf] Runway download failed:", err.message);
      }
    }

    const runways = {};
    stations.forEach((s) => { runways[s] = cache.runways[s] || []; });
    this.sendSocketNotification("METAR_RUNWAYS", { identifier, runways });
  },

  async downloadRunways(stations) {
    const res = await fetch(RUNWAY_CSV, { headers: HEADERS, signal: AbortSignal.timeout(90000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lines = (await res.text()).split("\n");

    const header = parseCsvLine(lines[0].replace(/\r$/, ""));
    const col = (name) => header.indexOf(name);
    const I = {
      ident: col("airport_ident"), len: col("length_ft"), wid: col("width_ft"),
      closed: col("closed"),
      leId: col("le_ident"), leLat: col("le_latitude_deg"), leLon: col("le_longitude_deg"), leHdg: col("le_heading_degT"),
      heId: col("he_ident"), heLat: col("he_latitude_deg"), heLon: col("he_longitude_deg"), heHdg: col("he_heading_degT")
    };
    if (I.ident < 0 || I.leId < 0 || I.heId < 0) throw new Error("Unexpected runway CSV format");

    const wanted = new Set(stations);
    const result = {};

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, "");
      if (!line) continue;
      const f = parseCsvLine(line);
      const icao = f[I.ident];
      if (!wanted.has(icao) || f[I.closed] === "1") continue;

      const rw = {
        le: f[I.leId], he: f[I.heId],
        lenFt: num(f[I.len]), widthFt: num(f[I.wid]),
        leLat: num(f[I.leLat]), leLon: num(f[I.leLon]),
        heLat: num(f[I.heLat]), heLon: num(f[I.heLon]),
        leHdg: num(f[I.leHdg])
      };
      const heHdg = num(f[I.heHdg]);

      // Resolve a true heading, best source first
      if (rw.leHdg === null && heHdg !== null) rw.leHdg = (heHdg + 180) % 360;
      if (rw.leHdg === null && [rw.leLat, rw.leLon, rw.heLat, rw.heLon].every((v) => v !== null)) {
        rw.leHdg = bearing(rw.leLat, rw.leLon, rw.heLat, rw.heLon);
      }
      if (rw.leHdg === null) {
        // last resort: the runway number is the magnetic heading / 10
        const n = parseInt(rw.le, 10);
        if (!isNaN(n)) rw.leHdg = (n % 36) * 10;
      }
      if (rw.leHdg === null) continue; // helipads etc.

      (result[icao] = result[icao] || []).push(rw);
    }
    return result;
  }
});
