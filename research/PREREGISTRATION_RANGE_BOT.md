# Pre-registration — RB-1: can a spot bot make money from the FC-1 range forecast?

Registered 2026-10-26, before any strategy in this document was coded or run on any data. Rules are frozen; a change
means a new registration (RB-2) and RB-1 stays reported as registered. The SHA-256 of this file is published in the
public site repository (`research/`) before the backtest runs.

## 1. Question
FC-1 forecasts the distribution of the next 4-hour return and is calibrated (exam 2024–2026 passed), but 23 years of tests
found no directional edge (Phases 5–7, CP-1). RB-1 asks whether the **range** information alone supports a spot trading
rule that is profitable after realistic costs, and better than the same trades with a random direction.

## 2. Data
- FC-1 point-in-time forecasts `state/forecast/fc1/forecasts_{gold,silver}_exam.parquet`, model **M2-ACI** (the model
  chosen on development and live since 2026-10-23), one row per 4h decision time t (the bar close): quantiles q025, q100,
  q500, q900, q975 and sigma of the log return from the mid at t to the mid at the next bar close.
- 4h bars from `forecast.data.build_bars` (frozen RV floors), Dukascopy hourly **bid/ask** for every fill and exit.
- Periods (by decision time): **development 2003-05-05 → 2018-12-31 · validation 2019-01-01 → 2023-12-31 ·
  holdout 2024-01-01 → 2026-09-30.** The holdout prices were seen by earlier, unrelated tests (FC-1 exam, CP-1, Phase 7);
  no range strategy has ever been run on them. The decisive test is a live paper-trading ledger (section 7).

## 3. Execution and costs (all strategies)
- Orders become active at the first hour starting at or after t. Fills and exits are resolved on hourly bid/ask bars:
  longs buy on the ask and sell on the bid, shorts the reverse.
- Limit orders fill when the ask low (buy) / bid high (sell) reaches the limit, at the limit price.
- Stops are market orders: fill at the stop, or at the hour's open if it gaps through, minus slippage
  (`config.EXECUTION_VENUES` XAU/USD $0.50, XAG/USD $0.030). Fees: venue bps per side (0.1 / 0.2 bps).
- Within one hour the order of events is unknown, so ties go against the trade: a stop and a target touched in the same
  hour = stop; a stop touched in the fill hour = stop; a target is only checked from the hour after the fill.
- One position at a time per strategy and metal; signals while a position is open are skipped.
- Result per trade in **R** = net profit per ounce / |entry − stop| (costs included).

## 4. Strategies (fixed; no parameter search)
Price levels from the forecast at t: L_q = P_t × exp(q), P_t = mid close at t.
- **S1 — range reversion.** At each t (flat), place a buy limit at L_q100 and a sell limit at L_q900 for the next bar
  (until the next decision time); the first to fill cancels the other. Long: stop L_q025, target L_q500; short: stop
  L_q975, target L_q500. Exit at the bid/ask close of the last hour before the close of the second bar after t if neither
  is hit.
- **S2 — band breakout.** If the bar that closed at t closed outside the 95% band forecast for it at the previous decision
  time (return > q975: long; < q025: short), enter at market in the first hour after t. Stop 1 sigma_t, target
  2 sigma_t (in price: P_t × sigma_t), time exit at the close of the sixth bar after t.
- **S3 — volatility-managed long.** Hold gold / silver long with exposure w_t = min(2, s*_t / sigma_t), where s*_t is the
  median of sigma over all decision times up to and including t (point-in-time); rebalanced every 6th decision time
  (about daily). Cost per rebalance |Δw| × (half the hour's spread + fee) in return terms. Benchmark: buy and hold
  (w = 1, one entry cost).

## 5. Controls
- S1 and S2 **coin-flip control:** for every strategy trade, the same entry time and price, the same stop and target
  distances, the same exits and costs, with a random direction; 20 seeds (fixed 1..20), averaged per trade.
- S2 **fade control:** the opposite direction at the same entries.
- S1 **EWMA control (secondary):** S1 with the B1 (EWMA) bands instead of FC-1: does FC-1 add value over a standard
  volatility model?
- S3: buy and hold; and S3 with B1 sigma (secondary).

## 6. Decision rules
Primary tests: S1 and S2 × gold and silver (4 tests); S3 × gold and silver (2 tests).
- **S1 / S2 pass** (per metal) only if all hold:
  development: ≥ 100 trades, mean net R > 0 with t ≥ 2.5, and mean R minus the coin-flip control with t ≥ 2.0;
  validation: ≥ 30 trades, mean net R > 0 with t ≥ 1.65 (one-sided 5%).
- **S3 passes** (per metal) only if the annualised Sharpe ratio of S3 minus buy and hold is > 0 in development with a
  weekly-block bootstrap p < 0.05 (2,000 resamples, 30-bar blocks), and > 0 in validation.
- Holdout 2024–2026 is reported for everything; a strategy that passed is **deployed to paper trading only if** its
  holdout mean net R (S3: Sharpe difference) is > 0.
- Reported for every strategy: trades, win rate, mean / median R, t, profit factor, max drawdown and annual return at
  1% risk per trade (S3: at w as defined), trades per year.
- **Win rate is not a pass criterion.** A high win rate with a negative mean R is a losing strategy.

## 7. Afterwards
- If nothing passes, no bot is deployed; the result is published as a negative result (paper, section "Direction vs range").
- If a strategy passes, it runs as a **paper bot** on a hash-chained ledger (signals written before the bar opens, fills
  and exits from the same rules on live data), shown on the site with its equity curve next to buy and hold; at least
  three months of live paper record before any real-money use, which only the user can enable with their own broker.

## 8. Predictions (registered)
S1 negative after costs (band edges are touched about 20% of the time and price does not reliably revert); S2 near
zero, not passing; S3 a higher Sharpe than buy and hold is plausible (volatility management literature) but the
difference may not be significant on one asset.
