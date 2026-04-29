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

function buildRuleContext(latest: any, history: any[]) {
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
  const vixRising = num(indiaVix?.ltp) !== null && num(prevVix?.ltp) !== null ? Number(indiaVix.ltp) > Number(prevVix.ltp) : false;
  const sixtyMinuteRows = history.filter((row) => Date.now() - new Date(row.created_at).getTime() <= 60 * 60 * 1000);
  const rangeValues = sixtyMinuteRows.flatMap((row) => [num(row.high_price), num(row.low_price), num(row.ltp)]).filter((value): value is number => value !== null);
  const noTradeRange = rangeValues.length > 2 && Math.max(...rangeValues) - Math.min(...rangeValues) < 40;
  const bankMove = pctMove(num(latest?.raw_payload?.context?.bankNifty?.ltp), num(latest?.raw_payload?.context?.bankNifty?.open));
  const niftyMove = pctMove(ltp, open);
  const heavyMoves = (latest?.raw_payload?.context?.heavyweights ?? []).map((quote: any) => pctMove(num(quote?.ltp), num(quote?.open))).filter((value: number | null): value is number => value !== null);
  const divergence = niftyMove !== null && ((bankMove !== null && Math.sign(bankMove) !== Math.sign(niftyMove)) || heavyMoves.filter((move) => Math.sign(move) !== Math.sign(niftyMove)).length >= 2);
  const pcr = num(latest?.raw_payload?.optionChain?.pcr);

  return {
    rules: { volumeValid, avg5Volume, fakeBreakout, vixRising, europeanOpenCaution, overextended, noTradeRange, divergence, pcr, pcrState: pcr === null ? "Unavailable" : pcr > 1.3 ? "Overbought" : pcr < 0.7 ? "Oversold" : "Neutral" },
    guidance: [
      fakeBreakout ? "POTENTIAL TRAP: breakout/breakdown happened without the required +20% volume filter." : volumeValid === true ? `Volume +20% filter confirmed from ${latest?.raw_payload?.volumeSource ?? "Upstox live feed"}.` : volume !== null ? "Volume received from Upstox but awaiting enough history for +20% comparison; treat as neutral, not failed." : "Volume unavailable/insufficient from Upstox; treat as neutral, not failed.",
      vixRising ? "India VIX rising: reduce position size alert." : "India VIX not rising or unavailable.",
      europeanOpenCaution ? "European Market Open time-block: extra caution active." : "Normal time block.",
      overextended ? "Overextended Zone: Nifty moved >1.5% without pullback; stop new entries." : "Mean-reversion guard clear.",
      noTradeRange ? "No-Trade Zone: 60-minute range is under 40 points." : "Range filter clear or awaiting more history.",
      divergence ? "Divergence Guard: Nifty disagrees with Bank Nifty/top heavyweights; Low Conviction." : "Divergence guard clear or awaiting context.",
      pcr === null ? "PCR temporarily unavailable from option-chain payload; do not downgrade conviction only for missing PCR." : `PCR ${pcr}: ${pcr > 1.3 ? "Overbought" : pcr < 0.7 ? "Oversold" : "Neutral"}.`,
    ],
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const tradingQuantity = Number.isInteger(body?.tradingQuantity) && body.tradingQuantity > 0 ? body.tradingQuantity : null;
    const executionIntent = body?.executionIntent === true;
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

    const prompt = `You are the institutional-risk trading mind for a Nifty Options Scalper. Apply these hard rules before any signal:
- Fake breakout/breakdown with low volume = POTENTIAL TRAP and usually WAIT.
- Valid signal requires current volume at least 20% above the 5-period average when Upstox provides volume; if volume/PCR is temporarily unavailable, treat it as neutral instead of an automatic failure.
- If India VIX is rising, reduce position size in the reason.
- 12:30 PM to 1:30 PM IST is a cautious European Market Open block.
- If Nifty has moved more than 1.5% without pullback, mark Overextended Zone and stop new entries.
- PCR > 1.3 is Overbought; PCR < 0.7 is Oversold. If PCR is unavailable, state unavailable.
- No-Trade Zone if the last 60 minutes remain inside a 40-point range.
- Entry must wait for minor retracement: dip for CALL, bounce for PUT.
- Risk reward must be strict 1:2.
- TSL: at 50% target, move SL to entry; every 10 points additional gain trails SL by 5 points.
- Divergence Guard: if Nifty disagrees with Bank Nifty or top heavyweights, label Low Conviction.

Respond exactly with:
ACTION: BUY/SELL/WAIT
STRIKE: Current ATM or WAIT
CONVICTION: HIGH/MEDIUM/LOW
REASON: concise rule-trigger explanation including entry, RR, and TSL logic.

Computed rule context:\n${JSON.stringify(ruleContext)}

Execution payload:\n${JSON.stringify({ executionIntent, tradingQuantity })}

Latest market data:\n${JSON.stringify(latest)}`;

    const result = await generateOpenAIText(settings.openai_api_key, prompt, 700);
    const text = result.text || "ACTION: WAIT, STRIKE: Current ATM, REASON: No analysis returned.";
    const signal = parseSignal(text.includes("REASON") ? text : `${text}\nREASON: ${ruleContext.guidance.join(" ")}`);
    const conviction = text.match(/CONVICTION\s*:\s*(HIGH|MEDIUM|LOW)/i)?.[1]?.toUpperCase() ?? (ruleContext.rules.divergence ? "LOW" : "MEDIUM");
    const highProbability = conviction === "HIGH" && signal.action !== "WAIT" && ruleContext.rules.volumeValid !== false && !ruleContext.rules.fakeBreakout && !ruleContext.rules.overextended && !ruleContext.rules.noTradeRange && !ruleContext.rules.divergence;

    const { data, error } = await auth.adminClient.from("ai_trade_signals").insert({
      user_id: auth.user.id,
      market_data_id: latest.id,
      action: signal.action,
      strike: signal.strike,
      reason: signal.reason,
      raw_response: JSON.stringify({ text, model: result.modelName, conviction, highProbability, ruleContext, executionIntent, tradingQuantity }),
    }).select("*").single();
    if (error) throw error;

    return json({ success: true, signal: { ...data, conviction, highProbability, ruleContext, raw_text: text } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "AI analysis failed" }, 500);
  }
});
