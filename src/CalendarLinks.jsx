// Calendar subscription links for the teacher's Setup screen
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { supabase, CONFIG } from "./platform.js";

const C = { ink: "#1B2A4A", soft: "#5B6B88", rule: "#D6E4F5", pencil: "#F2B705", redpen: "#C8322B", white: "#FFFFFF" };
const btn = "inline-flex items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold focus:outline-none focus:ring-2";
const feedBase = () => (CONFIG.aiUrl ? CONFIG.aiUrl.replace(/\/$/, "") + "/calendar/" : "");

function Qr({ url, who }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(url, { width: 220, margin: 1, color: { dark: C.ink, light: "#FFFFFF" } }).then(setSrc).catch(() => {});
  }, [url]);
  return (
    <div className="text-center my-2">
      {src && <img src={src} width={220} height={220} alt={`Code to add ${who} calendar`} className="mx-auto rounded-lg" style={{ border: `1px solid ${C.rule}` }} />}
      <p className="text-xs mt-1" style={{ color: C.soft }}>On the iPhone or iPad, open the Camera and point it here, then tap Subscribe.</p>
    </div>
  );
}

export default function CalendarLinks({ students = [] }) {
  const [feeds, setFeeds] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const base = feedBase();
  const load = () =>
    supabase.rpc("list_calendar_feeds").then(({ data }) => setFeeds(Object.fromEntries((data || []).map((f) => [f.student_id || "", f.token]))));
  useEffect(() => { if (base) load(); }, []);

  if (!base) {
    return (
      <div>
        <h3 className="text-lg font-bold mt-8 mb-1" style={{ color: C.ink }}>Calendar on your devices</h3>
        <p className="text-sm" style={{ color: C.soft }}>Available after the Cloudflare worker is set up (step 5 of the setup guide).</p>
      </div>
    );
  }

  const rows = [
    { id: "", label: "Whole family", sub: "For you: everyone's work, tests, and events" },
    ...students.map((s) => ({ id: s.id, label: s.name, sub: `For ${s.name}'s iPad or phone` })),
  ];
  async function make(id) {
    setBusy(id); setMsg("");
    const { error } = await supabase.rpc("create_calendar_feed", { p_student: id });
    if (error) setMsg(error.message); else { await load(); setOpen(id); }
    setBusy("");
  }
  async function turnOff(id) {
    setBusy(id);
    await supabase.rpc("revoke_calendar_feed", { p_student: id });
    await load(); setOpen(null); setBusy("");
  }
  async function copy(url) {
    try { await navigator.clipboard.writeText(url); setMsg("Link copied."); } catch { setMsg(url); }
  }

  return (
    <div>
      <h3 className="text-lg font-bold mt-8 mb-1" style={{ color: C.ink }}>Calendar on your devices</h3>
      <p className="text-sm mb-3 leading-relaxed" style={{ color: C.ink }}>
        Put school in the calendar app you already use, with reminders: each morning's work at 7:30, and a heads-up at 6 p.m. the evening before tests and due dates. Calendar apps check for changes about once an hour.
      </p>
      {rows.map((r) => {
        const token = feeds?.[r.id];
        const url = token ? base + token + ".ics" : "";
        const webcal = url.replace(/^https?:/, "webcal:");
        return (
          <div key={r.id || "family"} className="py-3 border-b" style={{ borderColor: C.rule }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="font-semibold" style={{ color: C.ink }}>{r.label}</div>
                <div className="text-xs" style={{ color: C.soft }}>{r.sub}</div>
              </div>
              {feeds === null ? (
                <span className="text-sm" style={{ color: C.soft }}>…</span>
              ) : !token ? (
                <button className={btn} style={{ background: C.ink, color: C.white }} disabled={busy === r.id} onClick={() => make(r.id)}>Make link</button>
              ) : (
                <button className={btn} style={{ border: `1.5px solid ${C.ink}`, color: C.ink }} onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {open === r.id ? "Hide" : "Add to a device"}
                </button>
              )}
            </div>
            {token && open === r.id && (
              <div className="mt-3 rounded-lg p-3" style={{ background: "#F3F7FC" }}>
                <div className="flex flex-wrap gap-2 mb-2">
                  <a className={btn} style={{ background: C.ink, color: C.white }} href={webcal}>Add to this device</a>
                  <button className={btn} style={{ border: `1.5px solid ${C.ink}`, color: C.ink }} onClick={() => copy(url)}>Copy link</button>
                </div>
                <Qr url={webcal} who={r.id ? `${r.label}'s` : "the family"} />
                <details className="text-xs mt-2" style={{ color: C.ink }}>
                  <summary className="cursor-pointer font-semibold">How to add it and get reminders</summary>
                  <div className="mt-2 space-y-2 leading-relaxed">
                    <p><strong>iPhone or iPad:</strong> tap Add to this device (or scan the code), then Subscribe. For reminders, go to Settings → Calendar → Accounts → Subscribed Calendars → this calendar, and make sure Remove Alarms is off.</p>
                    <p><strong>Google Calendar (on a computer):</strong> Copy link, then in Google Calendar choose Other calendars → + → From URL and paste it. Google uses its own reminder settings: open the calendar's Settings and set All-day event notifications.</p>
                    <p><strong>Outlook:</strong> Copy link, then Add calendar → Subscribe from web and paste it.</p>
                  </div>
                </details>
                <div className="flex justify-between items-center mt-3">
                  <button className="text-xs underline" style={{ color: C.soft }} disabled={busy === r.id} onClick={() => make(r.id)}>Make a new link (stops the old one)</button>
                  <button className="text-xs underline" style={{ color: C.redpen }} disabled={busy === r.id} onClick={() => turnOff(r.id)}>Turn off</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {msg && <p className="text-sm mt-2 break-all" style={{ color: C.ink }}>{msg}</p>}
      <p className="text-xs mt-2" style={{ color: C.soft }}>Anyone with a link can see that calendar's lessons and events, but never grades, notes, or answer keys.</p>
    </div>
  );
}
