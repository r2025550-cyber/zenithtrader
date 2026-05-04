import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { generateOpenAIText } from "../_shared/openai.ts";
import { corsHeaders, getAuthenticatedClients, getSettings, json, parseSignal } from "../_shared/trading.ts";

// =====================================================================
// Pure Price-Action Scalping Engine for Nifty 50 Options
// ---------------------------------------------------------------------
// Removed: PCR/VIX gating, multi-confirmation scoring, AI scoring,
// "wait for perfect setup" filters, divergence/heavyweight checks.
// Kept: 15-candle Support/Resistance, EMA21 trend filter, candlestick
// patterns (engulfing + strong-body), breakout entries, fixed SL/Target,
// trailing stop loss, ATM strike picking, trade-gap & range guards.
// =====================================================================

const NIFTY_LOT_SIZE = 65;
const MIN_TRADE_GAP_MIN = 12; // 10–15 min gap between trades
const MAX_TRADES_PER_DAY = 5;
const SIDEWAYS_RANGE_PTS = 30; // <30 pts in last 30 min → WAIT
const TRAIL_TRIGGER_PTS = 10; // move SL to break-even after +10 pts
const TRAIL_STEP_PTS = 5; // then trail every +5 pts

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  return values.slice(1).reduce((avg, v) => v * k + avg * (1 - k), values[0]);
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

function buildPriceAction(latest: MarketRow, history: MarketRow[]) {
  const ltp = num(latest?.ltp);
  const open = num(latest?.open_price);
  const high = num(latest?.high_price);
  const low = num(latest?.low_price);
  const close = num(latest?.close_price);

  // 15-candle S/R (exclude live tick so breakouts can register)
  const last15 = history.slice(1, 16);
  const highs = last15.map((r) => num(r?.high_price)).filter((v): v is number => v !== null);
  const lows = last15.map((r) => num(r?.low_price)).filter((v): v is number => v !== null);
  const resistance = highs.length ? Math.max(...highs) : null;
  const support = lows.length ? Math.min(...lows) : null;

  // EMA21 on closes (chronological)
  const closes = [...history].reverse().map((r) => num(r?.ltp) ?? num(r?.close_price)).filter((v): v is number => v !== null);
  const ema21 = ema(closes, 21);
  const ema9 = ema(closes, 9);
  const priceAboveEma21 = ltp !== null && ema21 !== null && ltp > ema21;
  const priceBelowEma21 = ltp !== null && ema21 !== null && ltp < ema21;

  // Candlestick: engulfing + strong-body
  const prev = history[1];
  const pOpen = num(prev?.open_price);
  const pClose = num(prev?.close_price);
  const pHigh = num(prev?.high_price);
  const pLow = num(prev?.low_price);
  const body = open !== null && close !== null ? Math.abs(close - open) : 0;
  const range = high !== null && low !== null ? high - low : 0;
  const strongBody = range > 0 && body >= range * 0.7 && body >= 5; // big-body candle (>=5 pts)
  const bullishEngulfing = open !== null && close !== null && pOpen !== null && pClose !== null && pClose < pOpen && close > open && close >= pOpen && open <= pClose;
  const bearishEngulfing = open !== null && close !== null && pOpen !== null && pClose !== null && pClose > pOpen && close < open && close <= pOpen && open >= pClose;
  const strongGreen = open !== null && close !== null && close > open && strongBody;
  const strongRed = open !== null && close !== null && close < open && strongBody;

  // Proximity to S/R (within 12 pts)
  const nearSupport = support !== null && ltp !== null && Math.abs(ltp - support) <= 12;
  const nearResistance = resistance !== null && ltp !== null && Math.abs(ltp - resistance) <= 12;

  // Breakouts (close beyond level)
  const breakoutAboveR = ltp !== null && resistance !== null && ltp > resistance && (strongGreen || bullishEngulfing);
  const breakdownBelowS = ltp !== null && support !== null && ltp < support && (strongRed || bearishEngulfing);

  // Sideways guard: last 30 min range
  const thirtyMinRows = history.filter((row) => {
    const t = new Date((row?.source_timestamp ?? row?.created_at) as string).getTime();
    return Date.now() - t <= 30 * 60 * 1000;
  });
  const rangeVals = thirtyMinRows.flatMap((r) => [num(r.high_price), num(r.low_price), num(r.ltp)]).filter((v): v is number => v !== null);
  const last30Range = rangeVals.length > 2 ? Math.max(...rangeVals) - Math.min(...rangeVals) : null;
  const sidewaysMarket = last30Range !== null && last30Range < SIDEWAYS_RANGE_PTS;

  // Strong momentum (use 1m move + body)
  const oneMinMove = ltp !== null && num(prev?.ltp) !== null ? ltp - (num(prev?.ltp) as number) : 0;
  const strongMomentum = strongBody && Math.abs(oneMinMove) >= 8;

  return {
    ltp, open, high, low, close,
    prevHigh: pHigh, prevLow: pLow, prevClose: pClose,
    support, resistance, ema9, ema21,
    priceAboveEma21, priceBelowEma21,
    bullishEngulfing, bearishEngulfing, strongGreen, strongRed, strongBody,
    nearSupport, nearResistance,
    breakoutAboveR, breakdownBelowS,
    last30Range, sidewaysMarket,
    strongMomentum,
  };
}

function pickStrike(ltp: number | null, action: "BUY" | "SELL", strongMomentum: boolean) {
  const atm = atmStrike(ltp);
  if (atm === null) return null;
  // Slightly OTM on strong momentum for better delta on a fast move
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
      .limit(70);
    const latest = history?.[0] as MarketRow | undefined;
    if (latestError || !latest) return json({ error: "Fetch Nifty data before running AI analysis." }, 400);

    const pa = buildPriceAction(latest, (history ?? []) as MarketRow[]);

    // Hard guards
    const dailyTargetHit = dailyProfitTarget > 0 && dailyPnl >= dailyProfitTarget;
    const maxDailyLossHit = maxDailyLoss > 0 && dailyPnl <= -maxDailyLoss;

    // Trade-gap & per-day cap
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

    // Build signal (deterministic price-action rules; no AI scoring)
    let action: "BUY" | "SELL" | "WAIT" = "WAIT";
    let reasonParts: string[] = [];

    if (dailyTargetHit) {
      reasonParts.push("Daily profit target hit — trading paused.");
    } else if (maxDailyLossHit) {
      reasonParts.push("Max daily loss reached — kill-switch active.");
    } else if (!tradeCapOk) {
      reasonParts.push(`Daily trade cap reached (${MAX_TRADES_PER_DAY}).`);
    } else if (!tradeGapOk) {
      reasonParts.push(`Trade-gap guard: ${Math.round(minutesSinceLastTrade)}m since last trade (need ${MIN_TRADE_GAP_MIN}m).`);
    } else if (pa.sidewaysMarket) {
      reasonParts.push(`Sideways market: 30m range ${pa.last30Range?.toFixed(1) ?? "?"} pts < ${SIDEWAYS_RANGE_PTS}.`);
    } else {
      // BUY (CE) — bounce at support OR breakout above resistance
      const buyBounce = pa.nearSupport && (pa.bullishEngulfing || pa.strongGreen) && pa.priceAboveEma21;
      const buyBreakout = pa.breakoutAboveR;
      // SELL (PE) — rejection at resistance OR breakdown below support
      const sellRejection = pa.nearResistance && (pa.bearishEngulfing || pa.strongRed) && pa.priceBelowEma21;
      const sellBreakdown = pa.breakdownBelowS;

      if (buyBreakout) { action = "BUY"; reasonParts.push(`Breakout above 15-candle resistance ${pa.resistance?.toFixed(2)} with strong candle.`); }
      else if (buyBounce) { action = "BUY"; reasonParts.push(`Support bounce at ${pa.support?.toFixed(2)} with ${pa.bullishEngulfing ? "bullish engulfing" : "strong green candle"}, price > EMA21.`); }
      else if (sellBreakdown) { action = "SELL"; reasonParts.push(`Breakdown below 15-candle support ${pa.support?.toFixed(2)} with strong candle.`); }
      else if (sellRejection) { action = "SELL"; reasonParts.push(`Resistance rejection at ${pa.resistance?.toFixed(2)} with ${pa.bearishEngulfing ? "bearish engulfing" : "strong red candle"}, price < EMA21.`); }
      else { reasonParts.push(`No price-action setup. S=${pa.support?.toFixed(2) ?? "—"} R=${pa.resistance?.toFixed(2) ?? "—"} LTP=${pa.ltp?.toFixed(2) ?? "—"}.`); }
    }

    // SL/Target on spot points (for UI; option premium SL/T handled in place-live-order)
    let entry = pa.ltp ?? 0;
    let stopLoss: number | null = null;
    let target: number | null = null;
    let slPoints: number | null = null;
    let targetPoints: number | null = null;
    if (action === "BUY") {
      stopLoss = pa.prevLow ?? (pa.ltp !== null ? pa.ltp - 15 : null);
      slPoints = userSlPoints ?? (stopLoss !== null && pa.ltp !== null ? Math.max(5, pa.ltp - stopLoss) : 15);
      targetPoints = userTargetPoints ?? Math.round(slPoints * 2); // 1:2 RR
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
        : (pa.breakoutAboveR || pa.breakdownBelowS) && pa.strongMomentum ? "HIGH"
        : "MEDIUM";

    // Compose AI reasoning prompt — SHORT, decisive, price-action only
    const promptContext = {
      mode: tradingMode,
      ltp: pa.ltp,
      support: pa.support, resistance: pa.resistance,
      ema21: pa.ema21,
      candle: { bullishEngulfing: pa.bullishEngulfing, bearishEngulfing: pa.bearishEngulfing, strongGreen: pa.strongGreen, strongRed: pa.strongRed },
      breakout: { up: pa.breakoutAboveR, down: pa.breakdownBelowS },
      proximity: { nearSupport: pa.nearSupport, nearResistance: pa.nearResistance },
      sidewaysMarket: pa.sidewaysMarket, last30Range: pa.last30Range,
      ruleAction: action, ruleStrike: strikeLabel, ruleReason: reasonParts.join(" "),
    };
    const prompt = `You are a Nifty 50 options price-action scalper. NO indicators beyond EMA21, S/R, candlesticks. NO PCR/VIX/multi-confirmation. Use ONLY:
- BUY (CE): price near 15-candle support + bullish engulfing/strong-green + price>EMA21, OR breakout above resistance with strong candle.
- SELL (PE): price near 15-candle resistance + bearish engulfing/strong-red + price<EMA21, OR breakdown below support with strong candle.
- SL = previous candle low (BUY) / high (SELL). Target = 1.5x–2x risk.
- Skip if last-30m range < ${SIDEWAYS_RANGE_PTS} pts.
- Strike: ATM = round(LTP/50)*50; if strong momentum, ATM±50.
- Mode: ${tradingMode.toUpperCase()}. Be decisive — DO NOT default to WAIT if a setup is present.

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

    // Use rule engine as source of truth; AI text is for reasoning narrative only.
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

    // Keep ruleContext shape compatible with frontend (it reads support15/resistance15/priceAboveEma21/priceBelowEma21/volumeValid/pcr/pcrState/vixSizeCut/vixRising)
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
        priceAboveEma21: pa.priceAboveEma21,
        priceBelowEma21: pa.priceBelowEma21,
        bullishEngulfing: pa.bullishEngulfing,
        bearishEngulfing: pa.bearishEngulfing,
        strongGreen: pa.strongGreen,
        strongRed: pa.strongRed,
        breakoutAboveR15: pa.breakoutAboveR,
        breakdownBelowS15: pa.breakdownBelowS,
        nearSupport: pa.nearSupport,
        nearResistance: pa.nearResistance,
        last30Range: pa.last30Range,
        sidewaysMarket: pa.sidewaysMarket,
        strongMomentum: pa.strongMomentum,
        // Compatibility shims for old UI fields:
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
        engine: "price-action-scalper-v2",
        tradingMode,
        signal,
        ruleContext,
        executionIntent,
        tradingLotSize, niftyLotSize: NIFTY_LOT_SIZE, tradingQuantity,
        effectiveLotSize, effectiveTradingQuantity,
        userTargetPoints, userSlPoints,
        trail: { triggerPts: TRAIL_TRIGGER_PTS, stepPts: TRAIL_STEP_PTS },
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
        // Price-action specifics
        optionType: signal.optionType,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        target: signal.target,
        slPoints: signal.slPoints,
        targetPoints: signal.targetPoints,
        strikeNumber: signal.strikeNumber,
        trail: { triggerPts: TRAIL_TRIGGER_PTS, stepPts: TRAIL_STEP_PTS },
      },
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "AI analysis failed" }, 500);
  }
});
