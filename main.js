/**
 * annabelle.js — MODIS Wildfire Visualization
 * DSC 106 Project 3
 */

(function () {
  "use strict";

  /* ─── UTC date parser (avoids timezone-shift year errors) ─── */
  function parseYMD(str) {
    if (!str) return null;
    const p = str.split("-");
    if (p.length !== 3) return null;
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }

  /* ═══════════════ STATE ═══════════════ */
  const appState = {
    view: "national",
    year: 2001,
    colorMode: "intensity",
    selectedStateName: null,
    brushExtent: null,
    raw: [],
    years: [],
    geo: null,
    _stateFeatures: [],
    stateYearStats: {},
    projection: null,
    path: null,
  };

  /* ═══════════════ COLOUR SCALES ═══════════════ */
  const intensityScale = d3.scaleSequentialLog(
    d3.interpolateRgbBasis([
      "#e0f7ff",
      "#4cc9f0",
      "#2e75d3",

      "#184c9f",

      "#032265",
    ]),
  );
  const freqScale = d3.scaleSequentialLog(
    d3.interpolateRgbBasis([
      "#fff4d6",
      "#ffb347",
      "#ff7b00",
      "#d14900",
      "#7a0000",
      "#2b0000",
    ]),
  );
  const dotColorScale = d3.scaleSequentialLog(
    d3.interpolateRgbBasis([
      "#8b0000",
      "#d44000",
      "#ff8c00",
      "#ffd166",
      "#ffffff",
    ]),
  );

  /* ═══════════════ TOOLTIP ═══════════════ */
  const tooltipEl = document.getElementById("tooltip");
  function showTooltip(ev, html) {
    tooltipEl.innerHTML = html;
    tooltipEl.style.display = "block";
    moveTooltip(ev);
  }
  function moveTooltip(ev) {
    let x = ev.clientX + 12,
      y = ev.clientY - 10;
    if (x + 230 > window.innerWidth) x = ev.clientX - 230;
    tooltipEl.style.left = x + "px";
    tooltipEl.style.top = y + "px";
  }
  function hideTooltip() {
    tooltipEl.style.display = "none";
  }

  /* ═══════════════ SVG ═══════════════ */
  const svg = d3.select("#map-svg");
  const mapG = svg.append("g").attr("class", "map-root");
  const statesG = mapG.append("g").attr("class", "states-layer");
  const dotsG = mapG.append("g").attr("class", "dots-layer");
  const brushG = svg.append("g").attr("class", "brush-layer");

  let svgW = 0,
    svgH = 0;
  function getSVGDims() {
    const el = document.getElementById("map-panel");
    svgW = el.clientWidth;
    svgH = el.clientHeight;
    svg.attr("viewBox", `0 0 ${svgW} ${svgH}`);
  }

  const zoom = d3
    .zoom()
    .scaleExtent([1, 16])
    .on("zoom", (ev) => mapG.attr("transform", ev.transform));

  function enableZoom() {
    svg.call(zoom);
    svg.style("cursor", "grab");
  }
  function disableZoom() {
    svg.on(".zoom", null);
    svg.style("cursor", "crosshair");
  }
  enableZoom();

  /* ═══════════════ DATA HELPERS ═══════════════ */

  /** Point-in-polygon using d3.geoContains */
  function latLonToStateName(lon, lat) {
    for (const f of appState._stateFeatures) {
      if (d3.geoContains(f, [lon, lat])) return f.properties.name;
    }
    return null;
  }

  /**
   * Assign stateName to rows that don't have one yet.
   * Runs in async chunks so the page stays responsive and the loading
   * message keeps updating.
   */
  async function assignStateNames(rows) {
    const CHUNK = 5000;
    let done = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      for (const r of slice) {
        r.stateName = latLonToStateName(r.longitude, r.latitude);
      }
      done += slice.length;
      document.getElementById("loading-msg").textContent =
        `Assigning states… ${Math.round((done / rows.length) * 100)}%`;
      // yield to browser so UI stays alive
      await new Promise((res) => setTimeout(res, 0));
    }
  }

  function buildStateYearStats(rows) {
    const map = {};
    for (const r of rows) {
      const s = r.stateName;
      if (!s) continue;
      const y = r.year;
      if (!map[s]) map[s] = {};
      if (!map[s][y]) map[s][y] = { count: 0, sumFRP: 0, maxFRP: 0 };
      map[s][y].count++;
      map[s][y].sumFRP += r.frp;
      if (r.frp > map[s][y].maxFRP) map[s][y].maxFRP = r.frp;
    }
    for (const s in map)
      for (const y in map[s])
        map[s][y].avgFRP = map[s][y].sumFRP / map[s][y].count;
    return map;
  }

  function pctChangeSeries(statKey, years, statsMap) {
    const vals = years.map((y) => (statsMap[y] ? statsMap[y][statKey] : null));
    const baseIdx = vals.findIndex((v) => v !== null && v > 0);
    if (baseIdx < 0) return [];
    const base = vals[baseIdx];
    return years
      .map((y, i) => ({
        year: y,
        pct: vals[i] !== null ? ((vals[i] - base) / base) * 100 : null,
      }))
      .filter((d) => d.pct !== null);
  }

  /* ═══════════════ LEGEND ═══════════════ */
  function updateLegend(lo, hi, mode) {
    const canvas = document.getElementById("leg-canvas");
    const ctx = canvas.getContext("2d");
    const scale = mode === "intensity" ? intensityScale : freqScale;
    const safeLo = Math.max(lo, 0.1);
    for (let i = 0; i < 110; i++) {
      ctx.fillStyle = scale(safeLo * Math.pow(hi / safeLo, i / 109));
      ctx.fillRect(i, 0, 1, 8);
    }
    document.getElementById("leg-lo").textContent = lo.toFixed(1);
    document.getElementById("leg-hi").textContent = hi.toFixed(0);
    document.getElementById("leg-title").textContent =
      (mode === "intensity" ? "Avg FRP (MW)" : "Fire count") +
      ` · ${appState.year}`;
  }

  /* ═══════════════ NATIONAL VIEW ═══════════════ */
  function drawNational() {
    const { year, colorMode, stateYearStats, _stateFeatures, path } = appState;

    const vals = [];
    for (const sn in stateYearStats) {
      const v = stateYearStats[sn][year];
      if (v) vals.push(colorMode === "intensity" ? v.avgFRP : v.count);
    }
    const lo = d3.min(vals) || 1;
    const hi = d3.max(vals) || 100;
    const colorScale = colorMode === "intensity" ? intensityScale : freqScale;
    colorScale.domain([Math.max(lo, 0.1), hi]);
    updateLegend(lo, hi, colorMode);
    const statePaths = statesG
      .selectAll("path.state-path")
      .data(_stateFeatures, (d) => d.properties.name)
      .join("path")
      .attr("class", "state-path")
      .attr("d", path);

    statePaths
      .on("click", (ev, d) => {
        ev.stopPropagation();
        hideTooltip();
        drillIntoState(d.properties.name);
      })
      .on("mouseover", (ev, d) => {
        const sn = d.properties.name;
        const v = stateYearStats[sn] && stateYearStats[sn][year];

        showTooltip(
          ev,
          `<strong>${sn}</strong>` +
            `<div class="tt-row"><span class="tt-key">Fire count</span><span>${v ? v.count.toLocaleString() : "no data"}</span></div>` +
            `<div class="tt-row"><span class="tt-key">Avg FRP</span><span>${v ? v.avgFRP.toFixed(1) + " MW" : "—"}</span></div>` +
            `<div class="tt-row"><span class="tt-key">Max FRP</span><span>${v ? v.maxFRP.toFixed(1) + " MW" : "—"}</span></div>`,
        );
      })
      .on("mousemove", moveTooltip)
      .on("mouseout", hideTooltip)
      .transition()
      .duration(350)
      .attr("fill", (d) => {
        const sn = d.properties.name;
        const v = stateYearStats[sn] && stateYearStats[sn][year];
        if (!v) return "#0b1020";
        const val = colorMode === "intensity" ? v.avgFRP : v.count;
        return val > 0 ? colorScale(val) : "#0b1020";
      });
    dotsG.selectAll("*").remove();
    updateSidePanel(null, year);
  }

  /* ═══════════════ STATE DRILL-DOWN ═══════════════ */
  function drillIntoState(stateName) {
    appState.view = "state";
    appState.selectedStateName = stateName;
    appState.brushExtent = null;

    disableZoom();
    mapG.attr("transform", null);

    document.getElementById("back-btn").style.display = "block";
    const ov = document.getElementById("state-label-overlay");
    ov.textContent = stateName;
    ov.style.display = "block";
    document.getElementById("brush-controls").style.display = "";
    document.getElementById("mode-group").style.display = "none";
    document.getElementById("hint").textContent =
      "Drag to brush fires · side panel shows % change trends for selection";
    document.getElementById("cluster-legend").style.display = "block";
    drawStateView();
  }

  function drawStateView() {
    const stateName = appState.selectedStateName;
    const year = appState.year;
    const feat = appState._stateFeatures.find(
      (f) => f.properties.name === stateName,
    );
    if (!feat) return;

    getSVGDims();
    const proj = d3.geoAlbersUsa().fitExtent(
      [
        [40, 40],
        [svgW - 40, svgH - 40],
      ],
      feat,
    );
    const pathFn = d3.geoPath(proj);

    statesG.selectAll("*").remove();
    statesG
      .append("path")
      .datum(feat)
      .attr("class", "state-path selected")
      .attr("d", pathFn)
      .attr("fill", "#151525")
      .attr("stroke", "#ffd166")
      .attr("stroke-width", 1.5);

    const fires = appState.raw.filter(
      (d) => d.stateName === stateName && d.year === year,
    );

    const cellSize = 24; // bigger = fewer/larger groups

    const bins = d3
      .rollups(
        fires
          .map((d) => {
            const p = proj([d.longitude, d.latitude]);
            if (!p) return null;
            return { ...d, x: p[0], y: p[1] };
          })
          .filter(Boolean),
        (v) => ({
          count: v.length,
          avgFRP: d3.mean(v, (d) => d.frp),
          maxFRP: d3.max(v, (d) => d.frp),
          x: d3.mean(v, (d) => d.x),
          y: d3.mean(v, (d) => d.y),
        }),
        (d) => Math.floor(d.x / cellSize),
        (d) => Math.floor(d.y / cellSize),
      )
      .flatMap(([gx, rows]) => rows.map(([gy, value]) => value));

    const frpExt = d3.extent(fires, (d) => d.frp);
    dotColorScale.domain([Math.max(frpExt[0] || 1, 0.1), frpExt[1] || 100]);

    const radiusScale = d3
      .scaleSqrt()
      .domain([1, d3.max(bins, (d) => d.count) || 1])
      .range([3, 18]);

    dotsG
      .selectAll("circle.fire-dot")
      .data(bins)
      .join("circle")
      .attr("class", "fire-dot")
      .attr("cx", (d) => d.x)
      .attr("cy", (d) => d.y)
      .attr("r", (d) => radiusScale(d.count))
      .attr("fill", (d) => dotColorScale(Math.max(d.avgFRP, 0.1)))
      .attr("opacity", 0.75)
      .on("mouseover", (ev, d) =>
        showTooltip(
          ev,
          `<strong>${d.count} fires</strong>` +
            `<div class="tt-row"><span class="tt-key">Avg FRP</span><span>${d.avgFRP.toFixed(1)} MW</span></div>` +
            `<div class="tt-row"><span class="tt-key">Max FRP</span><span>${d.maxFRP.toFixed(1)} MW</span></div>`,
        ),
      )
      .on("mousemove", moveTooltip)
      .on("mouseout", hideTooltip);

    setupBrush(proj, fires, stateName);
    updateSidePanel(stateName, year, fires, null, null);
  }

  /* ═══════════════ BRUSH ═══════════════ */
  function setupBrush(proj, currentYearFires, stateName) {
    brushG.selectAll("*").remove();

    // Pre-cache ALL years for this state so brush trends have multi-year data
    const allStateFires = appState.raw.filter((d) => d.stateName === stateName);

    const brush = d3
      .brush()
      .extent([
        [0, 0],
        [svgW, svgH],
      ])
      .on("brush end", (ev) => {
        if (!ev.selection) {
          appState.brushExtent = null;
          dotsG.selectAll("circle.fire-dot").classed("brushed", false);
          updateSidePanel(
            stateName,
            appState.year,
            currentYearFires,
            null,
            null,
          );
          return;
        }

        const [[x0, y0], [x1, y1]] = ev.selection;
        appState.brushExtent = ev.selection;

        function inBrush(d) {
          const p = proj([d.longitude, d.latitude]);
          return p && p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
        }

        dotsG.selectAll("circle.fire-dot").classed("brushed", inBrush);

        // Current year: for stats display
        const brushedCurrentYear = currentYearFires.filter(inBrush);
        // All years in brushed region: for trend charts
        const brushedAllYears = allStateFires.filter(inBrush);

        updateSidePanel(
          stateName,
          appState.year,
          currentYearFires,
          brushedCurrentYear,
          brushedAllYears,
        );
      });

    brushG.call(brush);
  }

  /* ═══════════════ BACK ═══════════════ */
  function backToNational() {
    appState.view = "national";
    appState.selectedStateName = null;
    appState.brushExtent = null;
    enableZoom();

    document.getElementById("back-btn").style.display = "none";
    document.getElementById("state-label-overlay").style.display = "none";
    document.getElementById("brush-controls").style.display = "none";
    document.getElementById("mode-group").style.display = "";
    document.getElementById("hint").textContent =
      "← Click a state to drill in. Zoom + pan enabled.";
    document.getElementById("cluster-legend").style.display = "none";
    brushG.selectAll("*").remove();
    dotsG.selectAll("*").remove();
    svg.call(zoom.transform, d3.zoomIdentity);

    getSVGDims();
    const proj = d3.geoAlbersUsa().fitSize([svgW, svgH], {
      type: "FeatureCollection",
      features: appState._stateFeatures,
    });
    appState.projection = proj;
    appState.path = d3.geoPath(proj);
    drawNational();
  }

  /* ═══════════════ SIDE PANEL ═══════════════ */
  function updateSidePanel(
    stateName,
    year,
    stateFires,
    brushedCurrentYear,
    brushedAllYears,
  ) {
    document.getElementById("side-year").textContent = year;

    if (!stateName) {
      document.getElementById("side-context-label").innerHTML =
        `National · <span id="side-year">${year}</span>`;
      const stats = appState.stateYearStats;
      let total = 0,
        sumFRP = 0,
        count = 0,
        maxFRP = 0,
        peakState = "—",
        peakVal = 0;
      for (const sn in stats) {
        const v = stats[sn][year];
        if (!v) continue;
        total += v.count;
        sumFRP += v.sumFRP;
        count += v.count;
        if (v.maxFRP > maxFRP) maxFRP = v.maxFRP;
        if (v.count > peakVal) {
          peakVal = v.count;
          peakState = sn;
        }
      }
      document.getElementById("stat-count").textContent =
        total.toLocaleString();
      document.getElementById("stat-frp").textContent =
        count > 0 ? (sumFRP / count).toFixed(1) : "—";
      document.getElementById("stat-peak-box").style.display = "";
      document.getElementById("stat-peak").textContent = peakState;
      document.getElementById("stat-max").textContent =
        maxFRP > 0 ? maxFRP.toFixed(0) + " MW" : "—";
      setTrendEmpty("Drill into a state to see trends.");
      setFreqEmpty("Drill into a state to see trends.");
      return;
    }

    document.getElementById("side-context-label").innerHTML =
      `${stateName} · <span id="side-year">${year}</span>`;

    // Stats show current-year fires (brushed subset or all)
    const displayFires =
      brushedCurrentYear !== null ? brushedCurrentYear || [] : stateFires || [];
    const count2 = displayFires.length;
    const avgFRP = count2 > 0 ? d3.mean(displayFires, (d) => d.frp) : 0;
    const maxFRP2 = count2 > 0 ? d3.max(displayFires, (d) => d.frp) : 0;

    document.getElementById("stat-count").textContent = count2.toLocaleString();
    document.getElementById("stat-frp").textContent =
      count2 > 0 ? avgFRP.toFixed(1) : "—";
    document.getElementById("stat-peak-box").style.display = "none";
    document.getElementById("stat-max").textContent =
      maxFRP2 > 0 ? maxFRP2.toFixed(0) + " MW" : "—";

    // Trend source: brushed all-years (if brush active), else entire state all-years
    const trendSource =
      brushedAllYears && brushedAllYears.length > 0
        ? brushedAllYears
        : appState.raw.filter((d) => d.stateName === stateName);

    const yearStats = {};
    for (const r of trendSource) {
      const y = r.year;
      if (!yearStats[y]) yearStats[y] = { count: 0, sumFRP: 0 };
      yearStats[y].count++;
      yearStats[y].sumFRP += r.frp;
    }
    for (const y in yearStats)
      yearStats[y].avgFRP = yearStats[y].sumFRP / yearStats[y].count;

    const subtitle =
      brushedAllYears && brushedAllYears.length > 0
        ? `brushed region · ${brushedAllYears.length.toLocaleString()} fires (all years)`
        : `all fires in ${stateName}`;

    drawTrendChart(
      "#trend-svg",
      "#trend-empty",
      pctChangeSeries("avgFRP", appState.years, yearStats),
      subtitle,
      "#ff6b35",
    );
    const rawCountSeries = appState.years.map((y) => ({
      year: y,
      pct: yearStats[y] ? yearStats[y].count : 0,
    }));
    drawTrendChart(
      "#freq-svg",
      "#freq-empty",
      rawCountSeries,
      subtitle,
      "#4cc9f0",
      false,
    );
  }

  function setTrendEmpty(msg) {
    document.getElementById("trend-empty").textContent = msg;
    document.getElementById("trend-empty").style.display = "";
    document.getElementById("trend-svg").style.display = "none";
  }
  function setFreqEmpty(msg) {
    document.getElementById("freq-empty").textContent = msg;
    document.getElementById("freq-empty").style.display = "";
    document.getElementById("freq-svg").style.display = "none";
  }

  /* ═══════════════ TREND CHART ═══════════════ */
  function drawTrendChart(
    svgSel,
    emptySel,
    data,
    subtitle,
    color,
    isPercent = true,
  ) {
    const emptyEl = document.querySelector(emptySel);
    const svgEl = document.querySelector(svgSel);

    if (!data || data.length < 2) {
      emptyEl.textContent = "Not enough data for trend.";
      emptyEl.style.display = "";
      svgEl.style.display = "none";
      return;
    }

    emptyEl.style.display = "none";
    svgEl.style.display = "block";

    const W = 300,
      H = 130;
    const m = { top: 12, right: 14, bottom: 22, left: 38 };
    const iw = W - m.left - m.right,
      ih = H - m.top - m.bottom;

    const s = d3.select(svgSel).attr("viewBox", `0 0 ${W} ${H}`);
    s.selectAll("*").remove();
    const g = s.append("g").attr("transform", `translate(${m.left},${m.top})`);

    const x = d3
      .scaleLinear()
      .domain(d3.extent(data, (d) => d.year))
      .range([0, iw]);
    const yExt = d3.extent(data, (d) => d.pct);
    const yPad = Math.max(10, Math.abs(yExt[1] - yExt[0]) * 0.15);
    const y = d3
      .scaleLinear()
      .domain([yExt[0] - yPad, yExt[1] + yPad])
      .range([ih, 0]);

    if (y(0) >= 0 && y(0) <= ih)
      g.append("line")
        .attr("class", "zero-line")
        .attr("x1", 0)
        .attr("x2", iw)
        .attr("y1", y(0))
        .attr("y2", y(0));

    g.append("path")
      .datum(data)
      .attr("class", "trend-area")
      .attr("fill", color)
      .attr(
        "d",
        d3
          .area()
          .x((d) => x(d.year))
          .y0(y(0))
          .y1((d) => y(d.pct))
          .curve(d3.curveMonotoneX),
      );

    g.append("path")
      .datum(data)
      .attr("class", "trend-line")
      .attr("stroke", color)
      .attr(
        "d",
        d3
          .line()
          .x((d) => x(d.year))
          .y((d) => y(d.pct))
          .curve(d3.curveMonotoneX),
      );

    g.selectAll("circle.td")
      .data(data)
      .join("circle")
      .attr("class", "td")
      .attr("cx", (d) => x(d.year))
      .attr("cy", (d) => y(d.pct))
      .attr("r", 2)
      .attr("fill", color);

    g.append("g")
      .attr("class", "axis-trend")
      .attr("transform", `translate(0,${ih})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat(d3.format("d")));

    g.append("g")
      .attr("class", "axis-trend")
      .call(
        d3
          .axisLeft(y)
          .ticks(4)
          .tickFormat((d) => (isPercent ? d + "%" : d3.format(",")(d))),
      );

    g.append("text")
      .attr("x", iw / 2)
      .attr("y", -2)
      .attr("text-anchor", "middle")
      .attr("fill", "#55526a")
      .attr("font-size", "8px")
      .attr("font-family", "var(--font-mono)")
      .text(subtitle);
  }

  /* ═══════════════ EVENTS ═══════════════ */
  function wireEvents() {
    document.getElementById("year-slider").addEventListener("input", (e) => {
      appState.year = +e.target.value;
      document.getElementById("year-val").textContent = appState.year;
      if (appState.view === "national") {
        drawNational();
      } else {
        brushG.selectAll("*").remove();
        appState.brushExtent = null;
        drawStateView();
      }
    });

    document.querySelectorAll(".mode-btn[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll(".mode-btn[data-mode]")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        appState.colorMode = btn.dataset.mode;
        if (appState.view === "national") drawNational();
      });
    });

    document
      .getElementById("back-btn")
      .addEventListener("click", backToNational);

    document.getElementById("btn-brush-off").addEventListener("click", () => {
      brushG.selectAll("*").remove();
      appState.brushExtent = null;
      dotsG.selectAll("circle.fire-dot").classed("brushed", false);
      const fires = appState.raw.filter(
        (d) =>
          d.stateName === appState.selectedStateName &&
          d.year === appState.year,
      );
      updateSidePanel(
        appState.selectedStateName,
        appState.year,
        fires,
        null,
        null,
      );
      getSVGDims();
      const feat = appState._stateFeatures.find(
        (f) => f.properties.name === appState.selectedStateName,
      );
      if (feat) {
        const proj2 = d3.geoAlbersUsa().fitExtent(
          [
            [40, 40],
            [svgW - 40, svgH - 40],
          ],
          feat,
        );
        setupBrush(proj2, fires, appState.selectedStateName);
      }
    });

    window.addEventListener("resize", () => {
      getSVGDims();
      if (appState.view === "national") {
        const proj2 = d3.geoAlbersUsa().fitSize([svgW, svgH], {
          type: "FeatureCollection",
          features: appState._stateFeatures,
        });
        appState.projection = proj2;
        appState.path = d3.geoPath(proj2);
        statesG.selectAll("path.state-path").attr("d", appState.path);
      } else {
        drawStateView();
      }
    });
  }

  /* ═══════════════ INIT ═══════════════ */
  async function init() {
    getSVGDims();

    // 1. Geo
    const geo = await d3.json(
      "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json",
    );
    appState.geo = geo;
    const features = topojson.feature(geo, geo.objects.states).features;
    appState._stateFeatures = features;

    const proj = d3
      .geoAlbersUsa()
      .fitSize([svgW, svgH], { type: "FeatureCollection", features });
    appState.projection = proj;
    appState.path = d3.geoPath(proj);

    // 2. CSV
    document.getElementById("loading-msg").textContent =
      "Loading MODIS fire data…";
    let csvText;
    if (
      typeof window.__MODIS_FIRES_CSV === "string" &&
      window.__MODIS_FIRES_CSV.length
    ) {
      csvText = window.__MODIS_FIRES_CSV;
    } else {
      const compressed = await d3.buffer("fires_small.csv.gz");
  csvText = pako.ungzip(new Uint8Array(compressed), { to: "string" });

      // remove UTF-8 BOM if present
      csvText = csvText.replace(/^\uFEFF/, "");
    }

    document.getElementById("loading-msg").textContent =
      "Parsing fire records…";

    // Parse — works whether or not CSV has a stateName column
    const raw = d3
      .csvParse(csvText, (d) => {
        const date = parseYMD(d.acq_date);
        if (!date) return null;
        const year = date.getUTCFullYear();
        if (year < 2001 || year > 2025) return null;
        const frp = +d.frp;
        if (isNaN(frp) || frp <= 0) return null;
        return {
          latitude: +d.latitude,
          longitude: +d.longitude,
          brightness: +d.brightness,
          frp,
          acq_date: date,
          year,
          acq_time: d.acq_time || "",
          satellite: d.satellite || "",
          confidence: +d.confidence || 0,
          bright_t31: +d.bright_t31 || 0,
          daynight: d.daynight || "",
          // If pre-processed CSV has stateName, use it; otherwise assign below
          stateName:
            d.stateName && d.stateName.trim() !== ""
              ? d.stateName.trim()
              : null,
        };
      })
      .filter((d) => d !== null);

    // 3. Assign stateName via PIP for any rows that need it
    const needsPIP = raw.filter((r) => r.stateName === null);
    if (needsPIP.length > 0) {
      document.getElementById("loading-msg").textContent =
        `Assigning states… (${needsPIP.length.toLocaleString()} fires, please wait)`;
      await assignStateNames(needsPIP);
    }

    appState.raw = raw.filter((d) => d.stateName !== null);

    console.log(
      `Loaded ${appState.raw.length.toLocaleString()} fires with state assignments`,
    );

    appState.years = Array.from(new Set(appState.raw.map((d) => d.year)))
      .sort((a, b) => a - b)
      .filter((y) => y >= 2000 && y <= 2025);

    const minYear = appState.years[0] || 2000;
    const maxYear = appState.years[appState.years.length - 1] || 2025;

    // 4. Stats
    document.getElementById("loading-msg").textContent =
      "Computing statistics…";
    appState.stateYearStats = buildStateYearStats(appState.raw);

    // 5. Slider
    const slider = document.getElementById("year-slider");
    slider.min = minYear;
    slider.max = maxYear;
    slider.value = minYear;
    appState.year = minYear;
    document.getElementById("year-val").textContent = minYear;

    // 6. Go
    wireEvents();
    document.getElementById("loading").style.display = "none";
    drawNational();
  }

  init().catch((err) => {
    console.error(err);
    document.getElementById("loading").innerHTML =
      `<h2 style="color:#ff6b35">Load Error</h2>` +
      `<p style="color:#7a7890">${err.message}</p>` +
      `<p style="color:#7a7890;font-size:0.7rem;margin-top:1rem">` +
      `Make sure <code>data/modis_fires_us_2001_to_2025.csv</code> exists.</p>`;
  });
})();
