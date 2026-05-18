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
  // v8: explicit option side + market direction (preferred over deriving from action)
  optionSide: z.enum(["CE", "PE"]).optional(),
  direction: z.enum(["BULLISH", "BEARISH"]).optional(),
  transactionType: z.enum(["BUY", "SELL"]).optional(),
  spotPrice: z.number().positive(),
  strike: z.number().positive().optional(),
  tradingLotSize: z.number().int().positive(),
  effectiveLotSize: z.number().int().positive().optional(),
  targetPremiumPoints: z.number().positive().optional(),
  stopLossPremiumPoints: z.number().positive().optional(),
  maxSlippagePct: z.number().positive().max(10).optional(),
  riskPoints: z.number().positive().optional(),
  rrMultiplier: z.number().positive().max(10).optional(),
  // v8: product hint (defaults to "I" → fallback "D")
  preferredProduct: z.enum(["I", "D"]).optional(),
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

async function resolveOption(headers: HeadersInit, spotPrice: number, action: "BUY" | "SELL", requestedStrike?: number, explicitOptionSide?: "CE" | "PE") {
  const optionType = explicitOptionSide ?? (action === "BUY" ? "CE" : "PE");
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

// ===== v8: Required-field validation for Upstox order payload =====
function validateOrderPayload(payload: Record<string, unknown>) {
  const required = ["instrument_token", "quantity", "order_type", "transaction_type", "product"] as const;
  const missing: string[] = [];
  for (const k of required) {
    const v = payload[k];
    if (v === undefined || v === null || v === "" || (k === "quantity" && Number(v) <= 0)) {
      missing.push(k);
    }
  }
  if (!["MARKET", "LIMIT", "SL", "SL-M"].includes(String(payload.order_type))) missing.push("order_type:invalid");
  if (!["BUY", "SELL"].includes(String(payload.transaction_type))) missing.push("transaction_type:invalid");
  if (!["I", "D"].includes(String(payload.product))) missing.push("product:invalid");
  if (String(payload.order_type) === "LIMIT" && Number(payload.price) <= 0) missing.push("price:required-for-LIMIT");
  if (String(payload.order_type) === "SL" && (Number(payload.price) <= 0 || Number(payload.trigger_price) <= 0)) {
    missing.push("price/trigger_price:required-for-SL");
  }
  return missing;
}

// ===== v8: Entry placement with PRODUCT (I→D) + ORDER_TYPE (MARKET→LIMIT) fallbacks =====
async function placeEntryWithFallback(
  headers: HeadersInit,
  basePayload: Record<string, unknown>,
  optionLtp: number,
  preferredProduct: "I" | "D",
  label: string,
) {
  const productOrder: Array<"I" | "D"> = preferredProduct === "I" ? ["I", "D"] : ["D", "I"];
  const tried: Array<{ product: string; order_type: string; ok: boolean; error?: string; payload: Record<string, unknown> }> = [];
  let lastErr: unknown = null;

  for (const product of productOrder) {
    // First attempt: MARKET
    const marketPayload = { ...basePayload, product, order_type: "MARKET", price: 0, trigger_price: 0 };
    const validation = validateOrderPayload(marketPayload);
    if (validation.length) {
      const errMsg = `Payload validation failed: ${validation.join(", ")}`;
      tried.push({ product, order_type: "MARKET", ok: false, error: errMsg, payload: marketPayload });
      lastErr = new Error(errMsg);
      continue;
    }
    console.log(`[ORDER PAYLOAD] ${label} product=${product} order_type=MARKET`, JSON.stringify(marketPayload));
    try {
      const r = await placeOrderWithRetry(headers, marketPayload, `${label}/MARKET/${product}`);
      tried.push({ product, order_type: "MARKET", ok: true, payload: marketPayload });
      return { result: r.result, attempts: r.attempts, finalPayload: marketPayload, tried, productUsed: product, orderTypeUsed: "MARKET" };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      tried.push({ product, order_type: "MARKET", ok: false, error: msg, payload: marketPayload });
      console.warn(`[ORDER FALLBACK] MARKET/${product} failed: ${msg}`);
    }

    // Second attempt: LIMIT @ LTP for same product
    if (optionLtp > 0) {
      const limitPrice = Number(optionLtp.toFixed(2));
      const limitPayload = { ...basePayload, product, order_type: "LIMIT", price: limitPrice, trigger_price: 0 };
      const validationL = validateOrderPayload(limitPayload);
      if (validationL.length) {
        const errMsg = `Payload validation failed: ${validationL.join(", ")}`;
        tried.push({ product, order_type: "LIMIT", ok: false, error: errMsg, payload: limitPayload });
        lastErr = new Error(errMsg);
        continue;
      }
      console.log(`[ORDER PAYLOAD] ${label} product=${product} order_type=LIMIT price=${limitPrice}`, JSON.stringify(limitPayload));
      try {
        const r = await placeOrderWithRetry(headers, limitPayload, `${label}/LIMIT/${product}`);
        tried.push({ product, order_type: "LIMIT", ok: true, payload: limitPayload });
        return { result: r.result, attempts: r.attempts, finalPayload: limitPayload, tried, productUsed: product, orderTypeUsed: "LIMIT" };
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        tried.push({ product, order_type: "LIMIT", ok: false, error: msg, payload: limitPayload });
        console.warn(`[ORDER FALLBACK] LIMIT/${product} failed: ${msg}`);
      }
    }
  }

  const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown");
  throw Object.assign(new Error(`${label} failed across all product/order_type fallbacks: ${errMsg}`), { tried });
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

    // v8: explicit optionSide preferred; fallback derives from action (BUY→CE / SELL→PE) for backwards-compat
    const explicitOptionSide = parsed.data.optionSide;
    const option = await resolveOption(headers, parsed.data.spotPrice, parsed.data.action, parsed.data.strike, explicitOptionSide);

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

    // ===== ENTRY ORDER (v8: explicit fields + product/order_type fallback chain) =====
    // We always BUY the option leg (long CE for bullish, long PE for bearish).
    // optionSide already determined upstream via resolveOption(explicitOptionSide).
    const preferredProduct = parsed.data.preferredProduct ?? "I";
    const entryBasePayload = {
      quantity,
      validity: "DAY",
      tag: "zenith-live-ai",
      instrument_token: option.instrumentToken,
      transaction_type: "BUY" as const,           // long option leg
      disclosed_quantity: 0,
      is_amo: false,
    };

    let entry: Awaited<ReturnType<typeof placeEntryWithFallback>>;
    try {
      entry = await placeEntryWithFallback(headers, entryBasePayload, optionLtp, preferredProduct, "Entry");
    } catch (err: any) {
      const reason = err?.message ?? "Entry placement failed";
      console.error("[ORDER FAIL]", reason, err?.tried);
      return json({
        success: false,
        error: "Upstox Order Rejected",
        details: reason,
        execution: { orderPlaced: false, orderFilled: false, slActive: false, trailingActive: false, blocked: "upstox-rejected" },
        errorDetails: {
          reason,
          attempts: err?.tried ?? [],
          failedField: (err?.tried ?? []).slice(-1)[0]?.error?.match(/(?:field |missing )([\w_.-]+)/i)?.[1] ?? null,
          rejectedPayload: (err?.tried ?? []).slice(-1)[0]?.payload ?? null,
        },
        liquidity: liquidityChecks,
        instrument: option,
        optionLtp,
        entryPremium: optionLtp,
        quantity,
      });
    }

    const orderId = readOrderId(entry.result);
    const finalEntryPayload = entry.finalPayload;
    console.log("[ORDER PLACED] productUsed=", entry.productUsed, "order_type=", entry.orderTypeUsed, "orderId=", orderId);

    // ===== v6: Poll for fill + check slippage =====
    const fill = await pollOrderFill(headers, orderId);
    const fillPrice = fill.avgPrice || optionLtp;
    const slippagePct = optionLtp > 0 ? Math.abs(fillPrice - optionLtp) / optionLtp * 100 : 0;
    const slippageBreached = fill.filled && slippagePct > slippageTolerancePct;

    if (slippageBreached) {
      const exitPayload = { ...finalEntryPayload, transaction_type: "SELL", tag: "zenith-slippage-exit" };
      const exit = await placeOrderWithRetry(headers, exitPayload, "Slippage exit").catch((e) => ({ result: { error: e instanceof Error ? e.message : String(e) }, attempts: [] }));
      return json({
        success: false,
        error: "Entry Slippage Exceeded",
        details: `Fill ${fillPrice.toFixed(2)} vs quoted ${optionLtp.toFixed(2)} → ${slippagePct.toFixed(2)}% (max ${slippageTolerancePct}%). Position auto-exited.`,
        execution: { orderPlaced: true, orderFilled: true, slActive: false, trailingActive: false, slippageExit: true },
        slippage: { quotedLtp: optionLtp, fillPrice, slippagePct: Number(slippagePct.toFixed(3)), tolerancePct: slippageTolerancePct },
        entry: entry.result, exit: (exit as any)?.result, retryAttempts: entry.attempts,
        instrument: option, quantity, entryPremium: fillPrice, optionLtp,
      });
    }

    // ===== v6-safe: recompute SL/Target against ACTUAL fill price =====
    // premiumSL = entryPremium - riskPoints; premiumTarget = entryPremium + (riskPoints * RR)
    const effectiveStopPremium = v6RiskPoints
      ? Math.max(0.05, fillPrice - v6RiskPoints)
      : Math.max(0.05, fillPrice - stopLossPremiumPoints);
    const effectiveTargetPremium = v6RiskPoints
      ? fillPrice + (v6RiskPoints * v6Rr)
      : fillPrice + targetPremiumPoints;

    // ===== v6: SL-LMT instead of SL-M =====
    const slTrigger = Number(effectiveStopPremium.toFixed(2));
    const slLimit = Number(Math.max(0.05, slTrigger * (1 - SL_LMT_BUFFER_PCT / 100)).toFixed(2));
    // v8: use same product as the successfully-placed entry to keep position consistent.
    const slPayload = {
      quantity,
      product: entry.productUsed,
      validity: "DAY",
      price: slLimit,
      tag: "zenith-server-sl-lmt",
      instrument_token: option.instrumentToken,
      order_type: "SL",
      transaction_type: "SELL",
      disclosed_quantity: 0,
      trigger_price: slTrigger,
      is_amo: false,
    };
    const slValidation = validateOrderPayload(slPayload);
    if (slValidation.length) {
      console.error("[SL PAYLOAD INVALID]", slValidation, slPayload);
    } else {
      console.log("[SL PAYLOAD]", JSON.stringify(slPayload));
    }
    const sl = await placeOrderWithRetry(headers, slPayload, "SL-LMT").catch((e) => {
      return { result: { error: e instanceof Error ? e.message : String(e) }, attempts: [], failed: true } as any;
    });
    const slOrderId = readOrderId(sl.result);
    const slActive = !!slOrderId && !(sl as any).failed;

    // ===== v7 FAIL-SAFE: if SL didn't activate after fill, immediately exit position =====
    if (fill.filled && !slActive) {
      const exitPayload = { ...finalEntryPayload, transaction_type: "SELL", tag: "zenith-sl-failsafe-exit" };
      const exit = await placeOrderWithRetry(headers, exitPayload, "SL-failsafe exit").catch((e) => ({ result: { error: e instanceof Error ? e.message : String(e) }, attempts: [] }));
      return json({
        success: false,
        error: "SL Activation Failed",
        details: `Stop-loss order could not be registered after fill. Position auto-exited as fail-safe.`,
        execution: { orderPlaced: true, orderFilled: true, slActive: false, trailingActive: false, slFailsafeExit: true },
        slippage: { quotedLtp: optionLtp, fillPrice, slippagePct: Number(slippagePct.toFixed(3)), tolerancePct: slippageTolerancePct },
        entry: entry.result, slOrder: sl.result, exit: (exit as any)?.result,
        instrument: option, quantity,
        entryPremium: fillPrice, optionLtp,
        errorDetails: { reason: (sl as any)?.result?.error ?? "SL not accepted", rejectedPayload: slPayload, failedField: "SL" },
      });
    }

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
      targetPremium: effectiveTargetPremium,
      stopLossPremium: effectiveStopPremium,
      premiumSL: effectiveStopPremium,
      premiumTarget: effectiveTargetPremium,
      targetPremiumPoints,
      stopLossPremiumPoints,
      riskPoints: v6RiskPoints ?? null,
      rrMultiplier: v6Rr,
      version: "execution-layer-v6-safe",
    });
  } catch (error) {
    console.error("place-live-order Upstox failure", { message: error instanceof Error ? error.message : String(error) });
    return json({
      error: error instanceof Error ? error.message : "Live order placement failed",
      execution: { orderPlaced: false, orderFilled: false, slActive: false, trailingActive: false },
    }, 500);
  }
});
