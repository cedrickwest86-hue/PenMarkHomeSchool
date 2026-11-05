// Plans, billing, the 10-day read-only window, the paused (locked) screen, the contact form, and error reports
import { useEffect, useState } from "react";
import { BRAND } from "./brand.js";
import { supabase, workerFetch, CONFIG } from "./platform.js";

const C = { ink: "#1B2A4A", soft: "#5B6B88", rule: "#D6E4F5", pencil: "#F2B705", redpen: "#C8322B", white: "#FFFFFF", paper: "#F3F7FC", green: "#2F7D4F" };
const btn = "inline-flex items-center justify-center gap-1 rounded-lg px-4 py-2 font-semibold focus:outline-none focus:ring-2 disabled:opacity-50";
const fmt = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "");
const daysLeft = (d) => Math.max(0, Math.ceil((new Date(d) - Date.now()) / 86400000));
const money = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const PLAN_NAME = { trial: "Free trial", essentials: "Essentials", plus: "Plus" };

async function goStripe(path, body, setErr, setBusy) {
  setBusy(path + (body?.plan || "") + (body?.interval || "")); setErr("");
  try {
    const { url } = await workerFetch(path, { ...body, returnUrl: window.location.href });
    window.location.href = url;
  } catch (e) { setErr(e.message); setBusy(""); }
}

/* ---------- side-by-side plans ---------- */
export function PlanCompare({ current, onChoose, busy = "", showButtons = true }) {
  const [interval, setInterval_] = useState("year");
  const plans = BRAND.plans;
  const save = (p) => Math.round(100 - (p.year / (p.month * 12)) * 100);
  return (
    <div>
      <div className="flex justify-center mb-4">
        <div className="inline-flex rounded-full p-1" style={{ background: C.paper, border: `1px solid ${C.rule}` }} role="group" aria-label="Billing period">
          {[["month", "Monthly"], ["year", "Yearly"]].map(([k, l]) => (
            <button key={k} type="button" aria-pressed={interval === k} onClick={() => setInterval_(k)}
              className="rounded-full px-4 py-1.5 text-sm font-semibold focus:outline-none focus:ring-2"
              style={interval === k ? { background: C.ink, color: C.white } : { color: C.ink }}>{l}</button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {Object.entries(plans).map(([id, p]) => {
          const featured = id === "plus";
          return (
            <div key={id} className="rounded-xl p-4 flex flex-col" style={{ background: C.white, border: `2px solid ${featured ? C.ink : C.rule}`, boxShadow: featured ? `4px 4px 0 ${C.pencil}` : "none" }}>
              <div className="flex items-baseline justify-between">
                <h3 className="text-xl font-bold" style={{ color: C.ink }}>{p.name}</h3>
                {current === id && <span className="text-xs font-semibold rounded-full px-2 py-0.5" style={{ background: C.paper, color: C.ink }}>Your plan</span>}
              </div>
              <div className="my-2" style={{ color: C.ink }}>
                <span className="text-3xl font-bold">{money(interval === "year" ? p.year : p.month)}</span>
                <span className="text-sm" style={{ color: C.soft }}>{interval === "year" ? " a year" : " a month"}</span>
                {interval === "year" && <div className="text-xs font-semibold" style={{ color: C.green }}>Save {save(p)}% vs. monthly ({money(p.month)}/mo)</div>}
              </div>
              <p className="text-sm mb-3 flex-1" style={{ color: C.ink }}>{p.blurb}</p>
              {showButtons && onChoose && (
                <button className={btn + " w-full"} disabled={!!busy} style={featured ? { background: C.ink, color: C.white } : { border: `1.5px solid ${C.ink}`, color: C.ink }}
                  onClick={() => onChoose(id, interval)}>{busy === `/billing/checkout${id}${interval}` ? "Opening…" : `Choose ${p.name}`}</button>
              )}
            </div>
          );
        })}
      </div>
      <table className="w-full text-sm mt-4" style={{ color: C.ink }}>
        <thead>
          <tr style={{ color: C.soft }}><th className="text-left font-semibold py-1">What's included</th><th className="w-20 font-semibold">Essentials</th><th className="w-14 font-semibold">Plus</th></tr>
        </thead>
        <tbody>
          {BRAND.compare.map(([label, a, b]) => (
            <tr key={label} className="border-t" style={{ borderColor: C.rule }}>
              <td className="py-1.5 pr-2">{label}</td>
              <td className="text-center" aria-label={a ? "Included" : "Not included"}>{a ? "✓" : <span style={{ color: C.soft }}>–</span>}</td>
              <td className="text-center" aria-label={b ? "Included" : "Not included"}>{b ? "✓" : <span style={{ color: C.soft }}>–</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs mt-2" style={{ color: C.soft }}>One price for your whole family. Plus includes {BRAND.aiAllowance} of AI reading and grading. {BRAND.trialDays}-day free trial with Plus features, no card needed.</p>
    </div>
  );
}

/* ---------- Setup → Billing ---------- */
export const CANCEL_POLICY = "If you cancel, you keep everything until the end of the time you've paid for. Then you have 10 days of read-only access to download your records and print report cards. After that your account is paused, and we keep your records for 12 months; choose a plan any time in those 12 months and everything comes back just as you left it.";

export function BillingPanel({ account, compact = false }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  if (!account || !account.status) return null;
  const a = account;
  const priceText = a.price_cents ? `${money(a.price_cents / 100)} ${a.interval === "year" ? "a year" : "a month"}` : "";
  let line;
  if (a.status === "comp") line = <>Complimentary account ({PLAN_NAME[a.plan]} features). No billing needed.</>;
  else if (a.status === "trialing" && a.access === "full") line = <>Free trial: <strong>{daysLeft(a.trial_ends_at)} days left</strong> (ends {fmt(a.trial_ends_at)}). Choose a plan any time; you won't be charged until the trial ends.</>;
  else if (a.status === "active" && a.cancel_at) line = <><strong>{PLAN_NAME[a.plan]}</strong>, canceled. Full access until {fmt(a.cancel_at)}, then 10 days to download your records.</>;
  else if (a.status === "active") line = <><strong>{PLAN_NAME[a.plan]}</strong>{priceText && `, ${priceText}`}. Renews {fmt(a.current_period_end)}.</>;
  else if (a.status === "past_due") line = <span style={{ color: C.redpen }}>Your last payment didn't go through. Update your card to keep your account active.</span>;
  else if (a.access === "readonly") line = <span style={{ color: C.redpen }}>Your {a.status === "trialing" ? "free trial" : "plan"} has ended. Read-only until {fmt(a.grace_until)}: download your records, or choose a plan to keep going.</span>;
  else line = <>Your account is paused. Records are kept until {fmt(a.delete_after)}.</>;
  const paying = ["active", "past_due"].includes(a.status);
  const canChoose = a.is_owner && !paying && a.status !== "comp";
  const showAi = a.ai_cap_cents > 0 && (a.plan === "plus" || a.status === "trialing" || a.status === "comp");

  return (
    <div>
      <p className="mb-3 leading-relaxed" style={{ color: C.ink }}>{line}</p>
      {showAi && a.ai_cap_cents != null && (
        <div className="mb-3">
          <div className="flex justify-between text-xs mb-1" style={{ color: C.soft }}><span>AI used this month</span><span>{Math.min(100, Math.round((100 * (a.ai_used_cents || 0)) / a.ai_cap_cents))}%</span></div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: C.rule }}>
            <div className="h-full" style={{ width: `${Math.min(100, (100 * (a.ai_used_cents || 0)) / a.ai_cap_cents)}%`, background: (a.ai_used_cents || 0) >= a.ai_cap_cents ? C.redpen : C.green }} />
          </div>
        </div>
      )}
      {!CONFIG.aiUrl ? (
        <p className="text-sm" style={{ color: C.soft }}>Billing isn't set up on this site yet.</p>
      ) : !a.is_owner ? (
        <p className="text-sm" style={{ color: C.soft }}>Only the teacher who started this homeschool can change the plan.</p>
      ) : (
        <>
          {paying && (
            <button className={btn + " w-full mb-2"} style={{ background: C.ink, color: C.white }} disabled={!!busy}
              onClick={() => goStripe("/billing/portal", {}, setErr, setBusy)}>{busy ? "Opening…" : a.status === "past_due" ? "Update my card" : "Change plan, update card, or cancel"}</button>
          )}
          {canChoose && <PlanCompare current={null} busy={busy} onChoose={(plan, interval) => goStripe("/billing/checkout", { plan, interval }, setErr, setBusy)} />}
          {a.has_billing && !paying && (
            <button className="text-sm underline mt-2" style={{ color: C.soft }} disabled={!!busy} onClick={() => goStripe("/billing/portal", {}, setErr, setBusy)}>Past invoices and receipts</button>
          )}
        </>
      )}
      {err && <p className="text-sm mt-2" style={{ color: C.redpen }}>{err}</p>}
      {!compact && a.status !== "comp" && <p className="text-xs mt-3 leading-relaxed" style={{ color: C.soft }}>{CANCEL_POLICY}</p>}
    </div>
  );
}

/* ---------- banner above the app ---------- */
export function AccountBanner({ account, isTeacher, onOpenBilling, onDownload }) {
  const [hidden, setHidden] = useState(false);
  if (!account || !isTeacher || hidden) return null;
  const a = account;
  let tone = "warn", text = null, action = null;
  if (a.access === "readonly") {
    tone = "bad";
    text = <>Your {a.status === "trialing" ? "free trial" : "plan"} has ended. You can look and download until <strong>{fmt(a.grace_until)}</strong>; changes aren't saved.</>;
    action = (
      <>
        <button className="underline font-semibold" onClick={onDownload}>Download my records</button>
        {a.is_owner && <button className="underline font-semibold" onClick={onOpenBilling}>Choose a plan</button>}
      </>
    );
  } else if (a.status === "past_due") {
    tone = "bad"; text = <>Your last payment didn't go through.</>;
    action = a.is_owner && <button className="underline font-semibold" onClick={onOpenBilling}>Update my card</button>;
  } else if (a.status === "trialing" && daysLeft(a.trial_ends_at) <= 5) {
    text = <>Free trial: {daysLeft(a.trial_ends_at)} {daysLeft(a.trial_ends_at) === 1 ? "day" : "days"} left.</>;
    action = a.is_owner && <button className="underline font-semibold" onClick={onOpenBilling}>Choose a plan</button>;
  } else if (a.status === "active" && a.cancel_at && daysLeft(a.cancel_at) <= 14) {
    text = <>Your plan ends {fmt(a.cancel_at)}.</>;
    action = a.is_owner && <button className="underline font-semibold" onClick={onOpenBilling}>Keep my plan</button>;
  }
  if (!text) return null;
  return (
    <div className="hs-gate px-4 py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-1" role="status"
      style={{ background: tone === "bad" ? "#FBE9E7" : "#FFF6D6", color: C.ink, borderBottom: `1px solid ${tone === "bad" ? C.redpen : C.pencil}` }}>
      <span className="flex-1 min-w-0">{text}</span>
      <span className="flex gap-3">{action}</span>
      {tone !== "bad" && <button aria-label="Hide" className="px-1" onClick={() => setHidden(true)}>×</button>}
    </div>
  );
}

/* ---------- full-screen sheet for billing (#/billing and the banner) ---------- */
export function BillingSheet({ account, onClose, thanks }) {
  return (
    <div className="hs-gate fixed inset-0 z-50 flex items-end sm:items-center justify-center p-3" style={{ background: "rgba(27,42,74,0.45)" }} onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl p-5 overflow-y-auto" style={{ background: C.white, maxHeight: "92vh" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-xl font-bold" style={{ color: C.ink }}>Your plan</h2>
          <button aria-label="Close" className="text-2xl px-2" style={{ color: C.ink }} onClick={onClose}>×</button>
        </div>
        {thanks && (
          <p className="mb-3 rounded-lg p-3" style={{ background: "#E8F4EC", color: C.ink }}>
            {["active", "past_due"].includes(account?.status) ? "Thank you! Your plan is active." : "Thank you! Finishing up with Stripe… this takes a few seconds."}
          </p>
        )}
        <BillingPanel account={account} />
      </div>
    </div>
  );
}

/* ---------- paused account ---------- */
export function LockedScreen({ account, onSignOut, onDownloadNote }) {
  return (
    <div className="hs-gate min-h-screen px-4 py-10" style={{ background: C.paper }}>
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-2" style={{ color: C.ink }}>Your homeschool is paused</h1>
        <p className="mb-6 leading-relaxed" style={{ color: C.ink }}>
          Your {account.status === "trialing" ? "free trial" : "plan"} has ended. Your records are safe until <strong>{fmt(account.delete_after)}</strong>.
          {account.is_owner ? " Choose a plan and everything comes back just as you left it." : " Ask the teacher who started this homeschool to choose a plan, and everything comes back just as you left it."}
        </p>
        {account.is_owner && (
          <div className="rounded-xl p-4 mb-6" style={{ background: C.white, border: `1px solid ${C.rule}` }}>
            <BillingPanel account={account} compact />
          </div>
        )}
        <div className="rounded-xl p-4 mb-6" style={{ background: C.white, border: `1px solid ${C.rule}` }}>
          <h2 className="font-bold mb-2" style={{ color: C.ink }}>Questions?</h2>
          <HelpContact />
        </div>
        <button className="underline" style={{ color: C.soft }} onClick={onSignOut}>Sign out</button>
        {onDownloadNote}
      </div>
    </div>
  );
}

/* ---------- contact form for members ---------- */
export function HelpContact() {
  const [topic, setTopic] = useState("Question");
  const [body, setBody] = useState("");
  const [state, setState] = useState("");
  const [err, setErr] = useState("");
  async function send(e) {
    e.preventDefault(); setState("sending"); setErr("");
    try { await workerFetch("/support", { topic, body: body.trim() }); setState("sent"); setBody(""); }
    catch (x) { setErr(x.message); setState(""); }
  }
  if (state === "sent") return <p style={{ color: C.green }}>Thanks. Your message was sent, and we'll reply by email. <button className="underline" style={{ color: C.ink }} onClick={() => setState("")}>Send another</button></p>;
  return (
    <form onSubmit={send}>
      <label className="block text-sm font-semibold mb-1" style={{ color: C.ink }}>About
        <select className="block w-full rounded-md border px-3 py-2 mt-1 font-normal" style={{ borderColor: "#C3D3EA" }} value={topic} onChange={(e) => setTopic(e.target.value)}>
          {["Question", "Something isn't working", "Billing", "Idea or request"].map((t) => <option key={t}>{t}</option>)}
        </select>
      </label>
      <label className="block text-sm font-semibold mb-2 mt-2" style={{ color: C.ink }}>Message
        <textarea required rows={4} maxLength={5000} className="block w-full rounded-md border px-3 py-2 mt-1 font-normal" style={{ borderColor: "#C3D3EA" }} value={body} onChange={(e) => setBody(e.target.value)}
          placeholder={topic === "Something isn't working" ? "What were you doing, and what happened?" : ""} />
      </label>
      {err && <p className="text-sm mb-2" style={{ color: C.redpen }}>{err}{BRAND.contactEmail ? <> You can also email <a className="underline" href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a>.</> : null}</p>}
      <button className={btn} style={{ background: C.ink, color: C.white }} disabled={state === "sending" || body.trim().length < 3}>{state === "sending" ? "Sending…" : "Send"}</button>
    </form>
  );
}

/* ---------- send app errors to the admin portal ---------- */
let installed = false;
export function installErrorReporting() {
  if (installed || !supabase) return;
  installed = true;
  const seen = new Set();
  let sent = 0;
  const report = (message, stack) => {
    const m = String(message || "").slice(0, 500);
    if (!m || seen.has(m) || sent >= 15) return;
    if (/ResizeObserver|Script error\.?$|extension|Non-Error promise rejection/i.test(m)) return; // browser noise, not our bugs
    seen.add(m); sent++;
    supabase.rpc("log_client_error", { p_message: m, p_stack: String(stack || "").slice(0, 4000), p_url: window.location.href.split("#")[0] + window.location.hash.split("?")[0], p_agent: navigator.userAgent }).then(() => {}, () => {});
  };
  window.addEventListener("error", (e) => report(e.message, e.error?.stack));
  window.addEventListener("unhandledrejection", (e) => report(e.reason?.message || String(e.reason), e.reason?.stack));
  window.hsReportError = report;
}

// Keep the account status fresh: on load, when the app comes back to the foreground, and every 10 minutes
export function useAccount(enabled) {
  const [account, setAccount] = useState(null);
  // If the billing database update hasn't been run yet, carry on with full access instead of getting stuck
  const load = () => supabase.rpc("my_account").then(({ data, error }) => {
    if (data) setAccount(data);
    else if (error && /my_account|function|schema cache|404/i.test(`${error.message} ${error.code || ""}`)) setAccount((a) => a || { access: "full", missing: true });
  }, () => setAccount((a) => a || { access: "full", missing: true }));
  useEffect(() => {
    if (!enabled || !supabase) return;
    load();
    const vis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("hs-account-changed", load);
    const t = setInterval(load, 10 * 60 * 1000);
    return () => { document.removeEventListener("visibilitychange", vis); window.removeEventListener("hs-account-changed", load); clearInterval(t); };
  }, [enabled]);
  return [account, load];
}
