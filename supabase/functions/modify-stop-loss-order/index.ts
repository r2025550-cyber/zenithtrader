import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { corsHeaders, getAuthenticatedClients, getSettings, json } from "../_shared/trading.ts";

// v18: widened to 4% to guarantee SL-L fills on sharp premium drops (brokers block SL-M on options)
const SL_LMT_BUFFER_PCT = 4.0;
const MAX_RETRIES = 2;

const BodySchema = z.object({
  orderId: z.string().min(1),
  quantity: z.number().int().positive(),
  triggerPrice: z.number().positive(),
  // v6: optional explicit limit, else derived from trigger
  limitPrice: z.number().positive().optional(),
  orderType: z.enum(["SL", "SL-M"]).optional(), // default SL (limit)
});

function upstoxErrorMessage(prefix: string, status: number, payload: any) {
  const reason = payload?.errors?.[0]?.message ?? payload?.errors?.[0]?.errorCode ?? payload?.message ?? payload?.error ?? payload?.status ?? JSON.stringify(payload);
  return `${prefix} HTTP ${status}: ${reason}`;
}

async function modifyWithRetry(headers: HeadersInit, body: Record<string, unknown>) {
  let lastErr: unknown = null;
  const attempts: Array<{ attempt: number; ok: boolean; error?: string }> = [];
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const response = await fetch("https://api.upstox.com/v2/order/modify", {
        method: "PUT", headers, body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(upstoxErrorMessage("Modify SL", response.status, result));
      attempts.push({ attempt, ok: true });
      return { result, attempts };
    } catch (err) {
      lastErr = err;
      attempts.push({ attempt, ok: false, error: err instanceof Error ? err.message : String(err) });
      if (attempt <= MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
    }
  }
  throw new Error(`Modify SL failed after ${MAX_RETRIES + 1} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.flatten().fieldErrors }, 400);
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const settings = await getSettings(auth.adminClient, auth.user.id);
    if (!settings.upstox_access_token) return json({ error: "Connect Upstox OAuth before modifying stop loss." }, 400);

    const headers = { Authorization: `Bearer ${settings.upstox_access_token}`, Accept: "application/json", "Content-Type": "application/json" };
    const orderType = parsed.data.orderType ?? "SL";
    const trigger = Number(parsed.data.triggerPrice.toFixed(2));
    const limit = orderType === "SL"
      ? Number((parsed.data.limitPrice ?? Math.max(0.05, trigger * (1 - SL_LMT_BUFFER_PCT / 100))).toFixed(2))
      : 0;

    const body = {
      order_id: parsed.data.orderId,
      quantity: parsed.data.quantity,
      validity: "DAY",
      price: limit,
      order_type: orderType,
      disclosed_quantity: 0,
      trigger_price: trigger,
    };

    const { result, attempts } = await modifyWithRetry(headers, body);
    return json({
      success: true,
      result,
      triggerPrice: trigger,
      limitPrice: limit,
      orderType,
      retry: { attempts },
      execution: { trailingActive: true, slActive: true },
    });
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : "Stop loss modification failed",
      execution: { trailingActive: false, slActive: false },
    }, 500);
  }
});
