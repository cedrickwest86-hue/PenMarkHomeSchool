// Admin portal (#/admin): only accounts listed in the admins table can open it.
// Shows account and billing status, usage, AI cost, support messages, and app errors. It never shows families' lessons or grades.
import { useEffect, useState } from "react";
import { supabase } from "./platform.js";
import { BRAND } from "./brand.js";

const C = { ink: "#1B2A4A", soft: "#5B6B88", rule: "#D6E4F5", pencil: "#F2B705", redpen: "#C8322B", white: "#FFFFFF", paper: "#F3F7FC", green: "#2F7D4F" };
const btn = "inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-sm font-semibold focus:outline-none focus:ring-2 disabled:opacity-50";
const usd = (cents) => `$${((cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" }) : "–");
const ago = (d) => {
  if (!d) return "never";
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const FIXED_MONTHLY = 3525; // Supabase Pro + Cloudflare + GitHub + domain, in cents (from the break-even analysis)

function Stat({ label, value, sub, tone }) {
  return (
    <div className="rounded-xl p-3" style={{ background: C.white, border: `1px solid ${C.rule}` }}>
      <div className="text-xs" style={{ color: C.soft }}>{label}</div>
      <div className="text-2xl font-bold" style={{ color: tone === "bad" ? C.redpen : tone === "good" ? C.green : C.ink }}>{value}</div>
      {sub && <div className="text-xs" style={{ color: C.soft }}>{sub}</div>}
    </div>
  );
}

function Overview({ o }) {
  if (!o) return <p style={{ color: C.soft }}>Loading…</p>;
  const s = o.by_status || {}, p = o.by_plan || {};
  const paying = (s.active || 0) + (s.past_due || 0);
  const net = (o.mrr_cents || 0) - (o.ai_cost_month_cents || 0) - FIXED_MONTHLY;
  const days = o.ai_cost_30d_by_day || [];
  const max = Math.max(1, ...days.map((d) => d.cents));
  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label="Paying families" value={paying} sub={`${p.essentials || 0} Essentials · ${p.plus || 0} Plus`} />
        <Stat label="Monthly revenue (est.)" value={usd(o.mrr_cents)} sub="yearly plans counted ÷ 12" />
        <Stat label="AI cost this month" value={usd(o.ai_cost_month_cents)} />
        <Stat label="Est. net this month" value={usd(net)} sub="revenue − AI − ~$35 fixed" tone={net >= 0 ? "good" : "bad"} />
        <Stat label="Free trials" value={o.trials_active} sub={`${o.trials_ending_3d} ending in 3 days`} />
        <Stat label="New families (30 days)" value={o.new_30d} />
        <Stat label="Active (7 days)" value={o.active_7d} sub={`of ${o.families} families · ${o.students} children`} />
        <Stat label="Past due" value={s.past_due || 0} tone={s.past_due ? "bad" : undefined} />
        <Stat label="New messages" value={o.messages_new} tone={o.messages_new ? "bad" : undefined} />
        <Stat label="App errors (7 days)" value={o.errors_7d} tone={o.errors_7d > 20 ? "bad" : undefined} />
        <Stat label="Canceled / paused" value={s.canceled || 0} sub={`${o.deleting_30d} to be deleted within 30 days`} />
        <Stat label="Free (comp)" value={s.comp || 0} />
      </div>
      <h3 className="font-bold mb-2" style={{ color: C.ink }}>AI cost, last 30 days</h3>
      {days.length ? (
        <div className="flex items-end gap-1 h-24 rounded-xl p-2" style={{ background: C.white, border: `1px solid ${C.rule}` }}>
          {days.map((d) => <div key={d.day} title={`${d.day}: ${usd(d.cents)}`} className="flex-1 rounded-t" style={{ height: `${Math.max(4, (100 * d.cents) / max)}%`, background: C.ink }} />)}
        </div>
      ) : <p className="text-sm" style={{ color: C.soft }}>No AI use yet.</p>}
    </div>
  );
}

function FamilyRow({ f, onChanged }) {
  const [open, setOpen] = useState(false);
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const act = async (args, label) => {
    setBusy(true); setMsg("");
    const { error } = await supabase.rpc("admin_update_family", { p_family: f.id, ...args });
    setBusy(false); setMsg(error ? error.message : `${label}: done`);
    if (!error) onChanged();
  };
  const tone = f.access === "locked" ? C.redpen : f.status === "past_due" ? C.redpen : f.access === "readonly" ? "#B5651D" : C.green;
  return (
    <div className="py-3 border-b" style={{ borderColor: C.rule }}>
      <button className="w-full text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="font-semibold" style={{ color: C.ink }}>{f.name}</span>
          <span className="text-xs font-semibold rounded-full px-2 py-0.5" style={{ background: C.paper, color: tone }}>
            {f.status === "comp" ? "free" : f.status}{f.status !== "comp" && f.plan !== "trial" ? ` · ${f.plan}` : f.status === "comp" ? ` · ${f.plan}` : ""}{f.access !== "full" ? ` · ${f.access}` : ""}
          </span>
        </div>
        <div className="text-xs flex flex-wrap gap-x-3" style={{ color: C.soft }}>
          <span>{f.owner_email}</span>
          <span>{f.students ?? 0} children · {f.teachers} teachers · {f.devices} devices</span>
          <span>last active {ago(f.last_seen)}</span>
          <span>AI {usd(f.ai_cents)} / {usd(f.ai_cap_cents)}{f.ai_blocked ? " (blocked)" : ""}</span>
        </div>
      </button>
      {open && (
        <div className="mt-2 rounded-lg p-3 text-sm" style={{ background: C.paper, color: C.ink }}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 mb-3">
            <span>Joined: {day(f.created_at)}</span>
            {f.trial_ends_at && f.status === "trialing" && <span>Trial ends: {day(f.trial_ends_at)}</span>}
            {f.current_period_end && <span>Paid through: {day(f.current_period_end)}</span>}
            {f.price_cents != null && <span>Price: {usd(f.price_cents)}/{f.billing_interval === "year" ? "yr" : "mo"}</span>}
            {f.cancel_at && <span>Cancels: {day(f.cancel_at)}</span>}
            {f.grace_until && <span>Read-only until: {day(f.grace_until)}</span>}
            {f.delete_after && <span style={{ color: C.redpen }}>Deleted after: {day(f.delete_after)}</span>}
          </div>
          <div className="flex flex-wrap gap-2 mb-2">
            <button className={btn} style={{ border: `1.5px solid ${C.ink}` }} disabled={busy} onClick={() => act({ p_extend_trial_days: 7 }, "Trial extended 7 days")}>Extend trial 7 days</button>
            <button className={btn} style={{ border: `1.5px solid ${C.ink}` }} disabled={busy} onClick={() => act({ p_status: "comp", p_plan: "plus" }, "Free Plus")}>Make free (Plus)</button>
            <button className={btn} style={{ border: `1.5px solid ${C.ink}` }} disabled={busy} onClick={() => act({ p_status: "comp", p_plan: "essentials" }, "Free Essentials")}>Make free (Essentials)</button>
            <button className={btn} style={{ border: `1.5px solid ${f.ai_blocked ? C.ink : C.redpen}`, color: f.ai_blocked ? C.ink : C.redpen }} disabled={busy}
              onClick={() => act({ p_ai_blocked: !f.ai_blocked }, f.ai_blocked ? "AI unblocked" : "AI blocked")}>{f.ai_blocked ? "Unblock AI" : "Block AI"}</button>
          </div>
          <div className="flex gap-2 items-center">
            <label className="text-sm">Monthly AI limit $
              <input type="number" min="0" step="0.5" className="ml-1 w-20 rounded border px-2 py-1" style={{ borderColor: C.rule }} placeholder={((f.ai_cap_cents || 0) / 100).toFixed(2)} value={cap} onChange={(e) => setCap(e.target.value)} />
            </label>
            <button className={btn} style={{ border: `1.5px solid ${C.ink}` }} disabled={busy || cap === ""} onClick={() => act({ p_ai_cap_cents: Math.round(Number(cap) * 100) }, "AI limit set")}>Set</button>
            <button className="text-xs underline" style={{ color: C.soft }} disabled={busy} onClick={() => act({ p_ai_cap_cents: -1 }, "AI limit reset")}>Use default</button>
          </div>
          <p className="text-xs mt-2" style={{ color: C.soft }}>"Make free" is for your family and beta testers. To end a free account, set its status in Supabase → Table Editor → families. Refunds and paid-plan changes are made in Stripe.</p>
          {msg && <p className="mt-2 font-semibold">{msg}</p>}
        </div>
      )}
    </div>
  );
}

function Families() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState("all");
  const load = () => supabase.rpc("admin_families", { p_search: q.trim() }).then(({ data, error }) => setRows(error ? [] : data || []));
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [q]);
  const shown = (rows || []).filter((f) => filter === "all" || (filter === "paying" ? ["active", "past_due"].includes(f.status) : filter === "trial" ? f.status === "trialing" && f.access === "full" : filter === "attention" ? f.status === "past_due" || f.access !== "full" || f.ai_cents >= f.ai_cap_cents : f.status === filter));
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        <input className="flex-1 min-w-[12rem] rounded-md border px-3 py-2" style={{ borderColor: C.rule }} placeholder="Search by family or email" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="rounded-md border px-2 py-2" style={{ borderColor: C.rule }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All</option><option value="paying">Paying</option><option value="trial">On trial</option>
          <option value="attention">Needs attention</option><option value="canceled">Canceled</option><option value="comp">Free</option>
        </select>
      </div>
      {rows === null ? <p style={{ color: C.soft }}>Loading…</p> : !shown.length ? <p style={{ color: C.soft }}>No families match.</p> : shown.map((f) => <FamilyRow key={f.id} f={f} onChanged={load} />)}
    </div>
  );
}

function Messages({ onChanged }) {
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState("new");
  const load = () => supabase.rpc("admin_messages", { p_status: status === "all" ? null : status }).then(({ data }) => setRows(data || []));
  useEffect(() => { load(); }, [status]);
  const mark = async (id, s) => { await supabase.rpc("admin_set_message", { p_id: id, p_status: s, p_note: null }); load(); onChanged(); };
  return (
    <div>
      <div className="flex gap-2 mb-3">
        {["new", "answered", "closed", "all"].map((s) => (
          <button key={s} className={btn} aria-pressed={status === s} onClick={() => setStatus(s)} style={status === s ? { background: C.ink, color: C.white } : { border: `1px solid ${C.rule}`, color: C.ink }}>{s[0].toUpperCase() + s.slice(1)}</button>
        ))}
      </div>
      {rows === null ? <p style={{ color: C.soft }}>Loading…</p> : !rows.length ? <p style={{ color: C.soft }}>Nothing here.</p> : rows.map((m) => (
        <div key={m.id} className="rounded-xl p-3 mb-3" style={{ background: C.white, border: `1px solid ${C.rule}` }}>
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <span className="font-semibold" style={{ color: C.ink }}>{m.topic} · {m.family_name || "(deleted family)"}</span>
            <span style={{ color: C.soft }}>{new Date(m.at).toLocaleString()}</span>
          </div>
          <p className="my-2 whitespace-pre-wrap" style={{ color: C.ink }}>{m.body}</p>
          <div className="flex flex-wrap gap-2 items-center text-sm">
            {m.email && <a className={btn} style={{ background: C.ink, color: C.white }} href={`mailto:${m.email}?subject=${encodeURIComponent(`Re: ${m.topic} (${BRAND.name})`)}&body=${encodeURIComponent(`\n\n---\nYou wrote:\n${m.body}`)}`}>Reply by email</a>}
            {m.status !== "answered" && <button className={btn} style={{ border: `1.5px solid ${C.ink}` }} onClick={() => mark(m.id, "answered")}>Mark answered</button>}
            {m.status !== "closed" && <button className={btn} style={{ border: `1.5px solid ${C.ink}` }} onClick={() => mark(m.id, "closed")}>Close</button>}
            <span style={{ color: C.soft }}>{m.email}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Errors() {
  const [rows, setRows] = useState(null);
  useEffect(() => { supabase.rpc("admin_errors", { p_limit: 200 }).then(({ data }) => setRows(data || [])); }, []);
  if (rows === null) return <p style={{ color: C.soft }}>Loading…</p>;
  if (!rows.length) return <p style={{ color: C.soft }}>No errors reported. 🎉</p>;
  // Group the same message so repeated bugs stand out
  const groups = Object.values(rows.reduce((g, e) => { (g[e.message] ||= { message: e.message, items: [] }).items.push(e); return g; }, {})).sort((a, b) => b.items.length - a.items.length);
  return (
    <div>
      <p className="text-sm mb-3" style={{ color: C.soft }}>Errors the app ran into on families' devices, grouped by message, most frequent first. Send the message and stack to Claude to fix.</p>
      {groups.map((g) => (
        <details key={g.message} className="rounded-xl p-3 mb-2" style={{ background: C.white, border: `1px solid ${C.rule}` }}>
          <summary className="cursor-pointer" style={{ color: C.ink }}>
            <span className="font-semibold">{g.items.length}×</span> {g.message}
            <span className="block text-xs" style={{ color: C.soft }}>last {new Date(g.items[0].at).toLocaleString()} · {[...new Set(g.items.map((e) => e.family_name).filter(Boolean))].length} families</span>
          </summary>
          <div className="mt-2 text-xs" style={{ color: C.ink }}>
            {g.items.slice(0, 5).map((e) => (
              <div key={e.id} className="mb-2">
                <div>{new Date(e.at).toLocaleString()} · {e.family_name || "?"} · {e.email || "device"} · {e.url}</div>
                <div style={{ color: C.soft }}>{e.agent}</div>
                {e.stack && <pre className="whitespace-pre-wrap mt-1 p-2 rounded" style={{ background: C.paper }}>{e.stack}</pre>}
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

export default function AdminPortal({ onExit }) {
  const [tab, setTab] = useState("overview");
  const [o, setO] = useState(null);
  const [err, setErr] = useState("");
  const load = () => supabase.rpc("admin_overview").then(({ data, error }) => { if (error) setErr(error.message); else setO(data); });
  useEffect(() => { load(); }, []);
  const tabs = [["overview", "Overview"], ["families", "Families"], ["messages", `Messages${o?.messages_new ? ` (${o.messages_new})` : ""}`], ["errors", "Errors"]];
  return (
    <div className="hs-gate min-h-screen" style={{ background: C.paper }}>
      <div className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold" style={{ color: C.ink }}>{BRAND.name} admin</h1>
          <div className="flex gap-3 text-sm">
            <button className="underline" style={{ color: C.ink }} onClick={load}>Refresh</button>
            <button className="underline" style={{ color: C.ink }} onClick={onExit}>Back to the app</button>
          </div>
        </div>
        <div className="flex gap-1 mb-4 overflow-x-auto" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className="rounded-lg px-3 py-2 text-sm font-semibold whitespace-nowrap focus:outline-none focus:ring-2"
              style={tab === id ? { background: C.ink, color: C.white } : { background: C.white, color: C.ink, border: `1px solid ${C.rule}` }}>{label}</button>
          ))}
        </div>
        {err && <p className="mb-3" style={{ color: C.redpen }}>{err}</p>}
        {tab === "overview" && <Overview o={o} />}
        {tab === "families" && <Families />}
        {tab === "messages" && <Messages onChanged={load} />}
        {tab === "errors" && <Errors />}
        <p className="text-xs mt-8" style={{ color: C.soft }}>The admin portal shows accounts, billing, usage, and errors. It never shows a family's lessons, grades, or files.</p>
      </div>
    </div>
  );
}
