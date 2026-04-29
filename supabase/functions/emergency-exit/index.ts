import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { corsHeaders, getAuthenticatedClients, getSettings, json } from "../_shared/trading.ts";

const BodySchema = z.object({ lockForDay: z.boolean().optional().default(false) });

async function exitAllPositions(accessToken: string) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json" };
  const response = await fetch("https://api.upstox.com/v2/order/positions/exit", { method: "POST", headers, body: JSON.stringify({}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(JSON.stringify({ status: response.status, payload }));
  return payload;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.flatten().fieldErrors }, 400);
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const settings = await getSettings(auth.adminClient, auth.user.id);
    if (!settings.upstox_access_token) return json({ error: "Connect Upstox OAuth before emergency exit." }, 400);

    const result = await exitAllPositions(settings.upstox_access_token);
    if (parsed.data.lockForDay) {
      await auth.adminClient.from("ai_trading_sessions").upsert({
        user_id: auth.user.id,
        is_active: false,
        last_error: "Daily stop loss lock triggered emergency exit.",
        last_run_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    }

    return json({ success: true, result });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Emergency exit failed" }, 500);
  }
});
