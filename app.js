/* iSurfability dashboard.
 *
 * Reads what scripts/build_dashboard_data.py wrote and draws it. Four things
 * happen here, in this order, and nothing else:
 *
 *   1. load meta.json and coast.bin, and view the binary as typed arrays
 *   2. turn the chosen measure into coloured runs of coastline, as GeoJSON
 *   3. answer the pointer: which point is under it, and what does it say
 *   4. open a point, fetching its block of yearly and monthly series
 *
 * The coast is drawn as lines rather than dots on purpose. Points a kilometre
 * apart become a dotted string at a European zoom and separate dots up close,
 * and a reader fairly reads the holes as coast nobody evaluated. A line reads
 * the same at every zoom.
 */

const DATA = "data";

/* Every fetch carries the build stamp that index.html put on this script's own
 * URL. It is not decoration. The data files only mean anything together - the
 * chains in meta.json index the arrays in coast.bin - and a browser that keeps
 * one of them and refetches the other walks off the end of the arrays into
 * zeros, which draws a coastline through the Gulf of Guinea. Stamping them all
 * with the same build means a cache either has the whole set or none of it.
 * build_dashboard_data.py writes the stamp; without one, nothing breaks and
 * ordinary revalidation applies. */
const BUILD = (() => {
  const own = document.currentScript
    || [...document.scripts].find((script) => /app\.js/.test(script.src));
  const stamped = own && own.src.match(/[?&]v=([^&]+)/);
  return stamped ? stamped[1] : "";
})();

function dataURL(name) {
  return BUILD ? `${DATA}/${name}?v=${BUILD}` : `${DATA}/${name}`;
}

const BASEMAPS = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
};

/* Colour ramps, one per `palette` named in the build script. Seven steps for
 * the sequential ones, because seven quantile classes is about as much as an
 * eye separates on a thin line; twelve for months, which are cyclic. */
const PALETTES = {
  days:   ["#0a2a43", "#11527d", "#1b83a5", "#37b3a4", "#8ad97f", "#e4e15b", "#ffae3a"],
  flat:   ["#ffae3a", "#e4e15b", "#8ad97f", "#37b3a4", "#1b83a5", "#11527d", "#0a2a43"],
  season: ["#f7f4f9", "#d4b9da", "#c994c7", "#df65b0", "#dd3497", "#ae017e", "#7a0177"],
  waves:  ["#eff7fb", "#cfe6f2", "#9fd0e6", "#68b2d8", "#3d8dc4", "#2464a8", "#123f7f"],
  // Diverging, with a mid-grey rather than the usual near-white neutral: the
  // page offers a dark basemap as well as a light one, and white in the
  // middle disappears into one of them.
  trend:  ["#b5182b", "#e0603f", "#e7a07a", "#8b949b", "#7cb8dd", "#3a8ac4", "#12579e"],
  months: ["#4c78a8", "#6a9ec7", "#8fbfdd", "#9ed3b8", "#7fc47f", "#c8d96b",
           "#f3d35c", "#f2ab4e", "#e88a4a", "#d96a5e", "#b5628a", "#7b6aa8"],
};

const MISSING_COLOUR = "#6b7684";

/* The two models are kept apart everywhere they appear. The whole finding is
 * that they agree along the Atlantic facade and part company over the
 * Canaries, and an average is the one object that would hide that. */
const MODEL_COLOURS = { a: "#e0603f", e: "#3a8ac4" };

const state = {
  meta: null,
  strings: {},
  lang: "en",
  arrays: {},          // name -> typed array, all in drawing order
  metric: null,        // the measured metric shown in hindcast mode
  view: null,          // what the map draws: a metric, or a projected change
  period: "reanalysis",
  change: null,        // change.bin and its layout, once someone asks for it
  pathway: "ssp585",
  horizon: "end_century",
  model: "both",
  spots: [],
  grid: new Map(),     // coarse lon/lat cell -> point indices, for the pointer
  series: new Map(),   // block number -> DataView
  selected: null,
  hovered: null,
  openSpot: null,      // the beach whose panel is open, if it is a beach
  markers: [],
};

/* ------------------------------------------------------------- language
 *
 * Four languages, one file each, fetched like any other data file and stamped
 * with the same build. Switching re-renders rather than reloads, because a
 * reload would lose the view the reader had arrived at - and because a reader
 * who has to find their beach again has not been given a translation, they
 * have been given a new page.
 *
 * Keys the page cannot find fall back to English rather than to nothing: a
 * half-finished translation should show a few English words, not blanks.
 */
const LANGUAGES = ["en", "es", "fr", "pt"];
const FALLBACK = {};

async function loadStrings(lang) {
  const wanted = LANGUAGES.includes(lang) ? lang : "en";
  const response = await fetch(`i18n/${wanted}.json${BUILD ? `?v=${BUILD}` : ""}`);
  state.strings = await response.json();
  state.lang = wanted;
  if (wanted === "en") Object.assign(FALLBACK, state.strings);
  else if (!FALLBACK.ui) {
    const english = await fetch(`i18n/en.json${BUILD ? `?v=${BUILD}` : ""}`);
    Object.assign(FALLBACK, await english.json());
  }
  document.documentElement.lang = wanted;
  return state.strings;
}

function t(key, vars) {
  const text = (state.strings.ui || {})[key] ?? (FALLBACK.ui || {})[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    (vars[name] === undefined ? whole : vars[name]));
}

/* What a metric is called and what it counts, in this language, falling back
 * to the English the build script wrote into meta.json. */
function says(metric) {
  const here = (state.strings.metrics || {})[metric.key] || {};
  const english = (FALLBACK.metrics || {})[metric.key] || {};
  return {
    label: here.label || english.label || metric.label,
    about: here.about || english.about || metric.about,
    plain: here.plain || english.plain || "",
  };
}

/* Elements whose whole text is a translation carry data-i18n; those whose
 * title or placeholder is carry data-i18n-title or data-i18n-placeholder. */
function applyStatic() {
  document.title = t("pageTitle");
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  for (const attribute of ["title", "placeholder", "aria-label"]) {
    const mark = `data-i18n-${attribute}`;
    document.querySelectorAll(`[${mark}]`).forEach((node) => {
      node.setAttribute(attribute, t(node.getAttribute(mark)));
    });
  }
}

/* ---------------------------------------------------------------- loading */

async function load() {
  state.meta = await (await fetch(dataURL("meta.json"))).json();
  const buffer = await (await fetch(dataURL("coast.bin"))).arrayBuffer();

  /* meta.json and coast.bin are one object in two files, and a cache that
   * keeps one and refetches the other makes nonsense rather than an error:
   * the chains index past the end of the arrays, the reads come back zero,
   * and the coast is drawn through the Gulf of Guinea. Three cheap questions
   * catch that before a single line is drawn. */
  const width = { int32: 4, int16: 2, int8: 1, uint8: 1 };
  const needed = Math.max(...state.meta.arrays.map(
    (array) => array.offset + array.count * width[array.dtype]));
  const chained = state.meta.chains.reduce((total, n) => total + n, 0);
  const sized = state.meta.bytes === undefined
    ? buffer.byteLength >= needed            // a bundle built before the size was recorded
    : buffer.byteLength === state.meta.bytes;
  if (!sized || chained !== state.meta.count) {
    throw new Error(
      `the data files are from different builds: meta.json describes ${
      state.meta.count} points, ${state.meta.bytes ?? needed} bytes of coast.bin `
      + `and chains covering ${chained}; coast.bin holds ${buffer.byteLength} bytes`);
  }

  const readers = { int32: Int32Array, int16: Int16Array, int8: Int8Array };
  for (const array of state.meta.arrays) {
    state.arrays[array.name] =
      new readers[array.dtype](buffer, array.offset, array.count);
  }
  state.spots = await (await fetch(dataURL("spots.json"))).json();
  buildGrid();
}

/* Values come out of the binary as integers; this puts them back. */
function valueAt(metric, index) {
  const raw = state.arrays[metric.key][index];
  return raw === metric.missing ? NaN : raw / metric.scale;
}

function lonAt(i) { return state.arrays.lon[i] / state.meta.precision; }
function latAt(i) { return state.arrays.lat[i] / state.meta.precision; }

/* A plain grid hash over the coordinates. The map can tell us what line is
 * under the cursor, but a line here is a run of many points and we want the
 * one point, so we look it up ourselves. */
const CELL = 0.25;
function cellKey(lon, lat) {
  return `${Math.floor(lon / CELL)}:${Math.floor(lat / CELL)}`;
}

function buildGrid() {
  for (let i = 0; i < state.meta.count; i++) {
    const key = cellKey(lonAt(i), latAt(i));
    const bucket = state.grid.get(key);
    if (bucket) bucket.push(i); else state.grid.set(key, [i]);
  }
}

function nearestPoint(lon, lat, withinDegrees) {
  let best = null, bestDistance = withinDegrees * withinDegrees;
  const scale = Math.cos((lat * Math.PI) / 180);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = state.grid.get(cellKey(lon + dx * CELL, lat + dy * CELL));
      if (!bucket) continue;
      for (const i of bucket) {
        const ex = (lonAt(i) - lon) * scale, ey = latAt(i) - lat;
        const distance = ex * ex + ey * ey;
        if (distance < bestDistance) { bestDistance = distance; best = i; }
      }
    }
  }
  return best;
}

/* ------------------------------------------------------- colouring the map */

function classOf(metric, value) {
  if (!Number.isFinite(value)) return -1;
  const breaks = metric.breaks;
  let step = 0;
  while (step < breaks.length && value >= breaks[step]) step++;
  return step;
}

function colours(metric) {
  const ramp = PALETTES[metric.palette] || PALETTES.days;
  return metric.categorical ? ramp : ramp.slice(0, metric.breaks.length + 1);
}

/* Each chain is cut into runs of one colour. Both sides of a cut keep the
 * boundary point, so the runs meet instead of leaving a pixel of gap. */
/* Which points a metric shows at reduced weight rather than in full colour.
 * For a trend that is two things at once: a slope that cannot be told apart
 * from zero, and a coast with so few surfable days that a count bounded below
 * by zero has nowhere to go but up. Both mean the same to a reader - do not
 * read this stretch - so both use the same channel. */
const TREND_FLOOR_DAYS = 5;

function fadeTest(metric) {
  if (!metric.key.startsWith("trend")) return null;
  const significance = state.arrays.trend_is_significant;
  const baseline = state.meta.metrics.find((m) => m.key === "mean_days_per_year");
  return (index) => significance[index] === 0
    || !(valueAt(baseline, index) >= TREND_FLOOR_DAYS);
}

/* ------------------------------------------------------- the projections
 *
 * A second file, fetched the first time somebody asks for it. What it holds is
 * deliberately not an ensemble: both models' change, and one byte of flags a
 * point a horizon saying whether they move the same way, whether each is
 * significant once the false-discovery rate is controlled across the map, and
 * whether each shift is larger than the swing between an ordinary good year
 * and an ordinary bad one at that beach.
 */

async function loadChange() {
  if (state.change || !state.meta.change) return state.change;
  const spec = state.meta.change;
  const buffer = await (await fetch(dataURL(spec.file))).arrayBuffer();
  const arrays = {};
  for (const array of spec.arrays) {
    const Kind = { int16: Int16Array, int32: Int32Array,
                   int8: Int8Array, uint8: Uint8Array }[array.dtype];
    arrays[array.name] = new Kind(buffer, array.offset, array.count);
  }
  state.change = { ...spec, arrays };
  return state.change;
}

function changeFor(code, pathway, horizon, index) {
  const raw = state.change.arrays[`chg_${pathway}_${horizon}_${code}`][index];
  return raw === state.change.missing ? NaN : raw / 10;
}

function flagsFor(pathway, horizon, index) {
  return state.change.arrays[`flag_${pathway}_${horizon}`][index];
}

function changeAt(code, index) {
  return changeFor(code, state.pathway, state.horizon, index);
}

function baseAt(code, index) {
  const raw = state.change.arrays[`base_${code}`][index];
  return raw === state.change.missing ? NaN : raw / 10;
}

function spreadAt(code, index) {
  const raw = state.change.arrays[`spread_${code}`][index];
  return raw === state.change.missing ? NaN : raw / 10;
}

function flagsAt(index) {
  return flagsFor(state.pathway, state.horizon, index);
}

function isSet(flags, name) {
  return (flags >> state.change.flags[name] & 1) === 1;
}

/* Full colour is a claim, so it is only made where the projection survives
 * three questions at once: has this beach enough surf for a change in it to
 * mean anything, do the two models move the same way, and is each shift larger
 * than what the test would throw up by chance across thirty thousand points.
 * Choose one model and the agreement clause falls away - you are then reading
 * one model, and the map says so. */
function projectionFade(index) {
  if (state.change.arrays.summarised[index] !== 1) return true;
  const flags = flagsAt(index);
  if (state.model === "both") {
    return !(isSet(flags, "agree") && isSet(flags, "significant_a")
             && isSet(flags, "significant_e"));
  }
  return !isSet(flags, `significant_${state.model}`);
}

function projectionView() {
  const horizon = state.change.horizons.find((h) => h.key === state.horizon);
  const pathway = state.change.pathways.find((p) => p.key === state.pathway);
  const named = state.model === "both" ? t("aboutProjectionBoth")
    : state.change.models.find((m) => m.code === state.model).key;
  return {
    key: "change",
    label: t("changeLabel", { pathway: pathway.label, horizon: horizon.label }),
    unit: "days/yr",
    breaks: state.change.breaks[`${state.pathway}_${state.horizon}`],
    palette: "trend",
    categorical: false,
    about: t("aboutProjection", {
      who: named,
      whose: t(state.model === "both" ? "aboutProjectionTheirOwn" : "aboutProjectionItsOwn"),
      andAgree: state.model === "both" ? t("aboutProjectionAgree") : "",
      floor: state.change.floor_days,
    }),
    valueAt: (index) => {
      if (state.model !== "both") return changeAt(state.model, index);
      const a = changeAt("a", index), e = changeAt("e", index);
      return (a + e) / 2;
    },
    fadedAt: projectionFade,
  };
}

function metricView(metric) {
  // through says(), never from meta.json directly: the build writes those in
  // English, and reading them here is what left the line under the Measure
  // menu in English while the same words were translated everywhere else.
  const said = says(metric);
  return {
    key: metric.key,
    label: said.label,
    unit: metric.unit,
    breaks: metric.breaks,
    palette: metric.palette,
    categorical: metric.categorical,
    about: said.about,
    valueAt: (index) => valueAt(metric, index),
    fadedAt: fadeTest(metric),
  };
}

function activeView() {
  return state.period === "projections" && state.change
    ? projectionView() : metricView(state.metric);
}

function coastGeoJSON(view) {
  const features = [];
  const faded_at = view.fadedAt;
  let start = 0;

  for (const length of state.meta.chains) {
    if (length > 1) {
      let runStart = start;
      let runClass = classOf(view, view.valueAt(start));
      let runFaded = faded_at ? faded_at(start) : false;

      for (let i = start + 1; i <= start + length; i++) {
        const last = i === start + length;
        const klass = last ? -99 : classOf(view, view.valueAt(i));
        const faded = last ? true : (faded_at ? faded_at(i) : false);
        if (klass !== runClass || faded !== runFaded || last) {
          const end = last ? i : i + 1;          // share the boundary point
          if (end - runStart > 1) {
            const line = [];
            for (let j = runStart; j < Math.min(end, start + length); j++) {
              line.push([lonAt(j), latAt(j)]);
            }
            if (line.length > 1) {
              features.push({
                type: "Feature",
                properties: { c: runClass, faded: runFaded ? 1 : 0 },
                geometry: { type: "LineString", coordinates: line },
              });
            }
          }
          runStart = i; runClass = klass; runFaded = faded;
        }
      }
    }
    start += length;
  }
  return { type: "FeatureCollection", features };
}

function paintExpression(view) {
  const ramp = colours(view);
  const match = ["match", ["get", "c"]];
  ramp.forEach((colour, index) => match.push(index, colour));
  match.push(MISSING_COLOUR);
  return match;
}

/* ------------------------------------------------------------------- map */

let map;

function basemap() {
  return BASEMAPS[document.documentElement.dataset.theme === "dark" ? "dark" : "light"];
}

function addCoastLayers() {
  map.addSource("coast", { type: "geojson", data: coastGeoJSON(state.view) });

  // A neutral line under the coloured one. It carries no value; it is there so
  // that a stretch in the darkest class still reads as coast we evaluated,
  // rather than as coast we left out. Light on a dark basemap and the reverse.
  const dark = document.documentElement.dataset.theme === "dark";
  map.addLayer({
    id: "coast-halo",
    type: "line",
    source: "coast",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": dark ? "#ffffff" : "#0d1b2a",
      "line-opacity": dark ? 0.34 : 0.22,
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 3.2, 7, 6, 12, 12],
      "line-blur": 1.2,
    },
  });

  map.addLayer({
    id: "coast-line",
    type: "line",
    source: "coast",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": paintExpression(state.view),
      "line-opacity": ["case", ["==", ["get", "faded"], 1], 0.35, 1],
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.8, 7, 3.6, 12, 8],
    },
  });

  map.addSource("marker", { type: "geojson", data: empty() });
  map.addLayer({
    id: "marker",
    type: "circle",
    source: "marker",
    paint: {
      "circle-radius": ["case", ["==", ["get", "kind"], "selected"], 7, 5],
      "circle-color": "#ffffff",
      "circle-stroke-color": "#0f8b8d",
      "circle-stroke-width": 3,
    },
  });

}

function empty() { return { type: "FeatureCollection", features: [] }; }

/* The beaches are HTML markers rather than a symbol layer. A symbol layer has
 * to fetch its glyphs from whichever font server the basemap style points at,
 * and when that stack is not one the server has, the labels silently never
 * place - which is what happened here, with the layer present, the features
 * there, and nothing on screen. Twenty-eight elements cost nothing, style with
 * the rest of the page, and take their own clicks. */
function addSpotMarkers() {
  state.markers = state.spots.map((spot) => {
    const element = document.createElement("button");
    element.className = "spot";
    element.type = "button";
    element.innerHTML = `<i></i><span>${spot.name}</span>`;
    element.title = `${spot.name}${spot.municipality ? ` · ${spot.municipality}` : ""}`;
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      openSpot(spot);
    });
    return new maplibregl.Marker({ element, anchor: "center" })
      .setLngLat([spot.lon, spot.lat])
      .addTo(map);
  });
  map.on("zoom", showSpotMarkers);
  showSpotMarkers();
}

function showSpotMarkers() {
  const zoom = map.getZoom();
  document.body.classList.toggle("named-spots", zoom >= 7.5);
  const wanted = document.getElementById("show-spots").checked && zoom >= 5.5;
  for (const marker of state.markers || []) {
    marker.getElement().style.display = wanted ? "" : "none";
  }
}

function showCursor() {
  // the drawer can be opened before the map has its layers, or without a map
  // at all; the panel is worth showing either way
  if (!map || !map.getSource || !map.getSource("marker")) return;
  const features = [];
  for (const [index, kind] of [[state.selected, "selected"], [state.hovered, "hover"]]) {
    if (index === null || index === undefined) continue;
    features.push({
      type: "Feature",
      properties: { kind },
      geometry: { type: "Point", coordinates: [lonAt(index), latAt(index)] },
    });
  }
  map.getSource("marker").setData({ type: "FeatureCollection", features });
}

function redraw() {
  state.view = activeView();
  document.getElementById("about").textContent = state.view.about;
  if (map.getSource("coast")) {
    map.getSource("coast").setData(coastGeoJSON(state.view));
    map.setPaintProperty("coast-line", "line-color", paintExpression(state.view));
  }
  drawLegend();
}

/* ------------------------------------------------------------- the chrome */

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                   "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function months() {
  return state.strings.months || FALLBACK.months || MONTHS_EN;
}

function buildMetricMenu() {
  // The listener is attached once; the options are rebuilt whenever the
  // language changes. Two builders drifted apart once already - one translated
  // the group headings and the other did not, so the menu was English until
  // you switched language and then never English again.
  rebuildMetricMenu();
  document.getElementById("metric").addEventListener("change", (event) => {
    state.metric = state.meta.metrics.find((m) => m.key === event.target.value);
    document.getElementById("about").textContent = says(state.metric).about;
    redraw();
    reopen();
    writeHash();
  });
}


/* The segmented controls all behave the same way: one button on, the rest off,
 * and a redraw. Kept in one place so they cannot drift apart. */
function pickOne(groupId, value) {
  document.querySelectorAll(`#${groupId} button`).forEach((button) => {
    button.classList.toggle("on", Object.values(button.dataset)[0] === value);
  });
}

function fillSegmented(groupId, field, options, chosen) {
  const holder = document.getElementById(groupId);
  holder.innerHTML = options.map((option) =>
    `<button data-${field}="${option.key}"
       class="${option.key === chosen ? "on" : ""}">${option.label}</button>`).join("");
}

function buildProjectionControls() {
  const button = document.querySelector('#period button[data-period="projections"]');
  if (!state.meta.change) {
    button.disabled = true;
    button.title = t("noProjections");
    return;
  }
  fillSegmented("pathway", "pathway", state.meta.change.pathways, state.pathway);
  fillSegmented("horizon", "horizon", state.meta.change.horizons, state.horizon);
  // the model buttons are written in the HTML, so a link that names one has to
  // be pushed into them
  pickOne("model", state.model);

  for (const [groupId, field] of [["pathway", "pathway"], ["horizon", "horizon"],
                                  ["model", "model"]]) {
    document.getElementById(groupId).addEventListener("click", (event) => {
      const hit = event.target.closest("button");
      if (!hit || !hit.dataset[field]) return;
      state[field] = hit.dataset[field];
      pickOne(groupId, state[field]);
      redraw();
      reopen();
      writeHash();
    });
  }

  document.getElementById("period").addEventListener("click", async (event) => {
    const hit = event.target.closest("button");
    if (!hit || hit.disabled || hit.dataset.period === state.period) return;
    if (hit.dataset.period === "projections" && !(await loadChange())) return;
    setPeriod(hit.dataset.period);
    redraw();
    reopen();
    writeHash();
  });
}

function setPeriod(period) {
  state.period = period;
  pickOne("period", period);
  document.getElementById("projection-controls").hidden = period !== "projections";
  document.getElementById("measure-field").hidden = period === "projections";
}

/* The unit comes from meta.json, which the build script writes in English.
 * Translating it here keeps the build out of the language business. */
function unit(english) {
  return (state.strings.units || {})[english]
    || (FALLBACK.units || {})[english] || english || "";
}

function formatValue(metric, value) {
  if (!Number.isFinite(value)) return t("noValue");
  if (metric.categorical) return months()[Math.round(value) - 1];
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  // A change reads wrong without its sign: "3 days/yr" and "+3 days/yr" are
  // the same number and opposite news.
  const sign = metric.key === "change" && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)} ${unit(metric.unit)}`;
}

/* How much of the coast the projection actually claims something about, for
 * the pathway and horizon on screen. Four buckets, because four is what a
 * reader can hold: the two models agree it falls and each shift is bigger than
 * chance; they agree it falls but that is within the noise; they disagree; they
 * agree it rises. Counted over the beaches with enough surf to summarise. */
function projectionSummary() {
  const counts = { robust: 0, soft: 0, split: 0, rising: 0 };
  let total = 0;
  for (let i = 0; i < state.meta.count; i++) {
    if (state.change.arrays.summarised[i] !== 1) continue;
    const a = changeAt("a", i), e = changeAt("e", i);
    if (!Number.isFinite(a) || !Number.isFinite(e)) continue;
    total++;
    const flags = flagsAt(i);
    if (!isSet(flags, "agree")) counts.split++;
    else if (a > 0) counts.rising++;
    else if (isSet(flags, "significant_a") && isSet(flags, "significant_e")) counts.robust++;
    else counts.soft++;
  }
  return { ...counts, total };
}

const SUMMARY_COLOURS = {
  robust: "#b5182b", soft: "#e7a07a", split: "#8b949b", rising: "#3a8ac4",
};

function summaryStrip() {
  const s = projectionSummary();
  if (!s.total) return "";
  const share = (n) => (100 * n / s.total);
  const bar = ["robust", "soft", "split", "rising"].map((kind) =>
    `<i style="background:${SUMMARY_COLOURS[kind]};flex:${Math.max(s[kind], 0.001)}"
        title="${share(s[kind]).toFixed(0)} %"></i>`).join("");
  const line = (kind, key) =>
    `<span><i style="background:${SUMMARY_COLOURS[kind]}"></i>${
      t(key, { share: share(s[kind]).toFixed(0) })}</span>`;
  return `
    <div class="strip-title">${t("stripTitle", {
      count: s.total.toLocaleString(), floor: state.change.floor_days })}</div>
    <div class="ramp strip">${bar}</div>
    <div class="swatches strip-key">
      ${line("robust", "bucketRobust")}${line("soft", "bucketSoft")}
      ${line("split", "bucketSplit")}${line("rising", "bucketRising")}
    </div>`;
}

function drawLegend() {
  const metric = state.view || metricView(state.metric);
  const holder = document.getElementById("legend");
  const ramp = colours(metric);

  if (metric.categorical) {
    holder.innerHTML = `<div class="swatches">${
      months().map((month, index) =>
        `<span><i style="background:${ramp[index]}"></i>${month}</span>`).join("")
    }</div>`;
    return;
  }

  const ticks = metric.breaks.map((value) =>
    Math.abs(value) >= 100 ? value.toFixed(0)
      : Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2));
  const projecting = metric.key === "change";
  holder.innerHTML = `
    <div class="ramp">${ramp.map((c) => `<i style="background:${c}"></i>`).join("")}</div>
    <div class="ticks"><span>${projecting ? t("lessSurf") : t("low")}</span>${
      ticks.map((tick) => `<span>${tick}</span>`).join("")}<span>${
      projecting ? t("moreSurf") : t("high")}</span></div>
    <div class="ticks"><span>${unit(metric.unit)}</span></div>`
    + (projecting ? `<p class="faded-key">${t(
         state.model === "both" ? "fadedKeyBoth" : "fadedKeyOne",
         { floor: state.change.floor_days })}</p>${summaryStrip()}` : "");
}

/* ------------------------------------------------------ the detail drawer */

async function seriesBlock(index) {
  const block = Math.floor(index / state.meta.block);
  if (!state.series.has(block)) {
    const name = String(block).padStart(3, "0");
    const buffer = await (await fetch(dataURL(`series/${name}.bin`))).arrayBuffer();
    state.series.set(block, new Int16Array(buffer));
  }
  const data = state.series.get(block);
  const rows = data.length / (state.meta.years.length + 24);
  const row = index % state.meta.block;
  const years = state.meta.years.length;
  return {
    annual: Array.from(data.slice(row * years, (row + 1) * years), (v) => v / 10),
    monthly: Array.from(
      data.slice(rows * years + row * 12, rows * years + (row + 1) * 12),
      (v) => v / 100),
    index: Array.from(
      data.slice(rows * (years + 12) + row * 12, rows * (years + 12) + (row + 1) * 12),
      (v) => v / 1000),
  };
}

/* Small charts, drawn as SVG by hand. Plotly draws the full cards; here the
 * job is two sparklines inside a 340 px panel, and 3 MB of library to do it
 * would be the slowest thing on the page. */
function lineChart(values, labels, options = {}) {
  const width = 340, height = 96, pad = { l: 26, r: 4, t: 6, b: 16 };
  const top = Math.max(...values, options.floor || 0) || 1;
  const x = (i) => pad.l + (i * (width - pad.l - pad.r)) / Math.max(values.length - 1, 1);
  const y = (v) => height - pad.b - (v / top) * (height - pad.t - pad.b);

  const path = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${path}L${x(values.length - 1).toFixed(1)},${height - pad.b}L${x(0).toFixed(1)},${height - pad.b}Z`;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  const ticks = [0, top / 2, top].map((v) =>
    `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"
       stroke="currentColor" stroke-opacity=".12"/>
     <text x="${pad.l - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end"
       font-size="9" fill="currentColor" fill-opacity=".45">${v >= 10 ? v.toFixed(0) : v.toFixed(1)}</text>`).join("");

  const marks = labels.map((label, i) => (i % Math.ceil(labels.length / 5) === 0
    ? `<text x="${x(i).toFixed(1)}" y="${height - 3}" text-anchor="middle"
         font-size="9" fill="currentColor" fill-opacity=".45">${label}</text>` : "")).join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img">
    ${ticks}
    <path d="${area}" fill="var(--accent)" fill-opacity=".14"/>
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.6"
          stroke-linejoin="round"/>
    <line x1="${pad.l}" x2="${width - pad.r}" y1="${y(mean).toFixed(1)}" y2="${y(mean).toFixed(1)}"
          stroke="currentColor" stroke-opacity=".5" stroke-dasharray="3 3"/>
    ${marks}
  </svg>`;
}

function barChart(bars, line) {
  const width = 340, height = 104, pad = { l: 26, r: 22, t: 6, b: 16 };
  const top = Math.max(...bars, 0.001);
  const slot = (width - pad.l - pad.r) / 12;
  const y = (v) => height - pad.b - (v / top) * (height - pad.t - pad.b);
  const yIndex = (v) => height - pad.b - (v / Math.max(...line, 1)) * (height - pad.t - pad.b);

  const columns = bars.map((value, i) => {
    const h = Math.max(height - pad.b - y(value), 0);
    return `<rect x="${(pad.l + i * slot + slot * 0.18).toFixed(1)}"
      y="${y(value).toFixed(1)}" width="${(slot * 0.64).toFixed(1)}" height="${h.toFixed(1)}"
      rx="2" fill="var(--accent)" fill-opacity=".8"/>`;
  }).join("");

  const curve = line.map((value, i) =>
    `${i ? "L" : "M"}${(pad.l + i * slot + slot / 2).toFixed(1)},${yIndex(value).toFixed(1)}`).join("");

  const labels = months().map((month, i) =>
    `<text x="${(pad.l + i * slot + slot / 2).toFixed(1)}" y="${height - 3}"
       text-anchor="middle" font-size="8.5" fill="currentColor"
       fill-opacity=".45">${month[0]}</text>`).join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img">
    <line x1="${pad.l}" x2="${width - pad.r}" y1="${y(top).toFixed(1)}" y2="${y(top).toFixed(1)}"
      stroke="currentColor" stroke-opacity=".12"/>
    <text x="${pad.l - 5}" y="${(y(top) + 3).toFixed(1)}" text-anchor="end" font-size="9"
      fill="currentColor" fill-opacity=".45">${top.toFixed(top >= 10 ? 0 : 1)}%</text>
    ${columns}
    <path d="${curve}" fill="none" stroke="#ffae3a" stroke-width="1.6"/>
    ${labels}
  </svg>`;
}

/* A row whose label is the measure's own name, so the panel and the menu say
 * the same words in whatever language is on. */
function named(metric, index) {
  return fact(says(metric).label, formatValue(metric, valueAt(metric, index)));
}

function fact(label, value) {
  return `<tr><td>${label}</td><td>${value}</td></tr>`;
}

function position(lon, lat) {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}, ` +
         `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
}

function nearestSpot(lon, lat) {
  let best = null;
  for (const spot of state.spots) {
    const km = Math.hypot((spot.lon - lon) * 111.32 * Math.cos((lat * Math.PI) / 180),
                          (spot.lat - lat) * 110.57);
    if (!best || km < best.km) best = { spot, km };
  }
  return best;
}

/* A carded beach and the coastal grid point beside it answer two different
 * questions and can give two different numbers: the grid takes the aspect it
 * finds every kilometre along the coastline, which around a headland or inside
 * a bay is not the way the beach itself faces. Rather than show one under the
 * other's name, the panel opens in one of two modes and says which. */

function openSpot(spot) {
  const index = nearestPoint(spot.lon, spot.lat, 0.05);
  state.selected = index;
  state.openSpot = spot;
  showCursor();

  document.getElementById("drawer").hidden = false;
  document.getElementById("drawer-kind").textContent = t("studiedBeach");
  // a carded beach has sixteen pages of its own; the grid point's projection
  // panel would be answering a question about a different place
  document.getElementById("drawer-projection").hidden = true;
  document.getElementById("drawer-title").textContent = spot.name;
  document.getElementById("drawer-where").textContent =
    [spot.municipality, spot.aliases ? t("alsoCalled", { names: spot.aliases }) : "",
     position(spot.lon, spot.lat)].filter(Boolean).join(" · ");

  document.getElementById("drawer-days").textContent =
    spot.card_days === undefined ? "—" : spot.card_days.toFixed(1);
  document.getElementById("drawer-chips").innerHTML =
    `<span>${t("faces", { degrees: spot.facing.toFixed(0) })}</span>` +
    `<span>${t("cardsCount", { count: 16 })}</span>`;

  // the charts belong to the grid point, so they stay shut in this mode
  document.getElementById("drawer-charts").hidden = true;
  document.getElementById("drawer-facts").innerHTML = [
    fact(t("factFrom"), t("factOwnCard")),
    fact(t("factAspect"), `${spot.facing.toFixed(0)}°`),
    fact(says(state.meta.metrics.find((m) => m.key === "mean_days_per_year")).label,
         spot.card_days === undefined ? "—" : `${spot.card_days.toFixed(1)}`),
  ].join("");

  const note = document.getElementById("drawer-other");
  if (index !== null) {
    const days = valueAt(state.meta.metrics.find((m) => m.key === "mean_days_per_year"),
                         index);
    const facing = state.arrays.facing[index] / 10;
    note.hidden = false;
    note.innerHTML =
      t("gridNote", { degrees: facing.toFixed(0), days: days.toFixed(1) })
      + ` <button class="link" id="see-point">${t("seeGridPoint")}</button>`;
    document.getElementById("see-point").addEventListener("click", () => openPoint(index));
  } else {
    note.hidden = true;
  }

  const link = document.getElementById("card-link");
  link.hidden = !spot.card;
  if (spot.card) link.href = `cards/${spot.card}`;
  writeHash();
}

/* Re-open whichever panel is showing, after the measure changes under it. */
function reopen() {
  if (state.openSpot) openSpot(state.openSpot);
  else if (state.selected !== null) openPoint(state.selected);
}


/* Everything the page has already drawn has to be drawn again: the chrome, the
 * menu, the legend, whatever panel is open. Nothing is reloaded - the data is
 * language-independent and the view the reader reached is worth keeping. */
function retranslate() {
  applyStatic();
  document.getElementById("spots-label").textContent =
    t("showSpots", { count: state.spots.length });
  rebuildMetricMenu();
  state.view = activeView();
  document.getElementById("about").textContent = state.view.about;
  drawLegend();
  writeCredit();
  if (!document.getElementById("glossary-sheet").hidden) drawGlossary();
  if (!document.getElementById("sheet").hidden) drawSheet();
  reopen();
}

function writeCredit() {
  document.getElementById("credit-text").textContent = t("credit", {
    count: state.meta.count.toLocaleString(),
    from: state.meta.period[0].slice(0, 4),
    to: state.meta.period[1].slice(0, 4),
    threshold: state.meta.threshold,
  }) + (typeof maplibregl === "undefined" ? t("mapUnavailable") : "");
}

const LANGUAGE_NAMES = { en: "English", es: "Espanol", fr: "Francais", pt: "Portugues" };

function rebuildMetricMenu() {
  const select = document.getElementById("metric");
  const chosen = select.value || (state.metric && state.metric.key);
  select.innerHTML = "";
  let group = null;
  state.meta.metrics.forEach((metric) => {
    if (metric.group !== group) {
      group = metric.group;
      const holder = document.createElement("optgroup");
      const key = `group${group}`;
      const said = t(key);
      holder.label = said === key ? group : said;
      select.appendChild(holder);
    }
    const option = document.createElement("option");
    option.value = metric.key;
    option.textContent = says(metric).label;
    select.lastChild.appendChild(option);
  });
  select.value = chosen;
}

/* ------------------------------------------------- what the numbers mean
 *
 * The map answers "how much"; this answers "of what". It is written as data in
 * the language files rather than as markup, because it has to exist four times
 * and prose that lives in four parallel copies of the HTML drifts apart by the
 * second edit.
 *
 * The one interactive part is the measures: pick one and it tells you what it
 * counts, and draws how the published coast is distributed across it in the
 * colours the map itself uses. A reader who has just been told what "typical
 * run of surfable days" means can see at once that most of this coast sits at
 * one or two days, which is the sort of thing a sentence cannot do.
 */
function metricHistogram(metric) {
  const width = 560, height = 74, pad = { l: 4, r: 4, t: 4, b: 18 };
  const breaks = metric.breaks || [];
  const counts = new Array(breaks.length + 1).fill(0);
  let seen = 0;
  for (let i = 0; i < state.meta.count; i++) {
    const klass = classOf(metric, valueAt(metric, i));
    if (klass < 0) continue;
    counts[klass]++;
    seen++;
  }
  if (!seen) return "";
  const ramp = colours(metric);
  const tallest = Math.max(...counts);
  const slot = (width - pad.l - pad.r) / counts.length;
  const bars = counts.map((n, i) => {
    const h = Math.max((n / tallest) * (height - pad.t - pad.b), 1);
    const share = (100 * n / seen).toFixed(0);
    return `<rect x="${(pad.l + i * slot + 1).toFixed(1)}"
        y="${(height - pad.b - h).toFixed(1)}" width="${(slot - 2).toFixed(1)}"
        height="${h.toFixed(1)}" fill="${ramp[i] || MISSING_COLOUR}" rx="1.5"
      ><title>${share} % of the coast</title></rect>
      ${n / seen > 0.08 ? `<text x="${(pad.l + i * slot + slot / 2).toFixed(1)}"
        y="${(height - pad.b - h - 3).toFixed(1)}" text-anchor="middle" font-size="9"
        fill="currentColor" fill-opacity=".55">${share} %</text>` : ""}`;
  }).join("");
  const edges = breaks.map((value, i) =>
    `<text x="${(pad.l + (i + 1) * slot).toFixed(1)}" y="${height - 5}"
       text-anchor="middle" font-size="9" fill="currentColor" fill-opacity=".5">${
      Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(Math.abs(value) >= 10 ? 1 : 2)
    }</text>`).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img">${bars}${edges}</svg>`;
}

function showGlossaryMetric(key) {
  const metric = state.meta.metrics.find((m) => m.key === key);
  const said = says(metric);
  document.querySelectorAll("#glossary-picker button").forEach((button) =>
    button.classList.toggle("on", button.dataset.key === key));
  document.getElementById("glossary-metric").innerHTML =
    `<p class="glossary-plain">${said.plain || said.about}</p>
     ${metric.categorical ? "" : metricHistogram(metric)}
     <p class="caption">${said.about}${metric.unit ? ` · ${unit(metric.unit)}` : ""}</p>`;
}

function drawGlossary() {
  const book = state.strings.glossary || FALLBACK.glossary || {};
  document.getElementById("glossary-title").textContent = book.title || "";
  document.getElementById("glossary-lede").textContent = book.lede || "";

  document.getElementById("glossary-sections").innerHTML =
    (book.sections || []).map((section) =>
      `<h3>${section.heading}</h3>` + section.body.map((line) =>
        `<p class="glossary-body">${line
          .replace("{threshold}", state.meta.threshold)
          .replace("{spots}", state.spots.length)}</p>`).join("")).join("");

  document.getElementById("glossary-metrics-heading").textContent = book.metricsHeading || "";
  document.getElementById("glossary-metrics-lede").textContent = book.metricsLede || "";
  document.getElementById("glossary-picker").innerHTML = state.meta.metrics.map((metric) =>
    `<button data-key="${metric.key}">${says(metric).label}</button>`).join("");
  document.getElementById("glossary-picker").querySelectorAll("button").forEach((button) =>
    button.addEventListener("click", () => showGlossaryMetric(button.dataset.key)));
  showGlossaryMetric(state.metric.key);

  document.getElementById("glossary-projections-heading").textContent =
    book.projectionsHeading || "";
  document.getElementById("glossary-projections-lede").textContent =
    book.projectionsLede || "";
  document.getElementById("glossary-terms").innerHTML = (book.terms || []).map((term) =>
    `<dt>${term.term}</dt><dd>${term.body}</dd>`).join("");
}

function openGlossary() {
  drawGlossary();
  document.getElementById("glossary-sheet").hidden = false;
}

/* ------------------------------------------------ the projections, all at once
 *
 * The sheet behind "Full statistics" exists because the map can only ever show
 * one run, while the honest reading of this dataset is a comparison between
 * runs: at every pathway and horizon but one, most of the coast sits inside its
 * own year-to-year noise. Four questions, in the order a reader asks them - how
 * much is claimed, how big it is, whether the models agree, and where - each
 * computed here in the browser, because change.bin is already loaded.
 */

const BUCKETS = ["robust", "soft", "split", "rising"];
const BUCKET_KEYS = { robust: "bucketRobust", soft: "bucketSoft",
                      split: "bucketSplit", rising: "bucketRising" };

/* The legend keys read "{share} % lose surf..."; beside a swatch the share is
 * already in the bar, so the sentence is wanted without it. */
function bucketWords(kind, share) {
  return t(BUCKET_KEYS[kind], { share }).replace(/^\s*[\d.]+\s*%\s*/, "");
}

function summaryFor(pathway, horizon) {
  const counts = { robust: 0, soft: 0, split: 0, rising: 0, total: 0 };
  const flags = state.change.arrays[`flag_${pathway}_${horizon}`];
  for (let i = 0; i < state.meta.count; i++) {
    if (state.change.arrays.summarised[i] !== 1) continue;
    const a = changeFor("a", pathway, horizon, i);
    const e = changeFor("e", pathway, horizon, i);
    if (!Number.isFinite(a) || !Number.isFinite(e)) continue;
    counts.total++;
    const set = (name) => (flags[i] >> state.change.flags[name] & 1) === 1;
    if (!set("agree")) counts.split++;
    else if (a > 0) counts.rising++;
    else if (set("significant_a") && set("significant_e")) counts.robust++;
    else counts.soft++;
  }
  return counts;
}

function quartilesFor(code, pathway, horizon, keep) {
  const values = [];
  for (let i = 0; i < state.meta.count; i++) {
    if (state.change.arrays.summarised[i] !== 1) continue;
    if (keep && !keep(i)) continue;
    const v = changeFor(code, pathway, horizon, i);
    if (Number.isFinite(v)) values.push(v);
  }
  if (!values.length) return null;
  values.sort((x, y) => x - y);
  const at = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
  return {
    q1: at(0.25), median: at(0.5), q3: at(0.75), n: values.length,
    falling: values.filter((v) => v < 0).length / values.length,
  };
}

function eachRun(callback) {
  const out = [];
  for (const pathway of state.change.pathways) {
    for (const horizon of state.change.horizons) out.push(callback(pathway, horizon));
  }
  return out;
}

/* 1. composition: one bar per run, each the whole summarised coast */
function compositionChart() {
  const width = 620, row = 30, pad = { l: 152, r: 48, t: 4 };
  const runs = eachRun((pathway, horizon) => ({
    label: `${pathway.label} · ${horizon.label}`,
    counts: summaryFor(pathway.key, horizon.key),
  }));
  const height = pad.t + runs.length * row + 4;
  const span = width - pad.l - pad.r;

  const bars = runs.map((run, i) => {
    const y = pad.t + i * row;
    let x = pad.l;
    const pieces = BUCKETS.map((kind) => {
      const share = run.counts[kind] / Math.max(run.counts.total, 1);
      const w = share * span;
      const rect = `<rect x="${x.toFixed(1)}" y="${y + 7}" width="${Math.max(w, 0).toFixed(1)}"
        height="15" fill="${SUMMARY_COLOURS[kind]}"><title>${
        t(BUCKET_KEYS[kind], { share: (100 * share).toFixed(1) })}</title></rect>`;
      x += w;
      return rect;
    }).join("");
    const robust = 100 * run.counts.robust / Math.max(run.counts.total, 1);
    return `<text x="${pad.l - 8}" y="${y + 19}" text-anchor="end" font-size="11"
       fill="currentColor" fill-opacity=".7">${run.label}</text>${pieces}
      <text x="${width - pad.r + 7}" y="${y + 19}" font-size="11" font-weight="600"
        fill="${SUMMARY_COLOURS.robust}">${robust.toFixed(0)} %</text>`;
  }).join("");

  const key = BUCKETS.map((kind) =>
    `<span><i style="background:${SUMMARY_COLOURS[kind]}"></i>${
      bucketWords(kind, "")}</span>`).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img">${bars}</svg>
    <div class="sheet-key">${key}</div>`;
}

/* 2. how big: the middle half of beaches, per model, on one shared scale */
function spreadChart() {
  const width = 620, row = 24, pad = { l: 152, r: 24, t: 14, b: 24 };
  const rows = [];
  for (const pathway of state.change.pathways) {
    for (const horizon of state.change.horizons) {
      for (const model of state.change.models) {
        rows.push({
          label: `${pathway.label} · ${horizon.label}`,
          model,
          stats: quartilesFor(model.code, pathway.key, horizon.key),
        });
      }
    }
  }
  const live = rows.filter((r) => r.stats);
  const reach = Math.max(
    ...live.flatMap((r) => [Math.abs(r.stats.q1), Math.abs(r.stats.q3)]), 1) * 1.1;
  const height = pad.t + (rows.length / 2) * row + pad.b;
  const x = (v) => pad.l + ((v + reach) / (2 * reach)) * (width - pad.l - pad.r);

  const zero = `<line x1="${x(0).toFixed(1)}" x2="${x(0).toFixed(1)}" y1="${pad.t - 6}"
    y2="${height - pad.b + 2}" stroke="currentColor" stroke-opacity=".35"/>`;
  const ticks = [-reach * 0.6, 0, reach * 0.6].map((v) =>
    `<text x="${x(v).toFixed(1)}" y="${height - 7}" text-anchor="middle" font-size="10"
      fill="currentColor" fill-opacity=".5">${v > 0 ? "+" : ""}${v.toFixed(0)}</text>`).join("");

  let drawn = "";
  rows.forEach((r, i) => {
    if (!r.stats) return;
    const y = pad.t + Math.floor(i / 2) * row + (i % 2 ? 11 : 2);
    const colour = MODEL_COLOURS[r.model.code];
    if (i % 2 === 0) {
      drawn += `<text x="${pad.l - 8}" y="${y + 14}" text-anchor="end" font-size="11"
        fill="currentColor" fill-opacity=".7">${r.label}</text>`;
    }
    drawn += `<line x1="${x(r.stats.q1).toFixed(1)}" x2="${x(r.stats.q3).toFixed(1)}"
        y1="${y + 4}" y2="${y + 4}" stroke="${colour}" stroke-width="5"
        stroke-opacity=".45" stroke-linecap="round"><title>${t("tipSpread", { model: r.model.key, median: r.stats.median.toFixed(1), q1: r.stats.q1.toFixed(1), q3: r.stats.q3.toFixed(1) })}</title></line>
      <circle cx="${x(r.stats.median).toFixed(1)}" cy="${y + 4}" r="3.6" fill="${colour}"/>`;
  });

  const key = state.change.models.map((m) =>
    `<span><i style="background:${MODEL_COLOURS[m.code]}"></i>${m.key}</span>`).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img">${zero}${drawn}${ticks}</svg>
    <div class="sheet-key">${key}<span class="sheet-unit">${t("sheetSpreadUnit")}</span></div>`;
}

/* 3. agreement: one axis per model, every summarised beach binned. The dashed
 * diagonal is perfect agreement; the quadrants off it are the beaches where the
 * two models say opposite things, and counting those is the point. */
function agreementChart(pathway, horizon) {
  const size = 320, pad = { l: 46, r: 12, t: 12, b: 38 };
  const quadrant = { both_down: 0, both_up: 0, split: 0, total: 0 };
  const points = [];
  let reach = 1;
  for (let i = 0; i < state.meta.count; i++) {
    if (state.change.arrays.summarised[i] !== 1) continue;
    const a = changeFor("a", pathway, horizon, i);
    const e = changeFor("e", pathway, horizon, i);
    if (!Number.isFinite(a) || !Number.isFinite(e)) continue;
    points.push([a, e]);
    reach = Math.max(reach, Math.abs(a), Math.abs(e));
    quadrant.total++;
    if (a < 0 && e < 0) quadrant.both_down++;
    else if (a > 0 && e > 0) quadrant.both_up++;
    else quadrant.split++;
  }
  reach = Math.min(reach, 40);          // a handful of outliers must not set the frame
  const bins = 44;
  const inner = { w: size - pad.l - pad.r, h: size - pad.t - pad.b };
  const cells = new Map();
  for (const [a, e] of points) {
    const clamp = (v) => Math.max(0, Math.min(bins - 1,
      Math.floor(((v + reach) / (2 * reach)) * bins)));
    const key = `${clamp(a)},${clamp(e)}`;
    cells.set(key, (cells.get(key) || 0) + 1);
  }
  const busiest = Math.max(...cells.values(), 1);
  const x = (v) => pad.l + ((v + reach) / (2 * reach)) * inner.w;
  const y = (v) => (size - pad.b) - ((v + reach) / (2 * reach)) * inner.h;

  const grid = [...cells].map(([key, n]) => {
    const [bx, by] = key.split(",").map(Number);
    // a square root, so that a handful of beaches still shows against a cloud
    const weight = Math.sqrt(n / busiest);
    return `<rect x="${(pad.l + bx * inner.w / bins).toFixed(1)}"
      y="${(size - pad.b - (by + 1) * inner.h / bins).toFixed(1)}"
      width="${(inner.w / bins).toFixed(1)}" height="${(inner.h / bins).toFixed(1)}"
      fill="var(--accent)" fill-opacity="${(0.1 + 0.9 * weight).toFixed(3)}"/>`;
  }).join("");

  const frame = `
    <line x1="${x(-reach).toFixed(1)}" x2="${x(reach).toFixed(1)}" y1="${y(0).toFixed(1)}"
      y2="${y(0).toFixed(1)}" stroke="currentColor" stroke-opacity=".3"/>
    <line x1="${x(0).toFixed(1)}" x2="${x(0).toFixed(1)}" y1="${y(-reach).toFixed(1)}"
      y2="${y(reach).toFixed(1)}" stroke="currentColor" stroke-opacity=".3"/>
    <line x1="${x(-reach).toFixed(1)}" y1="${y(-reach).toFixed(1)}"
      x2="${x(reach).toFixed(1)}" y2="${y(reach).toFixed(1)}"
      stroke="currentColor" stroke-opacity=".45" stroke-dasharray="4 4"/>
    <text x="${x(0).toFixed(1)}" y="${size - 8}" text-anchor="middle" font-size="10"
      fill="currentColor" fill-opacity=".55">ACCESS-CM2 · ${t("daysAYearAxis")}</text>
    <text x="14" y="${y(0).toFixed(1)}" font-size="10" fill="currentColor"
      fill-opacity=".55" text-anchor="middle"
      transform="rotate(-90 14 ${y(0).toFixed(1)})">EC-EARTH3 · ${t("daysAYearAxis")}</text>
    <text x="${x(-reach * 0.5).toFixed(1)}" y="${y(-reach * 0.86).toFixed(1)}"
      font-size="10" fill="currentColor" fill-opacity=".45"
      text-anchor="middle">${t("bothLoseSurf")}</text>`;

  return { svg: `<svg viewBox="0 0 ${size} ${size}" role="img">${grid}${frame}</svg>`, quadrant };
}

/* 4. by area: the three coasts, each model, median and the share falling */
function areasChart(pathway, horizon) {
  // the Balearics went with the Mediterranean, so what is left of that run is
  // the Atlantic south: the Algarve, the Gulf of Cadiz and the Huelva coast
  const areas = [[t("areaFacade"), 0, 100000],
                 [t("areaSouth"), 100000, 200000],
                 [t("areaIslands"), 200000, Infinity]];
  const ids = state.arrays.point_id;
  const rows = areas.map(([label, low, high]) => ({
    label,
    models: state.change.models.map((model) => ({
      model,
      stats: quartilesFor(model.code, pathway, horizon,
                          (i) => ids[i] >= low && ids[i] < high),
    })),
  })).filter((row) => row.models.some((m) => m.stats));
  if (!rows.length) return "";

  const width = 620, row = 44, pad = { l: 152, r: 24, t: 6 };
  const live = rows.flatMap((r) => r.models.filter((m) => m.stats).map((m) => m.stats));
  const reach = Math.max(...live.map((s) => Math.abs(s.median)), 1) * 1.3;
  const height = pad.t + rows.length * row + 8;
  const x = (v) => pad.l + ((v + reach) / (2 * reach)) * (width - pad.l - pad.r);

  const drawn = rows.map((r, i) => {
    const y = pad.t + i * row;
    const bars = r.models.map((m, j) => {
      if (!m.stats) return "";
      const colour = MODEL_COLOURS[m.model.code];
      const left = Math.min(x(0), x(m.stats.median));
      const w = Math.abs(x(m.stats.median) - x(0));
      const label = `${m.stats.median.toFixed(1)} · ${
        t("falling", { share: (100 * m.stats.falling).toFixed(0) })}`;
      return `<rect x="${left.toFixed(1)}" y="${y + 6 + j * 16}" width="${w.toFixed(1)}"
          height="12" rx="2" fill="${colour}" fill-opacity=".8"><title>${t("tipArea", { model: m.model.key, median: m.stats.median.toFixed(1), count: m.stats.n.toLocaleString() })}</title></rect>
        <text x="${(left + w + 6).toFixed(1)}" y="${y + 16 + j * 16}" font-size="10"
          fill="currentColor" fill-opacity=".65">${label}</text>`;
    }).join("");
    return `<text x="${pad.l - 8}" y="${y + 21}" text-anchor="end" font-size="11"
       fill="currentColor" fill-opacity=".7">${r.label}</text>
      <line x1="${x(0).toFixed(1)}" x2="${x(0).toFixed(1)}" y1="${y + 2}" y2="${y + 38}"
        stroke="currentColor" stroke-opacity=".3"/>${bars}`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img">${drawn}</svg>`;
}

function drawSheet() {
  const pathway = state.sheetPathway, horizon = state.sheetHorizon;
  const pathwayLabel = state.change.pathways.find((p) => p.key === pathway).label;
  const horizonLabel = state.change.horizons.find((h) => h.key === horizon).label;

  document.getElementById("caption-composition").textContent =
    t("sheetCompositionCaption", { floor: state.change.floor_days });
  const end = summaryFor("ssp585", "end_century");
  document.getElementById("sheet-lede").innerHTML = t("sheetLede", {
    total: end.total.toLocaleString(),
    robust: (100 * end.robust / Math.max(end.total, 1)).toFixed(0),
  });

  document.getElementById("sheet-composition").innerHTML = compositionChart();
  document.getElementById("sheet-spread").innerHTML = spreadChart();

  const agreement = agreementChart(pathway, horizon);
  document.getElementById("sheet-agreement").innerHTML = agreement.svg;
  const q = agreement.quadrant;
  const share = (n) => (100 * n / Math.max(q.total, 1)).toFixed(0);
  document.getElementById("caption-agreement").innerHTML = t("sheetAgreementCaption", {
    pathway: pathwayLabel, horizon: horizonLabel,
    bothDown: share(q.both_down), bothUp: share(q.both_up), split: share(q.split),
  });

  document.getElementById("sheet-areas").innerHTML = areasChart(pathway, horizon);
}

function buildSheetControls() {
  const holder = document.getElementById("sheet-controls");
  const group = (field, options, chosen) =>
    `<div class="segmented" data-field="${field}">${options.map((o) =>
      `<button data-key="${o.key}" class="${o.key === chosen ? "on" : ""}">${o.label}</button>`
    ).join("")}</div>`;
  holder.innerHTML =
    group("sheetPathway", state.change.pathways, state.sheetPathway) +
    group("sheetHorizon", state.change.horizons, state.sheetHorizon);
  holder.querySelectorAll(".segmented").forEach((segmented) => {
    segmented.addEventListener("click", (event) => {
      const hit = event.target.closest("button");
      if (!hit) return;
      state[segmented.dataset.field] = hit.dataset.key;
      segmented.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === hit));
      drawSheet();
    });
  });
}

async function openSheet() {
  if (!(await loadChange())) return;
  state.sheetPathway = state.sheetPathway || state.pathway;
  state.sheetHorizon = state.sheetHorizon || state.horizon;
  buildSheetControls();
  drawSheet();
  document.getElementById("sheet").hidden = false;
}

/* ----------------------------------------------- the projection, one point
 *
 * The question a reader has in front of a single beach is not "what is the
 * ensemble mean" but "should I believe this". So the panel gives them the
 * yardstick they already own: the swing between a good year and a bad one at
 * this very beach, measured over the forty years it was observed, drawn as a
 * band. A projected shift that stays inside the band is smaller than the
 * difference between two ordinary years, whatever its p-value.
 */

function observedSpread(annual) {
  const mean = annual.reduce((a, b) => a + b, 0) / annual.length;
  const variance = annual.reduce((s, v) => s + (v - mean) ** 2, 0)
    / Math.max(annual.length - 1, 1);
  return Math.sqrt(variance);
}

function projectionChart(index) {
  const width = 340, height = 124, pad = { l: 32, r: 8, t: 10, b: 26 };
  const horizons = state.change.horizons;
  const models = state.change.models.map((model) => ({
    code: model.code,
    spread: spreadAt(model.code, index),
    values: [0, ...horizons.map((h) => changeFor(model.code, state.pathway, h.key, index))],
    significant: horizons.map((h) =>
      (flagsFor(state.pathway, h.key, index) >> state.change.flags[`significant_${model.code}`] & 1) === 1),
  }));

  const reach = Math.max(
    ...models.map((m) => (Number.isFinite(m.spread) ? m.spread * 1.35 : 0)),
    ...models.flatMap((m) => m.values.filter(Number.isFinite).map(Math.abs)),
    1,
  ) * 1.15;
  const x = (i) => pad.l + (i * (width - pad.l - pad.r)) / horizons.length;
  const y = (v) => pad.t + (height - pad.t - pad.b) * (1 - (v + reach) / (2 * reach));

  /* One band per model, each its own year-to-year swing, because that is the
   * quantity the verdict beside the chart is tested against. A single band
   * averaging the two would let the picture and the words disagree. */
  const band = models.filter((m) => Number.isFinite(m.spread)).map((model) =>
    `<rect x="${pad.l}" y="${y(model.spread).toFixed(1)}"
      width="${(width - pad.l - pad.r).toFixed(1)}"
      height="${Math.max(y(-model.spread) - y(model.spread), 1).toFixed(1)}"
      fill="${MODEL_COLOURS[model.code]}" fill-opacity=".10"/>`).join("");

  const zero = `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(0).toFixed(1)}"
      y2="${y(0).toFixed(1)}" stroke="currentColor" stroke-opacity=".35"/>`;

  const ticks = [reach * 0.66, -reach * 0.66].map((v) =>
    `<text x="${pad.l - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9"
       fill="currentColor" fill-opacity=".45">${v > 0 ? "+" : ""}${v.toFixed(0)}</text>`).join("");

  const lines = models.map((model) => {
    const colour = MODEL_COLOURS[model.code];
    const points = model.values
      .map((v, i) => (Number.isFinite(v) ? `${x(i).toFixed(1)},${y(v).toFixed(1)}` : null))
      .filter(Boolean).join(" ");
    const dots = model.values.map((v, i) => {
      if (!Number.isFinite(v) || i === 0) return "";
      const solid = model.significant[i - 1];
      return `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.4"
        fill="${solid ? colour : "var(--paper)"}" stroke="${colour}" stroke-width="1.6"/>`;
    }).join("");
    return `<polyline points="${points}" fill="none" stroke="${colour}"
      stroke-width="1.8" stroke-linejoin="round"/>${dots}`;
  }).join("");

  const marks = ["1985–2014", ...horizons.map((h) => h.label)].map((label, i) =>
    `<text x="${x(i).toFixed(1)}" y="${height - 12}" text-anchor="middle" font-size="8.5"
       fill="currentColor" fill-opacity=".45">${label}</text>`).join("");

  const key = state.change.models.map((model, i) =>
    `<circle cx="${pad.l + 4 + i * 96}" cy="${height - 3}" r="3" fill="${MODEL_COLOURS[model.code]}"/>
     <text x="${pad.l + 11 + i * 96}" y="${height}" font-size="8.5" fill="currentColor"
       fill-opacity=".6">${model.key}</text>`).join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img">
    ${band}${zero}${ticks}${lines}${marks}${key}
  </svg>`;
}

function signed(value, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function projectionVerdict(index, spread) {
  const floor = state.change.floor_days;
  const horizon = state.change.horizons.find((h) => h.key === state.horizon).label;
  const pathway = state.change.pathways.find((p) => p.key === state.pathway).label;
  const a = changeAt("a", index), e = changeAt("e", index);
  const flags = flagsAt(index);
  const both = t("daysAYear", { a: signed(a), e: signed(e) });
  const shared = { both, horizon, pathway, floor };

  if (state.change.arrays.summarised[index] !== 1) {
    return t("verdictBelowFloor", shared);
  }
  if (!isSet(flags, "agree")) {
    return t("verdictSplit", shared);
  }
  const word = t(a < 0 ? "lessSurfWord" : "moreSurfWord");
  const sure = isSet(flags, "significant_a") && isSet(flags, "significant_e");
  const clearing = state.change.models.filter((m) => isSet(flags, `beyond_${m.code}`));

  if (!sure) return t("verdictNotSure", { ...shared, word });
  if (clearing.length === 2) return t("verdictBothBeyond", { ...shared, word });
  if (clearing.length === 1) {
    return t("verdictOneBeyond", { ...shared, word, model: clearing[0].key });
  }
  return t("verdictNeitherBeyond", { ...shared, word });
}

/* The downscaled history can sit a long way from the record it was trained on:
 * at most beaches it lands within a quarter of the observed, but at about one
 * in fourteen it runs more than double. That is the reason every change here is
 * measured against the model's own past, and a reader looking at 14 observed
 * days beside a model's 56 deserves to be told so rather than left to wonder. */
function baselineNote(index, observed) {
  const ratios = state.change.models
    .map((model) => baseAt(model.code, index) / observed)
    .filter(Number.isFinite);
  if (!ratios.length || !ratios.some((r) => r > 2 || r < 0.5)) return "";
  return `<p class="caption">${t("baselineNote", {
    ratios: ratios.map((r) => `${r.toFixed(1)}×`).join(" / "),
  })}</p>`;
}

function projectionPanel(index, annual) {
  const holder = document.getElementById("drawer-projection");
  if (state.period !== "projections" || !state.change) { holder.hidden = true; return; }
  holder.hidden = false;

  const observed = annual.reduce((a, b) => a + b, 0) / annual.length;
  const spread = observedSpread(annual);
  document.getElementById("projection-verdict").innerHTML =
    projectionVerdict(index, spread);
  document.getElementById("chart-projection").innerHTML = projectionChart(index);
  document.getElementById("caption-projection").innerHTML =
    t("captionProjection", {
      pathway: state.change.pathways.find((p) => p.key === state.pathway).label,
    }) + baselineNote(index, observed);

  const flags = flagsAt(index);
  document.getElementById("projection-facts").innerHTML = [
    fact(t("factSwing"), t("factSwingValue", { value: spread.toFixed(1) })),
    ...state.change.models.map((model) => fact(
      t("factModelBy", {
        model: model.key,
        horizon: state.change.horizons.find((h) => h.key === state.horizon).label,
      }),
      t("factModelValue", { value: signed(changeAt(model.code, index)) }) +
      t(isSet(flags, `beyond_${model.code}`) ? "beyondTheSwing"
        : isSet(flags, `significant_${model.code}`) ? "beyondChance" : "withinTheNoise"),
    )),
    ...state.change.models.map((model) => fact(
      t("factModelHistory", { model: model.key }),
      t("factModelValue", { value: baseAt(model.code, index).toFixed(1) }))),
  ].join("");
}

async function openPoint(index) {
  state.selected = index;
  state.openSpot = null;
  showCursor();

  const drawer = document.getElementById("drawer");
  drawer.hidden = false;
  document.getElementById("drawer-charts").hidden = false;
  document.getElementById("drawer-kind").textContent = t("coastalPoint");
  document.getElementById("drawer-projection").hidden = true;

  const lon = lonAt(index), lat = latAt(index);
  const facing = state.arrays.facing[index] / 10;

  document.getElementById("drawer-title").textContent =
    t("coastAt", { lat: Math.abs(lat).toFixed(2), hemisphere: lat >= 0 ? "N" : "S" });
  document.getElementById("drawer-where").textContent =
    `${position(lon, lat)} · ${t("faces", { degrees: facing.toFixed(0) })}`;

  const by = (key) => state.meta.metrics.find((m) => m.key === key);
  const days = valueAt(by("mean_days_per_year"), index);
  document.getElementById("drawer-days").textContent =
    Number.isFinite(days) ? days.toFixed(1) : "—";

  const trend = valueAt(by("trend_days_per_decade"), index);
  const significant = state.arrays.trend_is_significant[index] === 1;
  const chips = [
    t("inWinter", { value: formatValue(by("days_winter"), valueAt(by("days_winter"), index)) }),
    t("inSummer", { value: formatValue(by("days_summer"), valueAt(by("days_summer"), index)) }),
    Number.isFinite(trend)
      ? t("perDecade", { value: `${trend >= 0 ? "+" : ""}${trend.toFixed(1)}` })
        + (significant ? "" : t("notClear"))
      : null,
  ].filter(Boolean);
  document.getElementById("drawer-chips").innerHTML =
    chips.map((chip) => `<span>${chip}</span>`).join("");

  document.getElementById("drawer-facts").innerHTML = [
    // the labels are the measures' own, so the table and the menu cannot drift
    named(by("mean_nearshore_wave_height"), index),
    named(by("mean_wave_period"), index),
    named(by("mean_wind_speed"), index),
    fact(says(by("offshore_wind_fraction")).label,
         `${(valueAt(by("offshore_wind_fraction"), index) * 100).toFixed(0)} %`),
    named(by("best_month_number"), index),
    named(by("longest_flat_spell_days"), index),
    named(by("corr_NAO"), index),
  ].join("");

  const near = nearestSpot(lon, lat);
  const note = document.getElementById("drawer-other");
  if (near && near.km < 2.5) {
    const gap = near.spot.card_days === undefined ? null
      : Math.abs(near.spot.card_days - days);
    note.hidden = false;
    note.innerHTML =
      t("nearbyBeach", {
        name: near.spot.name, km: near.km.toFixed(1),
        days: near.spot.card_days === undefined ? "—" : near.spot.card_days.toFixed(1),
      }) + " " +
      (gap !== null && gap > 20
        ? t("nearbyAspect", { beach: near.spot.facing.toFixed(0),
                              point: facing.toFixed(0) })
        : "") +
      ` <button class="link" id="see-spot">${t("openTheBeach")}</button>`;
    document.getElementById("see-spot")
      .addEventListener("click", () => openSpot(near.spot));
  } else {
    note.hidden = true;
  }
  document.getElementById("card-link").hidden = true;

  const series = await seriesBlock(index);
  if (state.selected !== index) return;      // someone clicked on while we read
  projectionPanel(index, Array.from(series.annual));
  const years = state.meta.years;
  document.getElementById("chart-annual").innerHTML =
    lineChart(series.annual, years.map(String));
  document.getElementById("caption-annual").textContent =
    t("captionAnnual", { first: years[0], last: years[years.length - 1] });
  document.getElementById("chart-monthly").innerHTML =
    barChart(series.monthly, series.index);

  writeHash();
}

/* ------------------------------------------------------------ interaction */

function attachPointer() {
  const tip = document.getElementById("tip");

  map.on("mousemove", (event) => {
    const reach = 12 * (map.getBounds().getEast() - map.getBounds().getWest())
      / map.getCanvas().clientWidth;
    const index = nearestPoint(event.lngLat.lng, event.lngLat.lat, reach);
    state.hovered = index;
    showCursor();

    if (index === null) { tip.hidden = true; map.getCanvas().style.cursor = ""; return; }
    map.getCanvas().style.cursor = "pointer";
    const value = state.view.valueAt(index);
    tip.hidden = false;
    tip.innerHTML = `<b>${formatValue(state.view, value)}</b> · ${state.view.label}`;
    tip.style.left = `${event.point.x + 14}px`;
    tip.style.top = `${event.point.y + 14}px`;
  });

  map.on("mouseout", () => { tip.hidden = true; state.hovered = null; showCursor(); });

  map.on("click", (event) => {
    // beach markers take their own clicks, so anything reaching here is coast
    const reach = 14 * (map.getBounds().getEast() - map.getBounds().getWest())
      / map.getCanvas().clientWidth;
    const index = nearestPoint(event.lngLat.lng, event.lngLat.lat, reach);
    if (index !== null) openPoint(index);
  });
}

function attachChrome() {
  document.querySelectorAll(".collapse").forEach((button) => {
    button.addEventListener("click", () => {
      const body = document.getElementById(button.dataset.for);
      const open = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!open));
      body.hidden = open;
    });
  });

  document.getElementById("drawer-close").addEventListener("click", () => {
    document.getElementById("drawer").hidden = true;
    state.selected = null;
    state.openSpot = null;
    showCursor();
    writeHash();
  });

  document.getElementById("show-spots").addEventListener("change", showSpotMarkers);

  document.getElementById("theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme === "dark";
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("isurf-theme", dark ? "light" : "dark"); } catch (e) { /* private window */ }
    if (!map) return;
    map.setStyle(basemap());
    map.once("styledata", () => { addCoastLayers(); showCursor(); });
  });

  const picker = document.getElementById("lang");
  picker.innerHTML = LANGUAGES.map((code) =>
    `<option value="${code}"${code === state.lang ? " selected" : ""}>${
      LANGUAGE_NAMES[code]}</option>`).join("");
  picker.addEventListener("change", async () => {
    await loadStrings(picker.value);
    try { localStorage.setItem("isurf-lang", state.lang); } catch (e) { /* private */ }
    retranslate();
    writeHash();
  });

  document.getElementById("glossary").addEventListener("click", openGlossary);
  document.getElementById("glossary-close").addEventListener("click", () => {
    document.getElementById("glossary-sheet").hidden = true;
  });
  document.getElementById("glossary-sheet").addEventListener("click", (event) => {
    if (event.target.id === "glossary-sheet") event.target.hidden = true;
  });

  const statistics = document.getElementById("stats");
  if (state.meta.change) {
    statistics.hidden = false;
    statistics.addEventListener("click", openSheet);
  }
  document.getElementById("sheet-close").addEventListener("click", () => {
    document.getElementById("sheet").hidden = true;
  });
  document.getElementById("sheet").addEventListener("click", (event) => {
    // the backdrop closes it; the panel itself does not
    if (event.target.id === "sheet") event.target.hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") document.getElementById("sheet").hidden = true;
  });

  document.getElementById("share").addEventListener("click", async () => {
    writeHash();
    await copy(location.href, "share");
  });

  document.getElementById("embed").addEventListener("click", async () => {
    writeHash();
    await copy(
      `<iframe src="${location.href}" width="100%" height="640" style="border:0"` +
      ` loading="lazy" title="iSurfability"></iframe>`, "embed");
  });

  attachSearch();
}

async function copy(text, id) {
  const button = document.getElementById(id);
  const was = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = t("copied");
  } catch (error) {
    button.textContent = t("pressToCopy");
    window.prompt("Copy this", text);
  }
  setTimeout(() => { button.textContent = was; }, 1600);
}

function attachSearch() {
  const input = document.getElementById("search");
  const results = document.getElementById("results");

  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    if (query.length < 2) { results.hidden = true; return; }
    const hits = state.spots.filter((spot) =>
      `${spot.name} ${spot.aliases} ${spot.municipality}`.toLowerCase().includes(query)
    ).slice(0, 8);
    results.hidden = hits.length === 0;
    results.innerHTML = hits.map((spot, i) =>
      `<li data-i="${i}">${spot.name}<small>${spot.municipality || ""}</small></li>`).join("");
    results.querySelectorAll("li").forEach((item, i) => {
      item.addEventListener("click", () => {
        const spot = hits[i];
        map.flyTo({ center: [spot.lon, spot.lat], zoom: 12.5 });
        openSpot(spot);
        results.hidden = true;
        input.value = "";
      });
    });
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search")) results.hidden = true;
  });
}

/* --------------------------------------------------------- shareable state */

function writeHash() {
  if (!map) return;                    // nothing to share without a map
  const centre = map.getCenter();
  const parts = [
    `m=${state.metric.key}`,
    `l=${state.lang}`,
    ...(state.period === "projections"
      ? [`pd=projections`, `pw=${state.pathway}`, `hz=${state.horizon}`,
         `md=${state.model}`] : []),
    `z=${map.getZoom().toFixed(2)}`,
    `c=${centre.lat.toFixed(4)},${centre.lng.toFixed(4)}`,
  ];
  if (state.openSpot) parts.push(`b=${state.openSpot.slug}`);
  else if (state.selected !== null) {
    parts.push(`p=${state.arrays.point_id[state.selected]}`);
  }
  history.replaceState(null, "", `#${parts.join("&")}`);
}

function readHash() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const metric = state.meta.metrics.find((m) => m.key === hash.get("m"));
  state.metric = metric || state.meta.metrics[0];
  for (const [key, field] of [["pw", "pathway"], ["hz", "horizon"], ["md", "model"]]) {
    if (hash.get(key)) state[field] = hash.get(key);
  }
  const centre = (hash.get("c") || "").split(",").map(Number);
  return {
    centre: centre.length === 2 && centre.every(Number.isFinite)
      ? [centre[1], centre[0]] : [-6.5, 46.5],
    zoom: Number(hash.get("z")) || 4.2,
    point: hash.get("p") ? Number(hash.get("p")) : null,
    beach: hash.get("b"),
    projections: hash.get("pd") === "projections",
  };
}

/* --------------------------------------------------------------- start up */

/* Run `ready` once the style can take layers. Listening for one "styledata"
 * is not enough: if the last of them has already fired by the time we ask,
 * nothing ever calls back and the map stays empty. So we listen, check at once,
 * and keep a slow poll as the backstop, all three disarmed by the first one
 * that wins. */
/* The backdrop is scenery, but it is good scenery and it is not thrown away
 * for being slow. MapLibre will not paint anything at all while a style is
 * unfinished, so a blocked tile CDN - a corporate proxy, an offline laptop -
 * leaves a blank page even though every number it draws is already here. The
 * fallback below exists for that, and only for that: it waits for evidence
 * that the basemap has actually failed, never merely that it is taking its
 * time. An earlier version timed out instead, and threw away a working
 * basemap that was two seconds from arriving.
 */
/* Two deadlines, because being slow and being broken look the same at first
 * and only one of them deserves to lose the basemap.
 *
 * At the first deadline the backdrop is only given up if something actually
 * errored. At the second it is given up regardless: a style that has not
 * arrived by then is not arriving, and a page that paints nothing is worse
 * than a page with a plain background.
 *
 * The test is isStyleLoaded(), never loaded(). loaded() stays false while
 * tiles are still coming in, which on a cold cache is a perfectly healthy map
 * a few seconds from finishing - and testing it is what made an earlier
 * version throw away good basemaps. */
const IF_BROKEN_MS = 12000;
const REGARDLESS_MS = 25000;

function watchBasemap() {
  let broken = false;
  map.on("error", (event) => {
    // our own coastline source is local and cannot fail this way
    if (!event || !event.sourceId || event.sourceId === "carto") broken = true;
  });

  const giveUp = (needProof) => {
    if (map.isStyleLoaded()) return;
    if (needProof && !broken) return;
    console.warn("basemap style did not arrive; drawing the coast on a plain one");
    map.setStyle(plainStyle());
    whenStyled(() => { addCoastLayers(); showCursor(); });
  };
  setTimeout(() => giveUp(true), IF_BROKEN_MS);
  setTimeout(() => giveUp(false), REGARDLESS_MS);
}

function plainStyle() {
  const dark = document.documentElement.dataset.theme === "dark";
  return {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background",
               paint: { "background-color": dark ? "#0b1620" : "#e8edf1" } }],
  };
}

function whenStyled(ready) {
  let done = false;
  const go = () => {
    if (done || !map.isStyleLoaded()) return;
    done = true;
    map.off("styledata", go);
    clearInterval(timer);
    ready();
  };
  const timer = setInterval(go, 200);
  map.on("styledata", go);
  go();
}

/* The map library comes from a CDN, and a CDN can be unreachable: a proxy, a
 * country, a bad morning. Everything else on this page is local, so when it is
 * missing the page says so and keeps what still works - the measures, the
 * legend, the numbers - rather than showing a blank rectangle and no reason. */
function withoutAMap() {
  document.getElementById("map").innerHTML =
    `<div class="no-map"><b>${t("noMapTitle")}</b><span>${t("noMapBody")}</span></div>`;
  writeCredit();
}

/* A mismatch is not something a reader can act on unless they are told, and
 * "reload harder" is exactly the action that fixes it. */
function mismatched(error) {
  document.getElementById("map").innerHTML =
    `<div class="no-map"><b>${t("mismatchTitle")}</b><span>${t("mismatchBody")}
      <br><br><code>${String(error.message || error)}</code></span></div>`;
}

async function start() {
  try {
    document.documentElement.dataset.theme =
      localStorage.getItem("isurf-theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }

  let chosen = "en";
  try {
    chosen = localStorage.getItem("isurf-lang") || "";
  } catch (error) { /* private window */ }
  const asked = new URLSearchParams(location.hash.slice(1)).get("l");
  chosen = asked || chosen || (navigator.language || "en").slice(0, 2);
  await loadStrings(chosen);
  applyStatic();

  try {
    await load();
  } catch (error) {
    mismatched(error);
    return;
  }
  const view = readHash();

  document.getElementById("about").textContent = state.metric.about;
  writeCredit();
  document.getElementById("spots-label").textContent =
    t("showSpots", { count: state.spots.length });

  // The panel does not wait for the basemap. Fetching a style from a CDN takes
  // a few seconds on a cold cache, and an empty menu for those seconds reads
  // as a broken page.
  buildMetricMenu();
  buildProjectionControls();
  if (view.projections && await loadChange()) setPeriod("projections");
  state.view = activeView();
  document.getElementById("about").textContent = state.view.about;
  drawLegend();
  attachChrome();

  if (typeof maplibregl === "undefined") { withoutAMap(); return; }

  map = new maplibregl.Map({
    container: "map",
    style: basemap(),
    center: view.centre,
    zoom: view.zoom,
    maxZoom: 15,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

  /* The coast is drawn as soon as the style is parsed, not on "load". "load"
   * waits for the basemap's tiles and sprites as well, and behind a proxy that
   * will not reach the tile CDN those never arrive - leaving a blank page even
   * though every number it draws is already in the browser. The basemap is the
   * backdrop; the data is the point, and the data does not wait for it. */
  watchBasemap();
  whenStyled(() => {
    addCoastLayers();
    addSpotMarkers();
    attachPointer();
    map.on("moveend", writeHash);

    const beach = view.beach && state.spots.find((s) => s.slug === view.beach);
    if (beach) {
      openSpot(beach);
    } else if (view.point !== null) {
      const index = state.arrays.point_id.indexOf(view.point);
      if (index >= 0) openPoint(index);
    }
  });
}

start();
