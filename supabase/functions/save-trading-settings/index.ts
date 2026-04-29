import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { corsHeaders, getAuthenticatedClients, json } from "../_shared/trading.ts";

const BodySchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("upstox"),
    upstoxApiKey: z.string().trim().min(8).max(500),
    upstoxApiSecret: z.string().trim().min(8).max(1000),
    redirectUri: z.string().trim().url().max(1000).optional(),
  }),
  z.object({
    provider: z.literal("gemini"),
    openaiApiKey: z.string().trim().min(8).max(1000),
  }),
]);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;

    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) return json({ error: parsed.error.flatten().fieldErrors }, 400);

    const { data: existing, error: existingError } = await auth.adminClient
      .from("trading_api_settings")
      .select("*")
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (existingError) throw existingError;

    const row = parsed.data.provider === "upstox"
      ? {
        user_id: auth.user.id,
        upstox_api_key: parsed.data.upstoxApiKey,
        upstox_api_secret: parsed.data.upstoxApiSecret,
        openai_api_key: existing?.openai_api_key,
        redirect_uri: parsed.data.redirectUri ?? existing?.redirect_uri,
        upstox_access_token: null,
        upstox_refresh_token: null,
        token_expires_at: null,
      }
      : {
        user_id: auth.user.id,
        upstox_api_key: existing?.upstox_api_key,
        upstox_api_secret: existing?.upstox_api_secret,
        openai_api_key: parsed.data.openaiApiKey,
        redirect_uri: existing?.redirect_uri,
        upstox_access_token: existing?.upstox_access_token,
        upstox_refresh_token: existing?.upstox_refresh_token,
        token_expires_at: existing?.token_expires_at,
      };

    const { error } = await auth.adminClient.from("trading_api_settings").upsert(row, { onConflict: "user_id" });

    if (error) throw error;
    return json({ success: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to save settings" }, 500);
  }
});
