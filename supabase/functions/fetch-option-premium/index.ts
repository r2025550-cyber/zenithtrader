import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { corsHeaders, getAuthenticatedClients, getSettings, json } from "../_shared/trading.ts";

const BodySchema = z.object({ instrumentToken: z.string().min(1) });

function numberFrom(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
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

    const encoded = encodeURIComponent(parsed.data.instrumentToken);
    const headers = { Authorization: `Bearer ${settings.upstox_access_token}`, Accept: "application/json" };
    const response = await fetch(`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encoded}`, { headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Option LTP HTTP ${response.status}: ${JSON.stringify(payload)}`);
    const node = Object.values((payload?.data as Record<string, unknown> | undefined) ?? {})[0] as Record<string, unknown> | undefined;
    const premium = numberFrom(node?.last_price, node?.ltp, node?.lastPrice);
    if (premium === null) return json({ error: "Option premium unavailable from Upstox." }, 400);
    return json({ success: true, premium, raw: payload });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Option premium fetch failed" }, 500);
  }
});