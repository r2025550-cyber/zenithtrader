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
// v7-aggressive: faster scalping cadence
const MIN_TRADE_GAP_MIN = 4;      // was 12 — allow more trades
const MAX_TRADES_PER_DAY = 12;    // was 5 — capture more intraday moves
const SIDEWAYS_RANGE_PTS = 20;    // was 30 — fewer sideways blocks
const TRAIL_TRIGGER_PTS = 6;      // was 10 — break-even sooner
const TRAIL_LOCK_PTS = 6;         // was 10 — lock smaller profit
const TRAIL_LOCK_AT_PROFIT = 12;  // was 20 — lock earlier
const NEAR_ZONE_PTS = 12;         // proximity to S/R for bounce/rejection
const RETEST_TOLERANCE_PTS = 8;   // pullback proximity to broken level
const RETEST_MAX_AGE_CANDLES = 4; // breakout must be within last N candles
// v4 constants
const EARLY_ENTRY_MIN_BODY_PTS = 10;     // strong breakout close min body
const EARLY_ENTRY_MIN_MOVE_PTS = 10;     // 1-min move threshold
const FREQUENCY_BOOST_MIN_GAP = 30;      // minutes
const PULLBACK_TOLERANCE_PTS = 10;       // trend continuation pullback to EMA21
const PARTIAL_BOOK_PTS = 15;             // book 50% at +15
const PARTIAL_BOOK_FRACTION = 0.5;
const MOMENTUM_STREAK = 3;               // N consecutive strong candles
const CHOPPY_RANGE_PTS = 20;             // very tight = choppy
// v5 constants
const TRAP_LOOKBACK_CANDLES = 3;         // confirm trap within last N candles
const LOSS_PAUSE_MIN = 60;               // pause minutes after 2 losses
const LOSS_STREAK_THRESHOLD = 2;         // consecutive losses
const SPIKE_RANGE_PTS = 50;              // candle range that flags news/spike
const SPIKE_COOLDOWN_MIN = 1.5;          // v7: was 5 — short cooldown, then trade spike
const COMPRESSION_LOOKBACK = 5;          // last N candles for compression
const COMPRESSION_SHRINK_RATIO = 0.7;    // each candle <=70% of previous (avg)
const SR_STALE_DISTANCE_PTS = 200;
const FALLBACK_SR_DISTANCE_PTS = 35;

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

  // ===== v4: EARLY ENTRY (strong breakout close, skip retest) =====
  const earlyBuy = ltp !== null && resistance !== null && close !== null &&
    close > resistance && strongGreen && body >= EARLY_ENTRY_MIN_BODY_PTS &&
    Math.abs(oneMinMove) >= EARLY_ENTRY_MIN_MOVE_PTS && !longUpperWick && (emaBullish || ema21Slope > 0);
  const earlySell = ltp !== null && support !== null && close !== null &&
    close < support && strongRed && body >= EARLY_ENTRY_MIN_BODY_PTS &&
    Math.abs(oneMinMove) >= EARLY_ENTRY_MIN_MOVE_PTS && !longLowerWick && (emaBearish || ema21Slope < 0);

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
    const maxDailyLoss = 2000;
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
    const maxDailyLossHit = maxDailyLoss > 0 && dailyPnl <= -maxDailyLoss;

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
    const tradeCapOk = tradesToday < MAX_TRADES_PER_DAY;

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

    // ===== v5: NEWS/SPIKE & COMPRESSION FLAGS =====
    const spikeBlock = pa.spikeDetected;
    const compressionBreakoutBuy = pa.compressionBreakout === "BULL" && (pa.emaBullish || pa.ema21Slope > 0);
    const compressionBreakoutSell = pa.compressionBreakout === "BEAR" && (pa.emaBearish || pa.ema21Slope < 0);

    // ===== v5: LIQUIDITY TRAP REVERSAL SETUPS =====
    // Trap above resistance => SELL signal; trap below support => BUY signal.
    const trapSell = pa.bullTrap && (pa.strongRed || pa.bearishEngulfing || pa.liveBullTrap);
    const trapBuy = pa.bearTrap && (pa.strongGreen || pa.bullishEngulfing || pa.liveBearTrap);

    let action: "BUY" | "SELL" | "WAIT" = "WAIT";

    // AGGRESSIVE ENTRY MODE
    if (pa.momentumBull || pa.emaBullish || pa.trendUp) {
      action = "BUY";
    }

    if (pa.momentumBear || pa.emaBearish || pa.trendDown) {
      action = "SELL";
    }
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
      reasonParts.push("Max daily loss reached — kill-switch active.");
    } else if (lossPauseActive) {
      reasonParts.push(`Loss-protection pause: ${consecutiveLosses} consecutive losses — trading paused for ~${lossPauseRemainingMin}m more.`);
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

    if (gapBypassedByReEntry && action !== "WAIT") {
      reasonParts.push(`(Re-entry: trend ${pa.trendUp ? "UP" : "DOWN"} still valid, gap bypassed.)`);
    }

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
    const signal = {
      action,
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
      engineVersion: "price-action-scalper-v6-safe",
      liveSpot: pa.ltp,
      analysisTimestamp,
      payloadTimestamp,
    };

    const highProbability = action !== "WAIT";
    // v5: position sizing — halve lots after a loss; restore on win.
    const sizedLots = Math.max(1, Math.floor(tradingLotSize * positionSizeMultiplier));
    const effectiveLotSize = sizedLots;
    const effectiveTradingQuantity = effectiveLotSize * NIFTY_LOT_SIZE;

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
      },
      guidance: reasonParts,
      tradesToday,
      tradeGapMinutes: Math.round(minutesSinceLastTrade === Infinity ? -1 : minutesSinceLastTrade),
    };

    const { data, error } = await auth.adminClient.from("ai_trade_signals").insert({
      user_id: auth.user.id,
      market_data_id: latest.id,
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
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "AI analysis failed";
    console.error("[analyze-with-ai] fallback triggered:", reason, error instanceof Error ? error.stack : undefined);
    return json({
      fallback: true,
      mode: "WAIT",
      action: "WAIT",
      reasoning: "Waiting for fresh market analysis...",
      reason: "Waiting for fresh market analysis...",
      support: null,
      resistance: null,
      ltp: null,
      confidence: "LOW",
      conviction: "LOW",
      strike: null,
      error: reason,
      analysisTimestamp: new Date().toISOString(),
    }, 200);
  }
});
