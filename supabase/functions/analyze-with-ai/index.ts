import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { generateOpenAIText } from "../_shared/openai.ts";
import { corsHeaders, getAuthenticatedClients, getSettings, json, parseSignal } from "../_shared/trading.ts";

function num(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pctMove(current: number | null, base: number | null) {
  return current !== null && base ? ((current - base) / base) * 100 : null;
}

function ema(values: number[], period: number) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  return values.slice(1).reduce((avg, value) => value * multiplier + avg * (1 - multiplier), values[0]);
}

function atmStrike(price: number | null) {
  return price === null ? null : Math.round(price / 50) * 50;
}

const NIFTY_LOT_SIZE = 65;

function latestMinuteCloses(history: MarketRow[], count = 4) {
  const byMinute = new Map<string, number>();
  for (const row of history) {
    const price = num(row?.ltp);
    const stampedAt = row?.source_timestamp ?? row?.created_at;
    if (price === null || !stampedAt) continue;
    const minuteKey = new Date(stampedAt).toISOString().slice(0, 16);
    if (!byMinute.has(minuteKey)) byMinute.set(minuteKey, price);
  }
  return Array.from(byMinute.values()).slice(0, count);
}

type MarketRow = Record<string, unknown> & { raw_payload?: Record<string, unknown>; created_at?: string; ltp?: unknown };

function buildRuleContext(latest: MarketRow, history: MarketRow[]) {
  const ltp = num(latest?.ltp);
  const open = num(latest?.open_price);
  const high = num(latest?.high_price);
  const low = num(latest?.low_price);
  const close = num(latest?.close_price);
  const volume = num(latest?.raw_payload?.volume) ?? num(latest?.raw_payload?.quote?.data && Object.values(latest.raw_payload.quote.data)[0]?.volume) ?? num(latest?.raw_payload?.optionChain?.totalVolume);
  const volumes = history.map((row) => num(row?.raw_payload?.volume) ?? num(row?.raw_payload?.optionChain?.totalVolume)).filter((value): value is number => value !== null).slice(0, 5);
  const avg5Volume = volumes.length ? volumes.reduce((sum, value) => sum + value, 0) / volumes.length : null;
  const fallbackAvgVolume = !avg5Volume && volumes.length >= 1 ? volumes.slice(0, 2).reduce((s, v) => s + v, 0) / Math.min(2, volumes.length) : null;
  const effectiveAvgVolume = avg5Volume ?? fallbackAvgVolume;
  const volumeAvailable = volume !== null && effectiveAvgVolume !== null;
  const volumeValid = volumeAvailable ? volume >= effectiveAvgVolume * 1.05 : null;
  const previous = history[1];
  const previousHigh = num(previous?.high_price);
  const previousLow = num(previous?.low_price);
  const fakeBreakout = volumeAvailable && volumeValid === false ? Boolean((ltp !== null && previousHigh !== null && ltp > previousHigh) || (ltp !== null && previousLow !== null && ltp < previousLow)) : false;
  const movePct = pctMove(ltp, open ?? close);
  const overextended = movePct !== null && Math.abs(movePct) > 1.5;
  const created = new Date(latest?.source_timestamp ?? latest?.created_at ?? Date.now());
  const minutes = created.getHours() * 60 + created.getMinutes();
  const europeanOpenCaution = minutes >= 12 * 60 + 30 && minutes <= 13 * 60 + 30;
  const indiaVix = latest?.raw_payload?.context?.indiaVix;
  const prevVix = previous?.raw_payload?.context?.indiaVix;
  const vixMovePct = pctMove(num(indiaVix?.ltp), num(prevVix?.ltp));
  const vixRising = vixMovePct !== null ? vixMovePct > 0 : false;
  const vixSizeCut = vixMovePct !== null && vixMovePct > 5;
  const sixtyMinuteRows = history.filter((row) => Date.now() - new Date(row.created_at).getTime() <= 60 * 60 * 1000);
  const rangeValues = sixtyMinuteRows.flatMap((row) => [num(row.high_price), num(row.low_price), num(row.ltp)]).filter((value): value is number => value !== null);
  const noTradeRange = rangeValues.length > 2 && Math.max(...rangeValues) - Math.min(...rangeValues) < 40;
  const bankMove = pctMove(num(latest?.raw_payload?.context?.bankNifty?.ltp), num(latest?.raw_payload?.context?.bankNifty?.open));
  const niftyMove = pctMove(ltp, open);
  const heavyweights = ((latest?.raw_payload?.context as Record<string, unknown> | undefined)?.heavyweights ?? []) as Record<string, unknown>[];
  const heavyMoves = heavyweights.map((quote) => pctMove(num(quote?.ltp), num(quote?.open))).filter((value: number | null): value is number => value !== null);
  const pcr = num(latest?.raw_payload?.optionChain?.pcr);
  const effectiveVolume = volume ?? num(latest?.raw_payload?.optionChain?.totalVolume);
  const volumeSource = volume !== null ? latest?.raw_payload?.volumeSource ?? "upstox_quote" : effectiveVolume !== null ? "upstox_option_chain" : null;
  const chronological = [...history].reverse();
  const prices = chronological.map((row) => num(row?.ltp)).filter((value): value is number => value !== null);
  const ema9 = ema(prices, 9);
  const ema21 = ema(prices, 21);
  const priceAboveEma21 = ltp !== null && ema21 !== null ? ltp > ema21 : false;
  const priceBelowEma21 = ltp !== null && ema21 !== null ? ltp < ema21 : false;
  const emaTrend = ema9 !== null && ema21 !== null ? (ema9 > ema21 ? "bullish" : ema9 < ema21 ? "bearish" : "flat") : "pending";
  const priceAction = ltp !== null && open !== null ? (ltp > open ? "bullish" : ltp < open ? "bearish" : "flat") : "pending";
  const emaAligned = emaTrend !== "pending" && priceAction !== "pending" && emaTrend === priceAction;
  const priceAboveBothEmas = ltp !== null && ema9 !== null && ema21 !== null && ltp > ema9 && ltp > ema21;
  const priceBelowBothEmas = ltp !== null && ema9 !== null && ema21 !== null && ltp < ema9 && ltp < ema21;
  const niftyDrivenMomentum = priceAboveBothEmas || priceBelowBothEmas;
  const rawDivergence = niftyMove !== null && ((bankMove !== null && Math.sign(bankMove) !== Math.sign(niftyMove)) || heavyMoves.filter((move) => Math.sign(move) !== Math.sign(niftyMove)).length >= 2);
  const divergence = niftyDrivenMomentum ? false : rawDivergence;
  const oneMinuteMovePct = pctMove(ltp, num(previous?.ltp));
  const entry1m = oneMinuteMovePct === null ? "pending" : oneMinuteMovePct > 0 ? "bullish" : oneMinuteMovePct < 0 ? "bearish" : "flat";
  const trendMinuteCloses = latestMinuteCloses(history, 6);
  const trend5MovePct = pctMove(trendMinuteCloses[0] ?? null, trendMinuteCloses[5] ?? trendMinuteCloses[trendMinuteCloses.length - 1] ?? null);
  const trend5 = trend5MovePct === null || trendMinuteCloses.length < 5 ? "pending" : trend5MovePct > 0.08 ? "bullish" : trend5MovePct < -0.08 ? "bearish" : "flat";
  const ema1mFallbackAligned = ltp !== null && ema9 !== null && ((entry1m === "bullish" && ltp > ema9) || (entry1m === "bearish" && ltp < ema9));
  // Scalper Mode: 5m neutral/flat is acceptable if 1m shows clear breakout aligned with EMA9.
  const strong1mBreakout = oneMinuteMovePct !== null && Math.abs(oneMinuteMovePct) > 0.05 && ema1mFallbackAligned;
  const multiTimeframeAligned = (trend5 !== "pending" && entry1m !== "pending" && trend5 !== "flat" && trend5 === entry1m) || ((trend5 === "pending" || trend5 === "flat") && (ema1mFallbackAligned || strong1mBreakout));
  const minuteCloses = latestMinuteCloses(history);
  const sustainedBullish1m = minuteCloses.length >= 4 && minuteCloses[0] > minuteCloses[1] && minuteCloses[1] > minuteCloses[2] && minuteCloses[2] > minuteCloses[3];
  const sustainedBearish1m = minuteCloses.length >= 4 && minuteCloses[0] < minuteCloses[1] && minuteCloses[1] < minuteCloses[2] && minuteCloses[2] < minuteCloses[3];
  const vixStable = vixMovePct === null || vixMovePct <= 0;

  // 15-minute Support/Resistance from last 15 rows — these double as the dashboard's "Immediate S/R"
  const last15 = history.slice(0, 15);
  const highs15 = last15.map((r) => num(r?.high_price)).filter((v): v is number => v !== null);
  const lows15 = last15.map((r) => num(r?.low_price)).filter((v): v is number => v !== null);
  const resistance15 = highs15.length ? Math.max(...highs15) : null;
  const support15 = lows15.length ? Math.min(...lows15) : null;
  const highVolume = volumeAvailable && volume !== null && effectiveAvgVolume !== null && volume >= effectiveAvgVolume * 1.2;
  const breakoutAboveR15 = ltp !== null && resistance15 !== null && ltp > resistance15 && highVolume;
  const breakdownBelowS15 = ltp !== null && support15 !== null && ltp < support15 && highVolume;
  const srBreakout = breakoutAboveR15 || breakdownBelowS15;

  // Ghanshyam Sir's Foundation: PDH / PDL / PDC bias
  const yesterday = (latest?.raw_payload as any)?.context?.yesterday ?? {};
  const pdh = num(yesterday?.pdh);
  const pdl = num(yesterday?.pdl);
  const pdc = num(yesterday?.pdc);
  const pdhBreakWithVolume = ltp !== null && pdh !== null && ltp > pdh && (highVolume || volumeValid === true);
  const pdlBreakWithVolume = ltp !== null && pdl !== null && ltp < pdl && (highVolume || volumeValid === true);
  const aboveYesterdayClose = ltp !== null && pdc !== null && ltp > pdc;
  const belowYesterdayClose = ltp !== null && pdc !== null && ltp < pdc;

  // Candlestick patterns on latest 1m vs previous (for Quick Scalp at S/R)
  const prevOpen = num(previous?.open_price);
  const prevClose = num(previous?.close_price);
  const bodyTop = open !== null && close !== null ? Math.max(open, close) : null;
  const bodyBottom = open !== null && close !== null ? Math.min(open, close) : null;
  const bodySize = bodyTop !== null && bodyBottom !== null ? bodyTop - bodyBottom : 0;
  const lowerWick = bodyBottom !== null && low !== null ? bodyBottom - low : 0;
  const upperWick = bodyTop !== null && high !== null ? high - bodyTop : 0;
  const bullishEngulfing = open !== null && close !== null && prevOpen !== null && prevClose !== null && prevClose < prevOpen && close > open && close >= prevOpen && open <= prevClose;
  const bearishEngulfing = open !== null && close !== null && prevOpen !== null && prevClose !== null && prevClose > prevOpen && close < open && close <= prevOpen && open >= prevClose;
  const hammer = bodySize > 0 && lowerWick >= bodySize * 2 && upperWick <= bodySize * 0.5 && close !== null && open !== null && close >= open;
  const shootingStar = bodySize > 0 && upperWick >= bodySize * 2 && lowerWick <= bodySize * 0.5 && close !== null && open !== null && close <= open;
  const nearSupport = support15 !== null && ltp !== null && Math.abs(ltp - support15) <= 15;
  const nearResistance = resistance15 !== null && ltp !== null && Math.abs(ltp - resistance15) <= 15;
  const quickScalpBuy = (bullishEngulfing || hammer) && nearSupport;
  const quickScalpSell = (bearishEngulfing || shootingStar) && nearResistance;

  // Nifty 9:20 ORB candle (IST) — find the 1-min row stamped at 09:20 today and cap its size at 30 points.
  // If 9:20 candle range > 30 points, treat as a "wide opening" → suppress fresh entries until volatility settles.
  const todayIso = new Date().toISOString().slice(0, 10);
  const nineTwentyRow = history.find((row) => {
    const stamp = new Date((row?.source_timestamp ?? row?.created_at) as string);
    // Convert to IST (UTC+5:30); 09:20 IST == 03:50 UTC
    const istMinutes = stamp.getUTCHours() * 60 + stamp.getUTCMinutes() + 330;
    const istHour = Math.floor((istMinutes % 1440) / 60);
    const istMin = (istMinutes % 1440) % 60;
    const sameDay = stamp.toISOString().slice(0, 10) === todayIso || (istMinutes >= 1440 && new Date(stamp.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10) === todayIso);
    return sameDay && istHour === 9 && istMin === 20;
  });
  const nineTwentyHigh = num(nineTwentyRow?.high_price);
  const nineTwentyLow = num(nineTwentyRow?.low_price);
  const nineTwentyRange = nineTwentyHigh !== null && nineTwentyLow !== null ? nineTwentyHigh - nineTwentyLow : null;
  const nineTwentyOversized = nineTwentyRange !== null && nineTwentyRange > 30;

  // Psychological round-number proximity (Nifty 50-point levels: 24100, 24150, 24200…)
  const nearestRound50 = ltp !== null ? Math.round(ltp / 50) * 50 : null;
  const distanceToRound50 = ltp !== null && nearestRound50 !== null ? Math.abs(ltp - nearestRound50) : null;
  const nearRound50 = distanceToRound50 !== null && distanceToRound50 <= 10; // within 10 pts of a 50-level
  const atRound50 = distanceToRound50 !== null && distanceToRound50 <= 3;

  return {
    rules: { volumeValid, volume: effectiveVolume, volumeSource, avg5Volume, fakeBreakout, vixRising, vixMovePct, vixSizeCut, vixStable, europeanOpenCaution, overextended, noTradeRange, divergence, rawDivergence, niftyDrivenMomentum, priceAboveBothEmas, priceBelowBothEmas, pcr, pcrState: pcr === null ? "Unavailable" : pcr > 1.3 ? "Overbought" : pcr < 0.7 ? "Oversold" : "Neutral", ema9, ema21, priceAboveEma21, priceBelowEma21, emaTrend, emaAligned, trend5, trend5MovePct, entry1m, multiTimeframeAligned, sustainedBullish1m, sustainedBearish1m, resistance15, support15, immediateSupport: support15, immediateResistance: resistance15, breakoutAboveR15, breakdownBelowS15, srBreakout, highVolume, bullishEngulfing, bearishEngulfing, hammer, shootingStar, quickScalpBuy, quickScalpSell, previousLow, previousHigh, strong1mBreakout, low, high, pdh, pdl, pdc, pdhBreakWithVolume, pdlBreakWithVolume, aboveYesterdayClose, belowYesterdayClose, ltp, nineTwentyHigh, nineTwentyLow, nineTwentyRange, nineTwentyOversized, nearestRound50, distanceToRound50, nearRound50, atRound50 },
    atmStrike: atmStrike(ltp),
    guidance: [
      fakeBreakout ? "POTENTIAL TRAP: breakout/breakdown happened without the required +10% volume filter." : volumeValid === true ? `Volume +10% filter confirmed from ${volumeSource ?? "Upstox live feed"}.` : effectiveVolume !== null ? `Volume received from ${volumeSource ?? "Upstox"} but awaiting enough history for +10% comparison; treat as neutral, not failed.` : "Volume unavailable/insufficient from Upstox; treat as neutral, not failed.",
      vixSizeCut ? `India VIX rising ${vixMovePct?.toFixed(2)}%: reduce position size by 50%.` : vixRising ? "India VIX rising but below 5% size-cut threshold." : "India VIX not rising or unavailable.",
      europeanOpenCaution ? "European Market Open time-block: extra caution active." : "Normal time block.",
      overextended ? "Overextended Zone: Nifty moved >1.5% without pullback; stop new entries." : "Mean-reversion guard clear.",
      noTradeRange ? "No-Trade Zone: 60-minute range is under 40 points." : "Range filter clear or awaiting more history.",
      niftyDrivenMomentum ? `Nifty momentum override active (price ${priceAboveBothEmas ? "above" : "below"} both 9 & 21 EMA on 1m+5m); Bank Nifty divergence weight reduced.` : (divergence ? "Divergence Guard: Nifty disagrees with Bank Nifty/top heavyweights; Low Conviction." : "Divergence guard clear or awaiting context."),
      pcr === null ? "PCR temporarily unavailable from option-chain payload; do not downgrade conviction only for missing PCR." : `PCR ${pcr}: ${pcr > 1.3 ? "Overbought" : pcr < 0.7 ? "Oversold" : "Neutral"}.`,
      emaAligned ? `9/21 EMA crossover aligns ${emaTrend} with price action.` : `9/21 EMA alignment pending/failed: EMA=${emaTrend}, price=${priceAction}.`,
      multiTimeframeAligned ? `5m ${trend5} confirms 1m ${entry1m} (or scalper-mode 1m breakout).` : `5m=${trend5}, 1m=${entry1m} — scalper-mode awaiting 1m EMA-aligned breakout.`,
      srBreakout ? `S/R BREAKOUT: ${breakoutAboveR15 ? `15m resistance broken with high volume` : `15m support broken with high volume`}. EMA21 rule overridden.` : `15m S/R: support ${support15?.toFixed(2) ?? "n/a"}, resistance ${resistance15?.toFixed(2) ?? "n/a"}.`,
      quickScalpBuy ? "QUICK SCALP BUY: bullish engulfing/hammer at 15m support." : quickScalpSell ? "QUICK SCALP SELL: bearish engulfing/shooting-star at 15m resistance." : "No candlestick scalp pattern at S/R.",
      pdh !== null || pdl !== null || pdc !== null ? `Yesterday OHLC — PDH ${pdh?.toFixed(2) ?? "n/a"} · PDL ${pdl?.toFixed(2) ?? "n/a"} · PDC ${pdc?.toFixed(2) ?? "n/a"}. ${pdhBreakWithVolume ? "BULLISH BIAS: PDH broken with volume." : pdlBreakWithVolume ? "BEARISH BIAS: PDL broken with volume." : aboveYesterdayClose ? "Above PDC (mild bullish bias)." : belowYesterdayClose ? "Below PDC (mild bearish bias)." : "Inside yesterday's range."}` : "Yesterday OHLC unavailable.",
      nineTwentyRange !== null ? `9:20 ORB candle range = ${nineTwentyRange.toFixed(2)} pts. ${nineTwentyOversized ? "OVERSIZED OPENING (>30 pts cap): suppress fresh entries until volatility settles; only allow trades that confirm beyond the 9:20 high/low with volume." : "Within 30-pt cap — opening volatility acceptable."}` : "9:20 candle not yet formed (or pre-open).",
      nearestRound50 !== null ? `Nearest psychological 50-level: ${nearestRound50}. ${atRound50 ? "PRICE AT round number — prioritise; expect reaction (bounce or breakout)." : nearRound50 ? `Within ${distanceToRound50?.toFixed(1)} pts of ${nearestRound50} — high-priority zone for scalp entries.` : `${distanceToRound50?.toFixed(1)} pts away — neutral zone, lower priority.`}` : "Round-number context unavailable.",
    ],
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const tradingMode: "scalping" | "sniper" = body?.tradingMode === "sniper" ? "sniper" : "scalping";
    const tradingLotSize = Number.isInteger(body?.tradingLotSize) && body.tradingLotSize > 0 ? body.tradingLotSize : Number.isInteger(body?.tradingQuantity) && body.tradingQuantity > 0 ? Math.max(1, Math.ceil(body.tradingQuantity / NIFTY_LOT_SIZE)) : null;
    const tradingQuantity = tradingLotSize ? tradingLotSize * NIFTY_LOT_SIZE : null;
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
    const latest = history?.[0];
    if (latestError || !latest) return json({ error: "Fetch Nifty data before running AI analysis." }, 400);

    const ruleContext = buildRuleContext(latest, history ?? []);
    const dailyTargetHit = dailyProfitTarget > 0 && dailyPnl >= dailyProfitTarget;
    const maxDailyLossHit = maxDailyLoss > 0 && dailyPnl <= -maxDailyLoss;
    if (dailyTargetHit || maxDailyLossHit) {
      const reason = dailyTargetHit ? "Target Achieved: daily profit target reached. AI trading stopped for the day." : "Hard Kill-Switch Active: max daily loss reached. Trading disabled for the day.";
      return json({ success: true, signal: { action: "WAIT", strike: "WAIT", reason, conviction: "LOW", highProbability: false, ruleContext, raw_text: `ACTION: WAIT\nSTRIKE: WAIT\nCONVICTION: LOW\nREASON: ${reason}` } });
    }

    const r = ruleContext.rules;
    // Scalper Mode gates: relaxed sustained-candle and 5m requirements; S/R breakout or candlestick scalp can fully override EMA21.
    // 9:20 oversized opening guard: when the 9:20 candle exceeds the 30-pt cap, only allow entries that have CLEARED the 9:20 high/low with volume.
    const ltpForGate = r.ltp;
    const beyondNineTwentyHighWithVol = r.nineTwentyHigh !== null && ltpForGate !== null && ltpForGate > r.nineTwentyHigh && (r.highVolume || r.volumeValid === true);
    const beyondNineTwentyLowWithVol = r.nineTwentyLow !== null && ltpForGate !== null && ltpForGate < r.nineTwentyLow && (r.highVolume || r.volumeValid === true);
    const nineTwentyBuyOk = !r.nineTwentyOversized || beyondNineTwentyHighWithVol;
    const nineTwentySellOk = !r.nineTwentyOversized || beyondNineTwentyLowWithVol;

    const buySniperReady = nineTwentyBuyOk && (r.priceAboveEma21 === true || r.breakoutAboveR15 === true || r.quickScalpBuy === true) && r.vixStable === true && (r.volumeValid === true || r.highVolume === true || r.srBreakout === true) && (r.sustainedBullish1m === true || r.entry1m === "bullish" || r.strong1mBreakout === true || r.quickScalpBuy === true) && (r.trend5 === "bullish" || r.trend5 === "flat" || r.trend5 === "pending" || r.srBreakout === true || r.quickScalpBuy === true);
    const sellSniperReady = nineTwentySellOk && (r.priceBelowEma21 === true || r.breakdownBelowS15 === true || r.quickScalpSell === true) && r.vixStable === true && (r.volumeValid === true || r.highVolume === true || r.srBreakout === true) && (r.sustainedBearish1m === true || r.entry1m === "bearish" || r.strong1mBreakout === true || r.quickScalpSell === true) && (r.trend5 === "bearish" || r.trend5 === "flat" || r.trend5 === "pending" || r.srBreakout === true || r.quickScalpSell === true);
    const baseGateScore = Math.round(([r.volumeValid === true || r.highVolume === true, r.vixStable === true, r.priceAboveEma21 || r.priceBelowEma21 || r.srBreakout, r.sustainedBullish1m || r.sustainedBearish1m || r.strong1mBreakout, r.emaAligned === true, r.multiTimeframeAligned === true].filter(Boolean).length / 6) * 100);
    const instantEmaBoost = (r.priceAboveBothEmas || r.priceBelowBothEmas) ? 40 : 0;
    const srBoost = (r.srBreakout || r.quickScalpBuy || r.quickScalpSell) ? 30 : 0;
    const pdhPdlBoost = (r.pdhBreakWithVolume || r.pdlBreakWithVolume) ? 25 : (r.aboveYesterdayClose || r.belowYesterdayClose) ? 8 : 0;
    // Round-number proximity boost: prioritise scalps near 50-pt psychological levels.
    const roundNumberBoost = r.atRound50 ? 15 : r.nearRound50 ? 8 : 0;
    // Penalise when 9:20 is oversized and we don't have a confirmed break beyond it.
    const nineTwentyPenalty = r.nineTwentyOversized && !beyondNineTwentyHighWithVol && !beyondNineTwentyLowWithVol ? -20 : 0;
    const sniperConfirmationScore = Math.min(100, Math.max(0, Math.max(baseGateScore + nineTwentyPenalty, instantEmaBoost + srBoost + pdhPdlBoost + roundNumberBoost + nineTwentyPenalty + Math.round(baseGateScore * 0.6))));

    // Nifty 50 scalping: minimum score lowered to 70 per execution-logic spec.
    const minScore = tradingMode === "scalping" ? 70 : 80;
    const scalpingPrompt = `MODE: SCALPING (active). You are the trading mind for a Nifty Options SCALPER (4–5 quality trades/day target). IGNORE strict Sniper constraints. Apply Scalping logic:
- SCALPER MODE: Generate BUY/SELL on either (a) sustained 1m trend, (b) 15m S/R breakout with high volume (overrides 21 EMA), or (c) Bullish Engulfing/Hammer at 15m support (Quick Scalp Buy) / Bearish Engulfing/Shooting-Star at 15m resistance (Quick Scalp Sell).
- TREND ALIGNMENT (relaxed): If 5m is Neutral/Flat and 1m shows a strong EMA-aligned breakout, that counts as aligned. Do NOT require both 1m and 5m same color.
- 15m S/R OVERRIDE: If price breaks the 15m high/low with high volume, IGNORE the 21 EMA rule and trigger the trade.
- QUICK SCALP: Bullish Engulfing/Hammer at 15m support → Quick Scalp Buy. Mirror at resistance for Quick Scalp Sell.
- 9:20 ORB CAP (Nifty 50): The 9:20 candle is capped at 30 points. If 9:20 range > 30 pts (oversized opening), DO NOT take fresh entries unless price clears the 9:20 high (BUY) / low (SELL) with high volume.
- ROUND-NUMBER PRIORITY: Prioritise setups within 10 pts of a 50-point psychological level (24100, 24150, 24200…). Mention the round number in REASON when relevant.
- VIX must be Stable. Volume should be +10% above 5-period avg OR clearly high during S/R breakout.
- Trigger threshold: 60% score.`;
    const sniperPrompt = `MODE: SNIPER (active). You are the trading mind for a Nifty Options SNIPER (1–2 high-conviction trades/day). Apply STRICT Sniper constraints:
- Require 1m AND 5m EMA alignment in the same direction (no relaxation).
- Require Volume +20% above 5-period avg (no volume → WAIT).
- Require sustained 1m candles (3 consecutive in trend direction).
- Bank Nifty / heavyweight divergence blocks the trade (no override).
- Ignore relaxed S/R or candlestick "Quick Scalp" overrides — they are NOT enough alone.
- VIX must be Stable.
- Trigger threshold: 80% score.`;
    const prompt = `${tradingMode === "scalping" ? scalpingPrompt : sniperPrompt}

Common rules:
- Ghanshyam Sir's Foundation Bias: Yesterday's High (PDH), Low (PDL) and Close (PDC) are key levels. PDH break with volume = strong bullish bias. PDL break with volume = strong bearish bias. Price above PDC = mild bullish; below = mild bearish. Mention which side of yesterday's range price is on.
- Always reason from the LATEST Nifty spot LTP shown below — never reuse stale prices.
- 1:2 Risk-Reward: SL = previous 1m candle low (BUY) / high (SELL). Target = entry + 2 * (entry - SL).
- Strike freshness: always recompute ATM from latest spot.
- Manual override: if User Target/SL Points provided, use those exact point values.
- Hard guards always apply: Hard Kill-Switch, Overextended (>1.5%), No-Trade Range (<40 pts in 60m), European Open caution (12:30–13:30 IST size-down), 9:20 ORB cap (suppress fresh entries when 9:20 candle range > 30 pts unless price clears 9:20 H/L with volume), and prefer setups near 50-pt psychological levels.

Current Nifty spot is ${latest.ltp}; ATM strike is ${ruleContext.atmStrike ?? "unavailable"}. In STRIKE, write: "Buy Nifty ${ruleContext.atmStrike ?? "ATM"} CE" for BUY, "Buy Nifty ${ruleContext.atmStrike ?? "ATM"} PE" for SELL, or WAIT.

Respond exactly with:
ACTION: BUY/SELL/WAIT
STRIKE: Buy Nifty <ATM strike> CE/PE or WAIT
CONVICTION: HIGH/MEDIUM/LOW
REASON: start with "[${tradingMode.toUpperCase()} MODE]" then concise rule trigger including entry, SL, 1:2 target, and which mode fired (Trend / S/R Breakout / Quick Scalp for Scalping; EMA+Volume+Trend for Sniper).

Computed gates:\n${JSON.stringify({ tradingMode, buySniperReady, sellSniperReady, sniperConfirmationScore, minimumScoreToSwitchFromWait: minScore })}

Computed rule context:\n${JSON.stringify(ruleContext)}

Execution payload:\n${JSON.stringify({ tradingMode, executionIntent, tradingLotSize, niftyLotSize: NIFTY_LOT_SIZE, tradingQuantity, dailyPnl, dailyProfitTarget, maxDailyLoss, userTargetPoints, userSlPoints })}

Latest market data:\n${JSON.stringify(latest)}`;

    const result = await generateOpenAIText(settings.openai_api_key, prompt, 700);
    const text = result.text || "ACTION: WAIT, STRIKE: Current ATM, REASON: No analysis returned.";
    const signal = parseSignal(text.includes("REASON") ? text : `${text}\nREASON: ${ruleContext.guidance.join(" ")}`);
    const modeTag = `[${tradingMode.toUpperCase()} MODE]`;
    // High-conviction overrides: in Scalping mode, a sniperConfirmationScore >= 75 bypasses overextended/noTradeRange/fakeBreakout filters.
    // A score > 80 also overrides any divergence block.
    const scalpingHighConviction = tradingMode === "scalping" && sniperConfirmationScore >= 75;
    const divergenceOverride = sniperConfirmationScore > 80;
    const buyGateOk = buySniperReady || scalpingHighConviction;
    const sellGateOk = sellSniperReady || scalpingHighConviction;

    if (signal.action === "BUY" && (!buyGateOk || sniperConfirmationScore < minScore)) {
      signal.action = "WAIT";
      signal.strike = "WAIT";
      signal.reason = `${modeTag} WAITING — score ${sniperConfirmationScore}% (need ${minScore}%). Need bullish confirmation + stable VIX.`;
    }
    if (signal.action === "SELL" && (!sellGateOk || sniperConfirmationScore < minScore)) {
      signal.action = "WAIT";
      signal.strike = "WAIT";
      signal.reason = `${modeTag} WAITING — score ${sniperConfirmationScore}% (need ${minScore}%). Need bearish confirmation + stable VIX.`;
    }
    // Force-promote WAIT → BUY/SELL when score clears threshold and a directional gate is ready (vixSizeCut/riskSizeDown only affect quantity, not the signal).
    if (signal.action === "WAIT" && sniperConfirmationScore >= minScore) {
      if (buyGateOk && !sellGateOk) {
        signal.action = "BUY";
        signal.reason = `${modeTag} AUTO-BUY @ score ${sniperConfirmationScore}% — gates ready (force-promoted from WAIT).`;
      } else if (sellGateOk && !buyGateOk) {
        signal.action = "SELL";
        signal.reason = `${modeTag} AUTO-SELL @ score ${sniperConfirmationScore}% — gates ready (force-promoted from WAIT).`;
      }
    }
    if (signal.action !== "WAIT" && !signal.reason?.includes(modeTag)) signal.reason = `${modeTag} ${signal.reason ?? ""}`.trim();
    if (signal.action === "BUY" && ruleContext.atmStrike) signal.strike = `Buy Nifty ${ruleContext.atmStrike} CE`;
    if (signal.action === "SELL" && ruleContext.atmStrike) signal.strike = `Buy Nifty ${ruleContext.atmStrike} PE`;
    const conviction = text.match(/CONVICTION\s*:\s*(HIGH|MEDIUM|LOW)/i)?.[1]?.toUpperCase() ?? (ruleContext.rules.divergence ? "LOW" : "MEDIUM");
    const effectiveLotSize = ruleContext.rules.vixSizeCut ? Math.max(1, Math.floor((tradingLotSize ?? 1) / 2)) : tradingLotSize;
    const effectiveTradingQuantity = effectiveLotSize ? effectiveLotSize * NIFTY_LOT_SIZE : tradingQuantity;
    const divergenceWarningOnly = (tradingMode === "scalping" && sniperConfirmationScore > 60) || divergenceOverride;
    const divergenceBlocks = ruleContext.rules.divergence && !divergenceWarningOnly;
    // Relax filters when in scalping mode with high conviction (>=75): bypass overextended / noTradeRange / fakeBreakout.
    const overextendedBlocks = ruleContext.rules.overextended && !scalpingHighConviction;
    const noTradeRangeBlocks = ruleContext.rules.noTradeRange && !scalpingHighConviction;
    const fakeBreakoutBlocks = ruleContext.rules.fakeBreakout && !scalpingHighConviction;
    const highProbability = signal.action !== "WAIT" && sniperConfirmationScore >= minScore && !fakeBreakoutBlocks && !overextendedBlocks && !noTradeRangeBlocks && !divergenceBlocks;

    const { data, error } = await auth.adminClient.from("ai_trade_signals").insert({
      user_id: auth.user.id,
      market_data_id: latest.id,
      action: signal.action,
      strike: signal.strike,
      reason: signal.reason,
      raw_response: JSON.stringify({ text, model: result.modelName, tradingMode, conviction, highProbability, ruleContext, executionIntent, tradingLotSize, niftyLotSize: NIFTY_LOT_SIZE, tradingQuantity, effectiveLotSize, effectiveTradingQuantity, riskSizeDown: ruleContext.rules.vixSizeCut, userTargetPoints, userSlPoints }),
    }).select("*").single();
    if (error) throw error;

    return json({ success: true, signal: { ...data, tradingMode, conviction, highProbability, scalpingHighConviction, divergenceOverride, sniperConfirmationScore, minScore, ruleContext, raw_text: text, tradingLotSize, effectiveLotSize, tradingQuantity, effectiveTradingQuantity, riskSizeDown: ruleContext.rules.vixSizeCut, userTargetPoints, userSlPoints } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "AI analysis failed" }, 500);
  }
});
