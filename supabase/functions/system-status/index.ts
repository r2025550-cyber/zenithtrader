import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, getAuthenticatedClients, json } from "../_shared/trading.ts";

const ok = (message: string, details?: Record<string, unknown>) => ({ ok: true, message, details });
const fail = (message: string, details?: Record<string, unknown>) => ({ ok: false, message, details });
const GEMINI_MODEL_CANDIDATES = ["gemini-1.5-flash", "gemini-1.5-flash-latest", "gemini-1.5-flash-002"];

function extractGeminiError(payload: Record<string, unknown>) {
  const error = payload.error as { message?: string; code?: string | number; status?: string } | undefined;
  const message = error?.message ?? "Unknown Gemini error";
  const code = error?.status ? ` (${error.status})` : error?.code ? ` (${error.code})` : "";
  return `${message}${code}`;
}

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

async function checkGemini(apiKey?: string | null) {
  if (!apiKey) return fail("Gemini API key is missing. Save it in API Settings.");

  const modelsResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  const modelsPayload = await modelsResponse.json().catch(() => ({}));
  if (!modelsResponse.ok) return fail(extractGeminiError(modelsPayload), { status: modelsResponse.status, payload: modelsPayload });
  const availableModels = (modelsPayload.models ?? []) as Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  const model = availableModels.find((item) => GEMINI_MODEL_CANDIDATES.some((candidate) => item.name === `models/${candidate}`) && item.supportedGenerationMethods?.includes("generateContent"))?.name?.replace("models/", "") ?? GEMINI_MODEL_CANDIDATES[0];

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Reply with only OK." }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 5 },
    }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    return fail(extractGeminiError(payload), { status: response.status, payload });
  }

  return ok("Gemini 1.5 Flash responded successfully with the saved API key.", { status: response.status, model });
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

    return json({ ready: upstox.ok && gemini.ok, upstox, gemini, checkedAt: new Date().toISOString() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "System status check failed" }, 500);
  }
});