import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, getAuthenticatedClients, getSettings, json, parseSignal } from "../_shared/trading.ts";

const GEMINI_MODEL_CANDIDATES = ["gemini-1.5-flash", "gemini-1.5-flash-latest", "gemini-1.5-flash-002"];

async function getGeminiModel(apiKey: string) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return GEMINI_MODEL_CANDIDATES[0];
  const models = (payload.models ?? []) as Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  return models.find((item) => GEMINI_MODEL_CANDIDATES.some((candidate) => item.name === `models/${candidate}`) && item.supportedGenerationMethods?.includes("generateContent"))?.name?.replace("models/", "") ?? GEMINI_MODEL_CANDIDATES[0];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error;
    const settings = await getSettings(auth.adminClient, auth.user.id);

    const { data: latest, error: latestError } = await auth.adminClient
      .from("nifty_market_data")
      .select("*")
      .eq("user_id", auth.user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (latestError || !latest) return json({ error: "Fetch Nifty data before running AI analysis." }, 400);

    const prompt = `You are a professional Nifty Options Scalper. Analyze the provided data and respond with ACTION: BUY/SELL/WAIT, STRIKE: (Current ATM), and REASON: (brief logic)\n\nMarket data:\n${JSON.stringify(latest)}`;

    const geminiModel = await getGeminiModel(settings.openai_api_key);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${settings.openai_api_key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 300 },
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return json({ error: "Gemini analysis failed", details: payload }, response.status);
    const text = payload?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("").trim() ?? "ACTION: WAIT, STRIKE: Current ATM, REASON: No analysis returned.";
    const signal = parseSignal(text);

    const { data, error } = await auth.adminClient.from("ai_trade_signals").insert({
      user_id: auth.user.id,
      market_data_id: latest.id,
      action: signal.action,
      strike: signal.strike,
      reason: signal.reason,
      raw_response: text,
    }).select("*").single();
    if (error) throw error;

    return json({ success: true, signal: data });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "AI analysis failed" }, 500);
  }
});
