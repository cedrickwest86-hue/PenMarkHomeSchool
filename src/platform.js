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

// Billing and the contact form also go through the worker
export async function workerFetch(path, body = {}) {
  if (demoMode) throw new Error("This works in your own account, not in the demo.");
  if (!CONFIG.aiUrl || !supabase) throw new Error("Billing isn't set up on this site yet.");
  const { data } = await supabase.auth.getSession();
  let res;
  try {
    res = await fetch(CONFIG.aiUrl.replace(/\/$/, "") + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token || ""}` },
      body: JSON.stringify(body),
    });
  } catch { throw new Error("Couldn't connect. Check your internet and try again."); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error?.message || "Something went wrong. Try again.");
  return j;
}

// AI requests go to your Cloudflare Worker, which holds the Anthropic key and only serves teachers.
export async function aiFetch(init = {}) {
  if (demoMode) {
    return new Response(JSON.stringify({ type: "error", error: { message: "The AI tools work in your own account, not in the demo." } }), { status: 503 });
  }
  if (!CONFIG.aiUrl || !supabase) {
    return new Response(JSON.stringify({ type: "error", error: { message: "Photo reading and the other AI tools aren't set up on this site yet. They need the Cloudflare worker (step 5 of the setup guide)." } }), { status: 503 });
  }
  const { data } = await supabase.auth.getSession();
  return fetch(CONFIG.aiUrl, {
    ...init,
    method: "POST",
    headers: { ...(init.headers || {}), "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token || ""}` },
  });
}
