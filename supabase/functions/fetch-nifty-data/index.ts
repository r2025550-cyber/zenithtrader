import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, getAuthenticatedClients, getSettings, json } from "../_shared/trading.ts";

const INSTRUMENT_KEY = "NSE_INDEX|Nifty 50";
const NIFTY_LOT_SIZE = 65;
const RATE_LIMIT_RETRY_MS = 5_000;
const CONTEXT_INSTRUMENTS = {
  bankNifty: "NSE_INDEX|Nifty Bank",
  indiaVix: "NSE_INDEX|India VIX",
  heavyweights: ["NSE_EQ|INE040A01034", "NSE_EQ|INE002A01018", "NSE_EQ|INE090A01021"],
};

function numberFrom(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function firstNode(payload: Record<string, unknown>) {
  return Object.values(payload?.data ?? {})[0] as any;
}

function upstoxErrorMessage(prefix: string, status: number, payload: any) {
  const reason = payload?.errors?.[0]?.message ?? payload?.errors?.[0]?.errorCode ?? payload?.message ?? payload?.error ?? payload?.status ?? JSON.stringify(payload);
  return `${prefix} HTTP ${status}: ${reason}`;
}

function isUpstoxRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("UDAPI10005") || message.includes("HTTP 429") || message.toLowerCase().includes("too many request");
}

async function latestCachedMarketData(adminClient: any, userId: string, details: string) {
  const { data } = await adminClient
    .from("nifty_market_data")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return json({
    success: true,
    fallback: true,
    rateLimited: true,
    retryAfterMs: RATE_LIMIT_RETRY_MS,
    error: "Upstox rate limit hit (UDAPI10005)",
    details,
    data: data ?? null,
  });
}

function quoteFrom(node: any) {
  const ohlc = node?.ohlc ?? node ?? {};
  const depth = node?.depth ?? {};
  return {
    ltp: numberFrom(node?.last_price, node?.ltp, node?.lastPrice),
    open: numberFrom(ohlc.open, ohlc.o),
    high: numberFrom(ohlc.high, ohlc.h),
    low: numberFrom(ohlc.low, ohlc.l),
    close: numberFrom(ohlc.close, ohlc.c, node?.close_price),
    volume: numberFrom(node?.volume, node?.volume_traded, node?.totalTradedVolume, node?.total_traded_volume, node?.volumeTradedToday, node?.volume_traded_today, node?.ttv, ohlc.volume, ohlc.vol, depth?.total_buy_quantity, depth?.total_sell_quantity),
  };
}

function nextThursdayIso(date = new Date()) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const daysUntilThursday = (4 - utc.getUTCDay() + 7) % 7;
  utc.setUTCDate(utc.getUTCDate() + daysUntilThursday);
  return utc.toISOString().slice(0, 10);
}

async function getOptionChainPcr(headers: HeadersInit) {
  const encoded = encodeURIComponent(INSTRUMENT_KEY);
  const contractResponse = await fetch(`https://api.upstox.com/v2/option/contract?instrument_key=${encoded}`, { headers });
  const contractPayload = await contractResponse.json().catch(() => ({}));
  const expiries = (Array.isArray(contractPayload?.data) ? contractPayload.data : [])
    .map((row: any) => String(row?.expiry ?? row?.expiry_date ?? ""))
    .filter(Boolean)
    .sort();
  const expiry = expiries.find((value: string) => value >= new Date().toISOString().slice(0, 10)) ?? expiries[0] ?? nextThursdayIso();
  const response = await fetch(`https://api.upstox.com/v2/option/chain?instrument_key=${encoded}&expiry_date=${expiry}`, { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return { pcr: null, raw: payload, error: `Option chain HTTP ${response.status}`, expiry };
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const totals = rows.reduce((sum: { callOi: number; putOi: number; callVolume: number; putVolume: number }, row: any) => {
    sum.callOi += numberFrom(row?.call_options?.market_data?.oi, row?.call_options?.market_data?.open_interest, row?.ce_oi) ?? 0;
    sum.putOi += numberFrom(row?.put_options?.market_data?.oi, row?.put_options?.market_data?.open_interest, row?.pe_oi) ?? 0;
    sum.callVolume += numberFrom(row?.call_options?.market_data?.volume, row?.call_options?.market_data?.volume_traded, row?.call_options?.market_data?.totalTradedVolume, row?.ce_volume) ?? 0;
    sum.putVolume += numberFrom(row?.put_options?.market_data?.volume, row?.put_options?.market_data?.volume_traded, row?.put_options?.market_data?.totalTradedVolume, row?.pe_volume) ?? 0;
    return sum;
  }, { callOi: 0, putOi: 0, callVolume: 0, putVolume: 0 });
  return { pcr: totals.callOi > 0 ? Number((totals.putOi / totals.callOi).toFixed(3)) : null, totalVolume: totals.callVolume + totals.putVolume || null, raw: payload, error: null, expiry };
}

function isInvalidUpstoxToken(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("UDAPI100050") || message.toLowerCase().includes("invalid token");
}

async function getQuotes(instrumentKeys: string[], headers: HeadersInit) {
  const encoded = encodeURIComponent(instrumentKeys.join(","));
  const quoteResponse = await fetch(`https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encoded}`, { headers });
  const quotePayload = await quoteResponse.json().catch(() => ({}));
  if (!quoteResponse.ok) throw new Error(upstoxErrorMessage("Upstox quote request failed", quoteResponse.status, quotePayload));
  const nodes = Object.values((quotePayload?.data as Record<string, unknown> | undefined) ?? {}) as any[];
  const quoteFor = (instrumentKey: string) => quoteFrom(nodes.find((node) => node?.instrument_token === instrumentKey) ?? firstNode(quotePayload));
  return { quoteFor, raw: { quote: quotePayload } };
}

async function getFundsAndMargin(headers: HeadersInit) {
  const response = await fetch("https://api.upstox.com/v2/user/get-funds-and-margin?segment=SEC", { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return { availableCash: null, usedMargin: null, raw: payload, error: `Funds HTTP ${response.status}` };
  const equity = payload?.data?.equity ?? payload?.data?.SEC ?? payload?.data ?? {};
  const availableCash = numberFrom(equity?.available_margin, equity?.availableMargin, equity?.cash, equity?.available_cash, equity?.net);
  const usedMargin = numberFrom(equity?.used_margin, equity?.usedMargin, equity?.utilised_margin, equity?.utilized_margin);
  const todayPnl = numberFrom(equity?.realized_profit_and_loss, equity?.realised_profit_and_loss, equity?.realized_pnl, equity?.realised_pnl, equity?.pnl, equity?.mtm);
  return { availableCash, usedMargin, todayPnl, raw: payload, error: null };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const tradingLotSize = Number.isInteger(body?.tradingLotSize) && body.tradingLotSize > 0 ? body.tradingLotSize : null;
    const tradingQuantity = tradingLotSize ? tradingLotSize * NIFTY_LOT_SIZE : Number.isInteger(body?.tradingQuantity) && body.tradingQuantity > 0 ? body.tradingQuantity : null;
    const executionIntent = body?.executionIntent === true;
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const settings = await getSettings(auth.adminClient, auth.user.id);
    if (!settings.upstox_access_token) return json({ error: "Connect Upstox OAuth before fetching market data." }, 400);

    const headers = { Authorization: `Bearer ${settings.upstox_access_token}`, Accept: "application/json" };
    const nifty = await getQuote(INSTRUMENT_KEY, headers).catch((error) => ({ error }));
    if ("error" in nifty) {
      if (isInvalidUpstoxToken(nifty.error)) {
        await auth.adminClient.from("trading_api_settings").update({ upstox_access_token: null, upstox_refresh_token: null, token_expires_at: null }).eq("user_id", auth.user.id);
        return json({ error: "Upstox OAuth reconnect required", details: "The saved Upstox access token is invalid or expired. Open API Settings, tap Get Code, complete login, then paste a fresh code and Connect." }, 401);
      }
      return json({ error: "Upstox Nifty request failed", details: String(nifty.error?.message ?? nifty.error) }, 502);
    }

    const [bankNifty, indiaVix, optionChain, margin, ...heavyweights] = await Promise.allSettled([
      getQuote(CONTEXT_INSTRUMENTS.bankNifty, headers),
      getQuote(CONTEXT_INSTRUMENTS.indiaVix, headers),
      getOptionChainPcr(headers),
      getFundsAndMargin(headers),
      ...CONTEXT_INSTRUMENTS.heavyweights.map((key) => getQuote(key, headers)),
    ]);

    const contextQuote = (result: PromiseSettledResult<{ quote: Record<string, unknown>; raw: unknown }>) => result.status === "fulfilled" ? result.value.quote : null;
    const ltp = nifty.quote.ltp;

    const row = {
      user_id: auth.user.id,
      symbol: INSTRUMENT_KEY,
      ltp,
      open_price: nifty.quote.open,
      high_price: nifty.quote.high,
      low_price: nifty.quote.low,
      close_price: nifty.quote.close,
      raw_payload: {
        ...nifty.raw,
        volume: nifty.quote.volume ?? (optionChain.status === "fulfilled" ? optionChain.value.totalVolume : null),
        volumeSource: nifty.quote.volume !== null ? "upstox_quote" : optionChain.status === "fulfilled" && optionChain.value.totalVolume !== null ? "upstox_option_chain" : null,
        volumeStatus: nifty.quote.volume !== null || (optionChain.status === "fulfilled" && optionChain.value.totalVolume !== null) ? "available" : "unavailable",
        optionChain: optionChain.status === "fulfilled" ? { pcr: optionChain.value.pcr, totalVolume: optionChain.value.totalVolume, expiry: optionChain.value.expiry, error: optionChain.value.error } : { pcr: null, totalVolume: null, error: String(optionChain.reason?.message ?? optionChain.reason) },
        account: {
          margin: margin.status === "fulfilled" ? { availableCash: margin.value.availableCash, usedMargin: margin.value.usedMargin, error: margin.value.error } : { availableCash: null, usedMargin: null, error: String(margin.reason?.message ?? margin.reason) },
          todayPnl: margin.status === "fulfilled" ? margin.value.todayPnl : null,
        },
        context: {
          bankNifty: contextQuote(bankNifty),
          indiaVix: contextQuote(indiaVix),
          heavyweights: heavyweights.map(contextQuote).filter(Boolean),
        },
        execution: { intent: executionIntent, tradingLotSize, niftyLotSize: NIFTY_LOT_SIZE, tradingQuantity },
      },
      source_timestamp: new Date().toISOString(),
    };

    const { data, error } = await auth.adminClient.from("nifty_market_data").insert(row).select("*").single();
    if (error) throw error;
    return json({ success: true, data });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Market data fetch failed" }, 500);
  }
});
