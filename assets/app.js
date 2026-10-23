"use strict";
(() => {
  const DATA_URL = "data/site.json";
  const NAMES = { gold: "সোনা", silver: "রুপা" };
  const DIGITS = { gold: 2, silver: 3 };
  const FEED = { XAUUSDT: "gold", XAGUSDT: "silver" };
  const TZ = "Asia/Dhaka";
  const fmtInt = new Intl.NumberFormat("bn-BD");
  const fmtPct1 = new Intl.NumberFormat("bn-BD", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtPct0 = new Intl.NumberFormat("bn-BD", { style: "percent", maximumFractionDigits: 0 });
  const fmtTime = new Intl.DateTimeFormat("bn-BD", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtDateTime = new Intl.DateTimeFormat("bn-BD", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtUtc = new Intl.DateTimeFormat("bn-BD", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtDec = {};

  const state = { data: null, metal: "gold", live: { gold: null, silver: null }, wsFailures: 0, polling: null, chart: null };
  const $ = (id) => document.getElementById(id);

  function money(value, metal, signed = false) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    const d = DIGITS[metal];
    fmtDec[d] = fmtDec[d] || new Intl.NumberFormat("bn-BD", { minimumFractionDigits: d, maximumFractionDigits: d });
    const text = fmtDec[d].format(Math.abs(value));
    if (signed) return (value >= 0 ? "+" : "−") + "$" + text;
    return "$" + text;
  }
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

  function forecastFresh(f) {
    if (!f) return false;
    const end = new Date(f.decision_time).getTime() + 4 * 3600e3;
    return Date.now() < end + 45 * 60e3;
  }

  // ---------------------------------------------------------------- chart
  function buildChart() {
    const m = metalData();
    const el = $("chart");
    if (state.chart) { state.chart.remove(); state.chart = null; }
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
    });
    candles.setData(m.bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
    state.chart = chart;
    state.candles = candles;
    state.formingBar = m.bars.length && !m.bars[m.bars.length - 1].complete ? { ...m.bars[m.bars.length - 1] } : null;

    const f = m.forecast;
    if (f && forecastFresh(f)) {
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
      const q = f.quantiles_price;
      candles.createPriceLine({ price: q.q900, color: `rgba(${rgb}, 0.9)`, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "৮০% উপরে" });
      candles.createPriceLine({ price: q.q100, color: `rgba(${rgb}, 0.9)`, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "৮০% নিচে" });
    }
    // Open on the last few days so the projected cone is easy to see (drag or pinch to see more history).
    const shown = window.matchMedia("(max-width: 640px)").matches ? 24 : 42;
    const n = m.bars.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - shown), to: n + 5 });
    applyLiveToChart();
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

  // ---------------------------------------------------------------- panels
  function renderHero() {
    const m = metalData();
    if (!m) return;
    $("metal-name").textContent = NAMES[state.metal];
    const tick = state.live[state.metal];
    const lastBar = m.bars[m.bars.length - 1];
    const price = tick ? tick.price : lastBar.close;
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

    $("helper").innerHTML = f ? `
      <div><span class="side up">কিনলে (লং)</span>স্টপ লস <b>${money(f.helper.long_stop_below, metal)}</b> এর নিচে রাখুন; বাস্তবসম্মত লক্ষ্য <b>${money(f.helper.long_target_within, metal)}</b> পর্যন্ত।</div>
      <div><span class="side down">বেচলে (শর্ট)</span>স্টপ লস <b>${money(f.helper.short_stop_above, metal)}</b> এর উপরে রাখুন; বাস্তবসম্মত লক্ষ্য <b>${money(f.helper.short_target_within, metal)}</b> পর্যন্ত।</div>
      <p class="note">৯৫% সীমার ভেতরে স্টপ রাখলে স্বাভাবিক ওঠানামাতেই তা কেটে যাওয়ার ঝুঁকি বেশি। লক্ষ্য ৮০% সীমার বাইরে হলে ৪ ঘণ্টায় সেখানে পৌঁছানোর সম্ভাবনা কম।</p>`
      : `<p class="note">প্রথম পূর্বাভাস প্রকাশের পর এখানে স্টপ ও লক্ষ্যের স্তর দেখাবে।</p>`;

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
    renderCards();
    renderRecord();
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
    // The order-book stream ticks many times a second: repaint at most twice a second.
    if (metal === state.metal && Date.now() - lastPaint > 500) {
      lastPaint = Date.now();
      renderHero();
      applyLiveToChart();
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
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(renderNext, 30e3);
  setInterval(loadData, 5 * 60e3);
  loadData().then(() => { refreshOpen24(); connectSocket(); });
  setInterval(refreshOpen24, 60e3);
})();
