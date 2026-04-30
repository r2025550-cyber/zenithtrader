import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { corsHeaders, getAuthenticatedClients, getSettings, json } from "../_shared/trading.ts";

const INSTRUMENT_KEY = "NSE_INDEX|Nifty 50";

const BodySchema = z.object({
  instrumentToken: z.string().min(1).optional(),
  strike: z.number().positive().optional(),
  action: z.enum(["BUY", "SELL"]).optional(),
});

function numberFrom(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function upstoxErrorMessage(prefix: string, status: number, payload: any) {
  const reason = payload?.errors?.[0]?.message ?? payload?.errors?.[0]?.errorCode ?? payload?.message ?? payload?.error ?? payload?.status ?? JSON.stringify(payload);
  return `${prefix} HTTP ${status}: ${reason}`;
}

async function resolveOptionToken(headers: HeadersInit, strike: number, action: "BUY" | "SELL") {
  const optionType = action === "BUY" ? "CE" : "PE";
  const response = await fetch(`https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(INSTRUMENT_KEY)}`, { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(upstoxErrorMessage("Option contract", response.status, payload));

  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const today = new Date().toISOString().slice(0, 10);
  const expiries = rows.map((row: any) => String(row?.expiry ?? row?.expiry_date ?? "")).filter(Boolean).sort();
  const expiry = expiries.find((value: string) => value >= today) ?? expiries[0];
  const selected = rows.find((row: any) => {
    const rowExpiry = String(row?.expiry ?? row?.expiry_date ?? "");
    const rowType = String(row?.instrument_type ?? row?.option_type ?? row?.optionType ?? "").toUpperCase();
    const rowStrike = numberFrom(row?.strike_price, row?.strikePrice, row?.strike);
    return rowExpiry === expiry && rowType.includes(optionType) && rowStrike === strike;
  });
  if (!selected) throw new Error(`Invalid Symbol: Nifty ${strike} ${optionType} contract not found for nearest expiry.`);
  const instrumentToken = selected?.instrument_key ?? selected?.instrumentKey ?? selected?.instrument_token ?? selected?.instrumentToken;
  if (!instrumentToken) throw new Error(`Invalid Symbol: Nifty ${strike} ${optionType} is missing instrument_key from Upstox.`);
  return { instrumentToken: String(instrumentToken), tradingSymbol: `Nifty ${strike} ${optionType}`, strike, optionType };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.flatten().fieldErrors }, 400);
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const settings = await getSettings(auth.adminClient, auth.user.id);
    if (!settings.upstox_access_token) return json({ error: "Connect Upstox OAuth before fetching option premium." }, 400);

    const headers = { Authorization: `Bearer ${settings.upstox_access_token}`, Accept: "application/json" };
    const instrument = parsed.data.instrumentToken
      ? { instrumentToken: parsed.data.instrumentToken }
      : parsed.data.strike && parsed.data.action
        ? await resolveOptionToken(headers, parsed.data.strike, parsed.data.action)
        : null;
    if (!instrument?.instrumentToken) return json({ error: "Provide instrumentToken or strike + action before fetching option premium." }, 400);

    const encoded = encodeURIComponent(instrument.instrumentToken);
    const response = await fetch(`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encoded}`, { headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(upstoxErrorMessage("Option LTP", response.status, payload));
    const node = Object.values((payload?.data as Record<string, unknown> | undefined) ?? {})[0] as Record<string, unknown> | undefined;
    const premium = numberFrom(node?.last_price, node?.ltp, node?.lastPrice);
    if (premium === null) return json({ error: "Option premium unavailable from Upstox." }, 400);
    return json({ success: true, premium, instrument, raw: payload });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Option premium fetch failed" }, 500);
  }
});