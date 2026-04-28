import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { generateGeminiText } from "../_shared/gemini.ts";
import { corsHeaders, getAuthenticatedClients, getSettings, json, parseSignal } from "../_shared/trading.ts";

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

    const result = await generateGeminiText(settings.openai_api_key, prompt, 300);
    const text = result.text || "ACTION: WAIT, STRIKE: Current ATM, REASON: No analysis returned.";
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
