// Cloudflare Worker: lets the tracker use Claude without exposing your Anthropic API key.
// Only signed-in teachers whose family has AI turned on (families.ai_enabled) can use it.

const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
const fail = (message, status, headers) => json({ type: "error", error: { type: "proxy_error", message } }, status, headers);

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? origin : allowed[0] || "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
    if (request.method !== "POST") return fail("Use POST.", 405, cors);
    if (!okOrigin) return fail("This site isn't allowed to use the AI tools. Add it to ALLOWED_ORIGINS.", 403, cors);
    if (!env.ANTHROPIC_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return fail("The AI tools aren't finished setting up (missing a setting on the worker).", 500, cors);

    // Is the caller a signed-in teacher whose family has AI turned on?
    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return fail("Sign in as a teacher to use the AI tools.", 401, cors);
    const check = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/can_use_ai`, {
      method: "POST",
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: auth, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!check.ok || (await check.json().catch(() => false)) !== true) return fail("The AI tools aren't turned on for this account yet.", 403, cors);

    let body;
    try { body = await request.json(); } catch { return fail("The request wasn't valid.", 400, cors); }
    if (!Array.isArray(body?.messages) || !body.messages.length) return fail("The request had no messages.", 400, cors);

    // Only pass through what the tracker needs. The model and token cap are set here, not by the page.
    const payload = {
      model: env.MODEL || "claude-sonnet-5-5",
      max_tokens: Math.min(Math.max(Number(body.max_tokens) || 1000, 1), Number(env.MAX_TOKENS) || 4096),
      messages: body.messages,
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return new Response(res.body, { status: res.status, headers: { ...cors, "Content-Type": "application/json" } });
  },
};
