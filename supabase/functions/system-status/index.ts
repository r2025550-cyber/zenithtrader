import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
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

async function checkOpenAI(apiKey?: string | null) {
  if (!apiKey) return fail("OpenAI API key is missing. Save it in API Settings.");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 5,
      messages: [
        { role: "system", content: "Reply with only OK." },
        { role: "user", content: "connection test" },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    return fail("OpenAI test failed. Check the saved API key and billing/access status.", { status: response.status, payload });
  }

  return ok("AI engine responded successfully with the saved API key.", { status: response.status });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = await getAuthenticatedClients(req);
    if ("error" in auth) return auth.error ?? json({ error: "Please sign in before checking system status." }, 401);

    const { data: settings, error } = await auth.adminClient
      .from("trading_api_settings")
      .select("upstox_access_token, openai_api_key")
      .eq("user_id", auth.user.id)
      .maybeSingle();

    if (error) throw error;

    const [upstox, openai] = await Promise.all([
      checkUpstox(settings?.upstox_access_token),
      checkOpenAI(settings?.openai_api_key),
    ]);

    return json({ ready: upstox.ok && openai.ok, upstox, openai, checkedAt: new Date().toISOString() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "System status check failed" }, 500);
  }
});