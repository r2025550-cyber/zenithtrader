import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GEMINI_API_VERSION, generateGeminiText } from "../_shared/gemini.ts";
import { corsHeaders, getAuthenticatedClients, json } from "../_shared/trading.ts";

const ok = (message: string, details?: Record<string, unknown>) => ({ ok: true, message, details });
const fail = (message: string, details?: Record<string, unknown>) => ({ ok: false, message, details });

async function checkUpstox(accessToken?: string | null) {
  if (!accessToken) return fail("Upstox access token is missing. Complete OAuth again from API Settings.");

  const response = await fetch("https://api.upstox.com/v2/user/profile", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    return fail("Upstox token check failed. Reconnect OAuth before market open.", { status: response.status, payload });
  }

  return ok("Access token is valid and ready for tomorrow's market open.", { status: response.status });
}

async function clearUpstoxToken(adminClient: any, userId: string) {
  await adminClient
    .from("trading_api_settings")
    .update({ upstox_access_token: null, upstox_refresh_token: null, token_expires_at: null })
    .eq("user_id", userId);
}

async function checkGemini(apiKey?: string | null) {
  if (!apiKey) return fail("Gemini API key is missing. Save it in API Settings.");

  try {
    const result = await generateGeminiText(apiKey, "Reply with only OK.", 5);
    return ok("Gemini Flash responded successfully with the saved API key.", { model: result.modelName, apiVersion: GEMINI_API_VERSION, sdk: "@google/generative-ai", endpoint: "stable" });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Gemini Flash verification failed.", { apiVersion: GEMINI_API_VERSION, sdk: "@google/generative-ai", endpoint: "stable" });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const target = body?.target === "gemini" ? "gemini" : "all";
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error ?? json({ error: "Please sign in before checking system status." }, 401);

    const { data: settings, error } = await auth.adminClient
      .from("trading_api_settings")
      .select("upstox_access_token, openai_api_key")
      .eq("user_id", auth.user.id)
      .maybeSingle();

    if (error) throw error;

    if (target === "gemini") {
      const gemini = await checkGemini(settings?.openai_api_key);
      return json({ gemini, checkedAt: new Date().toISOString() });
    }

    const [upstox, gemini] = await Promise.all([checkUpstox(settings?.upstox_access_token), checkGemini(settings?.openai_api_key)]);
    if (!upstox.ok && JSON.stringify(upstox.details ?? {}).includes("UDAPI100050")) await clearUpstoxToken(auth.adminClient, auth.user.id);

    return json({ ready: upstox.ok && gemini.ok, upstox, gemini, checkedAt: new Date().toISOString() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "System status check failed" }, 500);
  }
});