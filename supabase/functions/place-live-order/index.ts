import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { corsHeaders, getAuthenticatedClients, getSettings, json } from "../_shared/trading.ts";

const INSTRUMENT_KEY = "NSE_INDEX|Nifty 50";
const NIFTY_LOT_SIZE = 65;

const BodySchema = z.object({
  action: z.enum(["BUY", "SELL"]),
  spotPrice: z.number().positive(),
  tradingLotSize: z.number().int().positive(),
  effectiveLotSize: z.number().int().positive().optional(),
  targetPremiumPoints: z.number().positive().optional(),
  stopLossPremiumPoints: z.number().positive().optional(),
});

type UpstoxRecord = Record<string, unknown>;

function numberFrom(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function firstNode(payload: Record<string, unknown>) {
  return Object.values((payload?.data as Record<string, unknown> | undefined) ?? {})[0] as UpstoxRecord | undefined;
}

async function getAvailableCash(headers: HeadersInit) {
  const response = await fetch("https://api.upstox.com/v2/user/get-funds-and-margin?segment=SEC", { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Funds HTTP ${response.status}: ${JSON.stringify(payload)}`);
  const equity = payload?.data?.equity ?? payload?.data?.SEC ?? payload?.data ?? {};
  return numberFrom(equity?.available_margin, equity?.availableMargin, equity?.cash, equity?.available_cash, equity?.net) ?? 0;
}

async function resolveAtmOption(headers: HeadersInit, spotPrice: number, action: "BUY" | "SELL") {
  const optionType = action === "BUY" ? "CE" : "PE";
  const atmStrike = Math.round(spotPrice / 50) * 50;
  const encoded = encodeURIComponent(INSTRUMENT_KEY);
  const contractResponse = await fetch(`https://api.upstox.com/v2/option/contract?instrument_key=${encoded}`, { headers });
  const contractPayload = await contractResponse.json().catch(() => ({}));
  if (!contractResponse.ok) throw new Error(`Option contract HTTP ${contractResponse.status}: ${JSON.stringify(contractPayload)}`);

  const rows = (Array.isArray(contractPayload?.data) ? contractPayload.data : []) as UpstoxRecord[];
  const today = new Date().toISOString().slice(0, 10);
  const expiries = rows.map((row) => String(row?.expiry ?? row?.expiry_date ?? "")).filter(Boolean).sort();
  const expiry = expiries.find((value: string) => value >= today) ?? expiries[0];
  const candidates = rows.filter((row) => {
    const rowExpiry = String(row?.expiry ?? row?.expiry_date ?? "");
    const rowType = String(row?.instrument_type ?? row?.option_type ?? row?.optionType ?? "").toUpperCase();
    return rowExpiry === expiry && rowType.includes(optionType);
  });
  const selected = candidates.reduce<UpstoxRecord | null>((best, row) => {
    const strike = numberFrom(row?.strike_price, row?.strikePrice, row?.strike);
    if (strike === null) return best;
    if (!best) return row;
    const bestStrike = numberFrom(best?.strike_price, best?.strikePrice, best?.strike) ?? atmStrike;
    return Math.abs(strike - atmStrike) < Math.abs(bestStrike - atmStrike) ? row : best;
  }, null);
  if (!selected) throw new Error(`No ${optionType} option contract found for nearest expiry.`);

  const strike = numberFrom(selected?.strike_price, selected?.strikePrice, selected?.strike) ?? atmStrike;
  const instrumentToken = selected?.instrument_key ?? selected?.instrumentKey ?? selected?.instrument_token ?? selected?.instrumentToken;
  if (!instrumentToken) throw new Error("Resolved option contract is missing instrument token.");
  return { instrumentToken, strike, optionType, tradingSymbol: `Nifty ${strike} ${optionType}` };
}

async function getOptionLtp(headers: HeadersInit, instrumentToken: string) {
  const encoded = encodeURIComponent(instrumentToken);
  const response = await fetch(`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encoded}`, { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Option LTP HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return numberFrom(firstNode(payload)?.last_price, firstNode(payload)?.ltp, firstNode(payload)?.lastPrice) ?? 0;
}

async function placeOrder(headers: HeadersInit, orderPayload: Record<string, unknown>) {
  const orderResponse = await fetch("https://api.upstox.com/v2/order/place", { method: "POST", headers, body: JSON.stringify(orderPayload) });
  const orderResult = await orderResponse.json().catch(() => ({}));
  if (!orderResponse.ok) throw new Error(`Order HTTP ${orderResponse.status}: ${JSON.stringify(orderResult)}`);
  return orderResult;
}

function readOrderId(payload: Record<string, unknown>) {
  return String(payload?.data?.order_id ?? payload?.data?.orderId ?? payload?.order_id ?? payload?.orderId ?? "");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.flatten().fieldErrors }, 400);
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const settings = await getSettings(auth.adminClient, auth.user.id);
    if (!settings.upstox_access_token) return json({ error: "Connect Upstox OAuth before placing live orders." }, 400);

    const headers = { Authorization: `Bearer ${settings.upstox_access_token}`, Accept: "application/json", "Content-Type": "application/json" };
    const liveLotSize = parsed.data.effectiveLotSize ?? parsed.data.tradingLotSize;
    const quantity = liveLotSize * NIFTY_LOT_SIZE;
    const option = await resolveAtmOption(headers, parsed.data.spotPrice, parsed.data.action);
    const optionLtp = await getOptionLtp(headers, option.instrumentToken);
    const targetPremiumPoints = parsed.data.targetPremiumPoints ?? 25;
    const stopLossPremiumPoints = parsed.data.stopLossPremiumPoints ?? 15;
    const targetPremium = optionLtp + targetPremiumPoints;
    const stopLossPremium = Math.max(0.05, optionLtp - stopLossPremiumPoints);
    const requiredCash = optionLtp * quantity;
    const availableCash = await getAvailableCash(headers);
    if (requiredCash > availableCash) {
      return json({ success: false, error: "Low Margin", details: `Required approx ₹${requiredCash.toFixed(0)} for ${quantity} qty, available ₹${availableCash.toFixed(0)}.`, quantity, availableCash, requiredCash, optionLtp, instrument: option });
    }

    const orderPayload = {
      quantity,
      product: "D",
      validity: "DAY",
      price: 0,
      tag: "zenith-live-ai",
      instrument_token: option.instrumentToken,
      order_type: "MARKET",
      transaction_type: "BUY",
      disclosed_quantity: 0,
      trigger_price: 0,
      is_amo: false,
    };
    const orderResult = await placeOrder(headers, orderPayload);
    const slOrderPayload = {
      quantity,
      product: "D",
      validity: "DAY",
      price: 0,
      tag: "zenith-server-sl",
      instrument_token: option.instrumentToken,
      order_type: "SL-M",
      transaction_type: "SELL",
      disclosed_quantity: 0,
      trigger_price: Number(stopLossPremium.toFixed(2)),
      is_amo: false,
    };
    const slOrderResult = await placeOrder(headers, slOrderPayload);

    return json({ success: true, order: orderResult, slOrder: slOrderResult, slOrderId: readOrderId(slOrderResult), instrument: option, instrumentToken: option.instrumentToken, quantity, availableCash, requiredCash, optionLtp, entryPremium: optionLtp, targetPremium, stopLossPremium, targetPremiumPoints, stopLossPremiumPoints });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Live order placement failed" }, 500);
  }
});