import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { generateOpenAIText } from "../_shared/openai.ts";
import { corsHeaders, getAuthenticatedClients, getSettings, json, parseSignal } from "../_shared/trading.ts";

// =====================================================================
// Hybrid Price-Action Scalping Engine v4 (Smart Execution)
// ---------------------------------------------------------------------
// v3 (Disciplined) features RETAINED:
//  Confirmed swing S/R, EMA21+slope, retest entries, strict candles,
//  wick rejection, mid-zone filter, sideways guard, smart trailing.
// v4 ADDITIONS (non-destructive, additive):
//  1) EARLY ENTRY mode — strong breakout close + momentum -> immediate entry
//  2) RE-ENTRY logic — after stop-out, allow 2nd valid breakout same trend
//  3) TREND CONTINUATION — HH/HL or LH/LL pullback entries (not just S/R)
//  4) FREQUENCY BOOST — relaxed entry if 30m without trades & medium setup
//  5) SMART TRAILING UPGRADE — strong trend = EMA21 / 2-candle trail
//  6) MOMENTUM DETECTION — 3 strong same-direction candles = momentum
//  7) NO-TRADE ZONE — choppy: position-size cut flag (riskSizeDown)
//  8) PARTIAL PROFIT BOOKING — book 50% @ +15pts, trail rest
// =====================================================================

const NIFTY_LOT_SIZE = 65;
const MIN_TRADE_GAP_MIN = 12;
const MAX_TRADES_PER_DAY = 5;
const SIDEWAYS_RANGE_PTS = 30;
const TRAIL_TRIGGER_PTS = 10;     // move SL to break-even
const TRAIL_LOCK_PTS = 10;        // lock min +10 after +20
const TRAIL_LOCK_AT_PROFIT = 20;
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

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

  // Confirmed swing S/R
  const { support, resistance } = confirmedSwings(history, 30, 2, 4);

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

    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const settings = await getSettings(auth.adminClient, auth.user.id);

    const { data: history, error: latestError } = await auth.adminClient
      .from("nifty_market_data")
      .select("*")
      .eq("user_id", auth.user.id)
      .order("created_at", { ascending: false })
      .limit(80);
    const latest = history?.[0] as MarketRow | undefined;
    if (latestError || !latest) return json({ error: "Fetch Nifty data before running AI analysis." }, 400);

    const pa = buildPriceAction(latest, (history ?? []) as MarketRow[]);

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

    let action: "BUY" | "SELL" | "WAIT" = "WAIT";
    const reasonParts: string[] = [];

    // Setup detection
    // BUY-bounce: near support + bullish candle + EMA bullish + no long lower wick (rejection ok = lower wick is fine for bounce, but we want close strong)
    const buyBounce =
      pa.nearSupport &&
      (pa.bullishEngulfing || pa.strongGreen) &&
      pa.emaBullish;
    // SELL-rejection: near resistance + bearish candle + EMA bearish
    const sellRejection =
      pa.nearResistance &&
      (pa.bearishEngulfing || pa.strongRed) &&
      pa.emaBearish;
    // Breakout entries require RETEST (entry precision + fake-breakout filter)
    const buyBreakoutRetest = pa.retestBullOk && pa.emaBullish;
    const sellBreakdownRetest = pa.retestBearOk && pa.emaBearish;
    // Live breakout allowed only with strong momentum + EMA aligned (rare aggressive case)
    const buyLiveMomentum = pa.liveBullBreakout && pa.strongMomentum && pa.emaBullish;
    const sellLiveMomentum = pa.liveBearBreakout && pa.strongMomentum && pa.emaBearish;

    const anySetup =
      buyBounce || sellRejection || buyBreakoutRetest || sellBreakdownRetest || buyLiveMomentum || sellLiveMomentum;

    if (dailyTargetHit) {
      reasonParts.push("Daily profit target hit — trading paused.");
    } else if (maxDailyLossHit) {
      reasonParts.push("Max daily loss reached — kill-switch active.");
    } else if (!tradeCapOk) {
      reasonParts.push(`Daily trade cap reached (${MAX_TRADES_PER_DAY}).`);
    } else if (!tradeGapOk) {
      reasonParts.push(`Trade-gap guard: ${Math.round(minutesSinceLastTrade)}m since last trade (need ${MIN_TRADE_GAP_MIN}m).`);
    } else if (pa.sidewaysMarket && !anySetup && !pa.strongMomentum) {
      reasonParts.push(`Sideways market: 30m range ${pa.last30Range?.toFixed(1) ?? "?"} pts < ${SIDEWAYS_RANGE_PTS} (no breakout/momentum).`);
    } else if (pa.midZone && !pa.strongMomentum && !buyBreakoutRetest && !sellBreakdownRetest && !buyLiveMomentum && !sellLiveMomentum) {
      reasonParts.push(`Mid-zone: LTP between S=${pa.support?.toFixed(2)} and R=${pa.resistance?.toFixed(2)} without momentum — skip.`);
    } else if (buyBreakoutRetest) {
      action = "BUY"; reasonParts.push(`Retest BUY: pullback to broken R≈${pa.recentBullBreakout?.level.toFixed(2)} confirmed by ${pa.bullishEngulfing ? "engulfing" : "strong green"} (EMA21 bullish, slope>0).`);
    } else if (sellBreakdownRetest) {
      action = "SELL"; reasonParts.push(`Retest SELL: pullback to broken S≈${pa.recentBearBreakout?.level.toFixed(2)} confirmed by ${pa.bearishEngulfing ? "engulfing" : "strong red"} (EMA21 bearish, slope<0).`);
    } else if (buyBounce) {
      action = "BUY"; reasonParts.push(`Support bounce at ${pa.support?.toFixed(2)} with ${pa.bullishEngulfing ? "bullish engulfing" : "strong green"} (EMA21 bullish).`);
    } else if (sellRejection) {
      action = "SELL"; reasonParts.push(`Resistance rejection at ${pa.resistance?.toFixed(2)} with ${pa.bearishEngulfing ? "bearish engulfing" : "strong red"} (EMA21 bearish).`);
    } else if (buyLiveMomentum) {
      action = "BUY"; reasonParts.push(`Momentum breakout above R=${pa.resistance?.toFixed(2)} (strong body, no upper wick).`);
    } else if (sellLiveMomentum) {
      action = "SELL"; reasonParts.push(`Momentum breakdown below S=${pa.support?.toFixed(2)} (strong body, no lower wick).`);
    } else {
      const wickNote = pa.longUpperWick ? " upper-wick rejected" : pa.longLowerWick ? " lower-wick rejected" : "";
      reasonParts.push(`No qualifying setup. S=${pa.support?.toFixed(2) ?? "—"} R=${pa.resistance?.toFixed(2) ?? "—"} LTP=${pa.ltp?.toFixed(2) ?? "—"}${wickNote}.`);
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

    const conviction: "HIGH" | "MEDIUM" | "LOW" =
      action === "WAIT" ? "LOW"
        : (buyBreakoutRetest || sellBreakdownRetest) && pa.strongMomentum ? "HIGH"
        : (buyBreakoutRetest || sellBreakdownRetest) ? "MEDIUM"
        : pa.strongMomentum ? "HIGH"
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

    const signal = {
      action,
      strike: strikeLabel,
      reason: finalReason,
      conviction,
      optionType,
      entry,
      stopLoss,
      target,
      slPoints,
      targetPoints,
      strikeNumber: strikeNum,
    };

    const highProbability = action !== "WAIT";
    const effectiveLotSize = tradingLotSize;
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
        strongMomentum: pa.strongMomentum,
        // Compatibility shims
        volumeValid: null,
        pcr: null,
        pcrState: "Disabled (price-action mode)",
        vixSizeCut: false,
        vixRising: false,
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
        engine: "price-action-scalper-v3",
        tradingMode,
        signal,
        ruleContext,
        executionIntent,
        tradingLotSize, niftyLotSize: NIFTY_LOT_SIZE, tradingQuantity,
        effectiveLotSize, effectiveTradingQuantity,
        userTargetPoints, userSlPoints,
        trail: {
          triggerPts: TRAIL_TRIGGER_PTS,
          lockAtProfit: TRAIL_LOCK_AT_PROFIT,
          lockPts: TRAIL_LOCK_PTS,
          mode: "BE@+10, lock+10@+20, then last-candle trail",
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
        riskSizeDown: false,
        userTargetPoints, userSlPoints,
        optionType: signal.optionType,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        target: signal.target,
        slPoints: signal.slPoints,
        targetPoints: signal.targetPoints,
        strikeNumber: signal.strikeNumber,
        trail: {
          triggerPts: TRAIL_TRIGGER_PTS,
          lockAtProfit: TRAIL_LOCK_AT_PROFIT,
          lockPts: TRAIL_LOCK_PTS,
        },
      },
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "AI analysis failed" }, 500);
  }
});
