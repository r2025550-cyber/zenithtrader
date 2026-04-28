import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, getAuthenticatedClients, getSettings, json } from "../_shared/trading.ts";

const INSTRUMENT_KEY = "NSE_INDEX|Nifty 50";

function numberFrom(...values: unknown[]) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const settings = await getSettings(auth.adminClient, auth.user.id);
    if (!settings.upstox_access_token) return json({ error: "Connect Upstox OAuth before fetching market data." }, 400);

    const headers = { Authorization: `Bearer ${settings.upstox_access_token}`, Accept: "application/json" };
    const encoded = encodeURIComponent(INSTRUMENT_KEY);
    const [ltpResponse, ohlcResponse] = await Promise.all([
      fetch(`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encoded}`, { headers }),
      fetch(`https://api.upstox.com/v2/market-quote/ohlc?instrument_key=${encoded}&interval=1d`, { headers }),
    ]);

    const ltpPayload = await ltpResponse.json().catch(() => ({}));
    const ohlcPayload = await ohlcResponse.json().catch(() => ({}));
    if (!ltpResponse.ok) return json({ error: "Upstox LTP request failed", details: ltpPayload }, ltpResponse.status);
    if (!ohlcResponse.ok) return json({ error: "Upstox OHLC request failed", details: ohlcPayload }, ohlcResponse.status);

    const ltpNode = Object.values(ltpPayload?.data ?? {})[0] as any;
    const ohlcNode = Object.values(ohlcPayload?.data ?? {})[0] as any;
    const ohlc = ohlcNode?.ohlc ?? ohlcNode ?? {};
    const ltp = numberFrom(ltpNode?.last_price, ltpNode?.ltp, ohlcNode?.last_price);

    const row = {
      user_id: auth.user.id,
      symbol: INSTRUMENT_KEY,
      ltp,
      open_price: numberFrom(ohlc.open, ohlc.o),
      high_price: numberFrom(ohlc.high, ohlc.h),
      low_price: numberFrom(ohlc.low, ohlc.l),
      close_price: numberFrom(ohlc.close, ohlc.c),
      raw_payload: { ltp: ltpPayload, ohlc: ohlcPayload },
      source_timestamp: new Date().toISOString(),
    };

    const { data, error } = await auth.adminClient.from("nifty_market_data").insert(row).select("*").single();
    if (error) throw error;
    return json({ success: true, data });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Market data fetch failed" }, 500);
  }
});
