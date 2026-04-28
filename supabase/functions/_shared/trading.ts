import { createClient } from "https://esm.sh/@supabase/supabase-js@2.105.0";
import { z } from "https://esm.sh/zod@3.25.76";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export const optionalString = z.string().trim().max(4000).optional().or(z.literal(""));

export async function getAuthenticatedClients(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !anonKey || !serviceKey) throw new Error("Backend environment is not configured");

  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const adminClient = createClient(url, serviceKey);
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return { error: json({ error: "Please sign in before using trading automation." }, 401) };

  return { user: data.user, adminClient };
}

export async function getSettings(adminClient: any, userId: string) {
  const { data, error } = await adminClient
    .from("trading_api_settings")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !data) throw new Error("Trading API settings are not configured");
  return data;
}

export function parseSignal(text: string) {
  const action = text.match(/ACTION\s*:\s*(BUY|SELL|WAIT)/i)?.[1]?.toUpperCase() ?? "WAIT";
  const strike = text.match(/STRIKE\s*:\s*([^\n,]+)/i)?.[1]?.trim() ?? "Current ATM";
  const reason = text.match(/REASON\s*:\s*([\s\S]+)/i)?.[1]?.trim() ?? text.trim();
  return { action, strike, reason };
}
