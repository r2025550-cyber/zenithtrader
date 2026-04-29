import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { corsHeaders, getAuthenticatedClients, json } from "../_shared/trading.ts";

const BodySchema = z.object({
  isActive: z.boolean(),
  riskMode: z.enum(["conservative", "moderate", "aggressive"]),
  tradingQuantity: z.number().int().positive().optional(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) return json({ error: parsed.error.flatten().fieldErrors }, 400);

    const { data, error } = await auth.adminClient.from("ai_trading_sessions").upsert({
      user_id: auth.user.id,
      is_active: parsed.data.isActive,
      risk_mode: parsed.data.riskMode,
      last_run_at: parsed.data.isActive ? new Date().toISOString() : null,
      last_error: null,
    }, { onConflict: "user_id" }).select("*").single();
    if (error) throw error;

    return json({ success: true, session: data });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to update AI trading session" }, 500);
  }
});
