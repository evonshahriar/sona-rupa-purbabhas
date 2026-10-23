# Pre-registration — CP-1: do "smart money" chart patterns predict gold and silver? Out-of-sample exam 2024–2026

Registered 2026-10-24, before any chart-pattern statistic was computed on 2024 or later data. Rules are frozen;
a change means a new registration (CP-2) and CP-1 stays reported as registered. The SHA-256 of this file is
published with the public site (`research/PREREGISTRATION_CHART_PATTERNS.md` in the site repository) before the
exam is run, so the commit timestamp shows the order.

## 1. Question
Retail price-action teaching ("smart money concepts", ICT, market structure) claims that structure breaks,
change of character, liquidity sweeps, fair value gaps, order blocks, premium/discount and multi-timeframe trend
agreement tell the next move, and that prior highs/lows and gaps act as magnets. On 2003–2023 (development
2003-05..2018, validation 2019–2023; `research/CHART_READING.md`) every such pattern was within about 5 points of
its control. CP-1 asks whether that null result holds on data the pattern statistics have never touched.

## 2. Data and code
- Dukascopy XAU/USD and XAG/USD hourly bid/ask mids, 2003-05-05 → 2026-09-30 (`DukascopyClient.load_hours`;
  complete months only). Patterns use the full history for warm-up; only events in the exam window are scored.
- **Exam window: events known from 2024-01-01 00:00 UTC to 2026-09-30 23:59 UTC.** Outcomes may use hourly bars up
  to 2026-09-30; a race unresolved by then is dropped (as any 5-day time-out is).
- Detection and scoring code is exactly `forecast.chart_read` and `forecast.chart_stats.analyse_tf` as of this
  registration (the code that produced the 2003–2023 tables and that the live site draws). No parameter changes:
  swing K (1h 3, 4h 2, 1d 2), ATR 14, equal-level tolerance 0.15 ATR, FVG minimum 0.25 ATR, 1-ATR races within
  120 hours, conservative zone fill rule (stop touched in the fill hour = loss).
- What 2024+ has been used for before: directional backtests of other rules (Phase 7 H5a exam) and the FC-1
  range-forecast exam; the live site has drawn these patterns on recent (Oct 2026) data. No chart-pattern outcome
  on 2024+ has been computed or looked at.

## 3. Hypotheses (2 metals × 2 chart timeframes, 4h and 1h)
- **Races (7 patterns, 28 tests):** BOS with the break, CHoCH with the break, daily+chart trend agree, discount in
  up-trend / premium in down-trend, sweep that closes back inside → reversal, first test of an FVG → bounce, first
  test of an order block → bounce. Statistic: exam win rate minus the exam control race rate (every bar, both
  directions).
- **Magnets (4 levels, 16 tests):** equal highs/lows touched within 5 days, FVG near edge revisited within 5 days,
  prior-day high touched the same day, prior-day low touched the same day. Statistic: exam touch rate minus the
  mirror-level touch rate for the same events (paired).
- **Planner calibration (3 checks per metal and timeframe):** target k ATR before stop 1 ATR, k = 1, 2, 3, against
  the random-walk value 1/(1+k).

## 4. Inference
- Standard errors are clustered by ISO calendar week (events within a week overlap in time). Races: difference
  vs control uses the control's standard error added in quadrature. Magnets: paired difference per event.
- Multiple testing: Bonferroni across the 44 race and magnet tests, two-sided alpha 0.05 → per-test 0.05/44
  (|z| ≥ 3.25).

## 5. Decision rules
- A pattern **has an edge in the exam** only if all hold: (a) |exam − control| ≥ 3.0 points; (b) |z| ≥ 3.25;
  (c) the same sign as both the development and the validation difference.
- **CP-1 confirms the null** if no race pattern meets the rule. Magnets are reported with the same rule; a magnet
  that passes is described as "touched more often than the mirror", never as a direction call.
- **Planner calibration holds** if every exam value is within 2.0 points of 1/(1+k) (gold and silver, 4h and 1h).
- Results are reported in full, whatever they are, in `research/CHART_PATTERNS_EXAM.md` and in the paper.

## 6. Predictions (registered)
All 28 race differences within ±5 points, none passing; magnets no better than the mirror; planner within
2 points of theory. A pass is possible and would be reported as such, with the caveat that one exam cannot be
re-run: 2024–2026 is spent for chart patterns after this registration.

## 7. Afterwards
Any later live record of these patterns (from 2026-10-24, fully clean) is descriptive and reported separately; it
never changes CP-1.
