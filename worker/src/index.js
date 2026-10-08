// Cloudflare Worker: lets the tracker use Claude without exposing your Anthropic API key.
// Only signed-in teachers whose family has AI turned on (families.ai_enabled) can use it.

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
    const rule = e.repeatWeekly ? [`RRULE:FREQ=WEEKLY;UNTIL=${ymd(e.until || plusDays(e.date, 280))}${e.time ? "T235959" : ""}`] : [];
    if (e.time && /^\d{2}:\d{2}$/.test(e.time)) {
      const [h, m] = e.time.split(":").map(Number);
      const mins = Number(e.minutes) || 60;
      const endTotal = h * 60 + m + mins;
      const endDate = plusDays(e.date, Math.floor(endTotal / 1440));
      const two = (n) => String(n).padStart(2, "0");
      const end = `${ymd(endDate)}T${two(Math.floor((endTotal % 1440) / 60))}${two(endTotal % 60)}00`;
      lines.push("BEGIN:VEVENT", `UID:event-${e.id}@${brand.toLowerCase()}`, `DTSTAMP:${stamp}`, `DTSTART:${ymd(e.date)}T${two(h)}${two(m)}00`, `DTEND:${end}`,
        `SUMMARY:${icsText(summary)}`, ...rule, ...alarm("-PT30M", summary), "END:VEVENT");
    } else {
      const last = e.endDate && e.endDate > e.date ? e.endDate : e.date;
      allDay(`event-${e.id}@${brand.toLowerCase()}`, e.date, plusDays(last, 1), summary, e.noLessons ? "No regular lessons" : (e.kind || ""), alarm("-PT6H", `Tomorrow: ${summary}`), rule);
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

export default {
  async fetch(request, env) {
    // Calendar apps fetch subscription links directly (no sign-in, no website origin)
    const cal = new URL(request.url).pathname.match(/^\/calendar\/([a-f0-9]{48})(?:\.ics)?$/);
    if (cal && (request.method === "GET" || request.method === "HEAD")) return calendarResponse(cal[1], env);
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
