import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { corsHeaders, getAuthenticatedClients, getSettings, json } from "../_shared/trading.ts";

const BodySchema = z.object({ order_id: z.string().min(1) });

type UpstoxRecord = Record<string, unknown>;

function num(...values: unknown[]) {
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function pickStatus(raw: UpstoxRecord | null | undefined): string {
  if (!raw) return "UNKNOWN";
  const s = String((raw.status ?? raw.order_status ?? "")).toUpperCase();
  return s || "UNKNOWN";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.flatten().fieldErrors }, 400);
    const { order_id } = parsed.data;

    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const settings = await getSettings(auth.adminClient, auth.user.id);
    if (!settings.upstox_access_token) return json({ error: "Connect Upstox OAuth before checking order status." }, 400);

    const headers = {
      Authorization: `Bearer ${settings.upstox_access_token}`,
      Accept: "application/json",
    };

    // Try v2 order details endpoint, then fallback to /v2/order/history if needed
    const url = `https://api.upstox.com/v2/order/details?order_id=${encodeURIComponent(order_id)}`;
    const resp = await fetch(url, { headers });
    const payload = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return json({
        success: false,
        order_id,
        upstox_status: resp.status,
        error: payload?.errors?.[0]?.message ?? payload?.message ?? "Upstox order details failed",
        raw: payload,
      }, 200);
    }

    // Upstox returns either {data: {...}} or {data: [...]} depending on endpoint version
    const dataNode = (payload as UpstoxRecord)?.data as UpstoxRecord | UpstoxRecord[] | undefined;
    const node: UpstoxRecord | undefined = Array.isArray(dataNode)
      ? (dataNode[dataNode.length - 1] as UpstoxRecord | undefined)
      : (dataNode as UpstoxRecord | undefined);

    const status = pickStatus(node);
    const average_price = num(node?.average_price, node?.avg_price, node?.averagePrice);
    const filled_quantity = num(node?.filled_quantity, node?.filledQuantity, node?.filled_qty);
    const pending_quantity = num(node?.pending_quantity, node?.pendingQuantity);
    const trading_symbol = String(node?.trading_symbol ?? node?.tradingsymbol ?? node?.tradingSymbol ?? "") || null;
    const instrument_token = String(node?.instrument_token ?? node?.instrumentToken ?? "") || null;

    const isFilled = status === "COMPLETE" && filled_quantity > 0 && average_price > 0;
    const isRejected = status === "REJECTED";
    const isCancelled = status === "CANCELLED" || status === "CANCELED";
    const isPending = !isFilled && !isRejected && !isCancelled;

    return json({
      success: true,
      order_id,
      status,
      isFilled,
      isRejected,
      isCancelled,
      isPending,
      average_price,
      filled_quantity,
      pending_quantity,
      trading_symbol,
      instrument_token,
      raw: node ?? payload,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Order status check failed" }, 500);
  }
});
