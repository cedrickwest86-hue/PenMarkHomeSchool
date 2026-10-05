// Connection settings come from GitHub (Settings → Secrets and variables → Actions → Variables).
import { createClient } from "@supabase/supabase-js";

const env = import.meta.env;
export const CONFIG = {
  supabaseUrl: env.VITE_SUPABASE_URL || "",
  supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY || "",
  aiUrl: env.VITE_AI_URL || "",
};
export const FEATURES = { ai: !!CONFIG.aiUrl, gcal: false };

export const supabase = CONFIG.supabaseUrl && CONFIG.supabaseAnonKey
  ? createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

let demoMode = false;
export const setDemoMode = (on) => { demoMode = on; };

// AI requests go to your Cloudflare Worker, which holds the Anthropic key and only serves teachers.
export async function aiFetch(init = {}) {
  if (demoMode) {
    return new Response(JSON.stringify({ type: "error", error: { message: "The AI tools work in your own account, not in the demo." } }), { status: 503 });
  }
  if (!CONFIG.aiUrl || !supabase) {
    return new Response(JSON.stringify({ type: "error", error: { message: "The AI tools aren't set up yet. See step 3 of the setup guide." } }), { status: 503 });
  }
  const { data } = await supabase.auth.getSession();
  return fetch(CONFIG.aiUrl, {
    ...init,
    method: "POST",
    headers: { ...(init.headers || {}), "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token || ""}` },
  });
}
