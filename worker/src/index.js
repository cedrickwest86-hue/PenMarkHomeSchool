// Cloudflare Worker for West Homeschool:
//  • AI: lets the app use Claude without exposing your Anthropic key (Plus plans and trials, within a monthly limit)
//  • Billing: Stripe checkout, the billing portal (change plan, update card, cancel), and Stripe's webhook
//  • Contact form for members, calendar subscription feeds, and a daily cleanup job

const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
const fail = (message, status, headers) => json({ type: "error", error: { type: "proxy_error", message } }, status, headers);


/* ---------- Calendar subscriptions (.ics) ---------- */
// GET /calendar/<code>.ics returns a calendar that iPhone/iPad Calendar, Google Calendar, and Outlook can subscribe to.
// Reminders: a morning list of the day's work, and an evening heads-up before tests and due dates.
const TESTS = ["Quiz", "Test", "Exam"];
const DEADLINE_TYPES = ["Book Report", "Project", "Memory Verse"];
const icsText = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const ymd = (iso) => iso.replace(/-/g, "");
const plusDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function fold(line) {
  const enc = new TextEncoder(); const parts = []; let cur = ""; let limit = 75;
  for (const ch of line) { if (enc.encode(cur + ch).length > limit) { parts.push(cur); cur = ch; limit = 74; } else cur += ch; }
  parts.push(cur);
  return parts.join("\r\n ");
}
function alarm(trigger, text) { return ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(text)}`, `TRIGGER:${trigger}`, "END:VALARM"]; }
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
// Reminder for an event: "none", minutes before ("0", "15", "30", "60", "120"), "eve" (6 p.m. the day before), or "morning" (7:30 a.m.)
function eventAlarm(e, summary, startMin) {
  const r = e.remind == null || e.remind === "" ? (startMin == null ? "eve" : "30") : String(e.remind);
  if (r === "none") return [];
  if (startMin == null) return r === "morning" ? alarm("PT7H30M", summary) : alarm("-PT6H", `Tomorrow: ${summary}`);
  if (r === "eve") return alarm(`-PT${startMin + 360}M`, `Tomorrow: ${summary}`);
  if (r === "morning") return alarm(startMin > 450 ? `-PT${startMin - 450}M` : "PT0M", `Today: ${summary}`);
  const n = Math.max(0, Math.min(1440, Number(r) || 0));
  return alarm(`-PT${n}M`, summary);
}

export function buildCalendar(feed, brand = "West Homeschool", now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const today = now.toISOString().slice(0, 10);
  const students = feed.students || [];
  const nameOf = (id) => students.find((s) => s.id === id)?.name || "";
  const single = !!feed.studentId;
  const calName = single ? `${students[0]?.name || "School"}'s school` : `${feed.family || "Our"} school`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//${brand}//Homeschool//EN`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(calName)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  const allDay = (uid, date, endExclusive, summary, description, alarms = [], extra = []) => {
    lines.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ymd(date)}`, `DTEND;VALUE=DATE:${ymd(endExclusive)}`,
      `SUMMARY:${icsText(summary)}`, ...(description ? [`DESCRIPTION:${icsText(description)}`] : []), "TRANSP:TRANSPARENT", ...extra, ...alarms, "END:VEVENT");
  };
  const who = (sid) => (single ? "" : `${nameOf(sid)}: `);
  const work = (feed.assignments || []).filter((a) => a.due && a.status !== "done");

  // 1. Each school day's work: one item per day (whole family) or per child, with a 7:30 a.m. reminder
  const byDay = {};
  for (const a of work) if (a.due >= today) (byDay[a.due] ||= []).push(a);
  for (const [day, list] of Object.entries(byDay)) {
    const kids = [...new Set(list.map((a) => a.studentId))];
    const summary = single ? `School: ${list.length} ${list.length === 1 ? "assignment" : "assignments"}` : `School: ${kids.map((k) => `${nameOf(k)} ${list.filter((a) => a.studentId === k).length}`).join(", ")}`;
    const description = kids.map((k) => `${single ? "" : nameOf(k) + "\n"}${list.filter((a) => a.studentId === k).map((a) => `• ${a.title || a.subject}`).join("\n")}`).join("\n\n");
    allDay(`day-${feed.studentId || "family"}-${day}@${brand.toLowerCase()}`, day, plusDays(day, 1), summary, description, alarm("PT7H30M", summary));
  }
  // 2. Tests and deadlines, with a 6 p.m. heads-up the evening before
  for (const a of work) {
    const deadline = a.dueBy && a.dueBy > a.due ? a.dueBy : (DEADLINE_TYPES.includes(a.type) ? a.due : null);
    if (TESTS.includes(a.type) && a.due >= today) {
      const t = `${who(a.studentId)}${a.title || a.type}`;
      allDay(`test-${a.id}@${brand.toLowerCase()}`, a.due, plusDays(a.due, 1), t, `${a.subject}${a.lesson ? `, lesson ${a.lesson}` : ""}`, alarm("-PT6H", `Tomorrow: ${t}`));
    } else if (deadline && deadline >= today) {
      const t = `${who(a.studentId)}${a.title || a.type} due`;
      allDay(`due-${a.id}@${brand.toLowerCase()}`, deadline, plusDays(deadline, 1), t, a.subject, alarm("-PT6H", `Tomorrow: ${t}`));
    }
  }
  // 3. Calendar events: swim lessons, field trips, holidays...
  for (const e of feed.events || []) {
    if (!e.date || !e.title) continue;
    const forWhom = !single && Array.isArray(e.studentIds) && e.studentIds.length ? ` (${e.studentIds.map(nameOf).filter(Boolean).join(", ")})` : "";
    const summary = `${e.title}${forWhom}`;
    const days = Array.isArray(e.days) ? e.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
    const rule = e.repeatWeekly ? [`RRULE:FREQ=WEEKLY;UNTIL=${ymd(e.until || plusDays(e.date, 280))}${e.time ? "T235959" : ""}${days.length ? `;BYDAY=${days.map((d) => BYDAY[d]).join(",")}` : ""}`] : [];
    const extra = [...(e.place ? [`LOCATION:${icsText(e.place)}`] : []), ...(e.notes ? [`DESCRIPTION:${icsText(e.notes)}`] : [])];
    if (e.time && /^\d{2}:\d{2}$/.test(e.time)) {
      const [h, m] = e.time.split(":").map(Number);
      const mins = Number(e.minutes) || 60;
      const endTotal = h * 60 + m + mins;
      const endDate = plusDays(e.date, Math.floor(endTotal / 1440));
      const two = (n) => String(n).padStart(2, "0");
      const end = `${ymd(endDate)}T${two(Math.floor((endTotal % 1440) / 60))}${two(endTotal % 60)}00`;
      lines.push("BEGIN:VEVENT", `UID:event-${e.id}@${brand.toLowerCase()}`, `DTSTAMP:${stamp}`, `DTSTART:${ymd(e.date)}T${two(h)}${two(m)}00`, `DTEND:${end}`,
        `SUMMARY:${icsText(summary)}`, ...extra, ...rule, ...eventAlarm(e, summary, h * 60 + m), "END:VEVENT");
    } else {
      const last = e.endDate && e.endDate > e.date ? e.endDate : e.date;
      allDay(`event-${e.id}@${brand.toLowerCase()}`, e.date, plusDays(last, 1), summary, [e.noLessons ? "No regular lessons" : (e.kind || ""), e.notes].filter(Boolean).join("\n"), eventAlarm(e, summary, null), [...rule, ...(e.place ? [`LOCATION:${icsText(e.place)}`] : [])]);
    }
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

async function calendarResponse(token, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return new Response("Calendar links aren't set up yet.", { status: 500 });
  const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/calendar_feed`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_token: token }),
  });
  const feed = r.ok ? await r.json().catch(() => null) : null;
  if (!feed) return new Response("This calendar link is no longer active.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(buildCalendar(feed, env.BRAND_NAME || "West Homeschool"), {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "public, max-age=900", "Content-Disposition": 'inline; filename="school.ics"' },
  });
}

/* ---------- helpers ---------- */
const base = (env) => env.SUPABASE_URL.replace(/\/$/, "");
async function rpc(env, name, args, auth) {
  const key = auth === "service" ? env.SUPABASE_SERVICE_KEY : env.SUPABASE_ANON_KEY;
  const r = await fetch(`${base(env)}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: key, Authorization: auth === "service" ? `Bearer ${env.SUPABASE_SERVICE_KEY}` : auth, "Content-Type": "application/json" },
    body: JSON.stringify(args || {}),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error(data?.message || `${name} failed (${r.status})`); e.status = r.status; throw e; }
  return data;
}
async function stripe(env, path, params, method = "POST") {
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const r = await fetch(`https://api.stripe.com/v1/${path}${method === "GET" && body ? `?${body}` : ""}`, {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: method === "POST" ? body : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "Stripe request failed");
  return data;
}
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
function safeEqual(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
export async function verifyStripe(raw, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = header.split(",").map((kv) => kv.split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(nowSec - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${raw}`)));
  return sigs.some((v) => safeEqual(v, mac));
}
const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);
function planForPrice(env, priceId) {
  if (!priceId) return null;
  if ([env.PRICE_PLUS_MONTHLY, env.PRICE_PLUS_YEARLY].includes(priceId)) return "plus";
  if ([env.PRICE_ESSENTIALS_MONTHLY, env.PRICE_ESSENTIALS_YEARLY].includes(priceId)) return "essentials";
  return null;
}
// AI price per million tokens, in dollars (input, output)
function aiPrice(env, model) {
  if (env.AI_PRICE_IN && env.AI_PRICE_OUT) return [Number(env.AI_PRICE_IN), Number(env.AI_PRICE_OUT)];
  if (/haiku/i.test(model)) return [0.1, 0.5];
  if (/opus/i.test(model)) return [5, 25];
  return [2, 10]; // Sonnet
}
async function sendEmail(env, to, subject, text, replyTo) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !to) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  return r.ok;
}
const AI_REASONS = {
  not_teacher: "Sign in as a teacher to use the AI tools.",
  device_only: "Create your login (Setup → Your login) to use the AI tools.",
  ended: "Your plan has ended. Choose a plan in Setup → Billing to use the AI tools again.",
  blocked: "The AI tools are paused for this account. Contact us from Setup → Help.",
  plan: "The AI tools are part of the Plus plan. You can upgrade in Setup → Billing.",
  limit: "You've reached this month's AI limit. It resets on the 1st; contact us from Setup → Help if you need more.",
};

/* ---------- Stripe webhook ---------- */
async function stripeWebhook(request, env) {
  const raw = await request.text();
  if (!(await verifyStripe(raw, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET))) return new Response("Bad signature", { status: 400 });
  const event = JSON.parse(raw);
  const o = event.data?.object || {};
  try {
    if (event.type === "checkout.session.completed" && o.client_reference_id && o.customer) {
      await rpc(env, "billing_set_customer", { p_family: o.client_reference_id, p_customer: o.customer }, "service");
    } else if (/^customer\.subscription\.(created|updated|deleted|paused|resumed)$/.test(event.type)) {
      const item = o.items?.data?.[0] || {};
      const price = item.price || {};
      const periodEnd = o.current_period_end || item.current_period_end;
      const result = await rpc(env, "billing_apply", {
        p_family: o.metadata?.family_id || null,
        p_customer: o.customer,
        p_subscription: o.id,
        p_stripe_status: event.type === "customer.subscription.deleted" ? "canceled" : o.status,
        p_plan: planForPrice(env, price.id),
        p_period_end: iso(periodEnd),
        p_cancel_at: iso(o.cancel_at || (o.cancel_at_period_end ? periodEnd : null)),
        p_price_cents: price.unit_amount ?? null,
        p_interval: price.recurring?.interval || null,
      }, "service");
      console.log(event.type, o.id, result);
    }
  } catch (e) {
    console.error("webhook", event.type, e.message);
    return new Response("Try again", { status: 500 }); // Stripe retries
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
}

/* ---------- billing for signed-in teachers ---------- */
async function billing(path, request, env, auth, origin) {
  if (!env.STRIPE_SECRET_KEY || !env.SUPABASE_SERVICE_KEY) return { status: 500, body: { error: { message: "Billing isn't set up yet." } } };
  const me = await rpc(env, "billing_me", {}, auth).catch(() => null);
  if (!me) return { status: 401, body: { error: { message: "Sign in with your teacher login to manage billing." } } };
  if (!me.is_owner) return { status: 403, body: { error: { message: "Only the teacher who started this homeschool can change the plan." } } };
  const body = await request.json().catch(() => ({}));
  const site = String(body.returnUrl || "").startsWith(origin) ? body.returnUrl.split("#")[0] : `${origin}/`;
  const portal = async () => (await stripe(env, "billing_portal/sessions", { customer: me.customer, return_url: `${site}#/billing` })).url;

  if (path === "/billing/portal") {
    if (!me.customer) return { status: 400, body: { error: { message: "There's no billing account yet. Choose a plan first." } } };
    return { status: 200, body: { url: await portal() } };
  }
  // /billing/checkout
  const plan = body.plan === "plus" ? "PLUS" : "ESSENTIALS";
  const price = env[`PRICE_${plan}_${body.interval === "year" ? "YEARLY" : "MONTHLY"}`];
  if (!price) return { status: 500, body: { error: { message: "That plan isn't set up yet." } } };
  // Already paying: switch plans in the billing portal instead of starting a second subscription
  if (me.customer && me.subscription && ["active", "past_due"].includes(me.status)) return { status: 200, body: { url: await portal() } };
  let customer = me.customer;
  if (!customer) {
    customer = (await stripe(env, "customers", { email: me.email || "", name: me.family_name || "", "metadata[family_id]": me.family_id })).id;
    await rpc(env, "billing_set_customer", { p_family: me.family_id, p_customer: customer }, "service");
  }
  const params = {
    mode: "subscription", customer, client_reference_id: me.family_id,
    "line_items[0][price]": price, "line_items[0][quantity]": "1",
    success_url: `${site}#/billing?done=1`, cancel_url: `${site}#/billing`,
    "subscription_data[metadata][family_id]": me.family_id, allow_promotion_codes: "true",
  };
  // Still in the free trial: they aren't charged until it ends
  const trialEnd = me.status === "trialing" && me.trial_ends_at ? Math.floor(new Date(me.trial_ends_at).getTime() / 1000) : 0;
  if (trialEnd > Date.now() / 1000 + 49 * 3600) params["subscription_data[trial_end]"] = String(trialEnd);
  const session = await stripe(env, "checkout/sessions", params);
  return { status: 200, body: { url: session.url } };
}

/* ---------- contact form ---------- */
async function support(request, env, auth) {
  const body = await request.json().catch(() => ({}));
  const id = await rpc(env, "send_support_message", { p_topic: String(body.topic || "Question"), p_body: String(body.body || "") }, auth);
  const me = await rpc(env, "billing_me", {}, auth).catch(() => null);
  await sendEmail(env, env.ADMIN_EMAIL, `[${env.BRAND_NAME || "West Homeschool"}] ${body.topic || "Question"} from ${me?.family_name || "a family"}`,
    `${body.body}\n\nFrom: ${me?.email || "unknown"} (${me?.family_name || ""})\nMessage #${id}. Reply to this email to answer them.`, me?.email).catch(() => false);
  return { status: 200, body: { ok: true, id } };
}

/* ---------- AI ---------- */
async function ai(request, env, auth, cors, ctx) {
  if (!env.ANTHROPIC_API_KEY) return fail("The AI tools aren't finished setting up (missing a setting on the worker).", 500, cors);
  let gate = await rpc(env, "ai_gate", {}, auth).catch((e) => ({ missing: /ai_gate|function|schema cache/i.test(e.message) }));
  // Before the billing update is run in Supabase, use the original check (AI switched on for the family)
  if (gate?.missing) gate = { ok: (await rpc(env, "can_use_ai", {}, auth).catch(() => false)) === true, reason: "not_enabled" };
  if (!gate?.ok) return fail(AI_REASONS[gate?.reason] || "AI tools aren't turned on for this account yet.", 403, cors);
  let body;
  try { body = await request.json(); } catch { return fail("The request wasn't valid.", 400, cors); }
  if (!Array.isArray(body?.messages) || !body.messages.length) return fail("The request had no messages.", 400, cors);
  // Only pass through what the app needs. The model and token cap are set here, not by the page.
  const model = env.MODEL || "claude-sonnet-5-5";
  const payload = { model, max_tokens: Math.min(Math.max(Number(body.max_tokens) || 1000, 1), Number(env.MAX_TOKENS) || 8192), messages: body.messages };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (res.ok && env.SUPABASE_SERVICE_KEY && gate.family_id) {
    try {
      const u = JSON.parse(text).usage || {};
      const tokensIn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const [pin, pout] = aiPrice(env, model);
      const cents = ((tokensIn * pin + (u.output_tokens || 0) * pout) / 1e6) * 100;
      ctx.waitUntil(rpc(env, "billing_log_ai", { p_family: gate.family_id, p_user: null, p_model: model, p_in: tokensIn, p_out: u.output_tokens || 0, p_cents: cents }, "service").catch(() => {}));
    } catch {}
  }
  return new Response(text, { status: res.status, headers: { ...cors, "Content-Type": "application/json" } });
}

/* ---------- daily job: reminder emails and deleting data past 12 months ---------- */
async function removeFiles(env, fid) {
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" };
  for (const folder of ["files", "keys"]) {
    for (let round = 0; round < 50; round++) {
      const list = await fetch(`${base(env)}/storage/v1/object/list/family-files`, { method: "POST", headers, body: JSON.stringify({ prefix: `${fid}/${folder}`, limit: 1000, offset: 0 }) }).then((r) => r.json()).catch(() => []);
      const names = (Array.isArray(list) ? list : []).filter((x) => x.name).map((x) => `${fid}/${folder}/${x.name}`);
      if (!names.length) break;
      await fetch(`${base(env)}/storage/v1/object/family-files`, { method: "DELETE", headers, body: JSON.stringify({ prefixes: names }) });
    }
  }
}
export async function daily(env) {
  if (!env.SUPABASE_SERVICE_KEY) return "no service key";
  const site = env.SITE_URL || "";
  const brand = env.BRAND_NAME || "West Homeschool";
  const d = await rpc(env, "billing_daily", {}, "service");
  for (const f of d.trial_ending || []) {
    const sent = await sendEmail(env, f.email, `Your ${brand} free trial ends soon`,
      `Your free trial for ${f.name} ends on ${new Date(f.ends).toDateString()}.\n\nTo keep going, choose a plan in Setup → Billing:\n${site}#/billing\n\nIf you don't, your account becomes read-only for 10 days so you can download your records, and then it's paused. Everything is kept for 12 months in case you come back.`);
    if (sent) await rpc(env, "billing_mark", { p_family: f.family_id, p_what: "trial" }, "service");
  }
  for (const f of d.delete_soon || []) {
    const sent = await sendEmail(env, f.email, `Your ${brand} records will be deleted on ${new Date(f.deletes).toDateString()}`,
      `We've kept ${f.name}'s homeschool records since your plan ended. They'll be permanently deleted on ${new Date(f.deletes).toDateString()}.\n\nTo keep them, sign in and choose a plan:\n${site}#/billing\n\nEverything comes back just as you left it.`);
    if (sent) await rpc(env, "billing_mark", { p_family: f.family_id, p_what: "delete" }, "service");
  }
  let removed = 0;
  for (const fid of d.delete_now || []) {
    await removeFiles(env, fid);
    if (await rpc(env, "billing_purge", { p_family: fid }, "service")) removed++;
  }
  return `trial ${d.trial_ending?.length || 0}, warned ${d.delete_soon?.length || 0}, deleted ${removed}`;
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname.replace(/\/$/, "") || "/";
    // Calendar apps fetch subscription links directly (no sign-in, no website origin)
    const cal = path.match(/^\/calendar\/([a-f0-9]{48})(?:\.ics)?$/);
    if (cal && (request.method === "GET" || request.method === "HEAD")) return calendarResponse(cal[1], env);
    // Stripe calls this directly; it's checked with the signing secret instead
    if (path === "/stripe/webhook" && request.method === "POST") return stripeWebhook(request, env);

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
    if (!okOrigin) return fail("This site isn't allowed to use this service. Add it to ALLOWED_ORIGINS.", 403, cors);
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return fail("This service isn't finished setting up (missing a setting on the worker).", 500, cors);
    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return fail("Sign in as a teacher first.", 401, cors);

    try {
      if (path === "/billing/checkout" || path === "/billing/portal") {
        const r = await billing(path, request, env, auth, origin);
        return json(r.body, r.status, cors);
      }
      if (path === "/support") {
        const r = await support(request, env, auth);
        return json(r.body, r.status, cors);
      }
      return await ai(request, env, auth, cors, ctx);
    } catch (e) {
      return fail(e.message || "Something went wrong. Try again.", e.status && e.status < 500 ? 400 : 500, cors);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(daily(env).then((r) => console.log("daily", r)).catch((e) => console.error("daily", e.message)));
  },
};
