import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "https://deno.land/x/zod@v3.25.76/mod.ts";
import { corsHeaders, getAuthenticatedClients, json } from "../_shared/trading.ts";

const BodySchema = z.object({
  upstoxApiKey: z.string().trim().min(8).max(500),
  upstoxApiSecret: z.string().trim().min(8).max(1000),
  openaiApiKey: z.string().trim().min(8).max(1000),
  redirectUri: z.string().trim().url().max(1000).optional(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;

    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) return json({ error: parsed.error.flatten().fieldErrors }, 400);

    const { error } = await auth.adminClient.from("trading_api_settings").upsert({
      user_id: auth.user.id,
      upstox_api_key: parsed.data.upstoxApiKey,
      upstox_api_secret: parsed.data.upstoxApiSecret,
      openai_api_key: parsed.data.openaiApiKey,
      redirect_uri: parsed.data.redirectUri,
    }, { onConflict: "user_id" });

    if (error) throw error;
    return json({ success: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to save settings" }, 500);
  }
});
