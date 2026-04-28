import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { corsHeaders, getAuthenticatedClients, getSettings, json } from "../_shared/trading.ts";

const BodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("url"), redirectUri: z.string().trim().url().max(1000) }),
  z.object({ mode: z.literal("token"), code: z.string().trim().min(4).max(2000), redirectUri: z.string().trim().url().max(1000) }),
]);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) return json({ error: parsed.error.flatten().fieldErrors }, 400);

    const settings = await getSettings(auth.adminClient, auth.user.id);
    const redirectUri = parsed.data.redirectUri;

    if (parsed.data.mode === "url") {
      const params = new URLSearchParams({ response_type: "code", client_id: settings.upstox_api_key, redirect_uri: redirectUri });
      await auth.adminClient.from("trading_api_settings").update({ redirect_uri: redirectUri }).eq("user_id", auth.user.id);
      return json({ url: `https://api.upstox.com/v2/login/authorization/dialog?${params.toString()}` });
    }

    const form = new URLSearchParams({
      code: parsed.data.code,
      client_id: settings.upstox_api_key,
      client_secret: settings.upstox_api_secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    const response = await fetch("https://api.upstox.com/v2/login/authorization/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form,
    });
    const tokenData = await response.json().catch(() => ({}));
    if (!response.ok) return json({ error: "Upstox OAuth failed", details: tokenData }, response.status);

    await auth.adminClient.from("trading_api_settings").update({
      upstox_access_token: tokenData.access_token,
      upstox_refresh_token: tokenData.refresh_token ?? null,
      token_expires_at: tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString() : null,
      redirect_uri: redirectUri,
    }).eq("user_id", auth.user.id);

    return json({ success: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "OAuth request failed" }, 500);
  }
});
