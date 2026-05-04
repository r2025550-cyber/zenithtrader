import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { corsHeaders, getAuthenticatedClients, getSettings, json } from "../_shared/trading.ts";

const INSTRUMENT_KEY = "NSE_INDEX|Nifty 50";
const NIFTY_LOT_SIZE = 65;

// ===== v6 EXECUTION LAYER CONSTANTS =====
const ENTRY_SLIPPAGE_PCT = 1.5;          // cancel if entry > quoted LTP by 1.5%
const SL_LMT_BUFFER_PCT = 0.5;           // limit = trigger * (1 - 0.5%) for SELL SL
const MAX_ORDER_RETRIES = 2;             // retry failed orders up to 2 times
const MAX_BID_ASK_SPREAD_PCT = 2.0;      // skip if spread > 2% of LTP
const MIN_OPTION_VOLUME = 5000;          // skip if day volume < 5000
const FILL_POLL_ATTEMPTS = 6;            // ~6 polls
const FILL_POLL_INTERVAL_MS = 800;       // ~5s total wait for fill

const BodySchema = z.object({
  action: z.enum(["BUY", "SELL"]),
  spotPrice: z.number().positive(),
  strike: z.number().positive().optional(),
  tradingLotSize: z.number().int().positive(),
  effectiveLotSize: z.number().int().positive().optional(),
  targetPremiumPoints: z.number().positive().optional(),
  stopLossPremiumPoints: z.number().positive().optional(),
  // v6: optional override for slippage tolerance from client
  maxSlippagePct: z.number().positive().max(10).optional(),
  // v6-safe: chart-based risk + RR from analyze-with-ai signal
  riskPoints: z.number().positive().optional(),
  rrMultiplier: z.number().positive().max(10).optional(),
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

function upstoxErrorMessage(prefix: string, status: number, payload: any) {
  const reason = payload?.errors?.[0]?.message ?? payload?.errors?.[0]?.errorCode ?? payload?.message ?? payload?.error ?? payload?.status ?? JSON.stringify(payload);
  return `${prefix} HTTP ${status}: ${reason}`;
}

async function getAvailableCash(headers: HeadersInit) {
  const response = await fetch("https://api.upstox.com/v2/user/get-funds-and-margin?segment=SEC", { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Funds HTTP ${response.status}: ${JSON.stringify(payload)}`);
  const equity = payload?.data?.equity ?? payload?.data?.SEC ?? payload?.data ?? {};
  return numberFrom(equity?.available_margin, equity?.availableMargin, equity?.cash, equity?.available_cash, equity?.net) ?? 0;
}

async function resolveOption(headers: HeadersInit, spotPrice: number, action: "BUY" | "SELL", requestedStrike?: number) {
  const optionType = action === "BUY" ? "CE" : "PE";
  const atmStrike = Math.round(spotPrice / 50) * 50;
  const targetStrike = requestedStrike ?? atmStrike;
  const encoded = encodeURIComponent(INSTRUMENT_KEY);
  const contractResponse = await fetch(`https://api.upstox.com/v2/option/contract?instrument_key=${encoded}`, { headers });
  const contractPayload = await contractResponse.json().catch(() => ({}));
  if (!contractResponse.ok) throw new Error(upstoxErrorMessage("Option contract", contractResponse.status, contractPayload));

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
    if (requestedStrike && strike === targetStrike) return row;
    if (!best) return row;
    const bestStrike = numberFrom(best?.strike_price, best?.strikePrice, best?.strike) ?? targetStrike;
    return Math.abs(strike - targetStrike) < Math.abs(bestStrike - targetStrike) ? row : best;
  }, null);
  const selectedStrike = selected ? numberFrom(selected?.strike_price, selected?.strikePrice, selected?.strike) : null;
  if (!selected || (requestedStrike && selectedStrike !== requestedStrike)) throw new Error(`Invalid Symbol: Nifty ${targetStrike} ${optionType} contract not found for nearest expiry.`);

  const strike = numberFrom(selected?.strike_price, selected?.strikePrice, selected?.strike) ?? atmStrike;
  const instrumentToken = selected?.instrument_key ?? selected?.instrumentKey ?? selected?.instrument_token ?? selected?.instrumentToken;
  if (!instrumentToken) throw new Error("Resolved option contract is missing instrument token.");
  return { instrumentToken, strike, optionType, tradingSymbol: `Nifty ${strike} ${optionType}` };
}

async function getOptionLtp(headers: HeadersInit, instrumentToken: string) {
  const encoded = encodeURIComponent(instrumentToken);
  const response = await fetch(`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encoded}`, { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(upstoxErrorMessage("Option LTP", response.status, payload));
  return numberFrom(firstNode(payload)?.last_price, firstNode(payload)?.ltp, firstNode(payload)?.lastPrice) ?? 0;
}

// ===== v6: Full quote (depth) for liquidity filter =====
async function getOptionQuote(headers: HeadersInit, instrumentToken: string) {
  const encoded = encodeURIComponent(instrumentToken);
  const response = await fetch(`https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encoded}`, { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(upstoxErrorMessage("Option quote", response.status, payload));
  const node = firstNode(payload) ?? {};
  const ltp = numberFrom(node?.last_price, node?.ltp, node?.lastPrice) ?? 0;
  const volume = numberFrom(node?.volume, (node as any)?.total_traded_volume) ?? 0;
  const depth = (node?.depth as any) ?? {};
  const buyTop = Array.isArray(depth?.buy) ? depth.buy[0] : undefined;
  const sellTop = Array.isArray(depth?.sell) ? depth.sell[0] : undefined;
  const bid = numberFrom(buyTop?.price) ?? 0;
  const ask = numberFrom(sellTop?.price) ?? 0;
  const spread = ask > 0 && bid > 0 ? ask - bid : 0;
  const spreadPct = ltp > 0 && spread > 0 ? (spread / ltp) * 100 : 0;
  return { ltp, volume, bid, ask, spread, spreadPct };
}

// ===== v6: Retry wrapper =====
async function placeOrderWithRetry(headers: HeadersInit, orderPayload: Record<string, unknown>, label: string) {
  let lastErr: unknown = null;
  const attempts: Array<{ attempt: number; ok: boolean; error?: string }> = [];
  for (let attempt = 1; attempt <= MAX_ORDER_RETRIES + 1; attempt++) {
    try {
      const orderResponse = await fetch("https://api.upstox.com/v2/order/place", { method: "POST", headers, body: JSON.stringify(orderPayload) });
      const orderResult = await orderResponse.json().catch(() => ({}));
      if (!orderResponse.ok) throw new Error(upstoxErrorMessage(`${label} order`, orderResponse.status, orderResult));
      attempts.push({ attempt, ok: true });
      return { result: orderResult, attempts };
    } catch (err) {
      lastErr = err;
      attempts.push({ attempt, ok: false, error: err instanceof Error ? err.message : String(err) });
      if (attempt <= MAX_ORDER_RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
    }
  }
  throw new Error(`${label} failed after ${MAX_ORDER_RETRIES + 1} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function readOrderId(payload: Record<string, unknown>) {
  return String(payload?.data?.order_id ?? payload?.data?.orderId ?? payload?.order_id ?? payload?.orderId ?? "");
}

// ===== v6: Poll order status to detect fill + actual avg price =====
async function pollOrderFill(headers: HeadersInit, orderId: string) {
  if (!orderId) return { filled: false, avgPrice: 0, status: "unknown" };
  for (let i = 0; i < FILL_POLL_ATTEMPTS; i++) {
    try {
      const res = await fetch(`https://api.upstox.com/v2/order/details?order_id=${encodeURIComponent(orderId)}`, { headers });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        const node = (payload?.data as any) ?? {};
        const status = String(node?.status ?? node?.order_status ?? "").toLowerCase();
        const avgPrice = numberFrom(node?.average_price, node?.avg_price, node?.averagePrice) ?? 0;
        const filledQty = numberFrom(node?.filled_quantity, node?.filledQuantity) ?? 0;
        if (status.includes("complete") || filledQty > 0) {
          return { filled: true, avgPrice, status, filledQty };
        }
        if (status.includes("rejected") || status.includes("cancelled")) {
          return { filled: false, avgPrice: 0, status };
        }
      }
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, FILL_POLL_INTERVAL_MS));
  }
  return { filled: false, avgPrice: 0, status: "pending" };
}

// ===== v6: Cancel order helper =====
async function cancelOrder(headers: HeadersInit, orderId: string) {
  if (!orderId) return { ok: false };
  try {
    const res = await fetch(`https://api.upstox.com/v2/order/cancel?order_id=${encodeURIComponent(orderId)}`, { method: "DELETE", headers });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
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
    const slippageTolerancePct = parsed.data.maxSlippagePct ?? ENTRY_SLIPPAGE_PCT;

    const option = await resolveOption(headers, parsed.data.spotPrice, parsed.data.action, parsed.data.strike);

    // ===== v6 LIQUIDITY FILTER =====
    const quote = await getOptionQuote(headers, String(option.instrumentToken));
    const optionLtp = quote.ltp || (await getOptionLtp(headers, String(option.instrumentToken)));
    const liquidityChecks = {
      ltp: optionLtp,
      bid: quote.bid,
      ask: quote.ask,
      spread: quote.spread,
      spreadPct: Number(quote.spreadPct.toFixed(3)),
      volume: quote.volume,
      maxSpreadPct: MAX_BID_ASK_SPREAD_PCT,
      minVolume: MIN_OPTION_VOLUME,
    };

    if (quote.spreadPct > MAX_BID_ASK_SPREAD_PCT && quote.bid > 0 && quote.ask > 0) {
      return json({
        success: false,
        error: "Liquidity Filter",
        details: `Bid-ask spread ${quote.spreadPct.toFixed(2)}% exceeds ${MAX_BID_ASK_SPREAD_PCT}% threshold. Trade skipped.`,
        execution: { orderPlaced: false, orderFilled: false, slActive: false, trailingActive: false, blocked: "spread" },
        liquidity: liquidityChecks,
        instrument: option,
      });
    }
    if (quote.volume > 0 && quote.volume < MIN_OPTION_VOLUME) {
      return json({
        success: false,
        error: "Liquidity Filter",
        details: `Day volume ${quote.volume} below minimum ${MIN_OPTION_VOLUME}. Trade skipped.`,
        execution: { orderPlaced: false, orderFilled: false, slActive: false, trailingActive: false, blocked: "volume" },
        liquidity: liquidityChecks,
        instrument: option,
      });
    }

    // v6-safe: prefer chart-derived risk points + RR from analyze-with-ai signal
    const v6RiskPoints = parsed.data.riskPoints;
    const v6Rr = parsed.data.rrMultiplier ?? 1.8;
    const targetPremiumPoints = parsed.data.targetPremiumPoints
      ?? (v6RiskPoints ? Math.round(v6RiskPoints * v6Rr * 10) / 10 : 25);
    const stopLossPremiumPoints = parsed.data.stopLossPremiumPoints
      ?? (v6RiskPoints ?? 15);
    const targetPremium = optionLtp + targetPremiumPoints;
    const stopLossPremium = Math.max(0.05, optionLtp - stopLossPremiumPoints);
    const requiredCash = optionLtp * quantity;
    const availableCash = await getAvailableCash(headers);
    if (requiredCash > availableCash) {
      return json({
        success: false,
        error: "Low Margin",
        details: `Required approx ₹${requiredCash.toFixed(0)} for ${quantity} qty, available ₹${availableCash.toFixed(0)}.`,
        execution: { orderPlaced: false, orderFilled: false, slActive: false, trailingActive: false, blocked: "margin" },
        quantity, availableCash, requiredCash, optionLtp, instrument: option,
      });
    }

    // ===== ENTRY ORDER (with retry) =====
    const entryPayload = {
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
    const entry = await placeOrderWithRetry(headers, entryPayload, "Entry");
    const orderId = readOrderId(entry.result);

    // ===== v6: Poll for fill + check slippage =====
    const fill = await pollOrderFill(headers, orderId);
    const fillPrice = fill.avgPrice || optionLtp;
    const slippagePct = optionLtp > 0 ? Math.abs(fillPrice - optionLtp) / optionLtp * 100 : 0;
    const slippageBreached = fill.filled && slippagePct > slippageTolerancePct;

    if (slippageBreached) {
      // Immediately exit position with market SELL to cap loss; do NOT place SL
      const exitPayload = { ...entryPayload, transaction_type: "SELL", tag: "zenith-slippage-exit" };
      const exit = await placeOrderWithRetry(headers, exitPayload, "Slippage exit").catch((e) => ({ result: { error: e instanceof Error ? e.message : String(e) }, attempts: [] }));
      return json({
        success: false,
        error: "Entry Slippage Exceeded",
        details: `Fill ${fillPrice.toFixed(2)} vs quoted ${optionLtp.toFixed(2)} → ${slippagePct.toFixed(2)}% (max ${slippageTolerancePct}%). Position auto-exited.`,
        execution: { orderPlaced: true, orderFilled: true, slActive: false, trailingActive: false, slippageExit: true },
        slippage: { quotedLtp: optionLtp, fillPrice, slippagePct: Number(slippagePct.toFixed(3)), tolerancePct: slippageTolerancePct },
        entry: entry.result, exit: (exit as any)?.result, retryAttempts: entry.attempts,
        instrument: option, quantity,
      });
    }

    // ===== v6: SL-LMT instead of SL-M =====
    const slTrigger = Number(stopLossPremium.toFixed(2));
    const slLimit = Number(Math.max(0.05, slTrigger * (1 - SL_LMT_BUFFER_PCT / 100)).toFixed(2));
    const slPayload = {
      quantity,
      product: "D",
      validity: "DAY",
      price: slLimit,                     // limit price (slightly worse than trigger to ensure fill)
      tag: "zenith-server-sl-lmt",
      instrument_token: option.instrumentToken,
      order_type: "SL",                   // SL = Stop-Loss Limit (vs SL-M = market)
      transaction_type: "SELL",
      disclosed_quantity: 0,
      trigger_price: slTrigger,
      is_amo: false,
    };
    const sl = await placeOrderWithRetry(headers, slPayload, "SL-LMT").catch((e) => {
      // SL placement failure is reported but does not invalidate the entry
      return { result: { error: e instanceof Error ? e.message : String(e) }, attempts: [], failed: true } as any;
    });
    const slOrderId = readOrderId(sl.result);
    const slActive = !!slOrderId && !(sl as any).failed;

    return json({
      success: true,
      execution: {
        orderPlaced: true,
        orderFilled: fill.filled,
        orderStatus: fill.status,
        slActive,
        trailingActive: false, // managed by frontend trailing loop
      },
      slippage: { quotedLtp: optionLtp, fillPrice, slippagePct: Number(slippagePct.toFixed(3)), tolerancePct: slippageTolerancePct, withinTolerance: !slippageBreached },
      liquidity: liquidityChecks,
      retry: { entryAttempts: entry.attempts, slAttempts: sl.attempts },
      order: entry.result,
      slOrder: sl.result,
      slOrderId,
      slType: "SL-LMT",
      slTriggerPrice: slTrigger,
      slLimitPrice: slLimit,
      instrument: option,
      instrumentToken: option.instrumentToken,
      quantity,
      availableCash,
      requiredCash,
      optionLtp,
      entryPremium: fillPrice,
      targetPremium,
      stopLossPremium,
      targetPremiumPoints,
      stopLossPremiumPoints,
      version: "execution-layer-v6",
    });
  } catch (error) {
    console.error("place-live-order Upstox failure", { message: error instanceof Error ? error.message : String(error) });
    return json({
      error: error instanceof Error ? error.message : "Live order placement failed",
      execution: { orderPlaced: false, orderFilled: false, slActive: false, trailingActive: false },
    }, 500);
  }
});
