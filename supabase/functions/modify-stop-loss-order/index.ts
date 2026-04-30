import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { corsHeaders, getAuthenticatedClients, getSettings, json } from "../_shared/trading.ts";

const BodySchema = z.object({
  orderId: z.string().min(1),
  quantity: z.number().int().positive(),
  triggerPrice: z.number().positive(),
});

function upstoxErrorMessage(prefix: string, status: number, payload: any) {
  const reason = payload?.errors?.[0]?.message ?? payload?.errors?.[0]?.errorCode ?? payload?.message ?? payload?.error ?? payload?.status ?? JSON.stringify(payload);
  return `${prefix} HTTP ${status}: ${reason}`;
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
    const response = await fetch("https://api.upstox.com/v2/order/modify", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        order_id: parsed.data.orderId,
        quantity: parsed.data.quantity,
        validity: "DAY",
        price: 0,
        order_type: "SL-M",
        disclosed_quantity: 0,
        trigger_price: Number(parsed.data.triggerPrice.toFixed(2)),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(upstoxErrorMessage("Modify SL", response.status, result));
    return json({ success: true, result, triggerPrice: parsed.data.triggerPrice });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Stop loss modification failed" }, 500);
  }
});