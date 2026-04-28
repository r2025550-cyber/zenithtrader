import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenerativeAI } from "npm:@google/generative-ai@0.24.1";
import { corsHeaders, getAuthenticatedClients, json } from "../_shared/trading.ts";

const ok = (message: string, details?: Record<string, unknown>) => ({ ok: true, message, details });
const fail = (message: string, details?: Record<string, unknown>) => ({ ok: false, message, details });
const GEMINI_MODELS = ["gemini-1.5-flash", "gemini-1.5-flash-latest"];

function extractGeminiError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown Gemini error";
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

  let lastError: unknown;
  try {
    const genAI = new GoogleGenerativeAI(apiKey.trim());
    for (const modelName of GEMINI_MODELS) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 0, maxOutputTokens: 5 } }, { apiVersion: "v1" });
        await model.generateContent("Reply with only OK.");
        return ok("Gemini 1.5 Flash responded successfully with the saved API key.", { model: modelName, apiVersion: "v1", keyHeader: "x-goog-api-key", sdk: "@google/generative-ai" });
      } catch (error) {
        lastError = error;
      }
    }
    return fail(extractGeminiError(lastError), { model: GEMINI_MODELS.join(" → "), apiVersion: "v1", keyHeader: "x-goog-api-key", sdk: "@google/generative-ai" });
  } catch (error) {
    return fail(extractGeminiError(error), { model: GEMINI_MODELS.join(" → "), apiVersion: "v1", keyHeader: "x-goog-api-key", sdk: "@google/generative-ai" });
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

    return json({ ready: upstox.ok && gemini.ok, upstox, gemini, checkedAt: new Date().toISOString() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "System status check failed" }, 500);
  }
});