"use strict";
(() => {
  const DATA_URL = "data/site.json";
  const NAMES = { gold: "সোনা", silver: "রুপা" };
  const DIGITS = { gold: 2, silver: 3 };
  const CONTRACT = { gold: 100, silver: 5000 };        // ounces per standard lot (XAUUSD / XAGUSD)
  const FEED = { XAUUSDT: "gold", XAGUSDT: "silver" };
  const TZ = "Asia/Dhaka";
  const LAYERS = ["structure", "liquidity", "zones", "cone", "plan"];
  const fmtInt = new Intl.NumberFormat("bn-BD");
  const fmtPct1 = new Intl.NumberFormat("bn-BD", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtPct0 = new Intl.NumberFormat("bn-BD", { style: "percent", maximumFractionDigits: 0 });
  const fmtTime = new Intl.DateTimeFormat("bn-BD", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtDateTime = new Intl.DateTimeFormat("bn-BD", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtUtc = new Intl.DateTimeFormat("bn-BD", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtUsd = new Intl.NumberFormat("bn-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtLot = new Intl.NumberFormat("bn-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtR = new Intl.NumberFormat("bn-BD", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtDec = {};

  const state = {
    data: null, metal: "gold", live: { gold: null, silver: null }, wsFailures: 0, polling: null, chart: null,
    layers: Object.fromEntries(LAYERS.map((k) => [k, true])),
    plan: { side: 1, budget: 1000, risk: 0.01, mode: "now", lev: 100 },
    planResult: null, planLines: [], lastPlanAt: 0,
  };
  const $ = (id) => document.getElementById(id);
  const DIG = "০১২৩৪৫৬৭৮৯";
  const bn = (s) => String(s).replace(/[0-9]/g, (d) => DIG[d]);

  function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { console.warn("storage unavailable", err); } }
  function restore(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (err) { return null; } }

  function money(value, metal, signed = false) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    const d = DIGITS[metal];
    fmtDec[d] = fmtDec[d] || new Intl.NumberFormat("bn-BD", { minimumFractionDigits: d, maximumFractionDigits: d });
    const text = fmtDec[d].format(Math.abs(value));
    if (signed) return (value >= 0 ? "+" : "−") + "$" + text;
    return "$" + text;
  }
  const usd = (v) => (v === null || v === undefined || !isFinite(v)) ? "—" : "$" + fmtUsd.format(v);
  const pct = (v, digits = 1) => (v === null || v === undefined || !isFinite(v)) ? "—" : (digits ? fmtPct1 : fmtPct0).format(v);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function relative(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return "এখনই";
    if (mins < 60) return `${fmtInt.format(mins)} মিনিট`;
    const hours = Math.floor(mins / 60), rest = mins % 60;
    if (hours < 48) return `${fmtInt.format(hours)} ঘণ্টা${rest ? " " + fmtInt.format(rest) + " মিনিট" : ""}`;
    return `${fmtInt.format(Math.floor(hours / 24))} দিন ${fmtInt.format(hours % 24)} ঘণ্টা`;
  }

  // Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7).
  function phi(x) {
    const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
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
      $("verdict").textContent = "ডেটা লোড করা যায়নি। কিছুক্ষণ পরে পাতাটি আবার খুলুন।";
      console.error("site data", err);
    }
  }

  function metalData() { return state.data && state.data.metals[state.metal]; }
  function currentPrice() {
    const m = metalData();
    const tick = state.live[state.metal];
    return tick ? tick.price : m.bars[m.bars.length - 1].close;
  }

  function forecastFresh(f) {
    if (!f) return false;
    const end = new Date(f.decision_time).getTime() + 4 * 3600e3;
    return Date.now() < end + 45 * 60e3;
  }

  // ---------------------------------------------------------------- chart reading helpers
  const POOL_NAME = {
    "swing:above": "আগের চূড়া", "swing:below": "আগের তল", "equal:above": "সমান চূড়া", "equal:below": "সমান তল",
    pdh: "গতকালের উচ্চ", pdl: "গতকালের নিম্ন", pwh: "গত সপ্তাহের উচ্চ", pwl: "গত সপ্তাহের নিম্ন",
  };
  const POOL_RANK = { equal: 3, pdh: 2, pdl: 2, pwh: 2, pwl: 2, swing: 1 };
  const poolName = (p) => POOL_NAME[p.kind] || POOL_NAME[`${p.kind}:${p.side}`];

  // Merge levels closer than 5% of an ATR (e.g. yesterday's low that is also last week's low).
  function pools(m, includeSwept = false) {
    const r = m.read, tol = 0.05 * r.atr_4h;
    const list = r.pools.filter((p) => includeSwept || !p.swept).map((p) => ({ ...p, names: [poolName(p)] })).sort((a, b) => a.price - b.price);
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
    const zs = m.read.zones;
    return {
      above: zs.filter((z) => z.bottom > price).sort((a, b) => a.bottom - b.bottom).slice(0, n),
      below: zs.filter((z) => z.top < price).sort((a, b) => b.top - a.top).slice(0, n),
      inside: zs.filter((z) => z.bottom <= price && z.top >= price),
    };
  }

  const zoneName = (z) => z.kind === "fvg" ? "পূরণ না হওয়া ফাঁক (FVG)" : z.direction > 0 ? "চাহিদা অঞ্চল (অর্ডার ব্লক)" : "সরবরাহ অঞ্চল (অর্ডার ব্লক)";

  // History pill: 2003-2023 base rate of the pattern next to its control.
  function hist(key, mode = "race") {
    const m = metalData();
    const r = m.reality && m.reality[key];
    if (!r || r.rate === null || r.rate === undefined) return "";
    if (mode === "race") {
      // Highlight only when both the 2003-2018 and the 2019-2023 halves sit at least 3 points from a coin flip, same side.
      const edge = Math.min(Math.abs(r.dev - 0.5), Math.abs(r.val - 0.5)) >= 0.03 && Math.sign(r.dev - 0.5) === Math.sign(r.val - 0.5);
      return `<span class="hist${edge ? " edge" : ""}" title="২০০৩–২০২৩, ${fmtInt.format(r.n)}টি ঘটনা">ইতিহাসে ${pct(r.rate, 0)} · কয়েন টস ৫০%</span>`;
    }
    const c = m.reality[`${key}_control`];
    return `<span class="hist" title="২০০৩–২০২৩, ${fmtInt.format(r.n)}টি ঘটনা">ছুঁয়েছে ${pct(r.rate, 0)} · উল্টো দিকে ${pct(c.rate, 0)}</span>`;
  }

  // ---------------------------------------------------------------- chart
  function buildChart() {
    const m = metalData();
    const el = $("chart");
    let range = null;
    if (state.chart) {
      if (state.chartMetal === state.metal) range = state.chart.timeScale().getVisibleLogicalRange();
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
        locale: "bn-BD",
        timeFormatter: (t) => fmtDateTime.format(new Date(t * 1000)),
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
    candles.setData(m.bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
    state.chart = chart;
    state.chartMetal = state.metal;
    state.candles = candles;
    state.planLines = [];
    state.formingBar = m.bars.length && !m.bars[m.bars.length - 1].complete ? { ...m.bars[m.bars.length - 1] } : null;

    if (state.layers.structure && m.read) {
      const markers = m.read.swings.map((s) => ({
        time: s.time, position: s.kind === "high" ? "aboveBar" : "belowBar", shape: "circle", size: 0.4,
        color: (s.label === "HH" || s.label === "HL") ? css("--up") : css("--down"), text: s.label,
      })).sort((a, b) => a.time - b.time);
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
    const shown = window.matchMedia("(max-width: 640px)").matches ? 30 : 60;
    const n = m.bars.length;
    chart.timeScale().setVisibleLogicalRange(range || { from: Math.max(0, n - shown), to: n + 5 });
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestDraw());
    applyLiveToChart();
    updatePlanLines();
    requestDraw();
  }

  function applyLiveToChart() {
    const tick = state.live[state.metal];
    const bar = state.formingBar;
    if (!tick || !bar || !state.candles) return;
    const now = Date.now() / 1000;
    if (now >= bar.time + 4 * 3600) return;           // the forming bar has ended; wait for the next data refresh
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
    add(p.entry, css("--ink"), p.mode === "pullback" ? "লিমিট এন্ট্রি" : "এন্ট্রি", 2);
    add(p.sl, css("--down"), "স্টপ লস");
    add(p.tp1.price, css("--up"), "TP1");
    if (p.tp2) add(p.tp2.price, css("--up"), "TP2");
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
        label(zone.kind === "fvg" ? "FVG" : zone.direction > 0 ? "চাহিদা" : "সরবরাহ", x1 + 4, Math.min(y1, y2) + 12, `rgba(${rgb}, 1)`);
      }
      const r = m.read.range;
      if (r) {
        const y = Y(r.mid);
        if (y !== null) {
          ctx.strokeStyle = `rgba(${css("--ink-rgb")}, 0.35)`; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.setLineDash([]);
          label("৫০% · উপরে প্রিমিয়াম, নিচে ডিসকাউন্ট", 6, y - 4, `rgba(${css("--ink-rgb")}, 0.55)`);
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
        label(`${p.names[0]}${p.names.length > 1 ? " +" + bn(p.names.length - 1) : ""} · স্টপ`, plotW - 6, p.side === "above" ? y - 4 : y + 13, `rgba(${rgb}, 1)`, "right");
      }
      for (const p of pools(m, true).filter((q) => q.swept).slice(0, 1)) {
        const y = Y(p.price);
        if (y === null) continue;
        ctx.strokeStyle = `rgba(${rgb}, 0.35)`; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.setLineDash([]);
        label(`${p.names[0]} · সুইপ হয়েছে`, plotW - 6, y + 13, `rgba(${rgb}, 0.75)`, "right");
      }
    }

    if (state.layers.structure) {
      for (const b of m.read.breaks.slice(-3)) {
        const x1 = X(b.from), x2 = X(b.time), y = Y(b.level);
        if (x1 === null || x2 === null || y === null) continue;
        const color = b.direction > 0 ? css("--up") : css("--down");
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(b.kind === "CHoCH" ? [4, 3] : []);
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke(); ctx.setLineDash([]);
        label(b.kind, (x1 + x2) / 2, b.direction > 0 ? y - 4 : y + 12, color, "center");
      }
    }

    const p = state.planResult;
    if (state.layers.plan && p && p.ok) {
      const last = m.bars[m.bars.length - 1];
      const xl = X(last.time);
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
        label(`ঝুঁকি ${usd(p.riskUsd)}`, x0 + 6, (ye + ys) / 2 + 4, css("--down"));
        label(`লাভ ${usd(p.tp1.profit)}${p.tp2 ? " / " + usd(p.tp2.profit) : ""}`, x0 + 6, (ye + yt) / 2 + 4, css("--up"));
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- market reading
  function renderStory() {
    const m = metalData();
    if (!m || !m.read) return;
    const r = m.read, metal = state.metal, price = currentPrice();
    const tf = [["1d", "দৈনিক"], ["4h", "৪ ঘণ্টা"], ["1h", "১ ঘণ্টা"]];
    $("mtf").innerHTML = tf.map(([k, name]) => `<span class="trend ${r.trend[k].key}">${name} <b>${esc(r.trend[k].bn)}</b></span>`).join("");
    const items = [];
    const keys = tf.map(([k]) => r.trend[k].key);
    if (keys.every((k) => k === "up")) items.push(["up", "তিনটি টাইমফ্রেমেই কাঠামো ঊর্ধ্বমুখী: উঁচু চূড়া ও উঁচু তল তৈরি হচ্ছে, ক্রেতারা নিয়ন্ত্রণে।", hist("race_trend_aligned")]);
    else if (keys.every((k) => k === "down")) items.push(["down", "তিনটি টাইমফ্রেমেই কাঠামো নিম্নমুখী: নিচু চূড়া ও নিচু তল তৈরি হচ্ছে, বিক্রেতারা নিয়ন্ত্রণে।", hist("race_trend_aligned")]);
    else items.push(["", `টাইমফ্রেমগুলো একমত নয় (দৈনিক ${r.trend["1d"].bn}, ৪ ঘণ্টা ${r.trend["4h"].bn}, ১ ঘণ্টা ${r.trend["1h"].bn})। এমন সময়ে দাম প্রায়ই দুই দিকেই ঝাঁকুনি দেয়।`, ""]);

    const lb = r.trend["4h"].last_break;
    if (lb) {
      const up = lb.direction > 0;
      const what = lb.kind === "BOS" ? "কাঠামো ভেঙেছে (BOS): চলমান প্রবণতা আরও এগিয়েছে" : "চরিত্র বদল (CHoCH): আগের প্রবণতার বিপরীতে প্রথম ভাঙন";
      items.push([up ? "up" : "down", `${esc(fmtDateTime.format(new Date(lb.time * 1000)))}-এর ক্যান্ডেল <b>${money(lb.level, metal)}</b> এর ${up ? "উপরে" : "নিচে"} বন্ধ হয়ে ${what}।`,
        hist(lb.kind === "BOS" ? "race_bos" : "race_choch")]);
    }
    if (r.range) {
      const pos = (price - r.range.low) / (r.range.high - r.range.low);
      const where = pos > 1 ? "পরিসরের উপরে বেরিয়ে গেছে" : pos < 0 ? "পরিসরের নিচে বেরিয়ে গেছে"
        : pos >= 0.5 ? "উপরের অর্ধেকে, অর্থাৎ প্রিমিয়ামে (কেনার জন্য দামি, বেচার জন্য ভালো জায়গা)" : "নিচের অর্ধেকে, অর্থাৎ ডিসকাউন্টে (কেনার জন্য সস্তা, বেচার জন্য খারাপ জায়গা)";
      items.push(["gold", `দাম সাম্প্রতিক পরিসরের (<b>${money(r.range.low, metal)}</b> – <b>${money(r.range.high, metal)}</b>) ${where}।`, hist("race_discount_premium")]);
    }
    const near = nearestPools(m, price, 1);
    const poolKey = (p) => p.kind === "equal" ? "magnet_equal_levels" : p.kind === "pdh" ? "magnet_pdh" : p.kind === "pdl" ? "magnet_pdl" : null;
    for (const [p, dir] of [[near.above[0], "উপরে"], [near.below[0], "নিচে"]]) {
      if (!p) continue;
      const who = p.side === "above" ? "বিক্রেতাদের স্টপ ও ব্রেকআউট ক্রেতাদের অর্ডার" : "ক্রেতাদের স্টপ ও ব্রেকডাউন বিক্রেতাদের অর্ডার";
      const k = poolKey(p);
      items.push(["liq", `${dir} <b>${money(p.price, metal)}</b>: ${esc(p.names.join(" ও "))}। এর ওপারে ${who} জমে থাকে, বড় খেলোয়াড়রা প্রায়ই এমন জায়গা ছুঁয়ে যায়।`, k ? hist(k, "magnet") : ""]);
    }
    const swept = pools(m, true).filter((p) => p.swept);
    for (const p of swept.slice(0, 1)) {
      items.push(["warn", `দাম ইতিমধ্যে ${esc(p.names.join(" ও "))} (<b>${money(p.price, metal)}</b>) পেরিয়ে সেখানকার স্টপ তুলে নিয়েছে। এখন দেখার বিষয় দাম ফিরে আসে (স্টপ হান্ট) নাকি এগিয়ে যায় (ব্রেকআউট)।`, hist("race_sweep_reversal")]);
    }
    const z = nearestZones(m, price, 1);
    for (const [zone, dir] of [[z.below[0], "নিচে"], [z.above[0], "উপরে"]]) {
      if (!zone) continue;
      items.push(["fvg", `${dir} <b>${money(zone.bottom, metal)}</b> – <b>${money(zone.top, metal)}</b>: ${zoneName(zone)}। দাম ফিরে এলে এখানে প্রতিক্রিয়া দেখাতে পারে।`,
        hist(zone.kind === "fvg" ? "race_fvg_first_test" : "race_ob_first_test")]);
    }
    const f = m.forecast;
    if (f && forecastFresh(f)) {
      items.push(["gold", `আমাদের পরীক্ষিত মডেল: আগামী ৪ ঘণ্টায় ৮০% সম্ভাবনায় দাম <b>${money(f.quantiles_price.q100, metal)}</b> – <b>${money(f.quantiles_price.q900, metal)}</b> এর মধ্যে থাকবে।`,
        `<span class="hist edge">পরীক্ষায় ${pct(m.exam.coverage["80"])} সঠিক</span>`]);
    }
    const ev = (state.data.events || []).find((e) => new Date(e.time_utc).getTime() > Date.now());
    if (ev) {
      const dt = new Date(ev.time_utc).getTime() - Date.now();
      if (dt < 24 * 3600e3) items.push(["warn", `${relative(dt)} পরে ${esc(ev.name)}। খবরের সময় দাম হঠাৎ লাফ দেয়, কাছের স্টপ সহজে কেটে যায়।`, ""]);
    }
    $("story").innerHTML = items.map(([ic, text, h]) => `<li><span class="ic ${ic}"></span><span>${text}</span>${h || "<span></span>"}</li>`).join("");
  }

  function renderMacro() {
    const m = metalData();
    if (!m || !m.macro) return;
    const mc = m.macro;
    $("macro").innerHTML = mc.items.map((it) => `<li><span class="dot ${it.effect}"></span><span><span class="lab">${esc(it.label)}</span><span class="val">${esc(bn(it.value))}</span>
      <span class="txt">${esc(it.text)}</span></span></li>`).join("") || `<li><span></span><span class="txt">পটভূমির তথ্য পাওয়া যায়নি।</span></li>`;
    $("macro-note").textContent = `${mc.as_of ? bn(mc.as_of) + " পর্যন্ত। " : ""}সবুজ = সাধারণত পক্ষে, লাল = বিপক্ষে। আমাদের পরীক্ষায় এগুলো দিয়ে এক সপ্তাহ বা এক মাসের দিক আগাম বলা যায়নি: এগুলো পটভূমি, সংকেত নয়।`;
  }

  // ---------------------------------------------------------------- trade planner
  function computePlan() {
    const m = metalData();
    if (!m || !m.read) return { ok: false, why: "চার্টের তথ্য এখনও তৈরি হয়নি।" };
    const P = state.plan, metal = state.metal, r = m.read, f = m.forecast && forecastFresh(m.forecast) ? m.forecast : null;
    const side = P.side, long = side > 0, atrv = r.atr_4h, spread = r.spread_typical || 0;
    const price = currentPrice();
    const buf = Math.max(0.25 * atrv, 3 * spread);
    let entry = price, mode = "now", zone = null, entryWhy = "এখনকার বাজার দামে";
    if (P.mode === "pullback") {
      const zs = r.zones.filter((z) => z.direction === side && (long ? z.top < price : z.bottom > price) && Math.abs((long ? z.top : z.bottom) - price) <= 3 * atrv)
        .sort((a, b) => long ? b.top - a.top : a.bottom - b.bottom);
      if (zs.length) {
        zone = zs[0]; mode = "pullback"; entry = long ? zone.top : zone.bottom;
        entryWhy = `দাম ফিরে এলে ${zoneName(zone)} এর কিনারায় লিমিট অর্ডার`;
      } else entryWhy = "কাছে কোনো উপযুক্ত অঞ্চল নেই, তাই বাজার দামে";
    }
    // Stop: beyond the swing that protects the idea, with a buffer; never inside normal 4h noise.
    const guard = r.swings.filter((s) => s.kind === (long ? "low" : "high") && (long ? s.price < entry : s.price > entry)).sort((a, b) => b.time - a.time)[0];
    let sl, slWhy;
    if (guard) { sl = guard.price - side * buf; slWhy = `সর্বশেষ ${guard.label} (${money(guard.price, metal)}) এর ${long ? "নিচে" : "উপরে"}, একটু ফাঁক রেখে`; }
    else { sl = entry - side * 1.5 * atrv; slWhy = "কাছে কোনো কাঠামো নেই, তাই ১.৫ গুণ ATR দূরে"; }
    if (zone) {
      const beyond = long ? zone.bottom - buf : zone.top + buf;
      if (long ? beyond < sl : beyond > sl) { sl = beyond; slWhy = "অঞ্চলের ওপারে, একটু ফাঁক রেখে"; }
    }
    let widened = false;
    if (f) {
      const noise = entry * Math.exp(long ? f.quantiles_return.q100 : f.quantiles_return.q900);
      const limit = noise - side * buf;
      if (long ? sl > limit : sl < limit) { sl = limit; widened = true; slWhy += "; স্বাভাবিক ৪ ঘণ্টার ওঠানামার বাইরে সরানো হয়েছে"; }
    }
    const risk = Math.abs(entry - sl);
    if (!(risk > 0)) return { ok: false, why: "স্টপ হিসাব করা যায়নি।" };

    // Targets: resting liquidity and opposing zones on the profit side, taken slightly before the level.
    const cands = [];
    for (const p of pools(m)) if (long ? p.price > entry : p.price < entry) cands.push({ level: p.price, why: `${p.names.join(" ও ")}: স্টপ জমে আছে` });
    for (const z of r.zones) if (z.direction === -side && (long ? z.bottom > entry : z.top < entry)) cands.push({ level: long ? z.bottom : z.top, why: `${zoneName(z)} শুরু` });
    if (r.range) { const lv = long ? r.range.high : r.range.low; if (long ? lv > entry : lv < entry) cands.push({ level: lv, why: "সাম্প্রতিক পরিসরের প্রান্ত" }); }
    for (const lv of r.round_levels) if (long ? lv > entry : lv < entry) cands.push({ level: lv, why: "রাউন্ড নম্বর" });
    cands.sort((a, b) => side * (a.level - b.level));
    const merged = [];
    for (const c of cands) {
      const prev = merged[merged.length - 1];
      if (prev && Math.abs(prev.level - c.level) < 0.2 * atrv) { if (!prev.why.includes(c.why)) prev.why += `; ${c.why}`; } else merged.push({ ...c });
    }
    const asTarget = (c) => ({ price: c.level - side * 0.1 * atrv, why: `${c.why} (একটু আগে লাভ তোলা)`, level: c.level });
    let tp1 = merged.map(asTarget).find((t) => Math.abs(t.price - entry) >= risk);
    if (!tp1) tp1 = { price: entry + side * 1.5 * risk, why: "কাছে কোনো স্টপের জায়গা নেই: ঝুঁকির ১.৫ গুণ" };
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
    const t4 = r.trend["4h"].key, td = r.trend["1d"].key, want = long ? "up" : "down", against = long ? "down" : "up";
    if (t4 === want && td === want) checks.push(["in", "✓", "৪ ঘণ্টা ও দৈনিক প্রবণতার সাথে", hist("race_trend_aligned")]);
    else if (t4 === against && td === against) checks.push(["wa", "!", "৪ ঘণ্টা ও দৈনিক প্রবণতার বিপরীতে: পাল্টা ট্রেড, তাই লক্ষ্য কাছে রাখুন", hist("race_trend_aligned")]);
    else checks.push(["in", "·", "প্রবণতা মিশ্র", ""]);
    if (r.range) {
      const pos = (entry - r.range.low) / (r.range.high - r.range.low);
      const good = long ? pos < 0.5 : pos > 0.5;
      checks.push(["in", good ? "✓" : "·", good ? (long ? "ডিসকাউন্টে কিনছেন (সস্তা জায়গা)" : "প্রিমিয়ামে বেচছেন (দামি জায়গা)") : (long ? "প্রিমিয়ামে কিনছেন (দামি জায়গা)" : "ডিসকাউন্টে বেচছেন (সস্তা জায়গা)"), hist("race_discount_premium")]);
    }
    checks.push(widened ? ["ok", "✓", "কাঠামোর স্টপ স্বাভাবিক ওঠানামার ভেতরে ছিল, তাই নিরাপদ দূরত্বে সরানো হয়েছে", ""]
      : ["ok", "✓", f ? "স্টপ স্বাভাবিক ৪ ঘণ্টার ওঠানামার বাইরে" : "স্টপ কাঠামোর ওপারে", ""]);
    checks.push(tp1.r >= 1.5 ? ["ok", "✓", `ঝুঁকি:লাভ ১:${fmtR.format(tp1.r)} (TP1)`, ""] : tp1.r >= 1 ? ["wa", "!", `ঝুঁকি:লাভ মাত্র ১:${fmtR.format(tp1.r)}`, ""] : ["no", "✗", `ঝুঁকি:লাভ ১:${fmtR.format(tp1.r)}, লাভের চেয়ে ঝুঁকি বেশি`, ""]);
    const ev = (state.data.events || []).find((e) => new Date(e.time_utc).getTime() > Date.now());
    const evIn = ev ? new Date(ev.time_utc).getTime() - Date.now() : Infinity;
    if (evIn < 3600e3) checks.push(["no", "✗", `${relative(evIn)} পরে ${ev.name}: খবরের ঠিক আগে নতুন ট্রেড নেবেন না`, ""]);
    else if (evIn < 4 * 3600e3) checks.push(["wa", "!", `${relative(evIn)} পরে ${ev.name}: তার আগে লাভ তুলুন বা স্টপ এন্ট্রিতে আনুন`, ""]);
    else checks.push(["ok", "✓", "আগামী ৪ ঘণ্টায় বড় মার্কিন খবর নেই", ""]);
    const sp = spreadUsd / riskUsd;
    checks.push(sp < 0.05 ? ["ok", "✓", `স্প্রেড খরচ ঝুঁকির ${pct(sp, 0)}`, ""] : sp < 0.15 ? ["wa", "!", `স্প্রেড খরচ ঝুঁকির ${pct(sp, 0)}`, ""] : ["no", "✗", `স্প্রেড খরচ ঝুঁকির ${pct(sp, 0)}: স্টপ খুব কাছে`, ""]);
    const rb = riskUsd / budget;
    if (minLot && rb > 0.03) checks.push(["no", "✗", `বাজেট কম: ন্যূনতম ০.০১ লটেও ঝুঁকি বাজেটের ${pct(rb)}`, ""]);
    else if (minLot) checks.push(["wa", "!", `ন্যূনতম ০.০১ লট: ঝুঁকি বাজেটের ${pct(rb)}`, ""]);
    else checks.push(["ok", "✓", `ঝুঁকি বাজেটের ${pct(rb)}`, ""]);
    if (margin > budget) checks.push(["no", "✗", `মার্জিন ${usd(margin)} বাজেটের চেয়ে বেশি`, ""]);
    else if (margin > 0.5 * budget) checks.push(["wa", "!", `মার্জিন ${usd(margin)}, বাজেটের অর্ধেকের বেশি`, ""]);
    if (f && f.mood && f.mood.key === "extreme") checks.push(["wa", "!", "বাজার অত্যন্ত অস্থির: লট কমান", ""]);
    const nNo = checks.filter((c) => c[0] === "no").length, nWa = checks.filter((c) => c[0] === "wa").length;
    const verdict = nNo ? ["avoid", "এই পরিকল্পনা এড়িয়ে চলুন"] : nWa >= 2 ? ["care", "সাবধানে: নিচের সতর্কতাগুলো দেখুন"] : ["good", "পরিকল্পনা ঝুঁকির নিয়ম মেনে চলছে"];
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
    const sideWord = p.side > 0 ? "কিনুন" : "বেচুন";
    const lvl = (cls, k, price, s) => `<div class="lvl ${cls}"><div class="k">${k}</div><div class="p">${money(price, metal)}</div><div class="s">${esc(s)}</div></div>`;
    const half = p.lots >= 0.02;
    const halfLots = Math.floor(p.lots * 50 + 1e-9) / 100;
    const calib = metalData().reality.planner_tp2_sl1;
    const steps = [
      `${p.mode === "pullback" ? "লিমিট অর্ডারে" : "বাজার দামে"} ${sideWord}: <b>${money(p.entry, metal)}</b>, <b>${fmtLot.format(p.lots)}</b> লট।`,
      `স্টপ লস <b>${money(p.sl, metal)}</b> এ সাথে সাথে বসান। লোকসান বাড়লে স্টপ কখনো দূরে সরাবেন না।`,
      half ? `TP1 <b>${money(p.tp1.price, metal)}</b> এ <b>${fmtLot.format(halfLots)}</b> লট বন্ধ করুন এবং স্টপ এন্ট্রিতে আনুন: বাকি ট্রেড তখন ঝুঁকিমুক্ত।`
        : `TP1 <b>${money(p.tp1.price, metal)}</b> এ পুরো ট্রেড বন্ধ করুন (লট ছোট, ভাগ করা যায় না)।`,
      p.tp2 && half ? `বাকি অংশ TP2 <b>${money(p.tp2.price, metal)}</b> এ, অথবা প্রতিটি নতুন ${p.side > 0 ? "উঁচু তলের নিচে" : "নিচু চূড়ার উপরে"} স্টপ টেনে আনুন।` : null,
      "২৪ ঘণ্টায় কোনোটি না হলে বা কাঠামো উল্টে গেলে (বিপরীত CHoCH) ট্রেড আবার বিবেচনা করুন।",
      p.event ? `${esc(p.event.name)} (${esc(fmtDateTime.format(new Date(p.event.time_utc)))}) এর আগে লাভ তুলুন বা স্টপ এন্ট্রিতে আনুন।` : null,
    ].filter(Boolean);
    out.innerHTML = `
      <div class="plan-verdict ${p.verdict[0]}"><div class="v">${p.verdict[1]}</div>
        <div class="note">স্টপের আগে TP1 ছোঁয়ার সম্ভাবনা ${pct(p.tp1.win, 0)} · ঝুঁকি:লাভ ১:${fmtR.format(p.tp1.r)}। দিক নিয়ে কোনো প্রমাণিত সুবিধা নেই, তাই এই সম্ভাবনা শুধু দূরত্ব থেকে আসে${calib ? `; ইতিহাসে মিলেছে (২:১ লক্ষ্যে ${pct(calib.rate, 0)}, হিসাবে ৩৩%)` : ""}।</div></div>
      <div class="levels">
        ${lvl("entry", p.mode === "pullback" ? "লিমিট এন্ট্রি" : "এন্ট্রি", p.entry, p.entryWhy)}
        ${lvl("sl", "স্টপ লস", p.sl, p.slWhy)}
        ${lvl("tp", `TP1 · ১:${fmtR.format(p.tp1.r)}`, p.tp1.price, p.tp1.why)}
        ${p.tp2 ? lvl("tp", `TP2 · ১:${fmtR.format(p.tp2.r)}`, p.tp2.price, p.tp2.why) : `<div class="lvl"><div class="k">TP2</div><div class="p">—</div><div class="s">আরও দূরে উপযুক্ত লক্ষ্য নেই</div></div>`}
      </div>
      <div class="facts">
        <div class="fact"><div class="k">লট সাইজ</div><div class="p">${fmtLot.format(p.lots)}</div></div>
        <div class="fact"><div class="k">স্টপ লাগলে ক্ষতি</div><div class="p down">${usd(p.riskUsd)}</div></div>
        <div class="fact"><div class="k">TP1 / TP2 এ লাভ</div><div class="p up">${usd(p.tp1.profit)}${p.tp2 ? " / " + usd(p.tp2.profit) : ""}</div></div>
        <div class="fact"><div class="k">৪ ঘণ্টায় TP1 ছোঁয়ার সম্ভাবনা</div><div class="p">${p.tp1.touch === null ? "—" : pct(p.tp1.touch, 0)}</div></div>
        <div class="fact"><div class="k">মার্জিন লাগবে</div><div class="p">${usd(p.margin)}</div></div>
        <div class="fact"><div class="k">আনুমানিক স্প্রেড খরচ</div><div class="p">${usd(p.spreadUsd)}</div></div>
      </div>
      <h3>যাচাই তালিকা</h3>
      <ul class="checks">${p.checks.map(([cls, mark, text, h]) => `<li><span class="${cls}">${mark}</span><span>${esc(text)} ${h}</span></li>`).join("")}</ul>
      <h3>ট্রেড চালানোর ধাপ</h3>
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
      if (!isFinite(budget) || budget < 10) { $("budget-error").textContent = "কমপক্ষে ১০ ডলার লিখুন"; return; }
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
    $("metal-name").textContent = NAMES[state.metal];
    const tick = state.live[state.metal];
    const price = currentPrice();
    $("price").textContent = money(price, state.metal);
    if (tick && tick.open24) {
      const diff = price - tick.open24, rel = diff / tick.open24;
      $("change").innerHTML = `<span class="${diff >= 0 ? "up" : "down"}">${money(diff, state.metal, true)} (${diff >= 0 ? "+" : "−"}${pct(Math.abs(rel), 2).replace("+", "")})</span> <span class="note">২৪ ঘণ্টায়</span>`;
    } else {
      $("change").innerHTML = `<span class="note">সর্বশেষ ঘণ্টার দাম · ${fmtDateTime.format(new Date(m.data_until))}</span>`;
    }
    const f = m.forecast;
    const chips = [];
    if (!f) {
      const next = new Date(new Date(state.data.next_bar_close_utc).getTime() + 7 * 60e3);
      $("verdict").textContent = `প্রথম লাইভ পূর্বাভাস প্রকাশিত হবে ঢাকা সময় ${fmtTime.format(next)}-এ।`;
    } else {
      const q = f.quantiles_price;
      const stale = !forecastFresh(f);
      $("verdict").innerHTML = stale
        ? `নতুন পূর্বাভাসের অপেক্ষায়। সর্বশেষ পূর্বাভাস (${esc(fmtDateTime.format(new Date(f.decision_time)))}): ৮০% সম্ভাবনায় <b>${money(q.q100, state.metal)}</b> থেকে <b>${money(q.q900, state.metal)}</b>।`
        : `${NAMES[state.metal]}র দাম ৮০% সম্ভাবনায় <b>${money(q.q100, state.metal)}</b> থেকে <b>${money(q.q900, state.metal)}</b> এর মধ্যে থাকবে।`;
      const mood = f.mood;
      const moodText = { calm: "স্বাভাবিকের চেয়ে কম ওঠানামা", normal: "সাধারণ ওঠানামা", volatile: "স্বাভাবিকের চেয়ে বড় ওঠানামা", extreme: "বছরের সবচেয়ে বড় ওঠানামার মধ্যে" }[mood.key];
      chips.push(`<span class="chip ${mood.key}"><i></i>বাজার: ${esc(mood.label)} <span>${moodText}</span></span>`);
      if (f.event_in_next_bar) chips.push(`<span class="chip news"><i></i>খবরের ঝুঁকি <span>এই ৪ ঘণ্টায় গুরুত্বপূর্ণ মার্কিন খবর</span></span>`);
    }
    $("chips").innerHTML = chips.join("");
    renderNext();
  }

  function renderNext() {
    if (!state.data) return;
    let next = new Date(state.data.next_bar_close_utc).getTime() + 7 * 60e3;
    while (next < Date.now()) next += 4 * 3600e3;
    $("next-update").textContent = `পরবর্তী পূর্বাভাস: ঢাকা ${fmtTime.format(new Date(next))} · ${relative(next - Date.now())} পরে`;
  }

  function renderCards() {
    const m = metalData();
    const f = m && m.forecast;
    const metal = state.metal;
    const rangeRows = f ? [
      ["৫০% সম্ভাবনা", "অর্ধেক সময় দাম এর ভেতরে", f.quantiles_price.q250, f.quantiles_price.q750],
      ["৮০% সম্ভাবনা", "প্রতি ১০ বারে ৮ বার", f.quantiles_price.q100, f.quantiles_price.q900],
      ["৯৫% সম্ভাবনা", "প্রায় নিশ্চিত সীমা", f.quantiles_price.q025, f.quantiles_price.q975],
    ].map(([k, s, lo, hi]) => `<tr><td>${k}<small>${s}</small></td><td>${money(lo, metal)} – ${money(hi, metal)}</td></tr>`).join("")
      : `<tr><td>প্রথম পূর্বাভাসের অপেক্ষায়</td><td>—</td></tr>`;
    $("range-table").querySelector("tbody").innerHTML = rangeRows;

    const touchRows = f ? Object.values(f.touch_levels).map((t) =>
      `<tr><td>${pct(t.probability_each, 0)} সম্ভাবনা<small>প্রতিটি দিকে</small></td><td>↑ ${money(t.up, metal)}<br>↓ ${money(t.down, metal)}</td></tr>`).join("")
      : `<tr><td>—</td><td>—</td></tr>`;
    $("touch-table").querySelector("tbody").innerHTML = touchRows;

    const events = state.data.events || [];
    $("events").querySelector("tbody").innerHTML = events.length ? events.slice(0, 8).map((e) => {
      const t = new Date(e.time_utc).getTime();
      return `<tr><td>${esc(e.name)}</td><td class="num">${esc(fmtDateTime.format(new Date(t)))}</td><td class="note">${relative(t - Date.now())} পরে</td></tr>`;
    }).join("") : `<tr><td class="note">আগামী ১০ দিনে কোনো উচ্চ প্রভাবের খবর নেই।</td></tr>`;
  }

  function renderRecord() {
    const m = metalData();
    if (!m) return;
    const lr = m.live_record, ex = m.exam, va = m.validation;
    const stat = (k, v, s = "") => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
    const covered = (v) => v === null || v === undefined ? "—" : pct(v);
    const started = "২৩ অক্টোবর ২০২৬ থেকে";
    $("stats").innerHTML = [
      `<div class="stat-group">লাইভ রেকর্ড · ${NAMES[state.metal]} <small>${started}, সব পূর্বাভাস ফলাফলের আগে প্রকাশিত</small></div>`,
      stat("মোট পূর্বাভাস", fmtInt.format(lr.forecasts || 0), lr.missed ? `${fmtInt.format(lr.missed)}টি বাদ পড়েছে` : "কোনোটি বাদ পড়েনি"),
      stat("মূল্যায়িত", fmtInt.format(lr.scored_on_time || 0), "সময়মতো প্রকাশিত"),
      stat("৮০% পরিসর সঠিক", covered(lr.coverage && lr.coverage["80"]), "লক্ষ্য ৮০%"),
      stat("৯৫% পরিসর সঠিক", covered(lr.coverage && lr.coverage["95"]), "লক্ষ্য ৯৫%"),
      `<div class="stat-group">চূড়ান্ত পরীক্ষা ২০২৪–২০২৬ <small>${fmtInt.format(ex.rows)}টি পূর্বাভাস, মডেল কখনো এই ডেটা দেখেনি</small></div>`,
      stat("৮০% পরিসর সঠিক", pct(ex.coverage["80"]), "লক্ষ্য ৮০%"),
      stat("৯৫% পরিসর সঠিক", pct(ex.coverage["95"]), "লক্ষ্য ৯৫%"),
      stat("খবরের সময় ৮০%", pct(ex.coverage_news_80), `প্রচলিত মডেল: ${pct(ex.baseline_news_80)}`),
      stat("নির্ভুলতা", "+" + pct(ex.accuracy_gain_vs_ewma), "প্রচলিত ব্যাংক মডেলের চেয়ে"),
      `<div class="stat-group">যাচাই ২০১৯–২০২৩ <small>${fmtInt.format(va.rows)}টি পূর্বাভাস</small></div>`,
      stat("৮০% পরিসর সঠিক", pct(va.coverage["80"]), "লক্ষ্য ৮০%"),
      stat("৯৫% পরিসর সঠিক", pct(va.coverage["95"]), "লক্ষ্য ৯৫%"),
      stat("খবরের সময় ৮০%", pct(va.coverage_news_80), `প্রচলিত মডেল: ${pct(va.baseline_news_80)}`),
      stat("নির্ভুলতা", "+" + pct(va.accuracy_gain_vs_ewma), "প্রচলিত ব্যাংক মডেলের চেয়ে"),
    ].join("");

    $("history-metal").textContent = NAMES[state.metal];
    const rows = (m.history || []).slice().reverse().map((h) => {
      const tag = h.next_close === null || h.next_close === undefined
        ? `<span class="tag wait">অপেক্ষমাণ</span>`
        : (h.inside80 ? `<span class="tag hit">✓ ভেতরে</span>` : `<span class="tag miss">✗ বাইরে</span>`);
      return `<tr><td>${esc(fmtDateTime.format(new Date(h.decision_time)))}</td><td class="num">${money(h.price, state.metal)}</td>
        <td class="num">${money(h.bands.q100, state.metal)} – ${money(h.bands.q900, state.metal)}</td>
        <td class="num">${money(h.next_close, state.metal)}</td><td>${tag}</td></tr>`;
    }).join("");
    $("history").querySelector("tbody").innerHTML = rows || `<tr><td colspan="5" class="note">প্রথম পূর্বাভাসের ফলাফল ৪ ঘণ্টা পরে এখানে দেখাবে।</td></tr>`;

    const led = state.data.ledger;
    $("ledger-ok").textContent = led.ok ? "যাচাই সম্পন্ন: সব হ্যাশ মিলেছে" : "সমস্যা: হ্যাশ মেলেনি";
    $("ledger-ok").className = led.ok ? "up" : "down";
    $("ledger-count").textContent = fmtInt.format(led.entries);
    $("ledger-head").textContent = led.head;
    $("generated").textContent = `শেষ হালনাগাদ ${fmtDateTime.format(new Date(state.data.generated_utc))}`;
  }

  function renderAll() {
    renderHero();
    renderStory();
    renderCards();
    renderMacro();
    renderRecord();
    renderPlanner(true);
    buildChart();
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
    el.querySelector("b").textContent = age < 20e3 ? "লাইভ" : age < 180e3 ? "বিলম্বিত" : "লাইভ দাম পাওয়া যাচ্ছে না";
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
    $("clock").textContent = `ঢাকা ${fmtTime.format(now)} · UTC ${fmtUtc.format(now)}`;
    updateLiveStatus();
  }

  function selectMetal(metal) {
    state.metal = metal;
    for (const btn of document.querySelectorAll(".switch button")) btn.setAttribute("aria-selected", String(btn.dataset.metal === metal));
    if (state.data) renderAll();
  }

  for (const btn of document.querySelectorAll(".switch button")) btn.addEventListener("click", () => selectMetal(btn.dataset.metal));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => buildChart());
  new ResizeObserver(() => requestDraw()).observe($("chart"));
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
