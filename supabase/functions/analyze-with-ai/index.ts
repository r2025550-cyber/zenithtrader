import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { generateOpenAIText } from "../_shared/openai.ts";
import { corsHeaders, getAuthenticatedClients, getSettings, json, parseSignal } from "../_shared/trading.ts";

// =====================================================================
// Hybrid Price-Action Scalping Engine v5 (Edge & Protection Layer)
// ---------------------------------------------------------------------
// v3 + v4 features fully RETAINED (do not modify).
// v5 ADDITIONS (purely additive — survival + edge layers):
//  1) LIQUIDITY TRAP DETECTION — failed breakouts/breakdowns reverse signal
//  2) LOSS PROTECTION — pause 60m after 2 consecutive losses
//  3) POSITION SIZING — halve size after a loss; restore after a win
//  4) NEWS/SPIKE FILTER — skip 5min after a >50pt single candle range
//  5) COMPRESSION DETECTION — shrinking 5-candle range; breakout = high prob
// =====================================================================

const NIFTY_LOT_SIZE = 65;
// v10-balanced: disciplined aggressive scalper (4–5 quality trades/day)
const MIN_TRADE_GAP_MIN = 6;      // v10: was 8 — slightly more active, still paced
const MAX_TRADES_PER_DAY = 5;     // v10: hard cap 5 quality trades
const SIDEWAYS_RANGE_PTS = 20;
const TRAIL_TRIGGER_PTS = 6;
const TRAIL_LOCK_PTS = 6;
const TRAIL_LOCK_AT_PROFIT = 12;
const NEAR_ZONE_PTS = 12;
const RETEST_TOLERANCE_PTS = 8;
const RETEST_MAX_AGE_CANDLES = 4;
// v9: tighter early-entry filters — kill weak spike entries
const EARLY_ENTRY_MIN_BODY_PTS = 12;     // v12: restored fast-scalp responsiveness
const EARLY_ENTRY_MIN_MOVE_PTS = 12;     // v12: restored fast-scalp responsiveness
const FREQUENCY_BOOST_MIN_GAP = 30;
const PULLBACK_TOLERANCE_PTS = 10;
const PARTIAL_BOOK_PTS = 15;
const PARTIAL_BOOK_FRACTION = 0.5;
const MOMENTUM_STREAK = 3;
const CHOPPY_RANGE_PTS = 20;
// v5 constants
const TRAP_LOOKBACK_CANDLES = 3;
const LOSS_PAUSE_MIN = 60;
const LOSS_STREAK_THRESHOLD = 2;
const SPIKE_RANGE_PTS = 50;
const SPIKE_COOLDOWN_MIN = 1.5;
const COMPRESSION_LOOKBACK = 5;
const COMPRESSION_SHRINK_RATIO = 0.7;
const SR_STALE_DISTANCE_PTS = 200;
const FALLBACK_SR_DISTANCE_PTS = 35;
// v9: post-loss re-entry discipline
const POST_LOSS_COOLDOWN_MIN = 10;       // after 1 SL
const POST_DOUBLE_LOSS_COOLDOWN_MIN = 20;// after 2 SL
const POST_LOSS_CONFIDENCE_BUMP = 5;     // +5 to required confidence
// v13: starvation-fix — gates lowered, EMA-slope + body-size scoring added,
// regime promoted to TRENDING when EMA slope is strongly directional.
const CONF_GATE_TRENDING = 42;
const CONF_GATE_SCALPING = 46;
const CONF_GATE_CHOPPY = 50;
const CONF_GATE_SNIPER = 66;
const CONF_GATE_FLOOR = 36;
// v11: open-session adaptive — reduce gate during opening drive (9:15–10:30 IST)
const OPEN_SESSION_START_IST_MIN = 9 * 60 + 15;   // 555
const OPEN_SESSION_END_IST_MIN   = 10 * 60 + 30;  // 630
const OPEN_SESSION_GATE_RELIEF   = 10;
// v14: Pre-Market (9:00–9:14) + Opening Drive (9:15–9:30) additive layer
const PREMARKET_START_IST_MIN    = 9 * 60;        // 540
const PREMARKET_END_IST_MIN      = 9 * 60 + 14;   // 554
const OPENING_DRIVE_START_IST_MIN = 9 * 60 + 15;  // 555
const OPENING_DRIVE_END_IST_MIN   = 9 * 60 + 30;  // 570
const OPENING_DRIVE_EXTRA_RELIEF  = 6;            // stacks on OPEN_SESSION_GATE_RELIEF
const OPENING_DRIVE_FLOOR         = 30;           // lower hard floor only during 9:15–9:30
// v13: EMA slope + body thresholds for "trend-equivalent" promotion
const STRONG_SLOPE_PTS = 15;
const BIG_BODY_PTS = 12;
// v15: LIVE MOMENTUM SCALPING — dynamic gate by momentum velocity
const MOMENTUM_GATE_EXPLOSIVE     = 20;   // velocity ≥ 75
const MOMENTUM_GATE_CONTINUATION  = 26;   // velocity 55–74
const MOMENTUM_GATE_NORMAL        = 30;   // velocity 35–54
const MOMENTUM_VELOCITY_EXPLOSIVE = 75;
const MOMENTUM_VELOCITY_CONTINUE  = 55;
const MOMENTUM_VELOCITY_NORMAL    = 35;
const LATE_ENTRY_STREAK_MAX       = 3;    // ≥3 expansion candles already done
const LATE_ENTRY_STRETCH_PTS      = 28;   // distance from ema21
const LATE_ENTRY_BODY_PTS         = 22;   // overstretched single candle
const ENTRY_QUALITY_MIN           = 40;   // floor — block ugly entries
// v17: MOMENTUM OVERRIDE LAYER (additive — momentum > structure during explosive moves)
const MOM_OVR_VELOCITY_MIN        = 60;   // momentumVelocity floor to consider override
const MOM_OVR_VELOCITY_EXTREME    = 78;   // extreme threshold → max multiplier
const MOM_OVR_EMA_SEP_MIN         = 6;    // EMA9/21 spread widening proxy (pts)
const MOM_OVR_STREAK_MIN          = 2;    // ≥2 directional expansion candles
const MOM_OVR_GATE_TRENDING_LO    = 24;
const MOM_OVR_GATE_TRENDING_HI    = 28;
const MOM_OVR_GATE_NORMAL_LO      = 22;
const MOM_OVR_GATE_NORMAL_HI      = 26;
const MOM_OVR_MULT_EXPLOSIVE      = 1.6;
const MOM_OVR_MULT_EXTREME        = 1.9;
// v18: MOMENTUM CONVICTION FLOOR — kill the 22–32 freeze trap (additive only)
const MOM_FLOOR_OVERRIDE          = 50;   // when momentumOverrideActive
const MOM_FLOOR_OVERRIDE_EXTREME  = 55;   // when extreme velocity + override
const MOM_FLOOR_EXPLOSIVE_TIER    = 45;   // EXPLOSIVE tier without full override
const MOM_FLOOR_CONTINUATION_TIER = 40;   // CONTINUATION tier without override
const MOM_SOFT_BOOST_PTS          = 8;    // additive boost when momentum present, override not

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeImmediateLevels(ltp: number | null, support: number | null, resistance: number | null, history: MarketRow[]) {
  if (ltp === null) return { support, resistance, stale: false };
  const staleSupport = support === null || support >= ltp || Math.abs(ltp - support) > SR_STALE_DISTANCE_PTS;
  const staleResistance = resistance === null || resistance <= ltp || Math.abs(ltp - resistance) > SR_STALE_DISTANCE_PTS;
  if (!staleSupport && !staleResistance) return { support, resistance, stale: false };

  const recent = history.slice(0, 20);
  const lows = recent.flatMap((r) => [num(r?.low_price), num(r?.ltp), num(r?.close_price)]).filter((v): v is number => v !== null && v < ltp && ltp - v <= SR_STALE_DISTANCE_PTS);
  const highs = recent.flatMap((r) => [num(r?.high_price), num(r?.ltp), num(r?.close_price)]).filter((v): v is number => v !== null && v > ltp && v - ltp <= SR_STALE_DISTANCE_PTS);
  return {
    support: staleSupport ? (lows.length ? Math.max(...lows) : Number((ltp - FALLBACK_SR_DISTANCE_PTS).toFixed(2))) : support,
    resistance: staleResistance ? (highs.length ? Math.min(...highs) : Number((ltp + FALLBACK_SR_DISTANCE_PTS).toFixed(2))) : resistance,
    stale: true,
  };
}

function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function atmStrike(price: number | null) {
  return price === null ? null : Math.round(price / 50) * 50;
}

type MarketRow = Record<string, unknown> & {
  raw_payload?: Record<string, unknown>;
  created_at?: string;
  source_timestamp?: string;
  ltp?: unknown;
  open_price?: unknown;
  high_price?: unknown;
  low_price?: unknown;
  close_price?: unknown;
};

// Find confirmed swing highs/lows with at least `minTouches` candles touching within tolerance.
function confirmedSwings(history: MarketRow[], lookback = 30, minTouches = 2, tolPts = 4) {
  const window = history.slice(1, lookback + 1); // exclude live tick
  const highs = window.map((r) => num(r?.high_price)).filter((v): v is number => v !== null);
  const lows = window.map((r) => num(r?.low_price)).filter((v): v is number => v !== null);
  if (highs.length < 5 || lows.length < 5) return { support: null, resistance: null };

  // Candidate swing points: local extremes over a 3-candle window
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let i = 1; i < window.length - 1; i++) {
    const h = num(window[i]?.high_price);
    const hPrev = num(window[i - 1]?.high_price);
    const hNext = num(window[i + 1]?.high_price);
    const l = num(window[i]?.low_price);
    const lPrev = num(window[i - 1]?.low_price);
    const lNext = num(window[i + 1]?.low_price);
    if (h !== null && hPrev !== null && hNext !== null && h >= hPrev && h >= hNext) swingHighs.push(h);
    if (l !== null && lPrev !== null && lNext !== null && l <= lPrev && l <= lNext) swingLows.push(l);
  }

  // Cluster: pick the level with most touches within tolPts
  const bestLevel = (points: number[], allBars: number[], pickHighest: boolean) => {
    if (!points.length) return null;
    let best: { level: number; touches: number } | null = null;
    for (const p of points) {
      const touches = allBars.filter((v) => Math.abs(v - p) <= tolPts).length;
      if (touches >= minTouches) {
        if (!best || touches > best.touches || (touches === best.touches && (pickHighest ? p > best.level : p < best.level))) {
          best = { level: p, touches };
        }
      }
    }
    // Fallback: hard extreme of window
    if (!best) return pickHighest ? Math.max(...allBars) : Math.min(...allBars);
    return best.level;
  };

  const resistance = bestLevel(swingHighs, highs, true);
  const support = bestLevel(swingLows, lows, false);
  return { support, resistance };
}

function buildPriceAction(latest: MarketRow, history: MarketRow[]) {
  const ltp = num(latest?.ltp);
  const open = num(latest?.open_price);
  const high = num(latest?.high_price);
  const low = num(latest?.low_price);
  const close = num(latest?.close_price);

  // Confirmed swing S/R, rebased around the latest live LTP if previous-session levels leak in.
  const rawLevels = confirmedSwings(history, 30, 2, 4);
  const sanitizedLevels = sanitizeImmediateLevels(ltp, rawLevels.support, rawLevels.resistance, history);
  const support = sanitizedLevels.support;
  const resistance = sanitizedLevels.resistance;

  // EMA21 series + slope
  const closesChrono = [...history].reverse().map((r) => num(r?.ltp) ?? num(r?.close_price)).filter((v): v is number => v !== null);
  const ema21Series = emaSeries(closesChrono, 21);
  const ema9Series = emaSeries(closesChrono, 9);
  const ema21 = ema21Series.length ? ema21Series[ema21Series.length - 1] : null;
  const ema9 = ema9Series.length ? ema9Series[ema9Series.length - 1] : null;
  const ema21Prev = ema21Series.length >= 4 ? ema21Series[ema21Series.length - 4] : null;
  const ema21Slope = ema21 !== null && ema21Prev !== null ? ema21 - ema21Prev : 0;
  const emaBullish = ltp !== null && ema21 !== null && ltp > ema21 && ema21Slope > 0;
  const emaBearish = ltp !== null && ema21 !== null && ltp < ema21 && ema21Slope < 0;

  // Strict candle classification (body>=60% range, close near extreme)
  const prev = history[1];
  const pOpen = num(prev?.open_price);
  const pClose = num(prev?.close_price);
  const pHigh = num(prev?.high_price);
  const pLow = num(prev?.low_price);
  const body = open !== null && close !== null ? Math.abs(close - open) : 0;
  const range = high !== null && low !== null ? Math.max(high - low, 0) : 0;
  const upperWick = high !== null && open !== null && close !== null ? high - Math.max(open, close) : 0;
  const lowerWick = low !== null && open !== null && close !== null ? Math.min(open, close) - low : 0;
  const bodyPct = range > 0 ? body / range : 0;
  const closeNearHigh = high !== null && close !== null && range > 0 ? (high - close) / range <= 0.2 : false;
  const closeNearLow = low !== null && close !== null && range > 0 ? (close - low) / range <= 0.2 : false;
  const strongBody = bodyPct >= 0.6 && body >= 5;
  const strongGreen = open !== null && close !== null && close > open && strongBody && closeNearHigh;
  const strongRed = open !== null && close !== null && close < open && strongBody && closeNearLow;
  const bullishEngulfing =
    open !== null && close !== null && pOpen !== null && pClose !== null &&
    pClose < pOpen && close > open && close >= pOpen && open <= pClose && bodyPct >= 0.55;
  const bearishEngulfing =
    open !== null && close !== null && pOpen !== null && pClose !== null &&
    pClose > pOpen && close < open && close <= pOpen && open >= pClose && bodyPct >= 0.55;

  // Wick rejection (fake-breakout filter): wick > 50% of range on the breakout side
  const upperWickPct = range > 0 ? upperWick / range : 0;
  const lowerWickPct = range > 0 ? lowerWick / range : 0;
  const longUpperWick = upperWickPct > 0.5;
  const longLowerWick = lowerWickPct > 0.5;

  // Proximity (near zone)
  const nearSupport = support !== null && ltp !== null && Math.abs(ltp - support) <= NEAR_ZONE_PTS;
  const nearResistance = resistance !== null && ltp !== null && Math.abs(ltp - resistance) <= NEAR_ZONE_PTS;

  // Mid-zone detection (avoid no-mans-land)
  const midZone = support !== null && resistance !== null && ltp !== null &&
    ltp > support + NEAR_ZONE_PTS && ltp < resistance - NEAR_ZONE_PTS;

  // Detect a recent breakout candle (within last N candles, excluding live tick)
  let recentBullBreakout: { idx: number; level: number; closePx: number } | null = null;
  let recentBearBreakout: { idx: number; level: number; closePx: number } | null = null;
  if (resistance !== null) {
    for (let i = 1; i <= Math.min(RETEST_MAX_AGE_CANDLES, history.length - 1); i++) {
      const r = history[i];
      const c = num(r?.close_price);
      const o = num(r?.open_price);
      const h = num(r?.high_price);
      const l = num(r?.low_price);
      if (c === null || o === null || h === null || l === null) continue;
      const rng = Math.max(h - l, 0);
      const bd = Math.abs(c - o);
      const strong = rng > 0 && bd / rng >= 0.6 && c > o && (rng > 0 ? (h - c) / rng <= 0.2 : false);
      const wickOk = rng > 0 ? (h - Math.max(o, c)) / rng <= 0.5 : false;
      if (c > resistance && strong && wickOk) { recentBullBreakout = { idx: i, level: resistance, closePx: c }; break; }
    }
  }
  if (support !== null) {
    for (let i = 1; i <= Math.min(RETEST_MAX_AGE_CANDLES, history.length - 1); i++) {
      const r = history[i];
      const c = num(r?.close_price);
      const o = num(r?.open_price);
      const h = num(r?.high_price);
      const l = num(r?.low_price);
      if (c === null || o === null || h === null || l === null) continue;
      const rng = Math.max(h - l, 0);
      const bd = Math.abs(c - o);
      const strong = rng > 0 && bd / rng >= 0.6 && c < o && (rng > 0 ? (c - l) / rng <= 0.2 : false);
      const wickOk = rng > 0 ? (Math.min(o, c) - l) / rng <= 0.5 : false;
      if (c < support && strong && wickOk) { recentBearBreakout = { idx: i, level: support, closePx: c }; break; }
    }
  }

  // Retest confirmation: current LTP pulled back near the breakout level AND current candle confirms direction
  const retestBullOk = recentBullBreakout !== null && ltp !== null &&
    Math.abs(ltp - recentBullBreakout.level) <= RETEST_TOLERANCE_PTS &&
    (strongGreen || bullishEngulfing) && !longUpperWick;
  const retestBearOk = recentBearBreakout !== null && ltp !== null &&
    Math.abs(ltp - recentBearBreakout.level) <= RETEST_TOLERANCE_PTS &&
    (strongRed || bearishEngulfing) && !longLowerWick;

  // Sideways guard: last 30 min range
  const thirtyMinRows = history.filter((row) => {
    const t = new Date((row?.source_timestamp ?? row?.created_at) as string).getTime();
    return Date.now() - t <= 30 * 60 * 1000;
  });
  const rangeVals = thirtyMinRows.flatMap((r) => [num(r.high_price), num(r.low_price), num(r.ltp)]).filter((v): v is number => v !== null);
  const last30Range = rangeVals.length > 2 ? Math.max(...rangeVals) - Math.min(...rangeVals) : null;
  const sidewaysMarket = last30Range !== null && last30Range < SIDEWAYS_RANGE_PTS;

  // Strong momentum
  const oneMinMove = ltp !== null && num(prev?.ltp) !== null ? ltp - (num(prev?.ltp) as number) : 0;
  const strongMomentum = strongBody && Math.abs(oneMinMove) >= 8;

  // Live breakout (close beyond level + strong + no long opposing wick)
  const liveBullBreakout = ltp !== null && resistance !== null && ltp > resistance && strongGreen && !longUpperWick;
  const liveBearBreakout = ltp !== null && support !== null && ltp < support && strongRed && !longLowerWick;

  // ===== v4: MOMENTUM DETECTION (3 strong candles same direction) =====
  let bullStreak = 0, bearStreak = 0;
  for (let i = 0; i < Math.min(MOMENTUM_STREAK, history.length); i++) {
    const r = history[i];
    const o = num(r?.open_price), c = num(r?.close_price), h = num(r?.high_price), l = num(r?.low_price);
    if (o === null || c === null || h === null || l === null) break;
    const rng = Math.max(h - l, 0); const bd = Math.abs(c - o);
    const strong = rng > 0 && bd / rng >= 0.55;
    if (!strong) break;
    if (c > o) { if (bearStreak > 0) break; bullStreak++; }
    else if (c < o) { if (bullStreak > 0) break; bearStreak++; }
    else break;
  }
  const momentumBull = bullStreak >= MOMENTUM_STREAK;
  const momentumBear = bearStreak >= MOMENTUM_STREAK;

  // ===== v4: TREND CONTINUATION (HH/HL or LH/LL on last ~6 candles) =====
  const lastN = history.slice(1, 7);
  const highsN = lastN.map(r => num(r?.high_price)).filter((v): v is number => v !== null);
  const lowsN = lastN.map(r => num(r?.low_price)).filter((v): v is number => v !== null);
  let trendUp = false, trendDown = false;
  if (highsN.length >= 4 && lowsN.length >= 4) {
    const firstHalfH = Math.max(...highsN.slice(Math.floor(highsN.length / 2)));
    const secondHalfH = Math.max(...highsN.slice(0, Math.floor(highsN.length / 2)));
    const firstHalfL = Math.min(...lowsN.slice(Math.floor(lowsN.length / 2)));
    const secondHalfL = Math.min(...lowsN.slice(0, Math.floor(lowsN.length / 2)));
    trendUp = secondHalfH > firstHalfH && secondHalfL > firstHalfL;
    trendDown = secondHalfH < firstHalfH && secondHalfL < firstHalfL;
  }
  // Pullback to EMA21 in trend direction with confirmation
  const pullbackBuy = trendUp && ema21 !== null && ltp !== null &&
    Math.abs(ltp - ema21) <= PULLBACK_TOLERANCE_PTS && (strongGreen || bullishEngulfing) && ema21Slope > 0;
  const pullbackSell = trendDown && ema21 !== null && ltp !== null &&
    Math.abs(ltp - ema21) <= PULLBACK_TOLERANCE_PTS && (strongRed || bearishEngulfing) && ema21Slope < 0;

  // ===== v12: EARLY ENTRY — EMA assists, not blocks. Allow strong breakouts regardless of EMA alignment. =====
  const earlyBuy = ltp !== null && resistance !== null && close !== null &&
    close > resistance && strongGreen && body >= EARLY_ENTRY_MIN_BODY_PTS &&
    Math.abs(oneMinMove) >= EARLY_ENTRY_MIN_MOVE_PTS && !longUpperWick;
  const earlySell = ltp !== null && support !== null && close !== null &&
    close < support && strongRed && body >= EARLY_ENTRY_MIN_BODY_PTS &&
    Math.abs(oneMinMove) >= EARLY_ENTRY_MIN_MOVE_PTS && !longLowerWick;

  // ===== v4: CHOPPY market (very tight range = downsize) =====
  const choppyMarket = last30Range !== null && last30Range < CHOPPY_RANGE_PTS;

  // ===== v5: LIQUIDITY TRAP DETECTION =====
  // Bull trap: a recent candle closed above resistance, but a SUBSEQUENT candle closed back below it.
  // Bear trap: a recent candle closed below support, but a SUBSEQUENT candle closed back above it.
  let bullTrap = false;
  let bearTrap = false;
  if (resistance !== null) {
    for (let i = 1; i <= Math.min(TRAP_LOOKBACK_CANDLES, history.length - 2); i++) {
      const breakoutBar = history[i + 1];
      const followBar = history[i];
      const bc = num(breakoutBar?.close_price);
      const fc = num(followBar?.close_price);
      if (bc !== null && fc !== null && bc > resistance && fc < resistance) { bullTrap = true; break; }
    }
  }
  if (support !== null) {
    for (let i = 1; i <= Math.min(TRAP_LOOKBACK_CANDLES, history.length - 2); i++) {
      const breakoutBar = history[i + 1];
      const followBar = history[i];
      const bc = num(breakoutBar?.close_price);
      const fc = num(followBar?.close_price);
      if (bc !== null && fc !== null && bc < support && fc > support) { bearTrap = true; break; }
    }
  }
  // Live trap (current candle reverses immediately)
  const liveBullTrap = resistance !== null && close !== null && open !== null &&
    high !== null && high > resistance && close < resistance;
  const liveBearTrap = support !== null && close !== null && open !== null &&
    low !== null && low < support && close > support;
  bullTrap = bullTrap || liveBullTrap;
  bearTrap = bearTrap || liveBearTrap;

  // ===== v5: NEWS / SPIKE FILTER =====
  // Find largest candle range in last 5 candles; if >= SPIKE_RANGE_PTS within cooldown, block.
  let spikeDetected = false;
  let spikeAgeMin = Infinity;
  for (let i = 0; i < Math.min(5, history.length); i++) {
    const r = history[i];
    const h = num(r?.high_price), l = num(r?.low_price);
    if (h === null || l === null) continue;
    const rng = h - l;
    if (rng >= SPIKE_RANGE_PTS) {
      const t = new Date((r?.source_timestamp ?? r?.created_at) as string).getTime();
      const ageMin = (Date.now() - t) / 60000;
      if (ageMin <= SPIKE_COOLDOWN_MIN) { spikeDetected = true; spikeAgeMin = Math.min(spikeAgeMin, ageMin); }
    }
  }

  // ===== v5: COMPRESSION DETECTION =====
  // Last N candle ranges shrinking on average; recent breakout from compression = high-prob.
  let compression = false;
  let compressionBreakout: "BULL" | "BEAR" | null = null;
  if (history.length >= COMPRESSION_LOOKBACK + 1) {
    const ranges: number[] = [];
    for (let i = 1; i <= COMPRESSION_LOOKBACK; i++) {
      const r = history[i];
      const h = num(r?.high_price), l = num(r?.low_price);
      if (h !== null && l !== null) ranges.push(h - l);
    }
    if (ranges.length === COMPRESSION_LOOKBACK) {
      // ranges[0] = most recent prior candle ... ranges[N-1] = oldest
      // Compression: oldest avg > newest avg by shrink ratio
      const oldHalf = ranges.slice(Math.floor(ranges.length / 2));
      const newHalf = ranges.slice(0, Math.floor(ranges.length / 2));
      const oldAvg = oldHalf.reduce((a, b) => a + b, 0) / oldHalf.length;
      const newAvg = newHalf.reduce((a, b) => a + b, 0) / newHalf.length;
      compression = oldAvg > 0 && newAvg / oldAvg <= COMPRESSION_SHRINK_RATIO;
      // Live candle breaking out of the compression range = high-prob trigger
      const compHigh = Math.max(...history.slice(1, COMPRESSION_LOOKBACK + 1)
        .map(r => num(r?.high_price)).filter((v): v is number => v !== null));
      const compLow = Math.min(...history.slice(1, COMPRESSION_LOOKBACK + 1)
        .map(r => num(r?.low_price)).filter((v): v is number => v !== null));
      if (compression && close !== null) {
        if (close > compHigh && strongGreen) compressionBreakout = "BULL";
        else if (close < compLow && strongRed) compressionBreakout = "BEAR";
      }
    }
  }

  return {
    ltp, open, high, low, close,
    prevHigh: pHigh, prevLow: pLow, prevClose: pClose,
    support, resistance, ema9, ema21, ema21Slope,
    emaBullish, emaBearish,
    bullishEngulfing, bearishEngulfing, strongGreen, strongRed, strongBody,
    bodyPct, upperWickPct, lowerWickPct, longUpperWick, longLowerWick,
    nearSupport, nearResistance, midZone,
    recentBullBreakout, recentBearBreakout, retestBullOk, retestBearOk,
    liveBullBreakout, liveBearBreakout,
    last30Range, sidewaysMarket, choppyMarket,
    strongMomentum,
    // v4 additions
    momentumBull, momentumBear, bullStreak, bearStreak,
    trendUp, trendDown, pullbackBuy, pullbackSell,
    earlyBuy, earlySell,
    // v5 additions
    bullTrap, bearTrap, liveBullTrap, liveBearTrap,
    spikeDetected, spikeAgeMin, staleLevelsRebased: sanitizedLevels.stale,
    compression, compressionBreakout,
  };
}

function pickStrike(ltp: number | null, action: "BUY" | "SELL", strongMomentum: boolean) {
  const atm = atmStrike(ltp);
  if (atm === null) return null;
  if (strongMomentum) return action === "BUY" ? atm + 50 : atm - 50;
  return atm;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const tradingMode: "scalping" | "sniper" = body?.tradingMode === "sniper" ? "sniper" : "scalping";
    const tradingLotSize = Number.isInteger(body?.tradingLotSize) && body.tradingLotSize > 0 ? body.tradingLotSize : 1;
    const tradingQuantity = tradingLotSize * NIFTY_LOT_SIZE;
    const executionIntent = body?.executionIntent === true;
    const dailyPnl = num(body?.dailyPnl) ?? 0;
    const dailyProfitTarget = num(body?.dailyProfitTarget) ?? 0;
    // v14.1: hard wallet-protection cap (₹1,500). Section-9 override of prior 2000 default.
    const MAX_DAILY_LOSS_HARD_CAP = 1500;
    const maxDailyLoss = MAX_DAILY_LOSS_HARD_CAP;
    // Live floating PnL of any open position (₹). Optional — frontend supplies when a trade is active.
    const floatingPnl = num(body?.floatingPnl) ?? 0;
    const userTargetPoints = num(body?.userTargetPoints);
    const userSlPoints = num(body?.userSlPoints);
    // v5: optional recent trade outcomes from frontend (most-recent first), e.g. [-12, +25, -8]
    const recentTradesPnl: number[] = Array.isArray(body?.recentTradesPnl)
      ? body.recentTradesPnl.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n))
      : [];
    const lastClosedTradeAt = num(body?.lastClosedTradeAt); // unix ms, optional

    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const settings = await getSettings(auth.adminClient, auth.user.id);

    const { data: storedHistory, error: latestError } = await auth.adminClient
      .from("nifty_market_data")
      .select("*")
      .eq("user_id", auth.user.id)
      .order("created_at", { ascending: false })
      .limit(80);
    const liveMarket = body?.liveMarket && typeof body.liveMarket === "object" ? body.liveMarket as MarketRow : null;
    const liveSpot = num(body?.spotPrice ?? liveMarket?.ltp);
    const liveTimestamp = String(body?.payloadTimestamp ?? liveMarket?.source_timestamp ?? liveMarket?.created_at ?? new Date().toISOString());
    const latest = liveMarket && liveSpot !== null
      ? { ...liveMarket, ltp: liveSpot, source_timestamp: liveTimestamp, created_at: liveTimestamp } as MarketRow
      : storedHistory?.[0] as MarketRow | undefined;
    if (latestError || !latest) return json({ error: "Fetch Nifty data before running AI analysis." }, 400);
    const history = [latest, ...((storedHistory ?? []) as MarketRow[]).filter((row) => String((row as any).id ?? "") !== String((latest as any).id ?? ""))];

    const pa = buildPriceAction(latest, history as MarketRow[]);

    const dailyTargetHit = dailyProfitTarget > 0 && dailyPnl >= dailyProfitTarget;
    // v14.1: include live floating PnL — circuit-breaker fires BEFORE a 12pt SL can blow past the cap.
    const projectedDailyPnl = dailyPnl + floatingPnl;
    const maxDailyLossHit = maxDailyLoss > 0 && projectedDailyPnl <= -maxDailyLoss;
    const safeMode = maxDailyLossHit; // SAFE_MODE engaged once wallet cap breached
    const forceCloseOpenTrade = safeMode && floatingPnl < 0; // signal UI/exec to flatten now

    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const { data: todaySignals } = await auth.adminClient
      .from("ai_trade_signals")
      .select("action, created_at")
      .eq("user_id", auth.user.id)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(20);
    const todayTrades = (todaySignals ?? []).filter((s: any) => s.action === "BUY" || s.action === "SELL");
    const tradesToday = todayTrades.length;
    const lastTradeAt = todayTrades[0] ? new Date(todayTrades[0].created_at).getTime() : 0;
    const minutesSinceLastTrade = lastTradeAt ? (Date.now() - lastTradeAt) / 60000 : Infinity;
    const tradeGapOk = minutesSinceLastTrade >= MIN_TRADE_GAP_MIN;
    // v9: 6th trade only if last trade was a win (caller passes recentTradesPnl[0])
    // Hard cap default = 5; soft-allow up to 6 if conditions met (checked later with regime+confidence).
    const tradeCapOk = tradesToday < MAX_TRADES_PER_DAY;
    const sixthTradeWindow = tradesToday === MAX_TRADES_PER_DAY; // exactly at cap

    // ===== v5: LOSS PROTECTION & POSITION SIZING =====
    let consecutiveLosses = 0;
    for (const p of recentTradesPnl) { if (p < 0) consecutiveLosses++; else break; }
    const lastTradePnl = recentTradesPnl.length ? recentTradesPnl[0] : null;
    const lastTradeWasLoss = lastTradePnl !== null && lastTradePnl < 0;
    const lastTradeWasWin = lastTradePnl !== null && lastTradePnl > 0;
    const minutesSinceLastClosed = lastClosedTradeAt ? (Date.now() - lastClosedTradeAt) / 60000 : Infinity;
    const lossPauseActive = consecutiveLosses >= LOSS_STREAK_THRESHOLD && minutesSinceLastClosed < LOSS_PAUSE_MIN;
    const lossPauseRemainingMin = lossPauseActive ? Math.max(0, Math.ceil(LOSS_PAUSE_MIN - minutesSinceLastClosed)) : 0;
    // Position-sizing multiplier: halve after a loss, restore after a win, default 1.
    const positionSizeMultiplier = lastTradeWasLoss ? 0.5 : (lastTradeWasWin ? 1 : 1);
    // v9: post-loss re-entry cooldown (1 SL = 10m, 2 SL = 20m). Separate from 60m loss-pause.
    const postLossCooldownMin = consecutiveLosses >= 2 ? POST_DOUBLE_LOSS_COOLDOWN_MIN
      : consecutiveLosses === 1 ? POST_LOSS_COOLDOWN_MIN
      : 0;
    const postLossCooldownActive = postLossCooldownMin > 0 && minutesSinceLastClosed < postLossCooldownMin;
    const postLossCooldownRemainingMin = postLossCooldownActive
      ? Math.max(0, Math.ceil(postLossCooldownMin - minutesSinceLastClosed)) : 0;

    // ===== v5: NEWS/SPIKE & COMPRESSION FLAGS =====
    const spikeBlock = pa.spikeDetected;
    const compressionBreakoutBuy = pa.compressionBreakout === "BULL" && (pa.emaBullish || pa.ema21Slope > 0);
    const compressionBreakoutSell = pa.compressionBreakout === "BEAR" && (pa.emaBearish || pa.ema21Slope < 0);

    // ===== v5: LIQUIDITY TRAP REVERSAL SETUPS =====
    // Trap above resistance => SELL signal; trap below support => BUY signal.
    const trapSell = pa.bullTrap && (pa.strongRed || pa.bearishEngulfing || pa.liveBullTrap);
    const trapBuy = pa.bearTrap && (pa.strongGreen || pa.bullishEngulfing || pa.liveBearTrap);

    let action: "BUY" | "SELL" | "WAIT" = "WAIT";

    // ===== v8 SIGNAL COOLDOWN =====
    // Same-direction BUY/SELL cannot repeat within SIGNAL_COOLDOWN_SEC.
    // This prevents the spammy 4-5s repeat signals seen in v7.
    const SIGNAL_COOLDOWN_SEC = 90;
    const lastSignalAction = (todayTrades[0]?.action as "BUY" | "SELL" | undefined) ?? null;
    const secsSinceLastSignal = lastTradeAt ? (Date.now() - lastTradeAt) / 1000 : Infinity;
    const cooldownActive = lastSignalAction !== null && secsSinceLastSignal < SIGNAL_COOLDOWN_SEC;

    const reasonParts: string[] = [];

    // Setup detection (v3 retained)
    const buyBounce =
      pa.nearSupport && (pa.bullishEngulfing || pa.strongGreen) && pa.emaBullish;
    const sellRejection =
      pa.nearResistance && (pa.bearishEngulfing || pa.strongRed) && pa.emaBearish;
    const buyBreakoutRetest = pa.retestBullOk && pa.emaBullish;
    const sellBreakdownRetest = pa.retestBearOk && pa.emaBearish;
    const buyLiveMomentum = pa.liveBullBreakout && pa.strongMomentum && pa.emaBullish;
    const sellLiveMomentum = pa.liveBearBreakout && pa.strongMomentum && pa.emaBearish;

    // v4 setups
    const earlyBuy = pa.earlyBuy;
    const earlySell = pa.earlySell;
    const trendPullbackBuy = pa.pullbackBuy;
    const trendPullbackSell = pa.pullbackSell;
    const momentumStreakBuy = pa.momentumBull && (pa.emaBullish || pa.ema21Slope > 0);
    const momentumStreakSell = pa.momentumBear && (pa.emaBearish || pa.ema21Slope < 0);

    // v4: RE-ENTRY — last trade direction + trend still valid + new breakout signal
    const lastTradeAction = todayTrades[0]?.action as ("BUY" | "SELL" | undefined);
    const reEntryBuy = lastTradeAction === "BUY" && pa.trendUp && (pa.liveBullBreakout || earlyBuy || pa.retestBullOk);
    const reEntrySell = lastTradeAction === "SELL" && pa.trendDown && (pa.liveBearBreakout || earlySell || pa.retestBearOk);

    // v4: FREQUENCY BOOST — relax if no trade in 30m and a medium setup is present
    const frequencyBoostActive = minutesSinceLastTrade >= FREQUENCY_BOOST_MIN_GAP;
    const mediumBuySetup = pa.nearSupport && pa.strongGreen;
    const mediumSellSetup = pa.nearResistance && pa.strongRed;
    const boostBuy = frequencyBoostActive && mediumBuySetup;
    const boostSell = frequencyBoostActive && mediumSellSetup;

    // ===== v7-aggressive: ANY-2-of-4 confluence setup =====
    // Confluence factors: near S/R, strong candle body, momentum streak, EMA alignment.
    const buyFactors = [
      pa.nearSupport,
      pa.strongGreen || pa.bullishEngulfing,
      pa.momentumBull || pa.bullStreak >= 2,
      pa.emaBullish || pa.ema21Slope > 0,
    ].filter(Boolean).length;
    const sellFactors = [
      pa.nearResistance,
      pa.strongRed || pa.bearishEngulfing,
      pa.momentumBear || pa.bearStreak >= 2,
      pa.emaBearish || pa.ema21Slope < 0,
    ].filter(Boolean).length;
    const confluenceBuy = buyFactors >= 2 && !pa.longUpperWick;
    const confluenceSell = sellFactors >= 2 && !pa.longLowerWick;

    // ===== v7-aggressive: SPIKE = OPPORTUNITY (not block) =====
    // If a spike fires, allow continuation or pullback-reversal entries.
    const spikeContinuationBuy = pa.spikeDetected && (pa.strongGreen || pa.momentumBull) && (pa.emaBullish || pa.ema21Slope > 0);
    const spikeContinuationSell = pa.spikeDetected && (pa.strongRed || pa.momentumBear) && (pa.emaBearish || pa.ema21Slope < 0);
    const spikeReversalBuy = pa.spikeDetected && pa.bearTrap && (pa.strongGreen || pa.bullishEngulfing);
    const spikeReversalSell = pa.spikeDetected && pa.bullTrap && (pa.strongRed || pa.bearishEngulfing);

    const anySetup =
      buyBounce || sellRejection || buyBreakoutRetest || sellBreakdownRetest ||
      buyLiveMomentum || sellLiveMomentum || earlyBuy || earlySell ||
      trendPullbackBuy || trendPullbackSell || momentumStreakBuy || momentumStreakSell ||
      boostBuy || boostSell ||
      // v5
      trapBuy || trapSell || compressionBreakoutBuy || compressionBreakoutSell ||
      // v7-aggressive
      confluenceBuy || confluenceSell ||
      spikeContinuationBuy || spikeContinuationSell || spikeReversalBuy || spikeReversalSell;

    // v4: re-entry bypasses trade-gap (still respects daily cap)
    const gapBypassedByReEntry = (reEntryBuy || reEntrySell) && !tradeGapOk;

    if (dailyTargetHit) {
      reasonParts.push("Daily profit target hit — trading paused.");
    } else if (maxDailyLossHit) {
      reasonParts.push(
        forceCloseOpenTrade
          ? `SAFE_MODE: wallet protection ₹${MAX_DAILY_LOSS_HARD_CAP} breached (realized ${dailyPnl.toFixed(0)} + floating ${floatingPnl.toFixed(0)}) — flatten open position & halt trading.`
          : `SAFE_MODE: wallet protection ₹${MAX_DAILY_LOSS_HARD_CAP} reached — trading halted.`
      );
    } else if (lossPauseActive) {
      reasonParts.push(`Loss-protection pause: ${consecutiveLosses} consecutive losses — trading paused for ~${lossPauseRemainingMin}m more.`);
    } else if (postLossCooldownActive) {
      reasonParts.push(`Post-loss cooldown: ${consecutiveLosses} SL — wait ~${postLossCooldownRemainingMin}m before re-entry.`);
    } else if (!tradeCapOk) {
      reasonParts.push(`Daily trade cap reached (${MAX_TRADES_PER_DAY}).`);
    } else if (!tradeGapOk && !gapBypassedByReEntry) {
      reasonParts.push(`Trade-gap guard: ${Math.round(minutesSinceLastTrade)}m since last trade (need ${MIN_TRADE_GAP_MIN}m).`);
    } else if (pa.sidewaysMarket && !anySetup && !pa.strongMomentum) {
      reasonParts.push(`Sideways market: 30m range ${pa.last30Range?.toFixed(1) ?? "?"} pts < ${SIDEWAYS_RANGE_PTS} (no breakout/momentum).`);
    } else if (spikeReversalSell) {
      action = "SELL"; reasonParts.push(`SPIKE REVERSAL SELL: bull-trap after spike — fade the move.`);
    } else if (spikeReversalBuy) {
      action = "BUY"; reasonParts.push(`SPIKE REVERSAL BUY: bear-trap after spike — fade the move.`);
    } else if (spikeContinuationBuy) {
      action = "BUY"; reasonParts.push(`SPIKE CONTINUATION BUY: ride the strong upward spike with EMA aligned.`);
    } else if (spikeContinuationSell) {
      action = "SELL"; reasonParts.push(`SPIKE CONTINUATION SELL: ride the strong downward spike with EMA aligned.`);
    } else if (trapSell) {
      action = "SELL"; reasonParts.push(`LIQUIDITY TRAP SELL: failed breakout above R=${pa.resistance?.toFixed(2)} reversed back below — bull trap.`);
    } else if (trapBuy) {
      action = "BUY"; reasonParts.push(`LIQUIDITY TRAP BUY: failed breakdown below S=${pa.support?.toFixed(2)} reversed back above — bear trap.`);
    } else if (compressionBreakoutBuy) {
      action = "BUY"; reasonParts.push(`COMPRESSION BREAKOUT BUY: ${COMPRESSION_LOOKBACK}-candle range shrank, broke upward with strong green.`);
    } else if (compressionBreakoutSell) {
      action = "SELL"; reasonParts.push(`COMPRESSION BREAKOUT SELL: ${COMPRESSION_LOOKBACK}-candle range shrank, broke downward with strong red.`);
    } else if (earlyBuy) {
      action = "BUY"; reasonParts.push(`EARLY BUY: strong breakout close above R=${pa.resistance?.toFixed(2)} (body≥${EARLY_ENTRY_MIN_BODY_PTS}pts, momentum confirmed).`);
    } else if (earlySell) {
      action = "SELL"; reasonParts.push(`EARLY SELL: strong breakdown close below S=${pa.support?.toFixed(2)} (body≥${EARLY_ENTRY_MIN_BODY_PTS}pts, momentum confirmed).`);
    } else if (buyBreakoutRetest) {
      action = "BUY"; reasonParts.push(`Retest BUY: pullback to broken R≈${pa.recentBullBreakout?.level.toFixed(2)} confirmed by ${pa.bullishEngulfing ? "engulfing" : "strong green"}.`);
    } else if (sellBreakdownRetest) {
      action = "SELL"; reasonParts.push(`Retest SELL: pullback to broken S≈${pa.recentBearBreakout?.level.toFixed(2)} confirmed by ${pa.bearishEngulfing ? "engulfing" : "strong red"}.`);
    } else if (momentumStreakBuy) {
      action = "BUY"; reasonParts.push(`Momentum streak BUY: ${pa.bullStreak} consecutive strong green candles, EMA21 aligned.`);
    } else if (momentumStreakSell) {
      action = "SELL"; reasonParts.push(`Momentum streak SELL: ${pa.bearStreak} consecutive strong red candles, EMA21 aligned.`);
    } else if (trendPullbackBuy) {
      action = "BUY"; reasonParts.push(`Trend continuation BUY: HH/HL with pullback to EMA21=${pa.ema21?.toFixed(2)} + bullish confirmation.`);
    } else if (trendPullbackSell) {
      action = "SELL"; reasonParts.push(`Trend continuation SELL: LH/LL with pullback to EMA21=${pa.ema21?.toFixed(2)} + bearish confirmation.`);
    } else if (buyBounce) {
      action = "BUY"; reasonParts.push(`Support bounce at ${pa.support?.toFixed(2)} with ${pa.bullishEngulfing ? "bullish engulfing" : "strong green"} (EMA21 bullish).`);
    } else if (sellRejection) {
      action = "SELL"; reasonParts.push(`Resistance rejection at ${pa.resistance?.toFixed(2)} with ${pa.bearishEngulfing ? "bearish engulfing" : "strong red"} (EMA21 bearish).`);
    } else if (buyLiveMomentum) {
      action = "BUY"; reasonParts.push(`Momentum breakout above R=${pa.resistance?.toFixed(2)} (strong body, no upper wick).`);
    } else if (sellLiveMomentum) {
      action = "SELL"; reasonParts.push(`Momentum breakdown below S=${pa.support?.toFixed(2)} (strong body, no lower wick).`);
    } else if (boostBuy) {
      action = "BUY"; reasonParts.push(`Frequency boost BUY: 30m+ idle, medium setup near support with strong green candle.`);
    } else if (boostSell) {
      action = "SELL"; reasonParts.push(`Frequency boost SELL: 30m+ idle, medium setup near resistance with strong red candle.`);
    } else if (confluenceBuy) {
      action = "BUY"; reasonParts.push(`CONFLUENCE BUY (${buyFactors}/4): nearS=${pa.nearSupport} strong=${pa.strongGreen||pa.bullishEngulfing} mom=${pa.momentumBull||pa.bullStreak>=2} ema=${pa.emaBullish||pa.ema21Slope>0}.`);
    } else if (confluenceSell) {
      action = "SELL"; reasonParts.push(`CONFLUENCE SELL (${sellFactors}/4): nearR=${pa.nearResistance} strong=${pa.strongRed||pa.bearishEngulfing} mom=${pa.momentumBear||pa.bearStreak>=2} ema=${pa.emaBearish||pa.ema21Slope<0}.`);
    } else {
      const wickNote = pa.longUpperWick ? " upper-wick rejected" : pa.longLowerWick ? " lower-wick rejected" : "";
      reasonParts.push(`No qualifying setup. S=${pa.support?.toFixed(2) ?? "—"} R=${pa.resistance?.toFixed(2) ?? "—"} LTP=${pa.ltp?.toFixed(2) ?? "—"}${wickNote}.`);
    }

    // ===== v8 SIGNAL COOLDOWN ENFORCEMENT =====
    // After candidate action is decided, if same direction was issued in the
    // last SIGNAL_COOLDOWN_SEC, suppress to WAIT. Prevents spam/duplicate signals.
    if (action !== "WAIT" && cooldownActive && lastSignalAction === action) {
      reasonParts.unshift(`Signal cooldown: same ${action} signal issued ${Math.round(secsSinceLastSignal)}s ago (cooldown ${SIGNAL_COOLDOWN_SEC}s).`);
      action = "WAIT";
    }

    if (gapBypassedByReEntry && action !== "WAIT") {
      reasonParts.push(`(Re-entry: trend ${pa.trendUp ? "UP" : "DOWN"} still valid, gap bypassed.)`);
    }

    // ============================================================
    // PRO+++ WEIGHTED CONFIDENCE ENGINE (additive, evolution patch)
    // Replaces hard-filter bias with scoring; promotes missed FAST_SCALPs.
    // ============================================================
    // v13: starvation-fix scoring — adds EMA slope strength + body magnitude
    // so real momentum candles score high even when HH/HL trend is absent.
    const slopeAbs = Math.abs(pa.ema21Slope ?? 0);
    const strongSlopeUp = (pa.ema21Slope ?? 0) >= STRONG_SLOPE_PTS;
    const strongSlopeDown = (pa.ema21Slope ?? 0) <= -STRONG_SLOPE_PTS;
    const bodyPts = (pa.high !== null && pa.low !== null && pa.open !== null && pa.close !== null)
      ? Math.abs((pa.close as number) - (pa.open as number)) : 0;
    const bigBody = bodyPts >= BIG_BODY_PTS;

    const bullScoring = [
      { w: 12, ok: !!pa.emaBullish, label: "EMA bullish (9>21)" },
      { w: 10, ok: strongSlopeUp, label: "EMA slope strong up" },                     // v13
      { w: 18, ok: !!pa.trendUp, label: "5m trend up aligned" },
      { w: 22, ok: !!(pa.strongGreen || pa.bullishEngulfing), label: "Breakout candle" },
      { w: 8,  ok: bigBody && (pa.close ?? 0) > (pa.open ?? 0), label: "Big bull body (≥12pts)" }, // v13
      { w: 20, ok: !!pa.momentumBull, label: "Momentum confirmed" },
      { w: 10, ok: !!pa.nearSupport, label: "Support bounce zone" },
      { w: 12, ok: !!(pa.compressionBreakout === "BULL"), label: "Compression breakout" },
      { w: 8,  ok: (pa.bullStreak ?? 0) >= 2, label: "Bullish streak" },
      { w: 10, ok: !!pa.liveBullBreakout || !!pa.earlyBuy, label: "Live bull breakout" },
      { w: 6,  ok: !!pa.retestBullOk, label: "Bull retest confirmed" },
      { w: -10, ok: !!pa.longUpperWick, label: "Upper wick rejection" },
      { w: -15, ok: !!pa.bullTrap, label: "Bull-trap risk" },
    ];
    const bearScoring = [
      { w: 12, ok: !!pa.emaBearish, label: "EMA bearish (9<21)" },
      { w: 10, ok: strongSlopeDown, label: "EMA slope strong down" },                 // v13
      { w: 18, ok: !!pa.trendDown, label: "5m trend down aligned" },
      { w: 22, ok: !!(pa.strongRed || pa.bearishEngulfing), label: "Breakdown candle" },
      { w: 8,  ok: bigBody && (pa.close ?? 0) < (pa.open ?? 0), label: "Big bear body (≥12pts)" }, // v13
      { w: 20, ok: !!pa.momentumBear, label: "Momentum confirmed" },
      { w: 10, ok: !!pa.nearResistance, label: "Resistance rejection zone" },
      { w: 12, ok: !!(pa.compressionBreakout === "BEAR"), label: "Compression breakdown" },
      { w: 8,  ok: (pa.bearStreak ?? 0) >= 2, label: "Bearish streak" },
      { w: 10, ok: !!pa.liveBearBreakout || !!pa.earlySell, label: "Live bear breakdown" },
      { w: 6,  ok: !!pa.retestBearOk, label: "Bear retest confirmed" },
      { w: -10, ok: !!pa.longLowerWick, label: "Lower wick rejection" },
      { w: -15, ok: !!pa.bearTrap, label: "Bear-trap risk" },
    ];
    const sumScore = (arr: typeof bullScoring) => arr.reduce((s, x) => s + (x.ok ? x.w : 0), 0);
    const bullScore = Math.max(0, Math.min(100, sumScore(bullScoring)));
    const bearScore = Math.max(0, Math.min(100, sumScore(bearScoring)));
    const biasDir: "BUY" | "SELL" | null =
      bullScore > bearScore + 5 ? "BUY" :
      bearScore > bullScore + 5 ? "SELL" : null;
    let confidenceScore = biasDir === "BUY" ? bullScore : biasDir === "SELL" ? bearScore : Math.max(bullScore, bearScore);
    const rawConfidenceScore = confidenceScore;
    const edgeFactors = (biasDir === "SELL" ? bearScoring : bullScoring)
      .filter((x) => x.ok && x.w > 0)
      .map((x) => x.label);

    // ============================================================
    // v15: LIVE MOMENTUM SCALPING — velocity, entry quality, late-entry guard
    // (additive only — does not touch execution / Upstox / VPS flow)
    // ============================================================
    const dirStreak = biasDir === "BUY" ? (pa.bullStreak ?? 0)
                    : biasDir === "SELL" ? (pa.bearStreak ?? 0) : 0;
    const dirSlopeAligned = biasDir === "BUY" ? ((pa.ema21Slope ?? 0) >= STRONG_SLOPE_PTS)
                          : biasDir === "SELL" ? ((pa.ema21Slope ?? 0) <= -STRONG_SLOPE_PTS) : false;
    const emaSep = (pa.ema9 !== null && pa.ema21 !== null) ? Math.abs((pa.ema9 as number) - (pa.ema21 as number)) : 0;
    const liveBreak = biasDir === "BUY" ? !!(pa.liveBullBreakout || pa.earlyBuy)
                    : biasDir === "SELL" ? !!(pa.liveBearBreakout || pa.earlySell) : false;
    const dirMomentum = biasDir === "BUY" ? !!pa.momentumBull
                      : biasDir === "SELL" ? !!pa.momentumBear : false;
    const dirBigBody = bigBody && ((biasDir === "BUY" && (pa.close ?? 0) > (pa.open ?? 0)) || (biasDir === "SELL" && (pa.close ?? 0) < (pa.open ?? 0)));
    const dirTrap = biasDir === "BUY" ? !!pa.bullTrap : biasDir === "SELL" ? !!pa.bearTrap : false;

    // momentumVelocityScore 0..100
    let momentumVelocityScore = 0;
    if (biasDir) {
      momentumVelocityScore += dirSlopeAligned ? 25 : (slopeAbs >= STRONG_SLOPE_PTS * 0.6 ? 12 : 0);
      momentumVelocityScore += dirBigBody ? 20 : (bigBody ? 8 : 0);
      momentumVelocityScore += dirMomentum ? 20 : (dirStreak >= 2 ? 12 : 0);
      momentumVelocityScore += liveBreak ? 20 : 0;
      momentumVelocityScore += emaSep >= 8 ? 10 : (emaSep >= 4 ? 5 : 0);
      momentumVelocityScore += (pa.compressionBreakout === (biasDir === "BUY" ? "BULL" : "BEAR")) ? 10 : 0;
      momentumVelocityScore -= dirTrap ? 25 : 0;
      momentumVelocityScore = Math.max(0, Math.min(100, momentumVelocityScore));
    }

    // late-entry detection — already too stretched / too many expansion candles done
    const distFromEma21 = (pa.ltp !== null && pa.ema21 !== null) ? Math.abs((pa.ltp as number) - (pa.ema21 as number)) : 0;
    const overstretched = distFromEma21 >= LATE_ENTRY_STRETCH_PTS;
    const lateBody = bodyPts >= LATE_ENTRY_BODY_PTS;
    const exhausted = dirStreak >= LATE_ENTRY_STREAK_MAX && (overstretched || lateBody);
    const wickAgainst = biasDir === "BUY" ? !!pa.longUpperWick : biasDir === "SELL" ? !!pa.longLowerWick : false;
    const lateEntryPenalty = !!biasDir && (exhausted || (overstretched && wickAgainst));

    // entryQualityScore 0..100 — favors clean, not-too-late entries
    let entryQualityScore = 50;
    if (biasDir) {
      entryQualityScore += dirMomentum ? 10 : 0;
      entryQualityScore += liveBreak ? 10 : 0;
      entryQualityScore += (distFromEma21 <= 12 ? 15 : distFromEma21 <= 20 ? 5 : -15);
      entryQualityScore += dirSlopeAligned ? 10 : 0;
      entryQualityScore -= wickAgainst ? 15 : 0;
      entryQualityScore -= dirTrap ? 25 : 0;
      entryQualityScore -= lateBody ? 10 : 0;
      entryQualityScore -= overstretched ? 15 : 0;
      entryQualityScore = Math.max(0, Math.min(100, entryQualityScore));
    }

    // scalping momentum tier — drives dynamic gate
    const momentumTier: "EXPLOSIVE" | "CONTINUATION" | "NORMAL" | "CHOP" =
      momentumVelocityScore >= MOMENTUM_VELOCITY_EXPLOSIVE ? "EXPLOSIVE"
      : momentumVelocityScore >= MOMENTUM_VELOCITY_CONTINUE ? "CONTINUATION"
      : momentumVelocityScore >= MOMENTUM_VELOCITY_NORMAL ? "NORMAL"
      : "CHOP";
    const momentumGate: number | null =
      momentumTier === "EXPLOSIVE" ? MOMENTUM_GATE_EXPLOSIVE
      : momentumTier === "CONTINUATION" ? MOMENTUM_GATE_CONTINUATION
      : momentumTier === "NORMAL" ? MOMENTUM_GATE_NORMAL
      : null;
    const scalpingMomentumMode = momentumTier === "EXPLOSIVE" || momentumTier === "CONTINUATION";

    // ============================================================
    // v17: MOMENTUM OVERRIDE LAYER — momentum > structure (additive)
    // Activates ONLY during real explosive expansion.
    // ============================================================
    const trendExpansionStrength = Math.max(0, Math.min(100,
      Math.round(emaSep * 4 + dirStreak * 10 + (dirSlopeAligned ? 20 : 0) + (dirBigBody ? 15 : 0))
    ));
    // Premium velocity proxy: spot expansion velocity (body * streak) — VPS/Upstox untouched.
    const premiumVelocity = Number((bodyPts * Math.max(1, dirStreak) * (liveBreak ? 1.2 : 1)).toFixed(2));
    const momentumExhaustionRisk = !!biasDir && (exhausted || (dirStreak >= 4 && wickAgainst) || (overstretched && lateBody));
    const momentumOverrideActive = !!biasDir
      && tradingMode !== "sniper"
      && momentumVelocityScore >= MOM_OVR_VELOCITY_MIN
      && dirSlopeAligned
      && emaSep >= MOM_OVR_EMA_SEP_MIN
      && dirStreak >= MOM_OVR_STREAK_MIN
      && (liveBreak || dirMomentum || dirBigBody)
      && !wickAgainst
      && !dirTrap
      && !momentumExhaustionRisk
      && !lateEntryPenalty;
    const momentumConvictionMultiplier = !momentumOverrideActive ? 1
      : (momentumVelocityScore >= MOM_OVR_VELOCITY_EXTREME ? MOM_OVR_MULT_EXTREME : MOM_OVR_MULT_EXPLOSIVE);
    if (momentumOverrideActive && momentumConvictionMultiplier > 1) {
      confidenceScore = Math.max(0, Math.min(100, Math.round(confidenceScore * momentumConvictionMultiplier)));
    }
    // Sideways override — never treat as sideways during real momentum expansion
    const sidewaysOverrideActive = !!pa.sidewaysMarket && (
      momentumOverrideActive
      || (scalpingMomentumMode && (dirSlopeAligned || liveBreak) && emaSep >= 4 && dirStreak >= 2)
    );


    // v13: full scoring breakdown for live debug panel (real backend values)
    const scoringBreakdown = (biasDir === "SELL" ? bearScoring : bullScoring).map((x) => ({
      label: x.label, weight: x.w, applied: x.ok, contribution: x.ok ? x.w : 0,
    }));

    // v13: regime promotion — treat strong EMA slope as TRENDING-equivalent even
    // without confirmed HH/HL pattern. This was the core CHOPPY-starvation bug.
    const slopeTrending = slopeAbs >= STRONG_SLOPE_PTS;
    const regime: "TRENDING" | "CHOPPY" | "COMPRESSION" =
      pa.compression ? "COMPRESSION" :
      (pa.trendUp || pa.trendDown || slopeTrending) ? "TRENDING" : "CHOPPY";

    const hardBlocked = dailyTargetHit || maxDailyLossHit || lossPauseActive || postLossCooldownActive || !tradeCapOk || (!tradeGapOk && !gapBypassedByReEntry) || cooldownActive;

    // v13: regime-aware HARD confidence gate + open-session adaptive relief
    const baseGate =
      tradingMode === "sniper" ? CONF_GATE_SNIPER :
      regime === "TRENDING" ? CONF_GATE_TRENDING :
      regime === "CHOPPY" ? CONF_GATE_CHOPPY :
      CONF_GATE_SCALPING;
    const _now = new Date();
    const istMinutes = (_now.getUTCHours() * 60 + _now.getUTCMinutes() + 330) % 1440;
    const openSessionActive = istMinutes >= OPEN_SESSION_START_IST_MIN && istMinutes <= OPEN_SESSION_END_IST_MIN;
    // v14: session-phase classification (additive, does not change exec flow)
    const preMarketActive = istMinutes >= PREMARKET_START_IST_MIN && istMinutes <= PREMARKET_END_IST_MIN;
    const openingDriveActive = istMinutes >= OPENING_DRIVE_START_IST_MIN && istMinutes <= OPENING_DRIVE_END_IST_MIN;
    const sessionPhase: "PRE_MARKET" | "OPENING_DRIVE" | "OPEN_SESSION" | "REGULAR" =
      preMarketActive ? "PRE_MARKET"
      : openingDriveActive ? "OPENING_DRIVE"
      : openSessionActive ? "OPEN_SESSION"
      : "REGULAR";
    const openSessionRelief = openSessionActive && tradingMode !== "sniper" ? OPEN_SESSION_GATE_RELIEF : 0;
    const openingDriveRelief = openingDriveActive && tradingMode !== "sniper" ? OPENING_DRIVE_EXTRA_RELIEF : 0;
    const lossBump = (lastTradeWasLoss || consecutiveLosses >= 1) ? POST_LOSS_CONFIDENCE_BUMP : 0;
    const effectiveFloor = openingDriveActive ? OPENING_DRIVE_FLOOR : CONF_GATE_FLOOR;
    // v15: dynamic momentum gate — collapse base gate when real momentum is live.
    // Sniper mode is never softened. CHOP tier keeps regime gate untouched.
    let dynamicBaseGate = (momentumGate !== null && tradingMode !== "sniper")
      ? Math.min(baseGate, momentumGate)
      : baseGate;
    // v17: momentum override → temporarily collapse base gate further (regime-aware)
    if (momentumOverrideActive) {
      const ovrLo = regime === "TRENDING" ? MOM_OVR_GATE_TRENDING_LO : MOM_OVR_GATE_NORMAL_LO;
      const ovrHi = regime === "TRENDING" ? MOM_OVR_GATE_TRENDING_HI : MOM_OVR_GATE_NORMAL_HI;
      const ovrGate = momentumVelocityScore >= MOM_OVR_VELOCITY_EXTREME ? ovrLo : ovrHi;
      dynamicBaseGate = Math.min(dynamicBaseGate, ovrGate);
    }
    const requiredConfidence = Math.max(effectiveFloor, dynamicBaseGate + lossBump - openSessionRelief - openingDriveRelief);

    // v13: CHOPPY confirm — kept loose (one of many price-action proofs)
    const choppyConfirmed = regime !== "CHOPPY" || (biasDir === "BUY"
      ? (pa.liveBullBreakout || pa.retestBullOk || pa.earlyBuy || pa.momentumBull || pa.bullStreak >= 2 || pa.bullishEngulfing || pa.strongGreen || bigBody)
      : biasDir === "SELL"
        ? (pa.liveBearBreakout || pa.retestBearOk || pa.earlySell || pa.momentumBear || pa.bearStreak >= 2 || pa.bearishEngulfing || pa.strongRed || bigBody)
        : false);

    let aiMode: "HIGH_CONVICTION" | "FAST_SCALP" | "WAIT" = "WAIT";
    let gateRejection: string | null = null;
    const gateBlockedReasons: string[] = [];

    // v14: Pre-Market (9:00–9:14) — preload analysis only, never execute.
    // Bias direction + confidence are still computed so the dashboard shows
    // the opening lean before the bell rings.
    if (preMarketActive && action !== "WAIT") {
      gateRejection = `PRE_MARKET preload — analysis only until 9:15 IST`;
      gateBlockedReasons.push("pre-market preload");
      reasonParts.unshift(`PRE-MARKET (${biasDir ?? "neutral"} lean @ ${confidenceScore}/100) — armed for 9:15 open.`);
      action = "WAIT";
    }

    // Apply confidence gate to ANY non-WAIT action
    if (action !== "WAIT") {
      if (confidenceScore < requiredConfidence) {
        gateRejection = `Conviction ${confidenceScore}/100 < gate ${requiredConfidence} (regime=${regime}${lossBump ? ", post-loss" : ""}${openingDriveActive ? ", opening-drive" : ""}${momentumGate !== null ? `, mom=${momentumTier}` : ""})`;
        gateBlockedReasons.push(`confidence ${confidenceScore} < gate ${requiredConfidence}`);
        reasonParts.unshift(`Gated to WAIT — ${gateRejection}.`);
        action = "WAIT";
      } else if (regime === "CHOPPY" && !choppyConfirmed && !openingDriveActive) {
        // v14: during 9:15–9:30 opening drive, skip the CHOPPY price-action
        // confirmation requirement — first 15 min are inherently choppy but
        // carry the day's directional intent.
        gateRejection = `CHOPPY regime requires at least one price-action confirmation`;
        gateBlockedReasons.push("CHOPPY: no price-action confirmation");
        reasonParts.unshift(`Gated to WAIT — ${gateRejection}.`);
        action = "WAIT";
      } else if (lateEntryPenalty) {
        // v15: anti-late-entry — block stretched/exhausted moves even if confidence passes.
        gateRejection = `LATE-ENTRY blocked (streak=${dirStreak}, dist=${distFromEma21.toFixed(0)}pt, body=${bodyPts.toFixed(0)}pt)`;
        gateBlockedReasons.push("late-entry: momentum overstretched");
        reasonParts.unshift(`Gated to WAIT — chasing exhausted move (${gateRejection}).`);
        action = "WAIT";
      } else if (entryQualityScore < ENTRY_QUALITY_MIN) {
        // v15: entry quality floor — refuse ugly entries (top/bottom chase, wick traps).
        gateRejection = `Entry quality ${entryQualityScore}/100 < ${ENTRY_QUALITY_MIN}`;
        gateBlockedReasons.push(`low entry quality ${entryQualityScore}`);
        reasonParts.unshift(`Gated to WAIT — ${gateRejection}.`);
        action = "WAIT";
      }
    }

    if (action !== "WAIT" && confidenceScore >= 75) aiMode = "HIGH_CONVICTION";
    else if (action !== "WAIT" && confidenceScore >= requiredConfidence) aiMode = "FAST_SCALP";
    else if (action === "WAIT" && !hardBlocked && biasDir && confidenceScore >= requiredConfidence && (regime !== "CHOPPY" || choppyConfirmed) && !lateEntryPenalty && entryQualityScore >= ENTRY_QUALITY_MIN) {
      action = biasDir;
      aiMode = "FAST_SCALP";
      reasonParts.unshift(`FAST SCALP (${confidenceScore}/100, gate ${requiredConfidence}): ${edgeFactors.slice(0, 3).join(", ") || "weighted bias"}.`);
    }


    // v9: 6th-trade override — allow exactly one extra trade if HIGH_CONVICTION + TRENDING + last win
    if (action === "WAIT" && sixthTradeWindow && biasDir && confidenceScore >= 80 && regime === "TRENDING" && lastTradeWasWin && !hardBlocked) {
      action = biasDir;
      aiMode = "HIGH_CONVICTION";
      reasonParts.unshift(`6TH-TRADE OVERRIDE: HIGH conviction (${confidenceScore}/100) in TRENDING regime after a win.`);
    }

    const rejectionReason = action === "WAIT"
      ? (cooldownActive ? `Signal cooldown ${Math.round(SIGNAL_COOLDOWN_SEC - secsSinceLastSignal)}s`
        : !tradeGapOk && !gapBypassedByReEntry ? `Min trade gap ${MIN_TRADE_GAP_MIN}m`
        : !tradeCapOk ? `Daily cap reached (${MAX_TRADES_PER_DAY})`
        : postLossCooldownActive ? `Post-loss cooldown ${postLossCooldownRemainingMin}m`
        : lossPauseActive ? `Loss-pause ${lossPauseRemainingMin}m`
        : dailyTargetHit ? `Daily target hit`
        : maxDailyLossHit ? `Kill-switch active`
        : gateRejection ? gateRejection
        : confidenceScore < requiredConfidence ? `Conviction ${confidenceScore}/100 < gate ${requiredConfidence}`
        : `No directional bias (bull ${bullScore} / bear ${bearScore})`)
      : null;

    // Intelligent WAIT reasoning — never empty.
    if (action === "WAIT" && reasonParts.length === 0) {
      reasonParts.push(
        pa.compression ? "WAIT — compression building, breakout probability increasing."
        : (pa.trendUp || pa.trendDown) ? "WAIT — momentum building, awaiting confirmation."
        : (pa.nearSupport || pa.nearResistance) ? "WAIT — EMA pullback forming near key level."
        : "WAIT — low conviction only, holding for cleaner setup."
      );
    }

    const supportStrength = pa.nearSupport
      ? ((pa.bullishEngulfing || pa.strongGreen) ? 3 : ((pa.bullStreak ?? 0) >= 2 ? 2 : 1))
      : 0;
    const resistanceStrength = pa.nearResistance
      ? ((pa.bearishEngulfing || pa.strongRed) ? 3 : ((pa.bearStreak ?? 0) >= 2 ? 2 : 1))
      : 0;

    // v13: LIVE DEBUG PAYLOAD — real backend values for the UI debug panel.
    const liveFactors = {
      emaBullish: !!pa.emaBullish,
      emaBearish: !!pa.emaBearish,
      emaSlope: Number((pa.ema21Slope ?? 0).toFixed(2)),
      strongSlopeUp,
      strongSlopeDown,
      momentumBull: !!pa.momentumBull,
      momentumBear: !!pa.momentumBear,
      breakoutDetected: !!(pa.liveBullBreakout || pa.earlyBuy || pa.recentBullBreakout),
      breakdownDetected: !!(pa.liveBearBreakout || pa.earlySell || pa.recentBearBreakout),
      retestBullOk: !!pa.retestBullOk,
      retestBearOk: !!pa.retestBearOk,
      retestConfirmed: !!(pa.retestBullOk || pa.retestBearOk),
      compressionActive: !!pa.compression,
      bullTrap: !!pa.bullTrap,
      bearTrap: !!pa.bearTrap,
      trapDetected: !!(pa.bullTrap || pa.bearTrap),
      strongCandle: !!(pa.strongGreen || pa.strongRed),
      bigBody,
      bodyPts: Number(bodyPts.toFixed(2)),
      sidewaysFilter: !!pa.sidewaysMarket && !sidewaysOverrideActive,
      choppyMarket: !!pa.choppyMarket,
      nearSupport: !!pa.nearSupport,
      nearResistance: !!pa.nearResistance,
      volumeValid: null as null | boolean,
      pcrState: "Disabled (price-action mode)",
      vixState: "n/a",
      spikeDetected: !!pa.spikeDetected,
    };
    const pipeline = [
      { stage: "MARKET DATA", passed: pa.ltp !== null, note: pa.ltp !== null ? `LTP ${pa.ltp}` : "no data" },
      { stage: "PRICE ACTION", passed: !!(pa.support && pa.resistance), note: `S=${pa.support?.toFixed(0) ?? "—"} R=${pa.resistance?.toFixed(0) ?? "—"}` },
      { stage: "SCORE AGGREGATION", passed: confidenceScore > 0, note: `${confidenceScore}/100 bull=${bullScore} bear=${bearScore}` },
      { stage: "REGIME FILTER", passed: confidenceScore >= requiredConfidence, note: `${regime} gate=${requiredConfidence}` },
      { stage: "SIGNAL DECISION", passed: action !== "WAIT", note: action },
      { stage: "ORDER EXECUTION", passed: action !== "WAIT" && !hardBlocked, note: hardBlocked ? "blocked" : (action !== "WAIT" ? "ready" : "—") },
    ];
    const gateInfo = {
      baseGate, dynamicBaseGate, requiredConfidence, regime, openSessionActive, openSessionRelief,
      openingDriveActive, openingDriveRelief, preMarketActive, sessionPhase, effectiveFloor,
      lossBump,
      passedGate: confidenceScore >= requiredConfidence,
      gateBlockedReasons,
      // v15
      momentumVelocityScore, entryQualityScore, momentumTier, momentumGate,
      // v17 override telemetry
      momentumOverrideActive, momentumConvictionMultiplier, rawConfidenceScore,
      trendExpansionStrength, premiumVelocity, momentumExhaustionRisk, sidewaysOverrideActive,
      lateEntryPenalty, scalpingMomentumMode,
      distFromEma21: Number(distFromEma21.toFixed(2)),
      emaSeparation: Number(emaSep.toFixed(2)),
    };

    console.log("[PRO+++ ENGINE v17]", { confidenceScore, rawConfidenceScore, momentumOverrideActive, momentumConvictionMultiplier, aiMode, regime, biasDir, momentumTier, momentumVelocityScore, entryQualityScore, lateEntryPenalty, momentumExhaustionRisk, sidewaysOverrideActive, requiredConfidence, dynamicBaseGate, baseGate, sessionPhase, rejectedByGate: !!gateRejection, dailyTradeCount: tradesToday });

    // SL/Target on spot points
    const entry = pa.ltp ?? 0;
    let stopLoss: number | null = null;
    let target: number | null = null;
    let slPoints: number | null = null;
    let targetPoints: number | null = null;
    if (action === "BUY") {
      stopLoss = pa.prevLow ?? (pa.ltp !== null ? pa.ltp - 15 : null);
      slPoints = userSlPoints ?? (stopLoss !== null && pa.ltp !== null ? Math.max(5, pa.ltp - stopLoss) : 15);
      targetPoints = userTargetPoints ?? Math.round(slPoints * 2);
      target = entry + targetPoints;
    } else if (action === "SELL") {
      stopLoss = pa.prevHigh ?? (pa.ltp !== null ? pa.ltp + 15 : null);
      slPoints = userSlPoints ?? (stopLoss !== null && pa.ltp !== null ? Math.max(5, stopLoss - pa.ltp) : 15);
      targetPoints = userTargetPoints ?? Math.round(slPoints * 2);
      target = entry - targetPoints;
    }

    const strikeNum = action !== "WAIT" ? pickStrike(pa.ltp, action as "BUY" | "SELL", pa.strongMomentum) : atmStrike(pa.ltp);
    const optionType = action === "BUY" ? "CE" : action === "SELL" ? "PE" : null;
    const strikeLabel = action !== "WAIT" && strikeNum !== null
      ? `Buy Nifty ${strikeNum} ${optionType}`
      : "WAIT";

    // v4: Strong trend = momentum streak OR (HH/HL & EMA-aligned)
    const strongTrend =
      (action === "BUY" && (pa.momentumBull || (pa.trendUp && pa.emaBullish))) ||
      (action === "SELL" && (pa.momentumBear || (pa.trendDown && pa.emaBearish)));

    // v4: Risk size-down on choppy markets
    const riskSizeDown = pa.choppyMarket;

    // v4: Smart trail mode
    const trailMode: "ema21" | "two-candle" | "standard" = strongTrend
      ? (pa.ema21 !== null ? "ema21" : "two-candle")
      : "standard";

    const conviction: "HIGH" | "MEDIUM" | "LOW" =
      action === "WAIT" ? "LOW"
        : (compressionBreakoutBuy || compressionBreakoutSell) ? "HIGH"
        : (trapBuy || trapSell) ? "HIGH"
        : (earlyBuy || earlySell || momentumStreakBuy || momentumStreakSell) ? "HIGH"
        : (buyBreakoutRetest || sellBreakdownRetest) && pa.strongMomentum ? "HIGH"
        : (buyBreakoutRetest || sellBreakdownRetest || trendPullbackBuy || trendPullbackSell) ? "MEDIUM"
        : pa.strongMomentum ? "HIGH"
        : (boostBuy || boostSell) ? "LOW"
        : "MEDIUM";

    const promptContext = {
      mode: tradingMode,
      ltp: pa.ltp,
      support: pa.support, resistance: pa.resistance,
      ema21: pa.ema21, ema21Slope: pa.ema21Slope,
      candle: { bullishEngulfing: pa.bullishEngulfing, bearishEngulfing: pa.bearishEngulfing, strongGreen: pa.strongGreen, strongRed: pa.strongRed, bodyPct: pa.bodyPct, upperWickPct: pa.upperWickPct, lowerWickPct: pa.lowerWickPct },
      breakout: { liveUp: pa.liveBullBreakout, liveDown: pa.liveBearBreakout, retestUp: pa.retestBullOk, retestDown: pa.retestBearOk },
      proximity: { nearSupport: pa.nearSupport, nearResistance: pa.nearResistance, midZone: pa.midZone },
      sidewaysMarket: pa.sidewaysMarket, last30Range: pa.last30Range,
      ruleAction: action, ruleStrike: strikeLabel, ruleReason: reasonParts.join(" "),
    };
    const prompt = `You are a disciplined Nifty 50 options price-action scalper v3. Use ONLY:
- Confirmed swing S/R, EMA21 + slope, strict candles (body>=60%, close near extreme).
- Breakout entries REQUIRE retest (pullback to broken level + confirmation candle).
- Reject candles with >50% wick on the breakout side.
- Skip mid-zone unless strong momentum or retest setup.
- SL = previous candle low (BUY) / high (SELL); RR 1:2.
- Strike: ATM = round(LTP/50)*50; on strong momentum, ATM±50.
- Mode: ${tradingMode.toUpperCase()}. Be decisive when a setup is present; otherwise WAIT.

Rule engine pre-computed: ACTION=${action}, STRIKE=${strikeLabel}.
Context: ${JSON.stringify(promptContext)}

Respond EXACTLY:
ACTION: BUY/SELL/WAIT
STRIKE: ${strikeLabel}
CONVICTION: HIGH/MEDIUM/LOW
REASON: [SCALPING MODE] one-line price-action trigger (entry, SL, target).`;

    let aiText = "";
    try {
      const result = await generateOpenAIText(settings.openai_api_key, prompt, 250);
      aiText = result.text || "";
    } catch (_e) {
      aiText = "";
    }

    const parsed = aiText ? parseSignal(aiText) : { action, strike: strikeLabel, reason: reasonParts.join(" ") };
    const finalReason = `[${tradingMode.toUpperCase()} MODE] ${parsed.reason || reasonParts.join(" ")}`.trim();

    // ============================================================
    // v6-safe ADDITIVE LAYER — SL/Target override + dynamic RR + smart trailing
    // DO NOT modify entry/decision logic above. This block ONLY refines
    // SL/Target math and exposes premium-conversion contract for execution.
    // ============================================================
    let slPrice: number | null = stopLoss;       // chart-based SL price (Nifty spot)
    let entryPrice: number | null = entry;       // chart-based entry (Nifty spot)
    let riskPoints: number | null = null;
    let rrMultiplier = 1.2;
    let momentumStrength: "strong" | "normal" | "weak" = "weak";
    let targetPrice: number | null = target;
    let v6TargetPoints: number | null = targetPoints;

    if (action === "BUY" || action === "SELL") {
      // SL override: previous candle low (BUY) / high (SELL) — chart-based
      if (action === "BUY") {
        slPrice = pa.prevLow ?? stopLoss;
      } else {
        slPrice = pa.prevHigh ?? stopLoss;
      }
      if (entryPrice !== null && slPrice !== null) {
        riskPoints = Math.max(1, Math.abs(entryPrice - slPrice));
      }

      // Momentum classification (AI's limited role: classify strength → RR)
      const strongMom =
        pa.strongMomentum ||
        (action === "BUY" && (pa.momentumBull || compressionBreakoutBuy || earlyBuy)) ||
        (action === "SELL" && (pa.momentumBear || compressionBreakoutSell || earlySell));
      const normalMom =
        (action === "BUY" && (pa.trendUp || pa.emaBullish || buyBreakoutRetest || trendPullbackBuy)) ||
        (action === "SELL" && (pa.trendDown || pa.emaBearish || sellBreakdownRetest || trendPullbackSell));

      if (strongMom) { momentumStrength = "strong"; rrMultiplier = 2.5; }
      else if (normalMom) { momentumStrength = "normal"; rrMultiplier = 1.8; }
      else { momentumStrength = "weak"; rrMultiplier = 1.2; }

      if (riskPoints !== null) {
        v6TargetPoints = Math.round(riskPoints * rrMultiplier * 10) / 10;
        if (entryPrice !== null) {
          targetPrice = action === "BUY"
            ? entryPrice + v6TargetPoints
            : entryPrice - v6TargetPoints;
        }
      }
    }

    // Smart trailing config (additive — frontend trail loop reads these)
    const v6TrailMode = "smart" as const;
    const v6TrailSteps = [10, 20] as const;

    // Premium-conversion contract for place-live-order:
    // executor computes premiumSL = entryPremium - riskPoints
    //                  premiumTarget = entryPremium + (riskPoints * rrMultiplier)
    const premiumContract = {
      formula: "premiumSL = entryPremium - riskPoints; premiumTarget = entryPremium + (riskPoints * rrMultiplier)",
      riskPoints,
      rrMultiplier,
      momentumStrength,
    };

    const analysisTimestamp = new Date().toISOString();
    const payloadTimestamp = liveTimestamp;
    // v8: explicit market direction, option side, and transaction type
    // (executor must not derive CE/PE from BUY/SELL — these are now first-class fields)
    const direction: "BULLISH" | "BEARISH" | null =
      action === "BUY" ? "BULLISH" : action === "SELL" ? "BEARISH" : null;
    const optionSide: "CE" | "PE" | null = optionType as ("CE" | "PE" | null);
    const transactionType: "BUY" = "BUY"; // we always BUY (long) the option leg
    const signal = {
      action,
      direction,
      optionSide,
      transactionType,
      strike: strikeLabel,
      reason: finalReason,
      conviction,
      optionType,
      entry,
      entryPrice,
      stopLoss,
      target,
      slPoints,
      targetPoints,
      strikeNumber: strikeNum,
      // ===== v6-safe additive fields =====
      slPrice,                       // chart-based stop price (spot)
      targetPrice,                   // chart-based target price (spot)
      riskPoints,                    // |entry - SL|
      rrMultiplier,                  // 2.5 / 1.8 / 1.2
      momentumStrength,              // strong / normal / weak
      // premium fields are computed at execution time (entryPremium known there)
      premiumSL: null as number | null,
      premiumTarget: null as number | null,
      premiumContract,
      trailMode: v6TrailMode,
      trailSteps: v6TrailSteps,
      engineVersion: "price-action-scalper-v12-aggressive-protected",
      liveSpot: pa.ltp,
      analysisTimestamp,
      payloadTimestamp,
    };

    const highProbability = action !== "WAIT";
    // v14.1: 1-lot integrity — options lots are indivisible. NEVER size below the user's base lot when
    // base is already 1 (65 qty). Post-loss halving only applies when base ≥ 2 lots.
    const halvedLots = Math.floor(tradingLotSize * positionSizeMultiplier);
    const sizedLots = Math.max(1, tradingLotSize === 1 ? tradingLotSize : halvedLots);
    const effectiveLotSize = sizedLots;
    const effectiveTradingQuantity = effectiveLotSize * NIFTY_LOT_SIZE; // floor: 65 qty

    const ruleContext = {
      atmStrike: atmStrike(pa.ltp),
      rules: {
        ltp: pa.ltp,
        support15: pa.support,
        resistance15: pa.resistance,
        immediateSupport: pa.support,
        immediateResistance: pa.resistance,
        ema9: pa.ema9,
        ema21: pa.ema21,
        ema21Slope: pa.ema21Slope,
        priceAboveEma21: pa.emaBullish,
        priceBelowEma21: pa.emaBearish,
        bullishEngulfing: pa.bullishEngulfing,
        bearishEngulfing: pa.bearishEngulfing,
        strongGreen: pa.strongGreen,
        strongRed: pa.strongRed,
        bodyPct: pa.bodyPct,
        upperWickPct: pa.upperWickPct,
        lowerWickPct: pa.lowerWickPct,
        breakoutAboveR15: pa.liveBullBreakout || pa.retestBullOk,
        breakdownBelowS15: pa.liveBearBreakout || pa.retestBearOk,
        retestBullOk: pa.retestBullOk,
        retestBearOk: pa.retestBearOk,
        nearSupport: pa.nearSupport,
        nearResistance: pa.nearResistance,
        midZone: pa.midZone,
        last30Range: pa.last30Range,
        sidewaysMarket: pa.sidewaysMarket,
        choppyMarket: pa.choppyMarket,
        strongMomentum: pa.strongMomentum,
        // v4 additions
        momentumBull: pa.momentumBull,
        momentumBear: pa.momentumBear,
        bullStreak: pa.bullStreak,
        bearStreak: pa.bearStreak,
        trendUp: pa.trendUp,
        trendDown: pa.trendDown,
        pullbackBuy: pa.pullbackBuy,
        pullbackSell: pa.pullbackSell,
        earlyBuy: pa.earlyBuy,
        earlySell: pa.earlySell,
        reEntryBuy,
        reEntrySell,
        gapBypassedByReEntry,
        frequencyBoostActive,
        strongTrend,
        trailMode,
        // Compatibility shims
        volumeValid: null,
        pcr: null,
        pcrState: "Disabled (price-action mode)",
        vixSizeCut: false,
        vixRising: false,
        // v5 additions
        bullTrap: pa.bullTrap,
        bearTrap: pa.bearTrap,
        liveBullTrap: pa.liveBullTrap,
        liveBearTrap: pa.liveBearTrap,
        trapBuy,
        trapSell,
        spikeDetected: pa.spikeDetected,
        spikeAgeMin: pa.spikeAgeMin === Infinity ? null : pa.spikeAgeMin,
        spikeBlock,
        compression: pa.compression,
        compressionBreakout: pa.compressionBreakout,
        compressionBreakoutBuy,
        compressionBreakoutSell,
        consecutiveLosses,
        lossPauseActive,
        lossPauseRemainingMin,
        positionSizeMultiplier,
        lastTradePnl,
        // v9 additions
        regime,
        aiMode,
        mode: aiMode,
        confidenceScore,
        requiredConfidence,
        bullScore,
        bearScore,
        edgeFactors,
        rejectionReason,
        supportStrength,
        resistanceStrength,
        postLossCooldownActive,
        postLossCooldownRemainingMin,
        sixthTradeWindow,
        // v14.1: wallet-protection + 1-lot integrity surface
        safeMode,
        forceCloseOpenTrade,
        maxDailyLossCap: MAX_DAILY_LOSS_HARD_CAP,
        floatingPnl,
        projectedDailyPnl,
        baseLotSize: tradingLotSize,
        minLotSize: 1,
        minQuantity: NIFTY_LOT_SIZE,
        // v13: debug payload (real backend values)
        scoringBreakdown,
        bullScoringFull: bullScoring.map(x => ({ label: x.label, weight: x.w, applied: x.ok })),
        bearScoringFull: bearScoring.map(x => ({ label: x.label, weight: x.w, applied: x.ok })),
        liveFactors,
        pipeline,
        gateInfo,
      },
      guidance: reasonParts,
      tradesToday,
      tradeGapMinutes: Math.round(minutesSinceLastTrade === Infinity ? -1 : minutesSinceLastTrade),
    };

    // Validate market_data_id is a real DB row id (UUID-shaped). liveMarket payloads
    // from the frontend may not have a valid id and would otherwise fail the FK.
    const latestId = (latest as any)?.id;
    const safeMarketDataId =
      typeof latestId === "string" && /^[0-9a-f-]{36}$/i.test(latestId) ? latestId : null;

    console.log("[AI RAW]", { aiText: aiText.slice(0, 500), action, strikeLabel });
    console.log("[AI PARSED]", {
      support: pa.support, resistance: pa.resistance, ltp: pa.ltp,
      ema21: pa.ema21, ema21Slope: pa.ema21Slope,
      momentumBull: pa.momentumBull, momentumBear: pa.momentumBear,
      trendUp: pa.trendUp, trendDown: pa.trendDown,
      conviction, action,
    });
    if (action === "BUY" || action === "SELL") {
      console.log("[SIGNAL GENERATED]", { action, strike: strikeLabel, conviction, entry, stopLoss, target });
    } else {
      console.log("[NO TRADE CONDITIONS]", { reason: reasonParts.join(" ") });
    }

    const { data, error } = await auth.adminClient.from("ai_trade_signals").insert({
      user_id: auth.user.id,
      market_data_id: safeMarketDataId,
      action: signal.action,
      strike: signal.strike,
      reason: signal.reason,
      raw_response: JSON.stringify({
        text: aiText,
        engine: "price-action-scalper-v5",
        tradingMode,
        signal,
        analysisTimestamp,
        payloadTimestamp,
        liveSpot: pa.ltp,
        ruleContext,
        executionIntent,
        tradingLotSize, niftyLotSize: NIFTY_LOT_SIZE, tradingQuantity,
        effectiveLotSize, effectiveTradingQuantity,
        userTargetPoints, userSlPoints,
        riskSizeDown,
        // v5
        protection: {
          consecutiveLosses,
          lossPauseActive,
          lossPauseRemainingMin,
          positionSizeMultiplier,
          spikeBlock,
          spikeAgeMin: pa.spikeAgeMin === Infinity ? null : pa.spikeAgeMin,
          bullTrap: pa.bullTrap,
          bearTrap: pa.bearTrap,
          compression: pa.compression,
          compressionBreakout: pa.compressionBreakout,
        },
        trail: {
          triggerPts: TRAIL_TRIGGER_PTS,
          lockAtProfit: TRAIL_LOCK_AT_PROFIT,
          lockPts: TRAIL_LOCK_PTS,
          mode: trailMode,
          description: trailMode === "ema21"
            ? "Strong trend: trail using EMA21"
            : trailMode === "two-candle"
              ? "Strong trend: trail using last 2 candle low/high"
              : "Standard: BE@+10, lock+10@+20, then last-candle trail",
        },
        partialBook: {
          enabled: true,
          atProfitPts: PARTIAL_BOOK_PTS,
          fraction: PARTIAL_BOOK_FRACTION,
          description: `Book ${PARTIAL_BOOK_FRACTION * 100}% at +${PARTIAL_BOOK_PTS}pts, trail rest`,
        },
      }),
    }).select("*").single();
    if (error) throw error;

    return json({
      success: true,
      signal: {
        ...data,
        tradingMode,
        conviction,
        highProbability,
        ruleContext,
        raw_text: aiText || finalReason,
        tradingLotSize,
        effectiveLotSize,
        tradingQuantity,
        effectiveTradingQuantity,
        riskSizeDown,
        userTargetPoints, userSlPoints,
        optionType: signal.optionType,
        entry: signal.entry,
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        target: signal.target,
        slPoints: signal.slPoints,
        targetPoints: signal.targetPoints,
        strikeNumber: signal.strikeNumber,
        // v6-safe additive
        slPrice: signal.slPrice,
        targetPrice: signal.targetPrice,
        riskPoints: signal.riskPoints,
        rrMultiplier: signal.rrMultiplier,
        momentumStrength: signal.momentumStrength,
        premiumSL: signal.premiumSL,
        premiumTarget: signal.premiumTarget,
        premiumContract: signal.premiumContract,
        trailMode: signal.trailMode,
        trailSteps: signal.trailSteps,
        engineVersion: signal.engineVersion,
        liveSpot: signal.liveSpot,
        analysisTimestamp: signal.analysisTimestamp,
        payloadTimestamp: signal.payloadTimestamp,
        trail: {
          triggerPts: TRAIL_TRIGGER_PTS,
          lockAtProfit: TRAIL_LOCK_AT_PROFIT,
          lockPts: TRAIL_LOCK_PTS,
          mode: trailMode,
          strongTrend,
        },
        partialBook: {
          atProfitPts: PARTIAL_BOOK_PTS,
          fraction: PARTIAL_BOOK_FRACTION,
        },
        protection: {
          consecutiveLosses,
          lossPauseActive,
          lossPauseRemainingMin,
          positionSizeMultiplier,
          spikeBlock,
          spikeAgeMin: pa.spikeAgeMin === Infinity ? null : pa.spikeAgeMin,
          bullTrap: pa.bullTrap,
          bearTrap: pa.bearTrap,
          compression: pa.compression,
          compressionBreakout: pa.compressionBreakout,
        },
        // ===== PRO+++ engine fields =====
        confidenceScore,
        aiMode,
        mode: aiMode,
        regime,
        edgeFactors,
        rejectionReason,
        supportStrength,
        resistanceStrength,
        bullScore,
        bearScore,
        biasDir,
        // v14: session-phase + opening-drive metadata for dashboard
        sessionPhase,
        preMarketActive,
        openingDriveActive,
        openSessionActive,
        openingDriveRelief,
        openSessionRelief,
        effectiveFloor,
        // v15: LIVE MOMENTUM SCALPING fields
        momentumVelocityScore,
        entryQualityScore,
        momentumTier,
        momentumGate,
        dynamicBaseGate,
        lateEntryPenalty,
        scalpingMomentumMode,
        distFromEma21: Number(distFromEma21.toFixed(2)),
        emaSeparation: Number(emaSep.toFixed(2)),
        // v17: MOMENTUM OVERRIDE telemetry
        momentumOverrideActive,
        momentumConvictionMultiplier,
        rawConfidenceScore,
        trendExpansionStrength,
        premiumVelocity,
        momentumExhaustionRisk,
        sidewaysOverrideActive,
      },
    });
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : (error as any)?.message ?? (error as any)?.error_description ?? "AI analysis failed";
    let detail: string = "";
    try { detail = JSON.stringify(error, Object.getOwnPropertyNames(error as any)); } catch { detail = String(error); }
    console.error("[AI FALLBACK] analyze-with-ai failed:", reason, detail);

    // Attempt to read the live spot from the request body for fallback S/R generation.
    let fbSpot: number | null = null;
    try {
      const cloned = (error as any)?.__body ?? null;
      if (cloned && typeof cloned === "object") fbSpot = num((cloned as any).spotPrice);
    } catch { /* ignore */ }
    // Body wasn't captured — derive nothing more; frontend will pass spot on next cycle.
    const fbSupport = fbSpot !== null ? Number((fbSpot - FALLBACK_SR_DISTANCE_PTS).toFixed(2)) : null;
    const fbResistance = fbSpot !== null ? Number((fbSpot + FALLBACK_SR_DISTANCE_PTS).toFixed(2)) : null;

    return json({
      fallback: true,
      mode: "WAIT",
      action: "WAIT",
      reasoning: "Price consolidating — waiting for fresh market analysis.",
      reason: "Price consolidating — waiting for fresh market analysis.",
      support: fbSupport,
      resistance: fbResistance,
      ltp: fbSpot,
      confidence: "LOW",
      conviction: "LOW",
      strike: null,
      error: reason,
      errorDetail: detail.slice(0, 500),
      analysisTimestamp: new Date().toISOString(),
      version: "fallback-v2",
    }, 200);
  }
});
