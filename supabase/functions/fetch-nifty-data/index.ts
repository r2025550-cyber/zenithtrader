import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, getAuthenticatedClients, getSettings, json } from "../_shared/trading.ts";

const INSTRUMENT_KEY = "NSE_INDEX|Nifty 50";
const CONTEXT_INSTRUMENTS = {
  bankNifty: "NSE_INDEX|Nifty Bank",
  indiaVix: "NSE_INDEX|India VIX",
  heavyweights: ["NSE_EQ|INE040A01034", "NSE_EQ|INE002A01018", "NSE_EQ|INE090A01021"],
};

function numberFrom(...values: unknown[]) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function firstNode(payload: Record<string, unknown>) {
  return Object.values(payload?.data ?? {})[0] as any;
}

function quoteFrom(node: any) {
  const ohlc = node?.ohlc ?? node ?? {};
  return {
    ltp: numberFrom(node?.last_price, node?.ltp, node?.lastPrice),
    open: numberFrom(ohlc.open, ohlc.o),
    high: numberFrom(ohlc.high, ohlc.h),
    low: numberFrom(ohlc.low, ohlc.l),
    close: numberFrom(ohlc.close, ohlc.c, node?.close_price),
    volume: numberFrom(node?.volume, node?.volume_traded, node?.totalTradedVolume, ohlc.volume),
  };
}

async function getQuote(instrumentKey: string, headers: HeadersInit) {
  const encoded = encodeURIComponent(instrumentKey);
  const [ltpResponse, ohlcResponse] = await Promise.all([
    fetch(`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encoded}`, { headers }),
    fetch(`https://api.upstox.com/v2/market-quote/ohlc?instrument_key=${encoded}&interval=1d`, { headers }),
  ]);
  const ltpPayload = await ltpResponse.json().catch(() => ({}));
  const ohlcPayload = await ohlcResponse.json().catch(() => ({}));
  if (!ltpResponse.ok) throw new Error(JSON.stringify({ error: "Upstox LTP request failed", status: ltpResponse.status, payload: ltpPayload }));
  if (!ohlcResponse.ok) throw new Error(JSON.stringify({ error: "Upstox OHLC request failed", status: ohlcResponse.status, payload: ohlcPayload }));
  return { quote: { ...quoteFrom(firstNode(ohlcPayload)), ...quoteFrom(firstNode(ltpPayload)) }, raw: { ltp: ltpPayload, ohlc: ohlcPayload } };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const settings = await getSettings(auth.adminClient, auth.user.id);
    if (!settings.upstox_access_token) return json({ error: "Connect Upstox OAuth before fetching market data." }, 400);

    const headers = { Authorization: `Bearer ${settings.upstox_access_token}`, Accept: "application/json" };
    const nifty = await getQuote(INSTRUMENT_KEY, headers).catch((error) => ({ error }));
    if ("error" in nifty) return json({ error: "Upstox Nifty request failed", details: String(nifty.error?.message ?? nifty.error) }, 502);

    const [bankNifty, indiaVix, ...heavyweights] = await Promise.allSettled([
      getQuote(CONTEXT_INSTRUMENTS.bankNifty, headers),
      getQuote(CONTEXT_INSTRUMENTS.indiaVix, headers),
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
        volume: nifty.quote.volume,
        context: {
          bankNifty: contextQuote(bankNifty),
          indiaVix: contextQuote(indiaVix),
          heavyweights: heavyweights.map(contextQuote).filter(Boolean),
        },
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
