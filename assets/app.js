"use strict";
(() => {
  const DATA_URL = "data/site.json";
  const DIGITS = { gold: 2, silver: 3 };
  const CONTRACT = { gold: 100, silver: 5000 };        // ounces per standard lot (XAUUSD / XAGUSD)
  const FEED = { XAUUSDT: "gold", XAGUSDT: "silver" };
  const TZ = "Asia/Dhaka";
  const LAYERS = ["structure", "liquidity", "zones", "cone", "plan"];
  const TF = { "4h": { hours: 4, shown: [60, 30], timeStop: 24 }, "1h": { hours: 1, shown: [96, 48], timeStop: 8 } };

  const state = {
    data: null, metal: "gold", tf: "4h", lang: "bn", live: { gold: null, silver: null }, wsFailures: 0, polling: null, chart: null,
    layers: Object.fromEntries(LAYERS.map((k) => [k, true])),
    plan: { side: 1, budget: 1000, risk: 0.01, mode: "now", lev: 100 },
    planResult: null, planLines: [], lastPlanAt: 0,
  };
  const $ = (id) => document.getElementById(id);

  function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { console.warn("storage unavailable", err); } }
  function restore(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (err) { return null; } }

  // ---------------------------------------------------------------- language
  // T(bangla, english): every visible string is written in both languages where it is used.
  const T = (bnText, enText) => state.lang === "en" ? enText : bnText;
  const DIG = "০১২৩৪৫৬৭৮৯";
  const digits = (s) => state.lang === "en" ? String(s) : String(s).replace(/[0-9]/g, (d) => DIG[d]);
  const NAME = () => ({ gold: T("সোনা", "Gold"), silver: T("রুপা", "Silver") });
  const tfName = (tf) => tf === "4h" ? T("৪ ঘণ্টার", "4-hour") : T("১ ঘণ্টার", "1-hour");
  let F = {};
  function makeFormatters() {
    const loc = state.lang === "en" ? "en-US" : "bn-BD";
    F = {
      loc,
      int: new Intl.NumberFormat(loc),
      pct1: new Intl.NumberFormat(loc, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      pct0: new Intl.NumberFormat(loc, { style: "percent", maximumFractionDigits: 0 }),
      time: new Intl.DateTimeFormat(loc, { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }),
      dateTime: new Intl.DateTimeFormat(loc, { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }),
      utc: new Intl.DateTimeFormat(loc, { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false }),
      usd: new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      lot: new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      r: new Intl.NumberFormat(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      dec: {},
    };
  }

  function money(value, metal, signed = false) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    const d = DIGITS[metal];
    F.dec[d] = F.dec[d] || new Intl.NumberFormat(F.loc, { minimumFractionDigits: d, maximumFractionDigits: d });
    const text = F.dec[d].format(Math.abs(value));
    if (signed) return (value >= 0 ? "+" : "−") + "$" + text;
    return "$" + text;
  }
  const usd = (v) => (v === null || v === undefined || !isFinite(v)) ? "—" : "$" + F.usd.format(v);
  const pct = (v, dp = 1) => (v === null || v === undefined || !isFinite(v)) ? "—" : (dp ? F.pct1 : F.pct0).format(v);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const when = (ms) => F.dateTime.format(new Date(ms));

  function relative(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return T("এখনই", "now");
    if (mins < 60) return T(`${F.int.format(mins)} মিনিট`, `${mins} min`);
    const hours = Math.floor(mins / 60), rest = mins % 60;
    if (hours < 48) return T(`${F.int.format(hours)} ঘণ্টা${rest ? " " + F.int.format(rest) + " মিনিট" : ""}`, `${hours} h${rest ? ` ${rest} min` : ""}`);
    return T(`${F.int.format(Math.floor(hours / 24))} দিন ${F.int.format(hours % 24)} ঘণ্টা`, `${Math.floor(hours / 24)} d ${hours % 24} h`);
  }
  const inTime = (ms) => T(`${relative(ms)} পরে`, `in ${relative(ms)}`);

  // Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7).
  function phi(x) {
    const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
  }

  // Static page text: the Bangla markup is the original; English comes from assets/i18n.js.
  function applyStatic() {
    const en = state.lang === "en", dict = window.I18N_EN || {};
    for (const el of document.querySelectorAll("[data-i18n]")) {
      if (el.dataset.bnHtml === undefined) el.dataset.bnHtml = el.innerHTML;
      const key = el.dataset.i18n;
      el.innerHTML = en && dict[key] !== undefined ? dict[key] : el.dataset.bnHtml;
    }
    for (const el of document.querySelectorAll("[data-i18n-aria]")) {
      if (el.dataset.bnAria === undefined) el.dataset.bnAria = el.getAttribute("aria-label") || "";
      const key = el.dataset.i18nAria;
      el.setAttribute("aria-label", en && dict[key] !== undefined ? dict[key] : el.dataset.bnAria);
    }
    document.documentElement.lang = state.lang;
    document.title = T("সোনা-রুপা পূর্বাভাস", dict.title || "Gold-Silver Forecast");
    const btn = $("lang-toggle");
    btn.textContent = en ? "বাংলা" : "English";
    btn.lang = en ? "bn" : "en";
    btn.setAttribute("aria-label", en ? "বাংলায় দেখুন" : "View in English");
    syncThemeButton();
  }

  // ---------------------------------------------------------------- day / night
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  function effectiveTheme() {
    const t = document.documentElement.getAttribute("data-theme");
    return t === "dark" || t === "light" ? t : (systemDark.matches ? "dark" : "light");
  }
  function syncThemeButton() {
    const dark = effectiveTheme() === "dark", btn = $("theme-toggle");
    btn.dataset.mode = dark ? "dark" : "light";
    btn.setAttribute("aria-label", dark ? T("দিনের রঙে দেখুন", "Switch to day colours") : T("রাতের রঙে দেখুন", "Switch to night colours"));
    btn.title = btn.getAttribute("aria-label");
  }
  function bindTheme() {
    $("theme-toggle").addEventListener("click", () => {
      const next = effectiveTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      store("srp-theme", next);
      syncThemeButton();
      buildChart();
    });
    systemDark.addEventListener("change", () => { syncThemeButton(); buildChart(); });
  }

  function bindLanguage() {
    const saved = restore("srp-lang");
    state.lang = saved === "en" ? "en" : "bn";
    makeFormatters();
    applyStatic();
    $("lang-toggle").addEventListener("click", () => {
      state.lang = state.lang === "en" ? "bn" : "en";
      store("srp-lang", state.lang);
      makeFormatters();
      applyStatic();
      syncTimeframeText();
      tickClock();
      if (state.data) renderAll();
    });
  }

  // ---------------------------------------------------------------- data
  async function loadData() {
    try {
      const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const changed = !state.data || state.data.generated_utc !== data.generated_utc;
      state.data = data;
      if (changed) renderAll();
    } catch (err) {
      $("verdict").textContent = T("ডেটা লোড করা যায়নি। কিছুক্ষণ পরে পাতাটি আবার খুলুন।", "Could not load the data. Please reopen the page in a little while.");
      console.error("site data", err);
    }
  }

  function metalData() { return state.data && state.data.metals[state.metal]; }
  // Layers (structure, zones, swing liquidity) of the timeframe on screen.
  function L(m) { return m.read.tf[state.tf]; }
  function reality(m) { return (m.reality && m.reality[state.tf]) || {}; }
  function currentPrice() {
    const m = metalData();
    const tick = state.live[state.metal];
    return tick ? tick.price : m.bars[m.bars.length - 1].close;
  }
  const trendWord = (t) => state.lang === "en" ? t.en : t.bn;
  const eventName = (e) => state.lang === "en" && e.name_en ? e.name_en : e.name;

  function forecastFresh(f) {
    if (!f) return false;
    const end = new Date(f.decision_time).getTime() + 4 * 3600e3;
    return Date.now() < end + 45 * 60e3;
  }

  // ---------------------------------------------------------------- chart reading helpers
  const poolName = (p) => {
    const key = p.kind === "swing" || p.kind === "equal" ? `${p.kind}:${p.side}` : p.kind;
    return {
      "swing:above": T("আগের চূড়া", "previous high"), "swing:below": T("আগের তল", "previous low"),
      "equal:above": T("সমান চূড়া", "equal highs"), "equal:below": T("সমান তল", "equal lows"),
      pdh: T("গতকালের উচ্চ", "yesterday's high"), pdl: T("গতকালের নিম্ন", "yesterday's low"),
      pwh: T("গত সপ্তাহের উচ্চ", "last week's high"), pwl: T("গত সপ্তাহের নিম্ন", "last week's low"),
    }[key];
  };
  const POOL_RANK = { equal: 3, pdh: 2, pdl: 2, pwh: 2, pwl: 2, swing: 1 };
  const joinNames = (names) => names.join(T(" ও ", " and "));

  // Merge levels closer than 5% of an ATR (e.g. yesterday's low that is also last week's low).
  function pools(m, includeSwept = false) {
    const lay = L(m), tol = 0.05 * lay.atr;
    const list = [...lay.pools, ...m.read.levels].filter((p) => includeSwept || !p.swept).map((p) => ({ ...p, names: [poolName(p)] })).sort((a, b) => a.price - b.price);
    const out = [];
    for (const p of list) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.price - p.price) <= tol && prev.side === p.side) {
        if (!prev.names.includes(p.names[0])) prev.names.push(p.names[0]);
        if (POOL_RANK[p.kind] > POOL_RANK[prev.kind]) { prev.kind = p.kind; prev.price = p.price; }
        prev.swept = prev.swept && p.swept;
      } else out.push(p);
    }
    return out;
  }

  function nearestPools(m, price, n = 3) {
    const all = pools(m);
    return {
      above: all.filter((p) => p.price > price).sort((a, b) => a.price - b.price).slice(0, n),
      below: all.filter((p) => p.price < price).sort((a, b) => b.price - a.price).slice(0, n),
    };
  }

  function nearestZones(m, price, n = 2) {
    const zs = L(m).zones;
    return {
      above: zs.filter((z) => z.bottom > price).sort((a, b) => a.bottom - b.bottom).slice(0, n),
      below: zs.filter((z) => z.top < price).sort((a, b) => b.top - a.top).slice(0, n),
      inside: zs.filter((z) => z.bottom <= price && z.top >= price),
    };
  }

  const zoneName = (z) => z.kind === "fvg" ? T("ফাঁকা জায়গা", "the gap")
    : z.direction > 0 ? T("আগের বড় কেনার জায়গা", "the old big-buying zone") : T("আগের বড় বিক্রির জায়গা", "the old big-selling zone");

  // History pill: 2003-2023 base rate of the pattern next to its control.
  function hist(key, mode = "race") {
    const m = metalData();
    const r = reality(m)[key];
    if (!r || r.rate === null || r.rate === undefined) return "";
    const title = T(`২০০৩–২০২৩, ${F.int.format(r.n)}টি ঘটনা`, `2003–2023, ${F.int.format(r.n)} cases`);
    if (mode === "race") {
      // Highlight only when both the 2003-2018 and the 2019-2023 halves sit at least 3 points from a coin flip, same side.
      const edge = Math.min(Math.abs(r.dev - 0.5), Math.abs(r.val - 0.5)) >= 0.03 && Math.sign(r.dev - 0.5) === Math.sign(r.val - 0.5);
      return `<span class="hist${edge ? " edge" : ""}" title="${title}">${T(`অতীতে মিলেছে ${pct(r.rate, 0)} · টসে ৫০%`, `Worked ${pct(r.rate, 0)} in the past · coin flip 50%`)}</span>`;
    }
    const c = reality(m)[`${key}_control`];
    return `<span class="hist" title="${title}">${T(`অতীতে ছুঁয়েছে ${pct(r.rate, 0)} · অন্য দিকে ${pct(c.rate, 0)}`, `Touched ${pct(r.rate, 0)} in the past · other side ${pct(c.rate, 0)}`)}</span>`;
  }

  // ---------------------------------------------------------------- chart
  function buildChart() {
    const m = metalData();
    const el = $("chart");
    let range = null;
    if (state.chart) {
      if (state.chartKey === `${state.metal}:${state.tf}`) range = state.chart.timeScale().getVisibleLogicalRange();
      state.chart.remove(); state.chart = null;
    }
    if (!m || typeof LightweightCharts === "undefined") return;
    const surface = css("--surface"), muted = css("--muted"), soft = css("--soft"), line = css("--line");
    const chart = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { type: "solid", color: surface }, textColor: muted, fontFamily: css("--font") || "sans-serif" },
      grid: { vertLines: { color: soft }, horzLines: { color: soft } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false, rightOffset: 3, barSpacing: 9 },
      crosshair: { mode: 0 },
      localization: {
        locale: F.loc,
        timeFormatter: (t) => when(t * 1000),
        priceFormatter: (p) => money(p, state.metal).replace("$", ""),
      },
    });
    const candles = chart.addCandlestickSeries({
      upColor: css("--up"), downColor: css("--down"), borderVisible: false,
      wickUpColor: css("--up"), wickDownColor: css("--down"), priceLineVisible: false,
      // Keep the planned stop and targets inside the visible price range.
      autoscaleInfoProvider: (original) => {
        const res = original();
        const p = state.layers.plan && state.planResult && state.planResult.ok ? state.planResult : null;
        if (!res || !p) return res;
        const levels = [p.sl, p.tp1.price, p.tp2 ? p.tp2.price : p.tp1.price];
        return { priceRange: { minValue: Math.min(res.priceRange.minValue, ...levels), maxValue: Math.max(res.priceRange.maxValue, ...levels) }, margins: res.margins };
      },
    });
    const bars = chartBars(m);
    candles.setData(bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
    state.chart = chart;
    state.chartKey = `${state.metal}:${state.tf}`;
    state.candles = candles;
    state.planLines = [];
    state.formingBar = bars.length && !bars[bars.length - 1].complete ? { ...bars[bars.length - 1] } : null;
    state.lastBarTime = bars.length ? bars[bars.length - 1].time : 0;

    if (state.layers.structure && m.read) {
      // Only the most recent swings are labelled: older ones add clutter without changing the read.
      const recent = L(m).swings.slice(-(state.tf === "1h" ? 14 : 20));
      const markers = recent.map((s) => {
        const higher = s.label === "HH" || s.label === "HL";
        return { time: s.time, position: s.kind === "high" ? "aboveBar" : "belowBar", shape: "circle", size: 0.4,
                 color: higher ? css("--up") : css("--down"), text: state.lang === "en" ? s.label : (higher ? "উঁচু" : "নিচু") };
      }).sort((a, b) => a.time - b.time);
      candles.setMarkers(markers);
    }

    const f = m.forecast;
    if (state.layers.cone && f && forecastFresh(f)) {
      const t0 = Math.floor(new Date(f.decision_time).getTime() / 1000);
      const rgb = css("--gold-rgb");
      const steps = [0, 1, 2, 3, 4];
      const edge = (key) => steps.map((k) => ({ time: t0 + k * 3600, value: f.price * Math.exp(f.quantiles_return[key] * Math.sqrt(k / 4)) }));
      // Area fills reach the bottom of the pane, so draw widest-top first and repaint below each lower edge.
      const layers = [["q975", 0.14], ["q900", 0.28], ["q750", 0.46], ["q250", 0.28], ["q100", 0.14], ["q025", null]];
      for (const [key, alpha] of layers) {
        const fill = alpha === null ? surface : `rgba(${rgb}, ${alpha})`;
        const s = chart.addAreaSeries({
          topColor: fill, bottomColor: fill, lineColor: `rgba(${rgb}, 0.75)`, lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        s.setData(edge(key));
      }
    }
    const shown = TF[state.tf].shown[window.matchMedia("(max-width: 640px)").matches ? 1 : 0];
    const n = bars.length;
    // Keep the reader's scroll position across rebuilds (theme, language, layers), unless it is implausibly wide.
    const keep = range && range.to - range.from > 5 && range.to - range.from <= 2 * shown;
    chart.timeScale().setVisibleLogicalRange(keep ? range : { from: Math.max(0, n - shown), to: n + 5 });
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestDraw());
    applyLiveToChart();
    updatePlanLines();
    requestDraw();
  }

  function chartBars(m) { return state.tf === "4h" ? m.bars : L(m).bars; }

  function applyLiveToChart() {
    const tick = state.live[state.metal];
    const m = metalData();
    if (!tick || !state.candles || !m) return;
    const now = Date.now() / 1000;
    if (state.tf === "1h") {
      // Hourly files are published after each hour: build the current hour from live ticks while the market is
      // open (Dukascopy data fresher than 3 hours; the exchange feed also trades at weekends, which is not spot).
      const hourStart = Math.floor(now / 3600) * 3600;
      const fresh = Date.now() - new Date(m.data_until).getTime() < 3 * 3600e3;
      if (fresh && hourStart > state.lastBarTime && (!state.formingBar || state.formingBar.time !== hourStart)) {
        state.formingBar = { time: hourStart, open: tick.price, high: tick.price, low: tick.price, close: tick.price };
        state.lastBarTime = hourStart;
      }
    }
    const bar = state.formingBar;
    if (!bar) return;
    if (now >= bar.time + TF[state.tf].hours * 3600) return;   // the forming bar has ended; wait for the next data refresh
    bar.high = Math.max(bar.high, tick.price);
    bar.low = Math.min(bar.low, tick.price);
    bar.close = tick.price;
    state.candles.update({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
  }

  function updatePlanLines() {
    if (!state.candles) return;
    for (const l of state.planLines) state.candles.removePriceLine(l);
    state.planLines = [];
    const p = state.planResult;
    if (!state.layers.plan || !p || !p.ok) return;
    const add = (price, color, title, style = 0) => state.planLines.push(state.candles.createPriceLine({
      price, color, lineWidth: 2, lineStyle: style, axisLabelVisible: true, title,
    }));
    add(p.entry, css("--ink"), T("ঢোকা", "Entry"), 2);
    add(p.sl, css("--down"), T("স্টপ লস", "Stop-loss"));
    add(p.tp1.price, css("--up"), T("লাভ ১", "Profit 1"));
    if (p.tp2) add(p.tp2.price, css("--up"), T("লাভ ২", "Profit 2"));
  }

  // ---------------------------------------------------------------- overlay (zones, liquidity, breaks, plan boxes)
  let drawPending = false;
  function requestDraw() {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => { drawPending = false; drawOverlay(); });
  }

  function drawOverlay() {
    const canvas = $("overlay");
    const m = metalData();
    const ctx = canvas.getContext("2d");
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!state.chart || !m || !m.read) return;
    const ts = state.chart.timeScale(), series = state.candles;
    const plotW = w - state.chart.priceScale("right").width();
    const plotH = h - ts.height();
    const X = (t) => ts.timeToCoordinate(t);
    const Y = (p) => series.priceToCoordinate(p);
    const font = css("--font") || "sans-serif";
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, plotW, plotH); ctx.clip();
    const surface = css("--surface");
    // Labels sit on a small surface-coloured plate so they stay readable over candles and lines.
    const placed = [];
    const label = (text, x, y, color, align = "left") => {
      // Skip a label that would overlap one already drawn on the same side (the line itself still shows).
      if (placed.some((q) => Math.abs(q.y - y) < 14 && q.align === align)) return;
      placed.push({ y, align });
      ctx.font = `600 11.5px ${font}`; ctx.textAlign = align;
      const tw = ctx.measureText(text).width, left = align === "right" ? x - tw : align === "center" ? x - tw / 2 : x;
      ctx.globalAlpha = 0.85; ctx.fillStyle = surface; ctx.fillRect(left - 3, y - 11, tw + 6, 15); ctx.globalAlpha = 1;
      ctx.fillStyle = color; ctx.fillText(text, x, y);
    };
    const price = currentPrice();

    if (state.layers.zones) {
      const z = nearestZones(m, price, 2);
      for (const zone of [...z.above, ...z.below, ...z.inside]) {
        const x1 = X(zone.time) ?? 0, y1 = Y(zone.top), y2 = Y(zone.bottom);
        if (y1 === null || y2 === null) continue;
        const rgb = zone.kind === "fvg" ? css("--fvg-rgb") : zone.direction > 0 ? css("--up-rgb") : css("--down-rgb");
        ctx.fillStyle = `rgba(${rgb}, ${zone.kind === "fvg" ? 0.16 : 0.14})`;
        ctx.fillRect(x1, Math.min(y1, y2), plotW - x1, Math.max(2, Math.abs(y2 - y1)));
        const name = zone.kind === "fvg" ? T("ফাঁক", "Gap") : zone.direction > 0 ? T("কেনার জায়গা", "Buy zone") : T("বেচার জায়গা", "Sell zone");
        label(name, x1 + 4, Math.min(y1, y2) + 12, `rgba(${rgb}, 1)`);
      }
      const r = L(m).range;
      if (r) {
        const y = Y(r.mid);
        if (y !== null) {
          ctx.strokeStyle = `rgba(${css("--ink-rgb")}, 0.35)`; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.setLineDash([]);
          label(T("মাঝখান · ওপরে দামি, নিচে সস্তা", "Middle · above expensive, below cheap"), 6, y - 4, `rgba(${css("--ink-rgb")}, 0.55)`);
        }
      }
    }

    if (state.layers.liquidity) {
      const rgb = css("--liq-rgb");
      const near = nearestPools(m, price, 2);
      for (const p of [...near.above, ...near.below]) {
        const y = Y(p.price);
        if (y === null) continue;
        const x1 = p.time ? (X(p.time) ?? 0) : 0;
        ctx.strokeStyle = `rgba(${rgb}, 0.9)`; ctx.lineWidth = p.kind === "equal" ? 2 : 1.2; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.setLineDash([]);
        label(`${p.names[0]}${p.names.length > 1 ? " +" + digits(p.names.length - 1) : ""} · ${T("স্টপ", "stops")}`, plotW - 6, p.side === "above" ? y - 4 : y + 13, `rgba(${rgb}, 1)`, "right");
      }
      for (const p of pools(m, true).filter((q) => q.swept).slice(0, 1)) {
        const y = Y(p.price);
        if (y === null) continue;
        ctx.strokeStyle = `rgba(${rgb}, 0.35)`; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.setLineDash([]);
        label(`${p.names[0]} · ${T("স্টপ কাটা হয়েছে", "stops taken")}`, plotW - 6, y + 13, `rgba(${rgb}, 0.75)`, "right");
      }
    }

    if (state.layers.structure) {
      for (const b of L(m).breaks.slice(-3)) {
        const x1 = X(b.from), x2 = X(b.time), y = Y(b.level);
        if (x1 === null || x2 === null || y === null) continue;
        const color = b.direction > 0 ? css("--up") : css("--down");
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(b.kind === "CHoCH" ? [4, 3] : []);
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke(); ctx.setLineDash([]);
        label(b.kind === "BOS" ? T("ভাঙন", "Break") : T("মোড়", "Turn"), (x1 + x2) / 2, b.direction > 0 ? y - 4 : y + 12, color, "center");
      }
    }

    const p = state.planResult;
    if (state.layers.plan && p && p.ok) {
      const xl = X(state.lastBarTime);
      const x0 = Math.max(0, (xl === null ? plotW - 60 : xl) + 6);
      const ye = Y(p.entry), ys = Y(p.sl), yt = Y((p.tp2 || p.tp1).price), yt1 = Y(p.tp1.price);
      if (ye !== null && ys !== null && yt !== null) {
        ctx.fillStyle = `rgba(${css("--down-rgb")}, 0.16)`;
        ctx.fillRect(x0, Math.min(ye, ys), plotW - x0, Math.abs(ys - ye));
        ctx.fillStyle = `rgba(${css("--up-rgb")}, 0.14)`;
        ctx.fillRect(x0, Math.min(ye, yt), plotW - x0, Math.abs(yt - ye));
        if (yt1 !== null && p.tp2) {
          ctx.fillStyle = `rgba(${css("--up-rgb")}, 0.12)`;
          ctx.fillRect(x0, Math.min(ye, yt1), plotW - x0, Math.abs(yt1 - ye));
        }
        label(`${T("হারালে", "Lose")} ${usd(p.riskUsd)}`, x0 + 6, (ye + ys) / 2 + 4, css("--down"));
        label(`${T("জিতলে", "Win")} ${usd(p.tp1.profit)}${p.tp2 ? " / " + usd(p.tp2.profit) : ""}`, x0 + 6, (ye + yt) / 2 + 4, css("--up"));
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- market reading
  function renderStory() {
    const m = metalData();
    if (!m || !m.read) return;
    const r = m.read, metal = state.metal, price = currentPrice();
    const tf = [["1d", T("দিনের চার্ট", "Daily chart")], ["4h", T("৪ ঘণ্টার চার্ট", "4-hour chart")], ["1h", T("১ ঘণ্টার চার্ট", "1-hour chart")]];
    $("mtf").innerHTML = tf.map(([k, name]) => `<span class="trend ${r.trend[k].key}">${name} <b>${esc(trendWord(r.trend[k]))}</b></span>`).join("");
    const items = [];
    const keys = tf.map(([k]) => r.trend[k].key);
    if (keys.every((k) => k === "up")) {
      items.push(["up", T("দাম এখন ওঠার পথে: দিনের, ৪ ঘণ্টার আর ১ ঘণ্টার, তিন চার্টেই। ক্রেতারা এগিয়ে।",
                          "Price is rising on all three charts: daily, 4-hour and 1-hour. Buyers are ahead."), hist("race_trend_aligned")]);
    } else if (keys.every((k) => k === "down")) {
      items.push(["down", T("দাম এখন নামার পথে: দিনের, ৪ ঘণ্টার আর ১ ঘণ্টার, তিন চার্টেই। বিক্রেতারা এগিয়ে।",
                            "Price is falling on all three charts: daily, 4-hour and 1-hour. Sellers are ahead."), hist("race_trend_aligned")]);
    } else {
      const tw = (k) => trendWord(r.trend[k]);
      items.push(["", T(`চার্টগুলো এক দিকে নেই (দিনে ${tw("1d")}, ৪ ঘণ্টায় ${tw("4h")}, ১ ঘণ্টায় ${tw("1h")})। এমন সময় দাম এদিক-ওদিক দোলে।`,
                        `The charts disagree (daily ${tw("1d")}, 4-hour ${tw("4h")}, 1-hour ${tw("1h")}). At times like this price swings both ways.`), ""]);
    }

    const lb = r.trend[state.tf].last_break;
    if (lb) {
      const up = lb.direction > 0;
      const what = lb.kind === "BOS"
        ? T(`আগের ${up ? "চূড়া" : "তল"} ভেঙে গেছে, দাম যে দিকে যাচ্ছিল সেদিকেই চলছে`, `the last ${up ? "high" : "low"} is broken, price keeps going the same way`)
        : T(`এতদিন দাম ${up ? "নামছিল" : "উঠছিল"}, এই প্রথম উল্টো দিকে ভাঙল, দিক বদলাতে পারে`, `price had been ${up ? "falling" : "rising"}, this is the first break the other way, the direction may change`);
      items.push([up ? "up" : "down", T(`${tfName(state.tf)} চার্টে ${esc(when(lb.time * 1000))}-এ দাম <b>${money(lb.level, metal)}</b> এর ${up ? "ওপরে" : "নিচে"} বন্ধ হয়েছে: ${what}।`,
                                         `On the ${tfName(state.tf)} chart at ${esc(when(lb.time * 1000))}, price closed ${up ? "above" : "below"} <b>${money(lb.level, metal)}</b>: ${what}.`),
        hist(lb.kind === "BOS" ? "race_bos" : "race_choch")]);
    }
    const rg = L(m).range;
    if (rg) {
      const pos = (price - rg.low) / (rg.high - rg.low);
      const where = pos > 1 ? T("সীমা ছাড়িয়ে ওপরে চলে গেছে", "has broken out above it")
        : pos < 0 ? T("সীমা ছাড়িয়ে নিচে চলে গেছে", "has broken out below it")
        : pos >= 0.5 ? T("ওপরের দিকে আছে: কেনার জন্য দামি, বেচার জন্য ভালো জায়গা", "is in the upper half: expensive to buy, a better place to sell")
        : T("নিচের দিকে আছে: কেনার জন্য সস্তা, বেচার জন্য খারাপ জায়গা", "is in the lower half: cheap to buy, a worse place to sell");
      items.push(["gold", T(`সাম্প্রতিক ওঠানামা <b>${money(rg.low, metal)}</b> থেকে <b>${money(rg.high, metal)}</b>। দাম এখন এর ${where}।`,
                            `The recent swing runs from <b>${money(rg.low, metal)}</b> to <b>${money(rg.high, metal)}</b>. Price ${where}.`), hist("race_discount_premium")]);
    }
    const near = nearestPools(m, price, 1);
    const poolKey = (p) => p.kind === "equal" ? "magnet_equal_levels" : p.kind === "pdh" ? "magnet_pdh" : p.kind === "pdl" ? "magnet_pdl" : null;
    for (const p of [near.above[0], near.below[0]]) {
      if (!p) continue;
      const k = poolKey(p), above = p.side === "above";
      items.push(["liq", T(`${above ? "উপরে" : "নিচে"} <b>${money(p.price, metal)}</b> (${esc(joinNames(p.names))})। এর ঠিক ${above ? "ওপরে" : "নিচে"} অনেকের স্টপ লস থাকে, তাই দাম প্রায়ই এমন জায়গা ছুঁয়ে আসে।`,
                           `${above ? "Above" : "Below"} at <b>${money(p.price, metal)}</b> (${esc(joinNames(p.names))}). Many stop-losses sit just ${above ? "above" : "below"} it, so price often touches places like this.`),
        k ? hist(k, "magnet") : ""]);
    }
    const swept = pools(m, true).filter((p) => p.swept);
    for (const p of swept.slice(0, 1)) {
      const up = p.side === "above";
      items.push(["warn", T(`দাম ${esc(joinNames(p.names))} (<b>${money(p.price, metal)}</b>) পার হয়ে ${up ? "ওপরে" : "নিচে"} গিয়ে ওখানকার স্টপ লস কেটে দিয়েছে। এখন দেখার বিষয়: দাম ফিরে আসে, নাকি আরও ${up ? "ওঠে" : "নামে"}।`,
                            `Price went ${up ? "above" : "below"} ${esc(joinNames(p.names))} (<b>${money(p.price, metal)}</b>) and took out the stop-losses there. Now watch: does price come back, or keep ${up ? "rising" : "falling"}?`),
        hist("race_sweep_reversal")]);
    }
    const z = nearestZones(m, price, 1);
    for (const zone of [z.below[0], z.above[0]]) {
      if (!zone) continue;
      const above = zone.bottom > price;
      const what = zone.kind === "fvg" ? T("এখানে আগে দাম খুব দ্রুত সরে গিয়েছিল, একটা ফাঁক রয়ে গেছে", "price moved very fast here before and left a gap")
        : zone.direction > 0 ? T("এখান থেকে আগে বড় কেনা শুরু হয়েছিল", "big buying started here before") : T("এখান থেকে আগে বড় বিক্রি শুরু হয়েছিল", "big selling started here before");
      items.push(["fvg", T(`${above ? "উপরে" : "নিচে"} <b>${money(zone.bottom, metal)}</b> – <b>${money(zone.top, metal)}</b>: ${what}। দাম ফিরে এলে এখানে থামতে পারে।`,
                           `${above ? "Above" : "Below"} at <b>${money(zone.bottom, metal)}</b> – <b>${money(zone.top, metal)}</b>: ${what}. Price may pause here if it comes back.`),
        hist(zone.kind === "fvg" ? "race_fvg_first_test" : "race_ob_first_test")]);
    }
    const f = m.forecast;
    if (f && forecastFresh(f)) {
      items.push(["gold", T(`আমাদের মডেল বলছে: আগামী ৪ ঘণ্টায় দাম ১০ বারে ৮ বার <b>${money(f.quantiles_price.q100, metal)}</b> থেকে <b>${money(f.quantiles_price.q900, metal)}</b> এর মধ্যে থাকে।`,
                            `Our model: over the next 4 hours price stays between <b>${money(f.quantiles_price.q100, metal)}</b> and <b>${money(f.quantiles_price.q900, metal)}</b> 8 times out of 10.`),
        `<span class="hist edge">${T(`পরীক্ষায় মিলেছে ${pct(m.exam.coverage["80"])}`, `Held ${pct(m.exam.coverage["80"])} in testing`)}</span>`]);
    }
    const ev = (state.data.events || []).find((e) => new Date(e.time_utc).getTime() > Date.now());
    if (ev) {
      const dt = new Date(ev.time_utc).getTime() - Date.now();
      if (dt < 24 * 3600e3) {
        items.push(["warn", T(`${inTime(dt)} ${esc(eventName(ev))}। খবরের সময় দাম হঠাৎ লাফ দেয়, কাছের স্টপ লস সহজে কেটে যায়।`,
                              `${esc(eventName(ev))} ${inTime(dt)}. Price jumps suddenly on news, and close stop-losses get hit easily.`), ""]);
      }
    }
    $("story").innerHTML = items.map(([ic, text, h]) => `<li><span class="ic ${ic}"></span><span>${text}</span>${h || "<span></span>"}</li>`).join("");
  }

  function renderMacro() {
    const m = metalData();
    if (!m || !m.macro) return;
    const mc = m.macro, en = state.lang === "en";
    $("macro").innerHTML = mc.items.map((it) => {
      const t = en && it.en ? it.en : it;
      return `<li><span class="dot ${it.effect}"></span><span><span class="lab">${esc(t.label)}</span><span class="val">${esc(digits(t.value))}</span>
      <span class="txt">${esc(t.text)}</span></span></li>`;
    }).join("") || `<li><span></span><span class="txt">${T("পটভূমির তথ্য পাওয়া যায়নি।", "Background data is not available.")}</span></li>`;
    $("macro-note").textContent = (mc.as_of ? T(`${digits(mc.as_of)} পর্যন্ত। `, `As of ${mc.as_of}. `) : "") +
      T("সবুজ = সাধারণত দামের জন্য ভালো, লাল = খারাপ। তবে আমাদের পরীক্ষায় এগুলো দিয়ে আগামী সপ্তাহ বা মাসের দিক বলা যায়নি। শুধু পটভূমি হিসেবে দেখুন।",
        "Green = usually good for the price, red = bad. But in our tests these could not predict next week's or next month's direction. Treat them as background only.");
  }

  // ---------------------------------------------------------------- trade planner
  function computePlan() {
    const m = metalData();
    if (!m || !m.read) return { ok: false, why: T("চার্টের তথ্য এখনও তৈরি হয়নি।", "Chart data is not ready yet.") };
    const P = state.plan, metal = state.metal, r = m.read, lay = L(m), f = m.forecast && forecastFresh(m.forecast) ? m.forecast : null;
    const side = P.side, long = side > 0, atrv = lay.atr, spread = r.spread_typical || 0, tfInfo = TF[state.tf];
    const price = currentPrice();
    const buf = Math.max(0.25 * atrv, 3 * spread);
    let entry = price, mode = "now", zone = null, entryWhy = T("এখনকার দামে", "At the current price");
    if (P.mode === "pullback") {
      const zs = lay.zones.filter((z) => z.direction === side && (long ? z.top < price : z.bottom > price) && Math.abs((long ? z.top : z.bottom) - price) <= 3 * atrv)
        .sort((a, b) => long ? b.top - a.top : a.bottom - b.bottom);
      if (zs.length) {
        zone = zs[0]; mode = "pullback"; entry = long ? zone.top : zone.bottom;
        entryWhy = T(`দাম ফিরে এসে ${zoneName(zone)} ছুঁলে (লিমিট অর্ডার)`, `If price comes back to ${zoneName(zone)} (limit order)`);
      } else entryWhy = T("কাছে ফিরে আসার মতো জায়গা নেই, তাই এখনকার দামে", "No nearby place to come back to, so at the current price");
    }
    // Stop: beyond the swing that protects the idea, with a buffer; never inside normal noise for the timeframe.
    const guard = lay.swings.filter((s) => s.kind === (long ? "low" : "high") && (long ? s.price < entry : s.price > entry)).sort((a, b) => b.time - a.time)[0];
    let sl, slWhy;
    if (guard) {
      sl = guard.price - side * buf;
      slWhy = T(`${tfName(state.tf)} চার্টের শেষ ${long ? "তলের" : "চূড়ার"} (${money(guard.price, metal)}) একটু ${long ? "নিচে" : "ওপরে"}`,
                `Just ${long ? "below" : "above"} the last ${long ? "low" : "high"} on the ${tfName(state.tf)} chart (${money(guard.price, metal)})`);
    } else {
      sl = entry - side * 1.5 * atrv;
      slWhy = T("কাছে কোনো চূড়া-তল নেই, তাই স্বাভাবিক ওঠানামার দেড় গুণ দূরে", "No nearby high or low, so 1.5 times a normal swing away");
    }
    if (zone) {
      const beyond = long ? zone.bottom - buf : zone.top + buf;
      if (long ? beyond < sl : beyond > sl) { sl = beyond; slWhy = T("ওই জায়গার একটু ওপারে", "Just beyond that zone"); }
    }
    let widened = false;
    if (f) {
      // The cone is for 4 hours; on the 1h chart its edge is scaled to one hour (square-root of time, as drawn).
      const noise = entry * Math.exp((long ? f.quantiles_return.q100 : f.quantiles_return.q900) * Math.sqrt(tfInfo.hours / 4));
      const limit = noise - side * buf;
      if (long ? sl > limit : sl < limit) {
        sl = limit; widened = true;
        slWhy += T("; সাধারণ ঝাঁকুনিতে যেন না কাটে, তাই আরও একটু দূরে", "; moved a bit further so normal wiggles don't hit it");
      }
    }
    const risk = Math.abs(entry - sl);
    if (!(risk > 0)) return { ok: false, why: T("স্টপ হিসাব করা যায়নি।", "Could not work out a stop-loss.") };

    // Targets: resting liquidity and opposing zones on the profit side, taken slightly before the level.
    const manyStops = T("এখানে অনেকের স্টপ লস", "many stop-losses here");
    const cands = [];
    for (const p of pools(m)) if (long ? p.price > entry : p.price < entry) cands.push({ level: p.price, why: `${joinNames(p.names)}, ${manyStops}` });
    if (state.tf === "1h") {
      // Higher-timeframe liquidity is a natural target for an entry timed on the 1h chart.
      for (const p of r.tf["4h"].pools) if (long ? p.price > entry : p.price < entry) cands.push({ level: p.price, why: T(`৪ ঘণ্টার চার্টের ${poolName(p)}, ${manyStops}`, `4-hour chart ${poolName(p)}, ${manyStops}`) });
    }
    for (const z of lay.zones) if (z.direction === -side && (long ? z.bottom > entry : z.top < entry)) cands.push({ level: long ? z.bottom : z.top, why: T(`${zoneName(z)} শুরু হয় এখানে`, `${zoneName(z)} starts here`) });
    if (lay.range) { const lv = long ? lay.range.high : lay.range.low; if (long ? lv > entry : lv < entry) cands.push({ level: lv, why: T("সাম্প্রতিক ওঠানামার শেষ সীমা", "Edge of the recent swing") }); }
    for (const lv of r.round_levels) if (long ? lv > entry : lv < entry) cands.push({ level: lv, why: T("গোল সংখ্যা, এখানে অনেকে অর্ডার রাখে", "Round number, many orders sit here") });
    cands.sort((a, b) => side * (a.level - b.level));
    const merged = [];
    for (const c of cands) {
      const prev = merged[merged.length - 1];
      if (prev && Math.abs(prev.level - c.level) < 0.2 * atrv) { if (!prev.why.includes(c.why)) prev.why += `; ${c.why}`; } else merged.push({ ...c });
    }
    const asTarget = (c) => ({ price: c.level - side * 0.1 * atrv, why: `${c.why}; ${T("লাভ একটু আগেই তুলুন", "take profit a little before it")}`, level: c.level });
    let tp1 = merged.map(asTarget).find((t) => Math.abs(t.price - entry) >= risk);
    if (!tp1) tp1 = { price: entry + side * 1.5 * risk, why: T("কাছে কোনো লক্ষ্য নেই, তাই ঝুঁকির দেড় গুণ দূরে", "No nearby target, so 1.5 times the risk away") };
    const d1 = Math.abs(tp1.price - entry);
    let tp2 = merged.map(asTarget).find((t) => Math.abs(t.price - entry) >= Math.max(2 * risk, d1 + 0.5 * risk)) || null;

    const contract = CONTRACT[metal];
    const budget = P.budget, wantRisk = budget * P.risk;
    let lots = Math.floor((wantRisk / (risk * contract)) * 100 + 1e-9) / 100;
    const minLot = lots < 0.01;
    if (minLot) lots = 0.01;
    const units = lots * contract;
    const riskUsd = units * risk, margin = units * entry / P.lev, spreadUsd = units * spread;
    // With no directional edge, the chance of the target before the stop is stop / (stop + target).
    const winP = (d) => risk / (risk + d);
    const sigma = f ? f.sigma : null;
    const touch4h = (level) => sigma ? Math.min(1, 2 * (1 - phi(Math.abs(Math.log(level / entry)) / sigma))) : null;
    tp1 = { ...tp1, r: d1 / risk, profit: units * d1, win: winP(d1), touch: touch4h(tp1.price) };
    if (tp2) { const d2 = Math.abs(tp2.price - entry); tp2 = { ...tp2, r: d2 / risk, profit: units * d2, win: winP(d2), touch: touch4h(tp2.price) }; }

    // Checklist: risk-control rules decide the verdict; chart-context items are shown with their history.
    const checks = [];
    const t4 = r.trend[state.tf].key, td = r.trend["1d"].key, want = long ? "up" : "down", against = long ? "down" : "up";
    if (t4 === want && td === want) checks.push(["in", "✓", T("দাম যে দিকে যাচ্ছে, সেদিকেই ট্রেড করছেন", "You are trading the way price is moving"), hist("race_trend_aligned")]);
    else if (t4 === against && td === against) checks.push(["wa", "!", T("দাম যে দিকে যাচ্ছে, তার উল্টো দিকে ট্রেড করছেন: লক্ষ্য কাছে রাখুন", "You are trading against the way price is moving: keep the target close"), hist("race_trend_aligned")]);
    else checks.push(["in", "·", T("দামের দিক এখন পরিষ্কার নয়", "Price direction is unclear right now"), ""]);
    if (lay.range) {
      const pos = (entry - lay.range.low) / (lay.range.high - lay.range.low);
      const good = long ? pos < 0.5 : pos > 0.5;
      const text = good ? (long ? T("সস্তা জায়গায় কিনছেন", "Buying in the cheap half") : T("দামি জায়গায় বেচছেন", "Selling in the expensive half"))
        : (long ? T("দামি জায়গায় কিনছেন", "Buying in the expensive half") : T("সস্তা জায়গায় বেচছেন", "Selling in the cheap half"));
      checks.push(["in", good ? "✓" : "·", text, hist("race_discount_premium")]);
    }
    checks.push(widened ? ["ok", "✓", T("স্টপ লস খুব কাছে ছিল, তাই একটু দূরে সরানো হয়েছে", "The stop-loss was too close, so it was moved a little further"), ""]
      : ["ok", "✓", T("স্টপ লস সাধারণ ঝাঁকুনির বাইরে আছে", "The stop-loss is outside normal wiggles"), ""]);
    const rr = F.r.format(tp1.r);
    checks.push(tp1.r >= 1.5 ? ["ok", "✓", T(`সম্ভাব্য লাভ ঝুঁকির ${rr} গুণ`, `Possible profit is ${rr} times the risk`), ""]
      : tp1.r >= 1 ? ["wa", "!", T(`সম্ভাব্য লাভ ঝুঁকির মাত্র ${rr} গুণ`, `Possible profit is only ${rr} times the risk`), ""]
      : ["no", "✗", T("সম্ভাব্য লাভ ঝুঁকির চেয়েও কম", "Possible profit is smaller than the risk"), ""]);
    const ev = (state.data.events || []).find((e) => new Date(e.time_utc).getTime() > Date.now());
    const evIn = ev ? new Date(ev.time_utc).getTime() - Date.now() : Infinity;
    if (evIn < 3600e3) checks.push(["no", "✗", T(`${inTime(evIn)} ${eventName(ev)}: বড় খবরের ঠিক আগে নতুন ট্রেড নেবেন না`, `${eventName(ev)} ${inTime(evIn)}: don't open a new trade right before big news`), ""]);
    else if (evIn < 4 * 3600e3) checks.push(["wa", "!", T(`${inTime(evIn)} ${eventName(ev)}: খবরের আগেই লাভ তুলে নিন বা স্টপ লস ঢোকার দামে আনুন`, `${eventName(ev)} ${inTime(evIn)}: take profit before it or move the stop-loss to your entry`), ""]);
    else checks.push(["ok", "✓", T("আগামী ৪ ঘণ্টায় বড় কোনো খবর নেই", "No big news in the next 4 hours"), ""]);
    const sp = spreadUsd / riskUsd;
    checks.push(sp < 0.05 ? ["ok", "✓", T(`ব্রোকারের খরচ (স্প্রেড) কম: ঝুঁকির ${pct(sp, 0)}`, `Broker cost (spread) is low: ${pct(sp, 0)} of the risk`), ""]
      : sp < 0.15 ? ["wa", "!", T(`ব্রোকারের খরচ (স্প্রেড) ঝুঁকির ${pct(sp, 0)}`, `Broker cost (spread) is ${pct(sp, 0)} of the risk`), ""]
      : ["no", "✗", T(`ব্রোকারের খরচই ঝুঁকির ${pct(sp, 0)}: স্টপ লস খুব কাছে`, `Broker cost alone is ${pct(sp, 0)} of the risk: the stop-loss is too close`), ""]);
    const rb = riskUsd / budget;
    if (minLot && rb > 0.03) checks.push(["no", "✗", T(`বাজেট কম: সবচেয়ে ছোট লটেও (০.০১) বাজেটের ${pct(rb)} হারানোর ঝুঁকি`, `Budget too small: even the smallest lot (0.01) risks ${pct(rb)} of it`), ""]);
    else if (minLot) checks.push(["wa", "!", T(`সবচেয়ে ছোট লট (০.০১): বাজেটের ${pct(rb)} ঝুঁকিতে`, `Smallest lot (0.01): ${pct(rb)} of the budget at risk`), ""]);
    else checks.push(["ok", "✓", T(`হারালে বাজেটের মাত্র ${pct(rb)} যাবে`, `If it loses, only ${pct(rb)} of the budget goes`), ""]);
    if (margin > budget) checks.push(["no", "✗", T(`এই ট্রেডে ${usd(margin)} আটকে থাকবে, যা বাজেটের চেয়ে বেশি`, `This trade ties up ${usd(margin)}, more than the budget`), ""]);
    else if (margin > 0.5 * budget) checks.push(["wa", "!", T(`এই ট্রেডে ${usd(margin)} আটকে থাকবে, বাজেটের অর্ধেকের বেশি`, `This trade ties up ${usd(margin)}, over half the budget`), ""]);
    if (f && f.mood && f.mood.key === "extreme") checks.push(["wa", "!", T("বাজার এখন খুব অস্থির: লট কমান", "The market is very volatile now: use fewer lots"), ""]);
    const nNo = checks.filter((c) => c[0] === "no").length, nWa = checks.filter((c) => c[0] === "wa").length;
    const verdict = nNo ? ["avoid", T("এই ট্রেড এখন নেবেন না", "Don't take this trade now")]
      : nWa >= 2 ? ["care", T("নিতে পারেন, তবে সাবধানে", "Possible, but be careful")] : ["good", T("পরিকল্পনা ঠিক আছে", "The plan looks fine")];
    return { ok: true, side, mode, entry, entryWhy, sl, slWhy, widened, tp1, tp2, lots, minLot, riskUsd, margin, spreadUsd, checks, verdict, event: evIn < 24 * 3600e3 ? ev : null };
  }

  function renderPlanner(force = false) {
    if (!state.data) return;
    if (!force && Date.now() - state.lastPlanAt < 2000) return;
    state.lastPlanAt = Date.now();
    const p = computePlan();
    state.planResult = p;
    const out = $("plan-out"), metal = state.metal;
    if (!p.ok) { out.innerHTML = `<p class="note">${esc(p.why)}</p>`; updatePlanLines(); requestDraw(); return; }
    const sideWord = p.side > 0 ? T("কিনুন", "Buy") : T("বেচুন", "Sell");
    const times = (r) => F.r.format(r);
    const lvl = (cls, k, price, s) => `<div class="lvl ${cls}"><div class="k">${k}</div><div class="p">${money(price, metal)}</div><div class="s">${esc(s)}</div></div>`;
    const half = p.lots >= 0.02;
    const halfLots = Math.floor(p.lots * 50 + 1e-9) / 100;
    const calib = reality(metalData()).planner_tp2_sl1;
    const lots = F.lot.format(p.lots);
    const steps = [
      T(`${p.mode === "pullback" ? "লিমিট অর্ডার দিয়ে" : "এখনই"} ${sideWord}: দাম <b>${money(p.entry, metal)}</b>, <b>${lots}</b> লট।`,
        `${sideWord} ${p.mode === "pullback" ? "with a limit order" : "now"}: price <b>${money(p.entry, metal)}</b>, <b>${lots}</b> lot.`),
      T(`সাথে সাথে স্টপ লস <b>${money(p.sl, metal)}</b> বসান। ক্ষতি বাড়লেও স্টপ লস সরাবেন না।`,
        `Set the stop-loss at <b>${money(p.sl, metal)}</b> straight away. Never move it further away, even if the loss grows.`),
      half ? T(`দাম <b>${money(p.tp1.price, metal)}</b> ছুঁলে অর্ধেক (<b>${F.lot.format(halfLots)}</b> লট) বন্ধ করুন, আর স্টপ লস ঢোকার দামে নিয়ে আসুন। তখন বাকিটায় আর ক্ষতির ভয় নেই।`,
               `When price touches <b>${money(p.tp1.price, metal)}</b>, close half (<b>${F.lot.format(halfLots)}</b> lot) and move the stop-loss to your entry price. The rest can no longer lose.`)
        : T(`দাম <b>${money(p.tp1.price, metal)}</b> ছুঁলে পুরোটা বন্ধ করুন (লট ছোট, ভাগ করা যায় না)।`,
            `When price touches <b>${money(p.tp1.price, metal)}</b>, close it all (the lot is too small to split).`),
      p.tp2 && half ? T(`বাকি অর্ধেক <b>${money(p.tp2.price, metal)}</b> এ বন্ধ করুন।`, `Close the other half at <b>${money(p.tp2.price, metal)}</b>.`) : null,
      T(`${digits(TF[state.tf].timeStop)} ঘণ্টায় কিছু না হলে, বা দাম উল্টো দিকে ঘুরে গেলে, ট্রেডটা নিয়ে আবার ভাবুন।`,
        `If nothing happens in ${TF[state.tf].timeStop} hours, or price turns the other way, rethink the trade.`),
      p.event ? T(`${esc(eventName(p.event))} (${esc(when(new Date(p.event.time_utc).getTime()))}) এর আগে লাভ তুলে নিন, বা স্টপ লস ঢোকার দামে আনুন।`,
                  `Before ${esc(eventName(p.event))} (${esc(when(new Date(p.event.time_utc).getTime()))}), take profit or move the stop-loss to your entry.`) : null,
    ].filter(Boolean);
    const calibText = calib ? T(`, আর অতীতের ডেটার সাথে মিলেছে (২ গুণ লাভের লক্ষ্যে ${pct(calib.rate, 0)}, হিসাবে ৩৩%)`,
                                `, and it matched past data (for a target twice the risk: ${pct(calib.rate, 0)}, expected 33%)`) : "";
    out.innerHTML = `
      <div class="plan-verdict ${p.verdict[0]}"><div class="v">${p.verdict[1]}</div>
        <div class="note">${T(`স্টপ লসের আগে প্রথম লক্ষ্যে পৌঁছানোর সম্ভাবনা ${pct(p.tp1.win, 0)}; ১ টাকা ঝুঁকিতে ${times(p.tp1.r)} টাকা লাভ। দাম কোন দিকে যাবে কেউ নিশ্চিত জানে না, তাই এই সম্ভাবনা শুধু দূরত্ব দেখে হিসাব করা${calibText}।`,
                               `Chance of reaching the first target before the stop-loss: ${pct(p.tp1.win, 0)}; ${times(p.tp1.r)} profit for every 1 at risk. Nobody knows for sure which way price will go, so this chance comes from the distances alone${calibText}.`)}</div></div>
      <div class="levels">
        ${lvl("entry", T("ঢোকার দাম", "Entry price"), p.entry, p.entryWhy)}
        ${lvl("sl", T("স্টপ লস (এখানে বেরিয়ে যাবেন)", "Stop-loss (you exit here)"), p.sl, p.slWhy)}
        ${lvl("tp", T(`লাভ তোলা ১ · ঝুঁকির ${times(p.tp1.r)} গুণ`, `Take profit 1 · ${times(p.tp1.r)}× the risk`), p.tp1.price, p.tp1.why)}
        ${p.tp2 ? lvl("tp", T(`লাভ তোলা ২ · ঝুঁকির ${times(p.tp2.r)} গুণ`, `Take profit 2 · ${times(p.tp2.r)}× the risk`), p.tp2.price, p.tp2.why)
          : `<div class="lvl"><div class="k">${T("লাভ তোলা ২", "Take profit 2")}</div><div class="p">—</div><div class="s">${T("আরও দূরে ভালো লক্ষ্য নেই", "No good target further away")}</div></div>`}
      </div>
      <div class="facts">
        <div class="fact"><div class="k">${T("কত লট নেবেন", "Lots to take")}</div><div class="p">${lots}</div></div>
        <div class="fact"><div class="k">${T("হারালে ক্ষতি", "Loss if stopped")}</div><div class="p down">${usd(p.riskUsd)}</div></div>
        <div class="fact"><div class="k">${T("জিতলে লাভ (১ / ২)", "Profit if hit (1 / 2)")}</div><div class="p up">${usd(p.tp1.profit)}${p.tp2 ? " / " + usd(p.tp2.profit) : ""}</div></div>
        <div class="fact"><div class="k">${T("৪ ঘণ্টার মধ্যে লক্ষ্য ১ ছোঁয়ার সম্ভাবনা", "Chance of target 1 within 4 hours")}</div><div class="p">${p.tp1.touch === null ? "—" : pct(p.tp1.touch, 0)}</div></div>
        <div class="fact"><div class="k">${T("অ্যাকাউন্টে আটকে থাকবে (মার্জিন)", "Tied up in your account (margin)")}</div><div class="p">${usd(p.margin)}</div></div>
        <div class="fact"><div class="k">${T("ব্রোকারের খরচ (স্প্রেড, আনুমানিক)", "Broker cost (spread, estimate)")}</div><div class="p">${usd(p.spreadUsd)}</div></div>
      </div>
      <h3>${T("ঝুঁকির হিসাব", "Risk check")}</h3>
      <ul class="checks">${p.checks.map(([cls, mark, text, h]) => `<li><span class="${cls}">${mark}</span><span>${esc(text)} ${h}</span></li>`).join("")}</ul>
      <h3>${T("কী করবেন, ধাপে ধাপে", "What to do, step by step")}</h3>
      <ol class="steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol>`;
    updatePlanLines();
    requestDraw();
  }

  function bindPlanner() {
    const saved = restore("srp-plan");
    if (saved) Object.assign(state.plan, saved);
    const form = $("plan-form");
    const sync = () => {
      for (const b of form.querySelectorAll(".seg button")) b.setAttribute("aria-pressed", String(Number(b.dataset.side) === state.plan.side));
      $("plan-budget").value = state.plan.budget; $("plan-risk").value = String(state.plan.risk);
      $("plan-mode").value = state.plan.mode; $("plan-lev").value = String(state.plan.lev);
    };
    const changed = () => {
      const budget = parseFloat($("plan-budget").value);
      if (!isFinite(budget) || budget < 10) { $("budget-error").textContent = T("কমপক্ষে ১০ ডলার লিখুন", "Enter at least 10 dollars"); return; }
      $("budget-error").textContent = "";
      Object.assign(state.plan, { budget, risk: parseFloat($("plan-risk").value), mode: $("plan-mode").value, lev: parseFloat($("plan-lev").value) });
      store("srp-plan", state.plan);
      renderPlanner(true);
    };
    sync();
    for (const b of form.querySelectorAll(".seg button")) b.addEventListener("click", () => { state.plan.side = Number(b.dataset.side); sync(); changed(); });
    $("plan-budget").addEventListener("input", changed);
    for (const id of ["plan-risk", "plan-mode", "plan-lev"]) $(id).addEventListener("change", changed);
    form.addEventListener("submit", (e) => e.preventDefault());
  }

  function syncTimeframeText() {
    for (const b of document.querySelectorAll("#tf-switch button")) b.setAttribute("aria-selected", String(b.dataset.tf === state.tf));
    $("chart-sub").textContent = T(`${tfName(state.tf)} ক্যান্ডেল`, `${tfName(state.tf)} candles`);
    $("plan-sub").textContent = T(`বাজেট আর দিক দিন; ${tfName(state.tf)} চার্ট দেখে বাকিটা আমরা হিসাব করব`,
                                  `Enter your budget and direction; we work out the rest from the ${tfName(state.tf)} chart`);
  }

  function bindTimeframe() {
    const saved = restore("srp-tf");
    if (saved && TF[saved]) state.tf = saved;
    syncTimeframeText();
    for (const b of document.querySelectorAll("#tf-switch button")) b.addEventListener("click", () => {
      if (state.tf === b.dataset.tf) return;
      state.tf = b.dataset.tf;
      store("srp-tf", state.tf);
      syncTimeframeText();
      if (state.data) { renderStory(); renderPlanner(true); buildChart(); }
    });
  }

  function bindLayers() {
    const saved = restore("srp-layers");
    if (saved) Object.assign(state.layers, saved);
    for (const b of document.querySelectorAll("#layers button")) {
      b.setAttribute("aria-pressed", String(!!state.layers[b.dataset.layer]));
      b.addEventListener("click", () => {
        state.layers[b.dataset.layer] = !state.layers[b.dataset.layer];
        b.setAttribute("aria-pressed", String(state.layers[b.dataset.layer]));
        store("srp-layers", state.layers);
        buildChart();
      });
    }
  }

  // ---------------------------------------------------------------- panels
  function renderHero() {
    const m = metalData();
    if (!m) return;
    const name = NAME()[state.metal];
    $("metal-name").textContent = name;
    const tick = state.live[state.metal];
    const price = currentPrice();
    $("price").textContent = money(price, state.metal);
    if (tick && tick.open24) {
      const diff = price - tick.open24, rel = diff / tick.open24;
      $("change").innerHTML = `<span class="${diff >= 0 ? "up" : "down"}">${money(diff, state.metal, true)} (${diff >= 0 ? "+" : "−"}${pct(Math.abs(rel), 2).replace("+", "")})</span> <span class="note">${T("২৪ ঘণ্টায়", "in 24 hours")}</span>`;
    } else {
      $("change").innerHTML = `<span class="note">${T("সর্বশেষ ঘণ্টার দাম", "Last hourly price")} · ${when(new Date(m.data_until).getTime())}</span>`;
    }
    const f = m.forecast;
    const chips = [];
    if (!f) {
      const next = new Date(state.data.next_bar_close_utc).getTime() + 7 * 60e3;
      $("verdict").textContent = T(`প্রথম লাইভ পূর্বাভাস প্রকাশিত হবে ঢাকা সময় ${F.time.format(new Date(next))}-এ।`,
                                   `The first live forecast comes out at ${F.time.format(new Date(next))} Dhaka time.`);
    } else {
      const q = f.quantiles_price;
      const lo = `<b>${money(q.q100, state.metal)}</b>`, hi = `<b>${money(q.q900, state.metal)}</b>`;
      $("verdict").innerHTML = !forecastFresh(f)
        ? T(`নতুন পূর্বাভাসের অপেক্ষায়। সর্বশেষ পূর্বাভাস (${esc(when(new Date(f.decision_time).getTime()))}): ৮০% সম্ভাবনায় ${lo} থেকে ${hi}।`,
            `Waiting for the next forecast. Latest (${esc(when(new Date(f.decision_time).getTime()))}): ${lo} to ${hi}, 8 times out of 10.`)
        : T(`${name}র দাম সম্ভবত ${lo} থেকে ${hi} এর মধ্যে থাকবে (১০ বারে ৮ বার এমন হয়)।`,
            `${name} will probably stay between ${lo} and ${hi} (this happens 8 times out of 10).`);
      const mood = f.mood;
      const moodText = {
        calm: T("স্বাভাবিকের চেয়ে কম ওঠানামা", "smaller swings than usual"), normal: T("সাধারণ ওঠানামা", "normal swings"),
        volatile: T("স্বাভাবিকের চেয়ে বড় ওঠানামা", "bigger swings than usual"), extreme: T("বছরের সবচেয়ে বড় ওঠানামার মধ্যে", "among the biggest swings of the year"),
      }[mood.key];
      const moodLabel = state.lang === "en" && mood.label_en ? mood.label_en : mood.label;
      chips.push(`<span class="chip ${mood.key}"><i></i>${T("বাজার", "Market")}: ${esc(moodLabel)} <span>${moodText}</span></span>`);
      if (f.event_in_next_bar) chips.push(`<span class="chip news"><i></i>${T("খবরের ঝুঁকি", "News risk")} <span>${T("এই ৪ ঘণ্টায় গুরুত্বপূর্ণ মার্কিন খবর", "important US news in these 4 hours")}</span></span>`);
    }
    $("chips").innerHTML = chips.join("");
    renderNext();
  }

  function renderNext() {
    if (!state.data) return;
    let next = new Date(state.data.next_bar_close_utc).getTime() + 7 * 60e3;
    while (next < Date.now()) next += 4 * 3600e3;
    $("next-update").textContent = T(`পরবর্তী পূর্বাভাস: ঢাকা ${F.time.format(new Date(next))} · ${inTime(next - Date.now())}`,
                                     `Next forecast: ${F.time.format(new Date(next))} Dhaka · ${inTime(next - Date.now())}`);
  }

  function renderCards() {
    const m = metalData();
    const f = m && m.forecast;
    const metal = state.metal;
    const rangeRows = f ? [
      [T("৫০% সম্ভাবনা", "50% chance"), T("অর্ধেক সময় দাম এর ভেতরে", "price inside half the time"), f.quantiles_price.q250, f.quantiles_price.q750],
      [T("৮০% সম্ভাবনা", "80% chance"), T("প্রতি ১০ বারে ৮ বার", "8 times out of 10"), f.quantiles_price.q100, f.quantiles_price.q900],
      [T("৯৫% সম্ভাবনা", "95% chance"), T("প্রায় নিশ্চিত সীমা", "almost certain limits"), f.quantiles_price.q025, f.quantiles_price.q975],
    ].map(([k, s, lo, hi]) => `<tr><td>${k}<small>${s}</small></td><td>${money(lo, metal)} – ${money(hi, metal)}</td></tr>`).join("")
      : `<tr><td>${T("প্রথম পূর্বাভাসের অপেক্ষায়", "Waiting for the first forecast")}</td><td>—</td></tr>`;
    $("range-table").querySelector("tbody").innerHTML = rangeRows;

    const touchRows = f ? Object.values(f.touch_levels).map((t) =>
      `<tr><td>${T(`${pct(t.probability_each, 0)} সম্ভাবনা`, `${pct(t.probability_each, 0)} chance`)}<small>${T("প্রতিটি দিকে", "each direction")}</small></td><td>↑ ${money(t.up, metal)}<br>↓ ${money(t.down, metal)}</td></tr>`).join("")
      : `<tr><td>—</td><td>—</td></tr>`;
    $("touch-table").querySelector("tbody").innerHTML = touchRows;

    const events = state.data.events || [];
    $("events").querySelector("tbody").innerHTML = events.length ? events.slice(0, 8).map((e) => {
      const t = new Date(e.time_utc).getTime();
      return `<tr><td>${esc(eventName(e))}</td><td class="num">${esc(when(t))}</td><td class="note">${inTime(t - Date.now())}</td></tr>`;
    }).join("") : `<tr><td class="note">${T("আগামী ১০ দিনে কোনো উচ্চ প্রভাবের খবর নেই।", "No high-impact news in the next 10 days.")}</td></tr>`;
  }

  function renderRecord() {
    const m = metalData();
    if (!m) return;
    const lr = m.live_record, ex = m.exam, va = m.validation;
    const stat = (k, v, s = "") => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
    const covered = (v) => v === null || v === undefined ? "—" : pct(v);
    const n = (v) => F.int.format(v || 0);
    const right80 = T("৮০% পরিসর সঠিক", "80% range correct"), right95 = T("৯৫% পরিসর সঠিক", "95% range correct");
    const target80 = T("লক্ষ্য ৮০%", "target 80%"), target95 = T("লক্ষ্য ৯৫%", "target 95%");
    const news = T("খবরের সময় ৮০%", "80% around news"), std = (v) => T(`প্রচলিত মডেল: ${pct(v)}`, `standard model: ${pct(v)}`);
    const acc = T("নির্ভুলতা", "Accuracy"), accSub = T("প্রচলিত ব্যাংক মডেলের চেয়ে", "better than the standard bank model");
    $("stats").innerHTML = [
      `<div class="stat-group">${T("লাইভ রেকর্ড", "Live record")} · ${NAME()[state.metal]} <small>${T("২৩ অক্টোবর ২০২৬ থেকে, সব পূর্বাভাস ফলাফলের আগে প্রকাশিত", "since 23 October 2026, every forecast published before its result")}</small></div>`,
      stat(T("মোট পূর্বাভাস", "Forecasts"), n(lr.forecasts), lr.missed ? T(`${n(lr.missed)}টি বাদ পড়েছে`, `${n(lr.missed)} missed`) : T("কোনোটি বাদ পড়েনি", "none missed")),
      stat(T("মূল্যায়িত", "Scored"), n(lr.scored_on_time), T("সময়মতো প্রকাশিত", "published on time")),
      stat(right80, covered(lr.coverage && lr.coverage["80"]), target80),
      stat(right95, covered(lr.coverage && lr.coverage["95"]), target95),
      `<div class="stat-group">${T("চূড়ান্ত পরীক্ষা ২০২৪–২০২৬", "Final exam 2024–2026")} <small>${T(`${n(ex.rows)}টি পূর্বাভাস, মডেল কখনো এই ডেটা দেখেনি`, `${n(ex.rows)} forecasts on data the model never saw`)}</small></div>`,
      stat(right80, pct(ex.coverage["80"]), target80),
      stat(right95, pct(ex.coverage["95"]), target95),
      stat(news, pct(ex.coverage_news_80), std(ex.baseline_news_80)),
      stat(acc, "+" + pct(ex.accuracy_gain_vs_ewma), accSub),
      `<div class="stat-group">${T("যাচাই ২০১৯–২০২৩", "Validation 2019–2023")} <small>${T(`${n(va.rows)}টি পূর্বাভাস`, `${n(va.rows)} forecasts`)}</small></div>`,
      stat(right80, pct(va.coverage["80"]), target80),
      stat(right95, pct(va.coverage["95"]), target95),
      stat(news, pct(va.coverage_news_80), std(va.baseline_news_80)),
      stat(acc, "+" + pct(va.accuracy_gain_vs_ewma), accSub),
    ].join("");

    $("history-metal").textContent = NAME()[state.metal];
    const rows = (m.history || []).slice().reverse().map((h) => {
      const tag = h.next_close === null || h.next_close === undefined
        ? `<span class="tag wait">${T("অপেক্ষমাণ", "pending")}</span>`
        : (h.inside80 ? `<span class="tag hit">✓ ${T("ভেতরে", "inside")}</span>` : `<span class="tag miss">✗ ${T("বাইরে", "outside")}</span>`);
      return `<tr><td>${esc(when(new Date(h.decision_time).getTime()))}</td><td class="num">${money(h.price, state.metal)}</td>
        <td class="num">${money(h.bands.q100, state.metal)} – ${money(h.bands.q900, state.metal)}</td>
        <td class="num">${money(h.next_close, state.metal)}</td><td>${tag}</td></tr>`;
    }).join("");
    $("history").querySelector("tbody").innerHTML = rows || `<tr><td colspan="5" class="note">${T("প্রথম পূর্বাভাসের ফলাফল ৪ ঘণ্টা পরে এখানে দেখাবে।", "The first result shows here 4 hours after the first forecast.")}</td></tr>`;

    const led = state.data.ledger;
    $("ledger-ok").textContent = led.ok ? T("যাচাই সম্পন্ন: সব হ্যাশ মিলেছে", "Verified: every hash matches") : T("সমস্যা: হ্যাশ মেলেনি", "Problem: hashes do not match");
    $("ledger-ok").className = led.ok ? "up" : "down";
    $("ledger-count").textContent = F.int.format(led.entries);
    $("ledger-head").textContent = led.head;
    $("generated").textContent = T(`শেষ হালনাগাদ ${when(new Date(state.data.generated_utc).getTime())}`, `Last update ${when(new Date(state.data.generated_utc).getTime())}`);
  }

  function renderAll() {
    renderHero();
    renderStory();
    renderCards();
    renderMacro();
    renderRecord();
    renderPlanner(true);
    buildChart();
    updateLiveStatus();
  }

  // ---------------------------------------------------------------- live prices
  const rawOpen24 = { gold: null, silver: null };
  let lastPaint = 0;

  function onTick(metal, rawPrice, rawOpen) {
    const m = state.data && state.data.metals[metal];
    const ratio = m && m.basis && m.basis.ratio ? m.basis.ratio : 1;
    if (rawOpen) rawOpen24[metal] = rawOpen;
    state.live[metal] = { price: rawPrice * ratio, open24: rawOpen24[metal] ? rawOpen24[metal] * ratio : null, at: Date.now() };
    state.lastMessage = Date.now();
    // The order-book stream ticks many times a second: repaint at most twice a second, re-plan every 2 s.
    if (metal === state.metal && Date.now() - lastPaint > 500) {
      lastPaint = Date.now();
      renderHero();
      applyLiveToChart();
      renderPlanner();
      requestDraw();
    }
    updateLiveStatus();
  }

  async function refreshOpen24() {
    for (const [symbol, metal] of Object.entries(FEED)) {
      try {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`);
        if (r.ok) rawOpen24[metal] = parseFloat((await r.json()).openPrice);
      } catch (err) { console.warn("24h open unavailable", err); }
    }
  }

  function updateLiveStatus() {
    const tick = state.live[state.metal];
    const el = $("live-status");
    const age = tick ? Date.now() - tick.at : Infinity;
    el.className = "live" + (age < 20e3 ? " on" : age < 180e3 ? " slow" : "");
    el.querySelector("b").textContent = age < 20e3 ? T("লাইভ", "Live") : age < 180e3 ? T("বিলম্বিত", "Delayed")
      : tick ? T("লাইভ দাম পাওয়া যাচ্ছে না", "Live price unavailable") : T("সংযোগ হচ্ছে", "Connecting");
  }

  function connectSocket() {
    let ws;
    try {
      // Best bid/ask stream (the summary streams are silent for these contracts); price = mid.
      ws = new WebSocket("wss://fstream.binance.com/stream?streams=xauusdt@bookTicker/xagusdt@bookTicker");
    } catch (err) {
      startPolling();
      return;
    }
    const opened = Date.now();
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data).data;
        if (msg && FEED[msg.s]) onTick(FEED[msg.s], (parseFloat(msg.b) + parseFloat(msg.a)) / 2, null);
      } catch (err) { console.error("feed", err); }
    };
    ws.onclose = () => {
      state.wsFailures += 1;
      if (state.wsFailures >= 3) startPolling();
      else setTimeout(connectSocket, 3000 * state.wsFailures);
    };
    // Watchdog: a stream that stays silent for 15 s is treated as blocked and replaced by polling.
    setInterval(() => {
      const last = state.lastMessage || opened;
      if (Date.now() - last > 15000) { startPolling(); }
    }, 5000);
  }

  async function pollOnce() {
    const sources = [
      async () => {
        const out = await Promise.all(["XAUUSDT", "XAGUSDT"].map(async (s) => {
          const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${s}`);
          if (!r.ok) throw new Error(`Binance ${r.status}`);
          const j = await r.json();
          return [s, parseFloat(j.lastPrice), parseFloat(j.openPrice)];
        }));
        return out;
      },
      async () => {
        const out = await Promise.all([["XAUUSDT", "XAU-USDT-SWAP"], ["XAGUSDT", "XAG-USDT-SWAP"]].map(async ([s, id]) => {
          const r = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${id}`);
          if (!r.ok) throw new Error(`OKX ${r.status}`);
          const j = (await r.json()).data[0];
          return [s, parseFloat(j.last), parseFloat(j.open24h)];
        }));
        return out;
      },
    ];
    for (const source of sources) {
      try {
        for (const [s, price, open] of await source()) onTick(FEED[s], price, open);
        return;
      } catch (err) { console.warn("price source failed", err); }
    }
  }

  function startPolling() {
    if (state.polling) return;
    pollOnce();
    state.polling = setInterval(pollOnce, 5000);
  }

  // ---------------------------------------------------------------- shell
  function tickClock() {
    const now = new Date();
    $("clock").textContent = T(`ঢাকা ${F.time.format(now)} · UTC ${F.utc.format(now)}`, `Dhaka ${F.time.format(now)} · UTC ${F.utc.format(now)}`);
    updateLiveStatus();
  }

  function selectMetal(metal) {
    state.metal = metal;
    for (const btn of document.querySelectorAll(".switch button")) btn.setAttribute("aria-selected", String(btn.dataset.metal === metal));
    if (state.data) renderAll();
  }

  for (const btn of document.querySelectorAll(".switch button")) btn.addEventListener("click", () => selectMetal(btn.dataset.metal));
  new ResizeObserver(() => requestDraw()).observe($("chart"));
  bindLanguage();
  bindTheme();
  bindTimeframe();
  bindLayers();
  bindPlanner();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(renderNext, 30e3);
  setInterval(() => { renderStory(); renderPlanner(true); }, 60e3);
  setInterval(loadData, 5 * 60e3);
  loadData().then(() => { refreshOpen24(); connectSocket(); });
  setInterval(refreshOpen24, 60e3);
})();
