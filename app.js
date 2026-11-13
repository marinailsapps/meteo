/*
 * Planificateur météo / Weather planner
 * Static app: the browser calls Open-Meteo directly. Places, language, cache
 * and the optional API key are kept in this browser only.
 * MIT License, Copyright (c) 2026 les auteurs de Météo — publié par Maryna SYOMKO, entrepreneur individuel.
 */
"use strict";

(function () {
  const I18N = window.METEO_I18N;
  const DAYS = 16;
  const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // re-fetch automatically after 1 hour
  const TIMEOUT_MS = 15000;
  const HOSTS = {
    free: { forecast: "https://api.open-meteo.com", geocoding: "https://geocoding-api.open-meteo.com" },
    own: { forecast: "https://customer-api.open-meteo.com", geocoding: "https://customer-geocoding-api.open-meteo.com" },
  };
  const K = { places: "meteo.places", lang: "meteo.lang", key: "meteo.apiKey", cache: "meteo.forecast" };
  const DAILY = [
    "weather_code",
    "precipitation_sum",
    "precipitation_probability_max",
    "wind_speed_10m_max",
    "temperature_2m_min",
    "temperature_2m_max",
  ];

  // ---------- storage (never throws; falls back to memory) ----------
  const memory = {};
  function store(area) {
    try {
      const s = window[area];
      const probe = "meteo.probe";
      s.setItem(probe, "1");
      s.removeItem(probe);
      return s;
    } catch (e) {
      return null;
    }
  }
  const local = store("localStorage");
  const session = store("sessionStorage");
  function get(s, k) {
    try { return s ? s.getItem(k) : (k in memory ? memory[k] : null); } catch (e) { return null; }
  }
  function set(s, k, v) {
    try { if (s) s.setItem(k, v); else memory[k] = v; } catch (e) { memory[k] = v; }
  }
  function del(s, k) {
    try { if (s) s.removeItem(k); } catch (e) { /* ignore */ }
    delete memory[k];
  }
  function getJSON(k, fallback) {
    try { const v = get(local, k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }

  // ---------- state ----------
  const state = {
    lang: pickLang(),
    places: sanitizePlaces(getJSON(K.places, [])),
    cache: getJSON(K.cache, null), // { fetchedAt, mode, byId: { id: { timezone, daily } } }
    busy: false,
    seq: 0,
    fseq: 0,
    lastError: null,
    lastResults: [],
    lastQuery: "",
  };

  function pickLang() {
    const saved = get(local, K.lang);
    if (saved === "fr" || saved === "en") return saved;
    const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "fr"];
    for (const l of langs) {
      const p = String(l).toLowerCase().slice(0, 2);
      if (p === "fr" || p === "en") return p;
    }
    return "fr";
  }

  function sanitizePlaces(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((p) => p && p.id != null && isFinite(p.latitude) && isFinite(p.longitude) && p.name);
  }

  function savePlaces() { set(local, K.places, JSON.stringify(state.places)); }
  function saveCache() {
    if (state.cache) set(local, K.cache, JSON.stringify(state.cache));
    else del(local, K.cache);
  }

  function apiKey() { return get(session, K.key) || get(local, K.key) || ""; }
  function mode() { return apiKey() ? "own" : "free"; }

  // ---------- i18n helpers ----------
  function t(key, vars) {
    const dict = I18N[state.lang] || I18N.fr;
    let s = dict[key];
    if (s == null) s = I18N.fr[key] != null ? I18N.fr[key] : key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] != null ? vars[n] : m));
    return s;
  }
  const locale = () => (state.lang === "fr" ? "fr-FR" : "en-GB");
  function fmtNumber(n, digits) {
    return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
  }
  function fmtUnit(n, unit, digits) {
    try {
      return new Intl.NumberFormat(locale(), { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
    } catch (e) {
      return fmtNumber(n, digits) + " " + unit;
    }
  }
  function fmtPercent(n) {
    return new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(n / 100);
  }
  function fmtDateTime(ms) {
    return new Intl.DateTimeFormat(locale(), { dateStyle: "short", timeStyle: "short" }).format(new Date(ms));
  }
  function parseDay(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function applyStaticTexts() {
    document.documentElement.lang = state.lang;
    document.title = t("appTitle");
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel)); });
    const lt = $("#lang-toggle");
    lt.lang = state.lang === "fr" ? "en" : "fr";
    updateKeyIndicators();
  }

  // ---------- DOM helpers ----------
  function $(sel) { return document.querySelector(sel); }
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? "" : v);
      }
    }
    (children || []).forEach((c) => { if (c != null) n.append(c); });
    return n;
  }

  // ---------- network ----------
  class ApiError extends Error {
    constructor(kind, status) { super(kind); this.kind = kind; this.status = status; }
  }

  async function request(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    } catch (e) {
      throw new ApiError("network");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) throw new ApiError("rate", 429);
    if (!res.ok) {
      let reason = "";
      try { reason = String((await res.json()).reason || ""); } catch (e) { /* ignore */ }
      if ((res.status === 400 || res.status === 401 || res.status === 403) && /api ?key|apikey/i.test(reason)) {
        throw new ApiError("key", res.status);
      }
      if (res.status === 401 || res.status === 403) throw new ApiError("key", res.status);
      throw new ApiError("server", res.status);
    }
    try {
      return await res.json();
    } catch (e) {
      throw new ApiError("server", res.status);
    }
  }

  function buildUrl(kind, path, params, key) {
    const m = key ? "own" : "free";
    const u = new URL(path, HOSTS[m][kind]);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (key) u.searchParams.set("apikey", key);
    return u.toString();
  }

  function forecastUrl(places, key) {
    return buildUrl("forecast", "/v1/forecast", {
      latitude: places.map((p) => Number(p.latitude).toFixed(4)).join(","),
      longitude: places.map((p) => Number(p.longitude).toFixed(4)).join(","),
      daily: DAILY.join(","),
      forecast_days: DAYS,
      timezone: "auto",
      wind_speed_unit: "kmh",
      temperature_unit: "celsius",
      precipitation_unit: "mm",
    }, key);
  }

  function errorText(err) {
    switch (err && err.kind) {
      case "rate": return mode() === "own" ? t("errRateOwn") : t("errRateFree");
      case "key": return t("errKey");
      case "network": return t("errNetwork");
      default: return t("errServer", { status: (err && err.status) || "?" });
    }
  }

  // ---------- status banner ----------
  function showStatus(err) {
    const box = $("#status");
    box.replaceChildren();
    state.lastError = err || null;
    if (!err) { box.hidden = true; box.className = "status"; return; }
    box.className = "status status-error";
    const msg = [el("span", { text: errorText(err) })];
    if (state.cache && state.cache.fetchedAt && Object.keys(state.cache.byId || {}).length) {
      msg.push(" ", el("span", { text: t("errStale", { time: fmtDateTime(state.cache.fetchedAt) }) }));
    }
    const actions = el("span", { class: "status-actions" });
    if (err.kind === "key" || (err.kind === "rate" && mode() === "free")) {
      actions.append(el("button", { type: "button", class: "btn btn-small", text: t("manageKey"), onclick: openKeyDialog }));
    }
    if (err.kind !== "key") {
      actions.append(el("button", { type: "button", class: "btn btn-small", text: t("retry"), onclick: () => refresh(true) }));
    }
    actions.append(el("button", { type: "button", class: "btn btn-small btn-ghost", text: t("dismiss"), onclick: () => showStatus(null) }));
    box.append(el("p", null, msg), actions);
    box.hidden = false;
  }

  // ---------- search ----------
  async function search(q) {
    const out = $("#search-results");
    state.lastQuery = q;
    if (!q) { state.lastResults = []; out.replaceChildren(el("p", { class: "muted", text: t("searchEmpty") })); return; }
    out.replaceChildren(el("p", { class: "muted", text: t("searching") }));
    const seq = ++state.seq;
    try {
      const data = await request(buildUrl("geocoding", "/v1/search", { name: q, count: 8, language: state.lang, format: "json" }, apiKey()));
      if (seq !== state.seq) return;
      state.lastResults = (data.results || [])
        .filter((r) => r && r.id != null && isFinite(r.latitude) && isFinite(r.longitude))
        .map((r) => ({
          id: r.id,
          name: r.name,
          admin1: r.admin1 || "",
          country: r.country || "",
          country_code: r.country_code || "",
          latitude: r.latitude,
          longitude: r.longitude,
        }));
      renderResults();
    } catch (err) {
      if (seq !== state.seq) return;
      state.lastResults = [];
      out.replaceChildren(el("p", { class: "error-text", text: errorText(err) }));
    }
  }

  function renderResults() {
    const out = $("#search-results");
    if (!state.lastQuery) { out.replaceChildren(); return; }
    if (!state.lastResults.length) {
      out.replaceChildren(el("p", { class: "muted", text: t("searchNoResult", { q: state.lastQuery }) }));
      return;
    }
    const ids = new Set(state.places.map((p) => String(p.id)));
    const list = el("ul", { class: "result-list" });
    for (const r of state.lastResults) {
      const already = ids.has(String(r.id));
      const sub = [r.admin1, r.country].filter(Boolean).join(", ");
      list.append(el("li", { class: "result" }, [
        el("div", { class: "result-text" }, [
          el("span", { class: "result-name", text: r.name }),
          el("span", { class: "result-sub", text: `${sub}${sub ? " · " : ""}${fmtNumber(r.latitude, 2)}, ${fmtNumber(r.longitude, 2)}` }),
        ]),
        el("button", {
          type: "button",
          class: "btn " + (already ? "btn-ghost" : "btn-primary"),
          disabled: already,
          text: already ? t("added") : t("add"),
          onclick: () => addPlace(r),
        }),
      ]));
    }
    out.replaceChildren(list);
  }

  // ---------- places ----------
  function placeLabel(p) { return p.name; }
  function placeSub(p) { return [p.admin1, p.country_code || p.country].filter(Boolean).join(", "); }

  function addPlace(p) {
    if (state.places.some((x) => String(x.id) === String(p.id))) return;
    state.places.push(p);
    savePlaces();
    renderPlaces();
    renderResults();
    render();
    refresh(true);
  }

  function removePlace(id) {
    state.places = state.places.filter((p) => String(p.id) !== String(id));
    savePlaces();
    if (state.cache && state.cache.byId) {
      delete state.cache.byId[id];
      saveCache();
    }
    renderPlaces();
    renderResults();
    render();
  }

  function renderPlaces() {
    const ul = $("#places");
    ul.replaceChildren(...state.places.map((p) => el("li", { class: "chip" }, [
      el("span", { class: "chip-name", text: placeLabel(p) }),
      el("span", { class: "chip-sub", text: placeSub(p) }),
      el("button", {
        type: "button",
        class: "chip-remove",
        "aria-label": t("remove", { name: placeLabel(p) }),
        title: t("remove", { name: placeLabel(p) }),
        text: "✕",
        onclick: () => removePlace(p.id),
      }),
    ])));
    $("#places-empty").hidden = state.places.length > 0;
  }

  // ---------- forecast ----------
  function cacheCovers() {
    const c = state.cache;
    if (!c || !c.byId || c.mode !== mode()) return false;
    return state.places.every((p) => c.byId[p.id]);
  }

  async function refresh(force) {
    if (!state.places.length) { render(); return; }
    if (!force && cacheCovers() && Date.now() - state.cache.fetchedAt < CACHE_MAX_AGE_MS) { render(); return; }
    const places = state.places.slice();
    const btn = $("#refresh");
    const seq = ++state.fseq;
    state.busy = true;
    btn.disabled = true;
    btn.textContent = t("refreshing");
    try {
      const data = await request(forecastUrl(places, apiKey()));
      if (seq !== state.fseq) return;
      const arr = Array.isArray(data) ? data : [data];
      const byId = {};
      places.forEach((p, i) => {
        const d = arr[i];
        if (d && d.daily && Array.isArray(d.daily.time)) byId[p.id] = { timezone: d.timezone || "", daily: d.daily };
      });
      state.cache = { fetchedAt: Date.now(), mode: mode(), byId };
      saveCache();
      showStatus(null);
    } catch (err) {
      if (seq !== state.fseq) return;
      showStatus(err);
    } finally {
      if (seq === state.fseq) {
        state.busy = false;
        btn.disabled = false;
        btn.textContent = t("refresh");
      }
      render();
    }
  }

  function wmo(code) {
    if (code == null) return ["·", "unknown"];
    if (code === 0) return ["☀️", "clear"];
    if (code === 1) return ["🌤️", "mainlyClear"];
    if (code === 2) return ["⛅", "partly"];
    if (code === 3) return ["☁️", "overcast"];
    if (code === 45 || code === 48) return ["🌫️", "fog"];
    if (code >= 51 && code <= 55) return ["🌦️", "drizzle"];
    if (code === 56 || code === 57 || code === 66 || code === 67) return ["🧊", "freezing"];
    if (code >= 61 && code <= 65) return ["🌧️", "rain"];
    if (code >= 71 && code <= 77) return ["❄️", "snow"];
    if (code >= 80 && code <= 82) return ["🌦️", "showers"];
    if (code === 85 || code === 86) return ["🌨️", "snowShowers"];
    if (code >= 95 && code <= 99) return ["⛈️", "storm"];
    return ["·", "unknown"];
  }

  function dayCell(d) {
    if (!d) return el("td", { class: "cell empty" }, [el("span", { class: "muted", text: t("noData") })]);
    const cues = [];
    const classes = ["cell"];
    if (d.tmin != null && d.tmin <= 0) { classes.push("cold"); cues.push(t("cueCold")); }
    if (d.tmax != null && d.tmax >= 28) { classes.push("hot"); cues.push(t("cueHot")); }
    if (d.psum != null && d.psum >= 10) { classes.push("wet"); cues.push(t("cueWet")); }
    else if (d.psum != null && d.psum === 0) { classes.push("dry"); cues.push(t("cueDry")); }

    const [icon, desc] = wmo(d.code);
    const descText = (I18N[state.lang].wmo || {})[desc] || desc;

    let rain;
    if (d.psum == null && d.pprob == null) rain = t("noData");
    else if ((d.psum || 0) <= 0 && (d.pprob == null || d.pprob < 20)) rain = t("noRain");
    else {
      const parts = [];
      if (d.pprob != null) parts.push(fmtPercent(d.pprob));
      if (d.psum != null) parts.push(fmtUnit(d.psum, "millimeter", 1));
      rain = parts.join(" · ");
    }
    const wind = d.wind == null ? t("noData") : fmtUnit(Math.round(d.wind), "kilometer-per-hour", 0);
    const tmin = d.tmin == null ? t("noData") : `${fmtNumber(Math.round(d.tmin) || 0, 0)}°`;
    const tmax = d.tmax == null ? t("noData") : `${fmtNumber(Math.round(d.tmax) || 0, 0)}°`;

    return el("td", { class: classes.join(" "), title: [descText].concat(cues).join(" · ") }, [
      el("div", { class: "cell-top" }, [
        el("span", { class: "wx", role: "img", "aria-label": descText, text: icon }),
        el("span", { class: "temps", "aria-label": `${t("tempLabel")} : ${tmin} / ${tmax}` }, [
          el("span", { class: "tmin", text: "↓" + tmin }),
          " ",
          el("span", { class: "tmax", text: "↑" + tmax }),
        ]),
      ]),
      el("div", { class: "rain" }, [el("span", { class: "sr-only", text: t("rainLabel") + " : " }), el("span", { "aria-hidden": "true", class: "ico", text: "💧" }), " " + rain]),
      el("div", { class: "wind" }, [el("span", { class: "sr-only", text: t("windLabel") + " : " }), el("span", { "aria-hidden": "true", class: "ico", text: "💨" }), " " + wind]),
      cues.length ? el("span", { class: "sr-only", text: cues.join(", ") }) : null,
    ]);
  }

  function render() {
    const thead = $("#forecast thead");
    const tbody = $("#forecast tbody");
    const updated = $("#updated");
    const has = state.cache && state.cache.byId && state.places.some((p) => state.cache.byId[p.id]);

    $("#refresh").hidden = state.places.length === 0;
    updated.textContent = state.places.length === 0 ? "" : has ? t("lastUpdate", { time: fmtDateTime(state.cache.fetchedAt) }) : t("neverUpdated");

    if (!state.places.length || !has) {
      thead.replaceChildren();
      tbody.replaceChildren();
      $("#forecast").hidden = true;
      return;
    }
    $("#forecast").hidden = false;

    // Per place: map date -> values. Dates are local to each place (timezone=auto).
    const perPlace = state.places.map((p) => {
      const c = state.cache.byId[p.id];
      const map = new Map();
      if (c) {
        const dl = c.daily;
        dl.time.forEach((date, i) => {
          map.set(date, {
            code: pick(dl.weather_code, i),
            psum: pick(dl.precipitation_sum, i),
            pprob: pick(dl.precipitation_probability_max, i),
            wind: pick(dl.wind_speed_10m_max, i),
            tmin: pick(dl.temperature_2m_min, i),
            tmax: pick(dl.temperature_2m_max, i),
          });
        });
      }
      return map;
    });
    const dates = Array.from(new Set(perPlace.flatMap((m) => Array.from(m.keys())))).sort().slice(0, DAYS + 1);

    const headRow = el("tr", null, [el("th", { scope: "col", class: "day-col", text: t("dayColumn") })]);
    state.places.forEach((p) => {
      headRow.append(el("th", { scope: "col", class: "place-col" }, [
        el("span", { class: "place-name", text: placeLabel(p) }),
        el("span", { class: "place-sub", text: placeSub(p) }),
      ]));
    });
    thead.replaceChildren(headRow);

    const fmtWeekday = new Intl.DateTimeFormat(locale(), { weekday: "short" });
    const fmtDay = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short" });
    const fmtFull = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long" });
    const rows = dates.map((date) => {
      const dt = parseDay(date);
      const weekend = dt.getDay() === 0 || dt.getDay() === 6;
      const tr = el("tr", { class: weekend ? "weekend" : null }, [
        el("th", { scope: "row", class: "day-col", title: fmtFull.format(dt) }, [
          el("span", { class: "wd", text: fmtWeekday.format(dt) }),
          el("span", { class: "dm", text: fmtDay.format(dt) }),
          weekend ? el("span", { class: "sr-only", text: " (" + t("weekend") + ")" }) : null,
        ]),
      ]);
      perPlace.forEach((m) => tr.append(dayCell(m.get(date))));
      return tr;
    });
    tbody.replaceChildren(...rows);
  }

  function pick(arr, i) {
    const v = Array.isArray(arr) ? arr[i] : null;
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  // ---------- API key dialog ----------
  function updateKeyIndicators() {
    const own = mode() === "own";
    $("#key-open-label").textContent = own ? t("keyButtonOwn") : t("keyButtonFree");
    $("#key-open").classList.toggle("is-own", own);
    $("#service-line").textContent = own ? t("serviceOwn") : t("serviceFree");
    $("#key-current").textContent = own ? t("keyStatusOwn") : t("keyStatusFree");
    const toggle = $("#key-toggle");
    toggle.textContent = $("#key-input").type === "password" ? t("keyShow") : t("keyHide");
  }

  function setKeyResult(text, kind) {
    const r = $("#key-result");
    r.textContent = text || "";
    r.className = "key-result" + (kind ? " " + kind : "");
  }

  function openKeyDialog() {
    const dlg = $("#key-dialog");
    const input = $("#key-input");
    input.value = apiKey();
    input.type = "password";
    $("#key-toggle").setAttribute("aria-pressed", "false");
    $("#key-session").checked = !!get(session, K.key) && !get(local, K.key);
    setKeyResult("");
    updateKeyIndicators();
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    input.focus();
  }

  function closeKeyDialog() {
    const dlg = $("#key-dialog");
    $("#key-input").value = "";
    if (typeof dlg.close === "function") dlg.close();
    else dlg.removeAttribute("open");
  }

  async function testKey() {
    const key = $("#key-input").value.trim();
    if (!key) { setKeyResult(t("keyEmpty"), "bad"); return; }
    setKeyResult(t("keyTesting"));
    try {
      await request(forecastUrl([{ latitude: 48.8566, longitude: 2.3522 }], key).replace("forecast_days=16", "forecast_days=1"));
      setKeyResult(t("keyValid"), "good");
    } catch (err) {
      if (err.kind === "rate") setKeyResult(t("errRateOwn"), "bad");
      else if (err.kind === "key") setKeyResult(t("keyRefused"), "bad");
      else setKeyResult(errorText(err), "bad");
    }
  }

  function saveKey() {
    const key = $("#key-input").value.trim();
    if (!key) { setKeyResult(t("keyEmpty"), "bad"); return; }
    const sessionOnly = $("#key-session").checked;
    del(local, K.key);
    del(session, K.key);
    set(sessionOnly ? session : local, K.key, key);
    setKeyResult(sessionOnly ? t("keySavedSession") : t("keySaved"), "good");
    updateKeyIndicators();
    showStatus(null);
    refresh(true);
  }

  function clearKey() {
    del(local, K.key);
    del(session, K.key);
    $("#key-input").value = "";
    setKeyResult(t("keyCleared"), "good");
    updateKeyIndicators();
    showStatus(null);
    refresh(true);
  }

  // ---------- wiring ----------
  function init() {
    applyStaticTexts();
    renderPlaces();
    render();

    $("#search-form").addEventListener("submit", (e) => {
      e.preventDefault();
      search($("#search-input").value.trim());
    });
    $("#refresh").addEventListener("click", () => refresh(true));
    $("#lang-toggle").addEventListener("click", () => {
      state.lang = state.lang === "fr" ? "en" : "fr";
      set(local, K.lang, state.lang);
      applyStaticTexts();
      renderPlaces();
      renderResults();
      render();
      showStatus(state.lastError);
    });
    $("#key-open").addEventListener("click", openKeyDialog);
    $("#key-close").addEventListener("click", closeKeyDialog);
    $("#key-dialog").addEventListener("close", () => { $("#key-input").value = ""; });
    $("#key-form").addEventListener("submit", (e) => { e.preventDefault(); saveKey(); });
    $("#key-toggle").addEventListener("click", () => {
      const input = $("#key-input");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      $("#key-toggle").setAttribute("aria-pressed", String(show));
      updateKeyIndicators();
    });
    $("#key-test").addEventListener("click", testKey);
    $("#key-save").addEventListener("click", saveKey);
    $("#key-clear").addEventListener("click", clearKey);

    // Keep tabs in step when places or the key change in another tab.
    window.addEventListener("storage", (e) => {
      if (e.key === K.places) { state.places = sanitizePlaces(getJSON(K.places, [])); renderPlaces(); renderResults(); refresh(false); }
      if (e.key === K.key) { updateKeyIndicators(); refresh(true); }
    });

    refresh(false);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
