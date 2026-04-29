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

const NIFTY_LOT_SIZE = 65;

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
  const volumeAvailable = volume !== null && avg5Volume !== null && volumes.length >= 2;
  const volumeValid = volumeAvailable ? volume >= avg5Volume * 1.2 : null;
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
  const divergence = niftyMove !== null && ((bankMove !== null && Math.sign(bankMove) !== Math.sign(niftyMove)) || heavyMoves.filter((move) => Math.sign(move) !== Math.sign(niftyMove)).length >= 2);
  const pcr = num(latest?.raw_payload?.optionChain?.pcr);
  const effectiveVolume = volume ?? num(latest?.raw_payload?.optionChain?.totalVolume);
  const volumeSource = volume !== null ? latest?.raw_payload?.volumeSource ?? "upstox_quote" : effectiveVolume !== null ? "upstox_option_chain" : null;
  const chronological = [...history].reverse();
  const prices = chronological.map((row) => num(row?.ltp)).filter((value): value is number => value !== null);
  const ema9 = ema(prices, 9);
  const ema21 = ema(prices, 21);
  const emaTrend = ema9 !== null && ema21 !== null ? (ema9 > ema21 ? "bullish" : ema9 < ema21 ? "bearish" : "flat") : "pending";
  const priceAction = ltp !== null && open !== null ? (ltp > open ? "bullish" : ltp < open ? "bearish" : "flat") : "pending";
  const emaAligned = emaTrend !== "pending" && priceAction !== "pending" && emaTrend === priceAction;
  const fifteenMinuteRows = history.filter((row) => Date.now() - new Date(row.created_at).getTime() <= 15 * 60 * 1000);
  const oldest15 = fifteenMinuteRows[fifteenMinuteRows.length - 1];
  const trend15MovePct = pctMove(ltp, num(oldest15?.ltp));
  const trend15 = trend15MovePct === null ? "pending" : trend15MovePct > 0.08 ? "bullish" : trend15MovePct < -0.08 ? "bearish" : "flat";
  const oneMinuteMovePct = pctMove(ltp, num(previous?.ltp));
  const entry1m = oneMinuteMovePct === null ? "pending" : oneMinuteMovePct > 0 ? "bullish" : oneMinuteMovePct < 0 ? "bearish" : "flat";
  const multiTimeframeAligned = trend15 !== "pending" && entry1m !== "pending" && trend15 !== "flat" && trend15 === entry1m;

  return {
    rules: { volumeValid, volume: effectiveVolume, volumeSource, avg5Volume, fakeBreakout, vixRising, vixMovePct, vixSizeCut, europeanOpenCaution, overextended, noTradeRange, divergence, pcr, pcrState: pcr === null ? "Unavailable" : pcr > 1.3 ? "Overbought" : pcr < 0.7 ? "Oversold" : "Neutral", ema9, ema21, emaTrend, emaAligned, trend15, trend15MovePct, entry1m, multiTimeframeAligned },
    guidance: [
      fakeBreakout ? "POTENTIAL TRAP: breakout/breakdown happened without the required +20% volume filter." : volumeValid === true ? `Volume +20% filter confirmed from ${volumeSource ?? "Upstox live feed"}.` : effectiveVolume !== null ? `Volume received from ${volumeSource ?? "Upstox"} but awaiting enough history for +20% comparison; treat as neutral, not failed.` : "Volume unavailable/insufficient from Upstox; treat as neutral, not failed.",
      vixSizeCut ? `India VIX rising ${vixMovePct?.toFixed(2)}%: reduce position size by 50%.` : vixRising ? "India VIX rising but below 5% size-cut threshold." : "India VIX not rising or unavailable.",
      europeanOpenCaution ? "European Market Open time-block: extra caution active." : "Normal time block.",
      overextended ? "Overextended Zone: Nifty moved >1.5% without pullback; stop new entries." : "Mean-reversion guard clear.",
      noTradeRange ? "No-Trade Zone: 60-minute range is under 40 points." : "Range filter clear or awaiting more history.",
      divergence ? "Divergence Guard: Nifty disagrees with Bank Nifty/top heavyweights; Low Conviction." : "Divergence guard clear or awaiting context.",
      pcr === null ? "PCR temporarily unavailable from option-chain payload; do not downgrade conviction only for missing PCR." : `PCR ${pcr}: ${pcr > 1.3 ? "Overbought" : pcr < 0.7 ? "Oversold" : "Neutral"}.`,
      emaAligned ? `9/21 EMA crossover aligns ${emaTrend} with price action.` : `9/21 EMA alignment pending/failed: EMA=${emaTrend}, price=${priceAction}.`,
      multiTimeframeAligned ? `15-minute ${trend15} trend confirms 1-minute ${entry1m} entry.` : `15-minute trend does not confirm 1-minute entry: 15m=${trend15}, 1m=${entry1m}.`,
    ],
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
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

    const prompt = `You are the institutional-risk trading mind for a Nifty Options Scalper. Apply these hard rules before any signal:
- Fake breakout/breakdown with low volume = POTENTIAL TRAP and usually WAIT.
- Valid signal requires current volume at least 20% above the 5-period average when Upstox provides volume; if volume/PCR is temporarily unavailable, treat it as neutral instead of an automatic failure.
- Analyze PCR and India VIX together: PCR extremes plus rising VIX lower conviction; if India VIX rises more than 5%, automatically reduce position size by 50% in the reason.
- 12:30 PM to 1:30 PM IST is a cautious European Market Open block.
- If Nifty has moved more than 1.5% without pullback, mark Overextended Zone and stop new entries.
- PCR > 1.3 is Overbought; PCR < 0.7 is Oversold. If PCR is unavailable, state unavailable.
- No-Trade Zone if the last 60 minutes remain inside a 40-point range.
- Multi-timeframe rule: 15-minute trend must confirm the 1-minute entry direction before BUY/SELL; otherwise WAIT or LOW conviction.
- Smart indicator rule: 9 EMA / 21 EMA crossover must align with price action for HIGH Conviction; if not aligned, cap conviction below HIGH.
- Entry must wait for minor retracement: dip for CALL, bounce for PUT.
- Risk reward must be strict 1:2.
- Manual override: if User Target Points or User SL Points are provided, use those exact point values instead of AI-generated target/SL.
- Trailing Stop Loss: at 1:1 RR lock profits by moving SL to entry, then every 10 points additional gain trails SL by 5 points.
- Divergence Guard: if Nifty disagrees with Bank Nifty or top heavyweights, label Low Conviction.

Respond exactly with:
ACTION: BUY/SELL/WAIT
STRIKE: Current ATM or WAIT
CONVICTION: HIGH/MEDIUM/LOW
REASON: concise rule-trigger explanation including entry, RR, and TSL logic.

Computed rule context:\n${JSON.stringify(ruleContext)}

Execution payload:\n${JSON.stringify({ executionIntent, tradingLotSize, niftyLotSize: NIFTY_LOT_SIZE, tradingQuantity, dailyPnl, dailyProfitTarget, maxDailyLoss, userTargetPoints, userSlPoints })}

Latest market data:\n${JSON.stringify(latest)}`;

    const result = await generateOpenAIText(settings.openai_api_key, prompt, 700);
    const text = result.text || "ACTION: WAIT, STRIKE: Current ATM, REASON: No analysis returned.";
    const signal = parseSignal(text.includes("REASON") ? text : `${text}\nREASON: ${ruleContext.guidance.join(" ")}`);
    const conviction = text.match(/CONVICTION\s*:\s*(HIGH|MEDIUM|LOW)/i)?.[1]?.toUpperCase() ?? (ruleContext.rules.divergence ? "LOW" : "MEDIUM");
    const effectiveLotSize = ruleContext.rules.vixSizeCut ? Math.max(1, Math.floor((tradingLotSize ?? 1) / 2)) : tradingLotSize;
    const effectiveTradingQuantity = effectiveLotSize ? effectiveLotSize * NIFTY_LOT_SIZE : tradingQuantity;
    const highProbability = conviction === "HIGH" && signal.action !== "WAIT" && ruleContext.rules.volumeValid !== false && ruleContext.rules.emaAligned === true && ruleContext.rules.multiTimeframeAligned === true && !ruleContext.rules.fakeBreakout && !ruleContext.rules.overextended && !ruleContext.rules.noTradeRange && !ruleContext.rules.divergence;

    const { data, error } = await auth.adminClient.from("ai_trade_signals").insert({
      user_id: auth.user.id,
      market_data_id: latest.id,
      action: signal.action,
      strike: signal.strike,
      reason: signal.reason,
      raw_response: JSON.stringify({ text, model: result.modelName, conviction, highProbability, ruleContext, executionIntent, tradingLotSize, niftyLotSize: NIFTY_LOT_SIZE, tradingQuantity, effectiveLotSize, effectiveTradingQuantity, riskSizeDown: ruleContext.rules.vixSizeCut, userTargetPoints, userSlPoints }),
    }).select("*").single();
    if (error) throw error;

    return json({ success: true, signal: { ...data, conviction, highProbability, ruleContext, raw_text: text, tradingLotSize, effectiveLotSize, tradingQuantity, effectiveTradingQuantity, riskSizeDown: ruleContext.rules.vixSizeCut, userTargetPoints, userSlPoints } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "AI analysis failed" }, 500);
  }
});
