/* MagicMirror² Module: MMM-MetarTaf
 * Displays decoded METAR observations (and optional TAF forecasts)
 * for any ICAO station worldwide.
 */
Module.register("MMM-MetarTaf", {
  defaults: {
    stations: ["KATL"],             // ICAO identifiers
    updateInterval: 10 * 60 * 1000, // 10 minutes
    hoursBack: 3,                   // look-back window to find the latest METAR
    tempUnit: "C",                  // "C" or "F"
    windUnit: "kt",                 // "kt" or "kmh"
    visUnit: "sm",                  // "sm" (aviation standard in Canada and the US) or "km"
    pressureUnit: "inHg",           // "inHg" (aviation standard in Canada and the US) or "hPa"
    showStationName: true,
    showFlightCategory: true,
    showWindArrow: true,            // arrow showing the direction the wind is blowing TOWARD
    showRaw: false,                 // show the raw METAR string
    staleMinutes: 90,               // dim a report if older than this

    // Runway diagram options
    showRunways: false,             // draw the airport's runways (north up) beside the ICAO
    runwaySize: 64,                 // diagram size in px
    showRunwayLabels: false,        // print runway numbers at each end

    // TAF (forecast) options
    showTAF: false,                 // turn the TAF section on/off
    tafMaxPeriods: 4,               // how many upcoming forecast periods to list
    tafTimeFormat: "local",         // "local" or "utc"
    showTafRaw: false,              // show the raw TAF string

    animationSpeed: 1000
  },

  getStyles() {
    return ["MMM-MetarTaf.css"];
  },

  start() {
    this.reports = {};
    this.tafs = null;
    this.runways = {};
    this.error = null;
    this.loaded = false;
    this.sendSocketNotification("METAR_INIT", {
      identifier: this.identifier,
      stations: this.config.stations.map((s) => s.trim().toUpperCase()),
      updateInterval: this.config.updateInterval,
      hoursBack: this.config.hoursBack,
      showTAF: this.config.showTAF,
      showRunways: this.config.showRunways
    });

    // If the helper never answers, say so instead of sitting on "Loading" forever
    setTimeout(() => {
      if (!this.loaded) {
        this.error =
          "no response from the module's helper after 20 s. Fully restart MagicMirror (not just a page refresh) and check its log for [MMM-MetarTaf] errors.";
        this.loaded = true;
        this.updateDom(0);
      }
    }, 20000);
  },

  socketNotificationReceived(notification, payload) {
    if (payload.identifier !== this.identifier) return;
    if (notification === "METAR_DATA") {
      this.reports = payload.reports;
      this.tafs = payload.tafs;
      this.error = null;
      this.loaded = true;
      this.updateDom(this.config.animationSpeed);
    } else if (notification === "METAR_RUNWAYS") {
      this.runways = payload.runways || {};
      this.updateDom(this.config.animationSpeed);
    } else if (notification === "METAR_ERROR") {
      this.error = payload.message;
      this.loaded = true;
      this.updateDom(this.config.animationSpeed);
    }
  },

  /* ---------- formatting helpers ---------- */

  fmtTemp(c) {
    if (c === null || c === undefined) return "--";
    return this.config.tempUnit === "F"
      ? `${Math.round(c * 9 / 5 + 32)}°F`
      : `${Math.round(c)}°C`;
  },

  convWind(kt) {
    return this.config.windUnit === "kmh" ? Math.round(kt * 1.852) : Math.round(kt);
  },

  windText(wdir, wspd, wgst) {
    if (wspd === null || wspd === undefined) return "--";
    if (wspd === 0) return "Calm";
    const unit = this.config.windUnit === "kmh" ? "km/h" : "kt";
    const dir = wdir === "VRB" || wdir === null || wdir === undefined
      ? "VRB"
      : String(wdir).padStart(3, "0") + "°";
    let s = `${dir} @ ${this.convWind(wspd)}`;
    if (wgst) s += ` G${this.convWind(wgst)}`;
    return `${s} ${unit}`;
  },

  // SVG arrow. METAR wind direction is where the wind blows FROM,
  // so the arrow points the opposite way (wdir + 180).
  windArrow(wdir) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "metar-arrow");
    svg.style.transform = `rotate(${(Number(wdir) + 180) % 360}deg)`;
    const title = document.createElementNS(NS, "title");
    title.textContent = `Wind from ${wdir}°`;
    svg.appendChild(title);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M12 2 L19 21 L12 16.5 L5 21 Z"); // points up (north)
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
    return svg;
  },

  // Builds a <span> with optional arrow + wind text
  windElement(wdir, wspd, wgst) {
    const span = document.createElement("span");
    span.className = "metar-wind";
    const hasDir = wdir !== "VRB" && wdir !== null && wdir !== undefined && !isNaN(Number(wdir));
    if (this.config.showWindArrow && wspd > 0 && hasDir) {
      span.appendChild(this.windArrow(wdir));
    } else if (this.config.showWindArrow && wspd > 0) {
      const vrb = document.createElement("span"); // variable direction: no meaningful arrow
      vrb.className = "metar-arrow-vrb";
      vrb.textContent = "↻";
      span.appendChild(vrb);
    }
    span.appendChild(document.createTextNode(this.windText(wdir, wspd, wgst)));
    return span;
  },

  fmtVis(v) {
    if (v === null || v === undefined) return "--";
    const plus = String(v).includes("+");
    const sm = parseFloat(v);
    if (isNaN(sm)) return "--";
    if (this.config.visUnit === "km") {
      const km = sm * 1.609;
      return `${km >= 10 ? Math.round(km) : km.toFixed(1)}${plus ? "+" : ""} km`;
    }
    return `${v} SM`;
  },

  fmtPressure(hpa) {
    if (hpa === null || hpa === undefined) return "--";
    return this.config.pressureUnit === "hPa"
      ? `${Math.round(hpa)} hPa`
      : `${(hpa * 0.02953).toFixed(2)} inHg`;
  },

  fmtClouds(clouds) {
    if (!clouds || clouds.length === 0) return "--";
    return clouds
      .map((c) => {
        if (["CLR", "SKC", "NCD", "NSC"].includes(c.cover)) return c.cover;
        return c.base !== null && c.base !== undefined
          ? `${c.cover} ${c.base.toLocaleString()} ft`
          : c.cover;
      })
      .join(", ");
  },

  // Compact aviation style, e.g. BKN040
  fmtCloudsCompact(clouds) {
    if (!clouds || clouds.length === 0) return "";
    return clouds
      .map((c) =>
        c.base !== null && c.base !== undefined
          ? `${c.cover}${String(Math.round(c.base / 100)).padStart(3, "0")}`
          : c.cover
      )
      .join(" ");
  },

  fmtAge(obsTime) {
    const mins = Math.round((Date.now() / 1000 - obsTime) / 60);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const h = Math.floor(mins / 60);
    return `${h}h ${mins % 60}m ago`;
  },

  fmtTafTime(epoch) {
    if (typeof epoch !== "number") return "--";
    const d = new Date(epoch * 1000);
    if (this.config.tafTimeFormat === "utc") {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getUTCDate()} ${pad(d.getUTCHours())}Z`; // e.g. "30 18Z"
    }
    const loc = (typeof config !== "undefined" && (config.locale || config.language)) || undefined;
    try {
      return d.toLocaleString(loc, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      });
    } catch (e) {
      return d.toLocaleString();
    }
  },

  row(label, valueNodeOrText) {
    const tr = document.createElement("tr");
    const l = document.createElement("td");
    l.className = "metar-label dimmed xsmall";
    l.textContent = label;
    const v = document.createElement("td");
    v.className = "metar-value small bright";
    if (typeof valueNodeOrText === "string") v.textContent = valueNodeOrText;
    else v.appendChild(valueNodeOrText);
    tr.appendChild(l);
    tr.appendChild(v);
    return tr;
  },

  /* ---------- TAF ---------- */

  buildTaf(icao) {
    const box = document.createElement("div");
    box.className = "metar-taf";

    const head = document.createElement("div");
    head.className = "metar-taf-head dimmed xsmall";

    if (this.tafs === null) {
      head.textContent = "TAF unavailable";
      box.appendChild(head);
      return box;
    }

    const taf = this.tafs[icao];
    if (!taf) {
      head.textContent = "No TAF issued for this station";
      box.appendChild(head);
      return box;
    }

    head.textContent =
      `TAF · valid ${this.fmtTafTime(taf.validTimeFrom)} – ${this.fmtTafTime(taf.validTimeTo)}`;
    box.appendChild(head);

    const now = Date.now() / 1000;
    const periods = (taf.fcsts || [])
      .filter((p) => p.timeTo > now)
      .slice(0, this.config.tafMaxPeriods);

    const table = document.createElement("table");
    table.className = "metar-taf-table";

    periods.forEach((p) => {
      const tr = document.createElement("tr");
      tr.className = "metar-taf-row";

      const type = document.createElement("td");
      type.className = "metar-taf-type xsmall";
      let label = p.fcstChange || "BASE";
      if (p.probability) label += ` ${p.probability}`;
      type.textContent = label;
      if (p.fcstChange === "TEMPO" || p.probability) type.classList.add("metar-taf-temp");
      tr.appendChild(type);

      const time = document.createElement("td");
      time.className = "metar-taf-time dimmed xsmall";
      const start = Math.max(p.timeFrom, now); // don't show start times in the past
      time.textContent = `${this.fmtTafTime(start)} → ${this.fmtTafTime(p.timeTo)}`;
      tr.appendChild(time);

      const detail = document.createElement("td");
      detail.className = "metar-taf-detail xsmall bright";
      if (p.wspd !== null && p.wspd !== undefined) {
        detail.appendChild(this.windElement(p.wdir, p.wspd, p.wgst));
      }
      const bits = [];
      if (p.visib !== null && p.visib !== undefined) bits.push(this.fmtVis(p.visib));
      if (p.wxString) bits.push(p.wxString);
      const cl = this.fmtCloudsCompact(p.clouds);
      if (cl) bits.push(cl);
      if (bits.length) {
        detail.appendChild(document.createTextNode((detail.childNodes.length ? " · " : "") + bits.join(" · ")));
      }
      tr.appendChild(detail);

      table.appendChild(tr);
    });

    if (periods.length === 0) {
      head.textContent += " (no upcoming periods)";
    } else {
      box.appendChild(table);
    }

    if (this.config.showTafRaw && taf.rawTAF) {
      const raw = document.createElement("div");
      raw.className = "metar-raw dimmed xsmall";
      raw.textContent = taf.rawTAF;
      box.appendChild(raw);
    }

    return box;
  },

  /* ---------- runway diagram ---------- */

  // Returns [{r, a:{x,y}, b:{x,y}}] in metres (x = east, y = north)
  runwayLayout(rwys) {
    const R = Math.PI / 180;
    const haveCoords = rwys.every((r) =>
      [r.leLat, r.leLon, r.heLat, r.heLon].every((v) => typeof v === "number")
    );

    if (haveCoords) {
      // True layout from threshold coordinates (parallels and crossings land correctly)
      const pts = rwys.flatMap((r) => [[r.leLat, r.leLon], [r.heLat, r.heLon]]);
      const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const lon0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      const kx = 111320 * Math.cos(lat0 * R);
      const ky = 110540;
      return rwys.map((r) => ({
        r,
        a: { x: (r.leLon - lon0) * kx, y: (r.leLat - lat0) * ky },
        b: { x: (r.heLon - lon0) * kx, y: (r.heLat - lat0) * ky }
      }));
    }

    // No usable coordinates: centre every runway on its heading and fan out parallels
    const groups = {};
    rwys.forEach((r) => {
      const key = Math.round((r.leHdg % 180) / 5);
      (groups[key] = groups[key] || []).push(r);
    });
    const segs = [];
    Object.values(groups).forEach((g) => {
      g.forEach((r, i) => {
        const h = r.leHdg * R;
        const half = ((r.lenFt || 6000) * 0.3048) / 2;
        const off = (i - (g.length - 1) / 2) * 250;
        const ox = Math.cos(h) * off;
        const oy = -Math.sin(h) * off;
        const dx = Math.sin(h) * half;
        const dy = Math.cos(h) * half;
        segs.push({ r, a: { x: ox - dx, y: oy - dy }, b: { x: ox + dx, y: oy + dy } });
      });
    });
    return segs;
  },

  runwaySvg(icao) {
    const rwys = this.runways[icao];
    if (!rwys || rwys.length === 0) return null;

    const NS = "http://www.w3.org/2000/svg";
    const segs = this.runwayLayout(rwys);
    const xs = segs.flatMap((s) => [s.a.x, s.b.x]);
    const ys = segs.flatMap((s) => [s.a.y, s.b.y]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const extent = Math.max(maxX - minX, maxY - minY, 1);
    const pad = this.config.showRunwayLabels ? 22 : 18;
    const scale = (100 - 2 * pad) / extent;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const P = (p) => ({ x: 50 + (p.x - cx) * scale, y: 50 - (p.y - cy) * scale });

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("class", "metar-runways");
    svg.setAttribute("width", this.config.runwaySize);
    svg.setAttribute("height", this.config.runwaySize);

    const title = document.createElementNS(NS, "title");
    title.textContent = "Runways (north up): " + rwys.map((r) => `${r.le}/${r.he}`).join(", ");
    svg.appendChild(title);

    // north marker
    const north = document.createElementNS(NS, "text");
    north.setAttribute("x", "93");
    north.setAttribute("y", "10");
    north.setAttribute("class", "metar-runway-north");
    north.textContent = "N";
    svg.appendChild(north);

    segs.forEach((s) => {
      const a = P(s.a);
      const b = P(s.b);

      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", a.x.toFixed(2));
      line.setAttribute("y1", a.y.toFixed(2));
      line.setAttribute("x2", b.x.toFixed(2));
      line.setAttribute("y2", b.y.toFixed(2));
      line.setAttribute("class", "metar-runway-line");
      svg.appendChild(line);

      if (this.config.showRunwayLabels) {
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        [[a, -1, s.r.le], [b, 1, s.r.he]].forEach(([pt, dir, id]) => {
          const t = document.createElementNS(NS, "text");
          t.setAttribute("x", (pt.x + ux * dir * 8).toFixed(2));
          t.setAttribute("y", (pt.y + uy * dir * 8).toFixed(2));
          t.setAttribute("class", "metar-runway-label");
          t.textContent = id;
          svg.appendChild(t);
        });
      }
    });

    return svg;
  },

  /* ---------- DOM ---------- */

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "mmm-metartaf";

    if (!this.loaded) {
      wrapper.innerHTML = "Loading METAR…";
      wrapper.className += " dimmed light small";
      return wrapper;
    }
    if (this.error) {
      wrapper.innerHTML = `METAR error: ${this.error}`;
      wrapper.className += " dimmed light small";
      return wrapper;
    }

    const renderStation = (id) => {
      const icao = id.trim().toUpperCase();
      const r = this.reports[icao];
      const card = document.createElement("div");
      card.className = "metar-card";

      const header = document.createElement("div");
      header.className = "metar-header";

      const title = document.createElement("span");
      title.className = "metar-icao medium bright";
      title.textContent = icao;
      header.appendChild(title);

      if (this.config.showRunways) {
        const rwSvg = this.runwaySvg(icao);
        if (rwSvg) header.appendChild(rwSvg);
      }

      if (r && this.config.showFlightCategory && r.fltCat) {
        const cat = document.createElement("span");
        cat.className = `metar-cat metar-${r.fltCat.toLowerCase()} xsmall`;
        cat.textContent = r.fltCat;
        header.appendChild(cat);
      }
      card.appendChild(header);

      if (!r) {
        const none = document.createElement("div");
        none.className = "dimmed light small";
        none.textContent = "No recent report";
        card.appendChild(none);
        if (this.config.showTAF) card.appendChild(this.buildTaf(icao));
        wrapper.appendChild(card);
        return;
      }

      if (this.config.showStationName && r.name) {
        const name = document.createElement("div");
        name.className = "metar-name dimmed xsmall";
        name.textContent = r.name;
        card.appendChild(name);
      }

      const table = document.createElement("table");
      table.className = "metar-table";
      table.appendChild(this.row("Temp / Dew", `${this.fmtTemp(r.temp)} / ${this.fmtTemp(r.dewp)}`));
      table.appendChild(this.row("Wind", this.windElement(r.wdir, r.wspd, r.wgst)));
      table.appendChild(this.row("Visibility", this.fmtVis(r.visib)));
      if (r.wxString) table.appendChild(this.row("Weather", r.wxString));
      table.appendChild(this.row("Clouds", this.fmtClouds(r.clouds)));
      table.appendChild(this.row("Altimeter", this.fmtPressure(r.altim)));
      card.appendChild(table);

      const age = document.createElement("div");
      age.className = "metar-age dimmed xsmall";
      age.textContent = `Observed ${this.fmtAge(r.obsTime)}`;
      const ageMin = (Date.now() / 1000 - r.obsTime) / 60;
      if (ageMin > this.config.staleMinutes) card.classList.add("metar-stale");
      card.appendChild(age);

      if (this.config.showRaw && r.rawOb) {
        const raw = document.createElement("div");
        raw.className = "metar-raw dimmed xsmall";
        raw.textContent = r.rawOb;
        card.appendChild(raw);
      }

      if (this.config.showTAF) card.appendChild(this.buildTaf(icao));

      wrapper.appendChild(card);
    };

    this.config.stations.forEach((id) => {
      try {
        renderStation(id);
      } catch (err) {
        console.error(`[MMM-MetarTaf] Could not display ${id}:`, err);
        const bad = document.createElement("div");
        bad.className = "metar-card dimmed light small";
        bad.textContent = `${id.trim().toUpperCase()}: display error (${err.message})`;
        wrapper.appendChild(bad);
      }
    });

    return wrapper;
  }
});
