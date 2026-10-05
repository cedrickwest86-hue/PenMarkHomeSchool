// Public home page, live demo, and policy pages. The "pictures" are the real app screens,
// rendered with a sample family, so they always match what customers actually get.
import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND } from "./brand.js";
import { makeDemoData } from "./demoData.js";
import HomeschoolTracker, { TodayView, MonthView, StudentApp, Compliance, ProgressView, Row, todayISO, reportCardHTML } from "./Tracker.jsx";
import { setDemoMode } from "./platform.js";

const C = { paper: "#FBFCFE", rule: "#D6E4F5", margin: "#E9A3A3", ink: "#1B2A4A", soft: "#5B6B88", pencil: "#F2B705", redpen: "#C8322B", white: "#FFFFFF", green: "#2F7D4F" };
const ruled = {
  backgroundColor: C.paper,
  backgroundImage: `linear-gradient(to right, transparent 28px, ${C.margin} 28px, ${C.margin} 29px, transparent 29px), repeating-linear-gradient(to bottom, transparent 0, transparent 31px, ${C.rule} 31px, ${C.rule} 32px)`,
};
const FONT = `@import url('https://fonts.googleapis.com/css2?family=Andika:wght@400;700&display=swap');
.hs-site, .hs-site *, .hs-root, .hs-root input, .hs-root select, .hs-root textarea, .hs-root button { font-family: 'Andika', 'Trebuchet MS', system-ui, sans-serif; }
.hs-site a:focus-visible, .hs-site button:focus-visible, .hs-site summary:focus-visible { outline: 3px solid ${C.pencil}; outline-offset: 2px; }
.hs-site summary { list-style: none; } .hs-site summary::-webkit-details-marker { display: none; }
@media (prefers-reduced-motion: no-preference) { .hs-rise { animation: hsRise .6s ease-out both; } @keyframes hsRise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } } }`;
const noop = () => {};
const go = (route) => { window.location.hash = route ? `#/${route}` : "#/"; window.scrollTo(0, 0); };

function Logo({ size = 28 }) {
  return (
    <span className="inline-flex items-center gap-2 font-bold" style={{ color: C.ink, fontSize: size * 0.8 }}>
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <rect x="3" y="3" width="26" height="26" rx="5" fill={C.white} stroke={C.ink} strokeWidth="2.5" />
        <line x1="10" y1="4" x2="10" y2="28" stroke={C.margin} strokeWidth="2" />
        <path d="M13 17 l4 4 l8 -10" fill="none" stroke={C.redpen} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {BRAND.name}
      {BRAND.beta && <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: C.pencil, color: C.ink, fontSize: 11 }}>BETA</span>}
    </span>
  );
}

// A device frame that shows a live, non-clickable app screen, scaled to fit whatever screen it's on
function Device({ kind = "tablet", scale: maxScale = 0.6, height, children, label }) {
  const wrap = useRef(null);
  const inner = useRef(null);
  const w = kind === "phone" ? 390 : 760;
  const h = height || (kind === "phone" ? 760 : 620);
  const [scale, setScale] = useState(maxScale);
  useEffect(() => {
    inner.current?.setAttribute("inert", "");
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => setScale(Math.min(maxScale, el.clientWidth / w));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxScale, w]);
  const radius = kind === "phone" ? 34 : 22;
  return (
    <figure className="mx-auto w-full" style={{ maxWidth: w * maxScale }}>
      <div ref={wrap} style={{ width: "100%", height: h * scale, overflow: "hidden", borderRadius: radius * scale + 6 }}>
        <div ref={inner} aria-hidden="true" className="hs-root"
          style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: "top left", boxSizing: "border-box", border: `${kind === "phone" ? 12 : 14}px solid ${C.ink}`, borderRadius: radius, overflow: "hidden", background: C.paper, pointerEvents: "none", userSelect: "none" }}>
          <div style={{ height: "100%", overflow: "hidden", position: "relative", transform: "translateZ(0)" }}>{children}</div>
        </div>
      </div>
      {label && <figcaption className="text-center text-sm mt-3" style={{ color: C.soft }}>{label}</figcaption>}
    </figure>
  );
}

function useDemo() { return useMemo(() => makeDemoData(), []); }

function Hero({ data }) {
  return (
    <section style={ruled} className="border-b-2" >
      <div className="max-w-6xl mx-auto px-6 pt-10 pb-14 grid md:grid-cols-2 gap-10 items-center">
        <div className="hs-rise min-w-0">
          <p className="font-bold mb-3 text-sm tracking-wide uppercase" style={{ color: C.redpen }}>For families who homeschool by the lesson plan</p>
          <h1 className="font-bold leading-tight mb-5" style={{ color: C.ink, fontSize: "clamp(2rem, 4.6vw, 3.3rem)" }}>
            {BRAND.tagline.split(" ").slice(0, -3).join(" ")}{" "}
            <span className="relative inline-block">
              {BRAND.tagline.split(" ").slice(-3).join(" ")}
              <svg className="absolute left-0 -bottom-2 w-full" height="12" viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true">
                <path d="M2 8 C 50 2, 120 12, 198 4" fill="none" stroke={C.redpen} strokeWidth="3.5" strokeLinecap="round" />
              </svg>
            </span>
          </h1>
          <p className="text-lg leading-relaxed mb-7" style={{ color: C.ink, maxWidth: 520 }}>{BRAND.short}</p>
          <div className="flex flex-wrap gap-3">
            <button onClick={() => go("demo")} className="rounded-lg px-6 py-3 font-bold text-lg" style={{ background: C.pencil, color: C.ink, boxShadow: `3px 3px 0 ${C.ink}` }}>Try the live demo</button>
            <button onClick={() => go("signup")} className="rounded-lg px-6 py-3 font-bold text-lg" style={{ background: C.ink, color: C.white }}>{BRAND.beta ? "Join the free beta" : "Start free"}</button>
          </div>
          <p className="text-sm mt-4" style={{ color: C.soft }}>No credit card. The demo needs no sign-up.</p>
        </div>
        <div className="hs-rise min-w-0" style={{ animationDelay: ".15s" }}>
          <Device kind="tablet" scale={0.66} label="The teacher's day: every child's lessons, what's turned in, and what's coming up">
            <div className="px-5 pt-5"><TodayView data={data} activeStudents={data.students} day={todayISO()} setDay={noop} onToggle={noop} onEdit={noop} onAttend={noop} onNew={noop} onShift={noop} onAddEvent={noop} onEditEvent={noop} onPrint={noop} /></div>
          </Device>
        </div>
      </div>
    </section>
  );
}

function Feature({ eyebrow, title, children, picture, flip }) {
  return (
    <div className="grid md:grid-cols-2 gap-10 items-center py-14 border-b" style={{ borderColor: C.rule }}>
      <div className={`min-w-0 ${flip ? "md:order-2" : ""}`}>
        <p className="font-bold text-sm uppercase tracking-wide mb-2" style={{ color: C.redpen }}>{eyebrow}</p>
        <h3 className="text-2xl md:text-3xl font-bold mb-4 leading-snug" style={{ color: C.ink }}>{title}</h3>
        <div className="text-lg leading-relaxed space-y-3" style={{ color: C.ink }}>{children}</div>
      </div>
      <div className={`min-w-0 ${flip ? "md:order-1" : ""}`}>{picture}</div>
    </div>
  );
}

function RescheduleVisual() {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Mon"];
  const before = ["21", "22", "23", "24", "25", "26"];
  const after = ["21", "22", "trip", "23", "24", "25"];
  const Cell = ({ v, moved }) => v === "trip"
    ? <div className="rounded-md py-3 text-center text-xs sm:text-sm font-bold flex items-center justify-center" style={{ background: C.green, color: C.white }}>Trip</div>
    : <div className="rounded-md py-3 text-center font-bold text-sm sm:text-base" style={{ background: moved ? "#FFF6D6" : C.white, border: `1.5px solid ${moved ? C.pencil : C.rule}`, color: C.ink }}><span className="hidden sm:inline">Lesson </span>{v}</div>;
  return (
    <div className="rounded-2xl p-5" style={{ background: C.white, border: `2px solid ${C.ink}`, boxShadow: `6px 6px 0 ${C.rule}` }} aria-label="Before and after adding a field trip: lessons 23 through 26 each move one school day later">
      {[["Before", before], ["After adding a field trip", after]].map(([label, row], r) => (
        <div key={label} className={r ? "mt-5" : ""}>
          <div className="text-sm font-bold mb-2" style={{ color: r ? C.green : C.soft }}>{label}</div>
          <div className="grid grid-cols-6 gap-1 sm:gap-1.5">
            {days.map((d, i) => <div key={i} className="text-center text-xs mb-1" style={{ color: C.soft }}>{d}</div>)}
            {row.map((v, i) => <Cell key={i} v={v} moved={r === 1 && i >= 3} />)}
          </div>
        </div>
      ))}
      <p className="text-sm mt-4" style={{ color: C.soft }}>Every subject stays one lesson per school day, in order. Delete the trip and it all slides back.</p>
    </div>
  );
}

function GradingVisual() {
  return (
    <div className="rounded-2xl p-5 mx-auto" style={{ background: "#FDF6F5", border: `2px solid ${C.ink}`, boxShadow: `6px 6px 0 ${C.rule}`, maxWidth: 440 }}>
      <div className="font-bold mb-3" style={{ color: C.redpen }}>Grade: Arithmetic Quiz 3</div>
      <div className="grid grid-cols-2 gap-2 mb-3 text-sm">
        <div className="rounded-lg p-3 text-center" style={{ background: C.white, border: `1px solid ${C.rule}`, color: C.ink }}>📷 Caleb's work</div>
        <div className="rounded-lg p-3 text-center" style={{ background: C.white, border: `1px solid ${C.rule}`, color: C.ink }}>🔑 Answer key</div>
      </div>
      <div className="rounded-lg p-3" style={{ background: C.white, border: `1.5px solid ${C.pencil}` }}>
        <div className="flex justify-between font-bold" style={{ color: C.ink }}><span>Suggested: 96% A</span><span className="text-sm font-normal" style={{ color: C.soft }}>4 points missed</span></div>
        <div className="text-sm py-1.5 border-b" style={{ borderColor: C.rule, color: C.ink }}><strong>#6</strong> wrote "48", key says "84" <span style={{ color: C.redpen }}>−2</span></div>
        <div className="text-sm py-1.5 border-b" style={{ borderColor: C.rule, color: C.ink }}><strong>#11</strong> wrote "1/3", key says "2/3" <span style={{ color: C.redpen }}>−2</span></div>
        <div className="text-sm py-1.5" style={{ color: C.soft }}><strong>#14</strong> couldn't read, please check</div>
        <div className="mt-3 rounded-lg py-2 text-center font-bold" style={{ background: C.ink, color: C.white }}>Use 96%</div>
      </div>
      <p className="text-xs mt-3" style={{ color: C.soft }}>You always confirm the grade. Or type points missed and it does the math the Abeka way.</p>
    </div>
  );
}

function ReportVisual({ data }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.setAttribute("inert", ""); }, []);
  const html = useMemo(() => reportCardHTML(data, data.students[1], 0, "Caleb has grown into a careful, steady worker this term. His arithmetic quizzes show real mastery, and his oral reading has gained expression. Next term we'll focus on finishing language review before each test."), [data]);
  return (
    <figure className="mx-auto" style={{ width: 400, maxWidth: "100%" }}>
      <div ref={ref} aria-hidden="true" style={{ height: 470, overflow: "hidden", borderRadius: 6, border: `2px solid ${C.ink}`, boxShadow: `6px 6px 0 ${C.rule}`, background: C.white, transform: "rotate(-1.2deg)" }}>
        <iframe title="Sample report card" srcDoc={html} sandbox="" style={{ width: 760, height: 900, border: 0, transform: "scale(0.52)", transformOrigin: "top left", pointerEvents: "none" }} />
      </div>
      <figcaption className="text-center text-sm mt-4" style={{ color: C.soft }}>A real report card, generated from the sample family's grades</figcaption>
    </figure>
  );
}

function Features({ data }) {
  const caleb = data.students[1], grace = data.students[0];
  const row = (a) => <Row key={a.id} a={a} student={data.students.find((s) => s.id === a.studentId)} showStudent onToggle={noop} onEdit={noop} />;
  return (
    <section id="features" className="max-w-6xl mx-auto px-6">
      <h2 className="text-center text-3xl md:text-4xl font-bold pt-16" style={{ color: C.ink }}>Everything a homeschool teacher juggles, in one place</h2>
      <Feature eyebrow="Plan the year" title="Lesson 9 today, lesson 10 tomorrow. Planned for the whole year in a minute."
        picture={<Device kind="tablet" scale={0.62} height={700} label="The month view: lessons, swim lessons, a field trip, and test days"><div className="p-5"><MonthView data={data} sids={data.students.map((s) => s.id)} mode="student" renderRow={row} /></div></Device>}>
        <p>Pick each child's subjects and it lays out one lesson per subject per school day, skipping weekends and holidays, just like a numbered lesson plan.</p>
        <p>Already have plans? Import a spreadsheet, snap photos of your lesson plan pages, or photograph a book's table of contents and the chapters are spread across the right days.</p>
      </Feature>
      <Feature flip eyebrow="Real life happens" title="Add a field trip. The schedule moves itself." picture={<RescheduleVisual />}>
        <p>Field trips, sick days, holidays, swim lessons, co-op: put them on the calendar and every child's lessons slide to the next school day automatically.</p>
        <p>Subjects that meet only some days, like Health on Mondays, Wednesdays, and Fridays, stay on their days.</p>
      </Feature>
      <Feature eyebrow="Grade faster" title="Snap the work and the answer key. Get a suggested grade." picture={<GradingVisual />}>
        <p>Kids photograph their work and tap Turn it in. You see it waiting, compare it with the answer key, and confirm the score.</p>
        <p>Optional AI helpers write practice questions from a study page, give you teaching ideas for tomorrow's lesson, and draft report card comments from real grades.</p>
      </Feature>
      <Feature flip eyebrow="For the kids" title="Each child gets their own simple view, with no email needed."
        picture={<Device kind="phone" scale={0.62} label="Grace's view on the family tablet"><StudentApp data={data} student={grace} onToggle={noop} onAttach={noop} onSwitch={noop} flash={noop} onAddReading={noop} onRemoveReading={noop} onTimer={noop} onPractice={noop} /></Device>}>
        <p>Connect a family tablet once with a code. Kids tap their name to see today's work, due dates, a calendar, practice questions, and memory verse drills.</p>
        <p>They earn stars for on-time work toward rewards you choose. Answer keys and teacher tools never appear on their screen.</p>
      </Feature>
      <Feature eyebrow="Records without the paperwork" title="Your state's requirements, tracked as you go."
        picture={<Device kind="tablet" scale={0.62} height={760} label="Florida requirements and Caleb's progress by subject"><div className="p-5"><Compliance data={data} activeStudents={[caleb]} onCheck={noop} /><ProgressView data={data} activeStudents={[caleb]} /></div></Device>}>
        <p>Choose your state and see its notice, attendance, subjects, and assessment rules, with a checklist for the year. All 50 states and DC.</p>
        <p>Attendance, hours, a reading log, and dated activity logs build themselves, ready for an evaluator, a portfolio review, or a transcript.</p>
      </Feature>
      <Feature flip eyebrow="Ready to hand over" title="Report cards, portfolios, and transcripts in one tap." picture={<ReportVisual data={data} />}>
        <p>Report cards by grading period, a year-end portfolio with work samples, and a high school transcript with credits and GPA.</p>
        <p>Download, print, or save as PDF. Back up everything anytime, and it's always yours.</p>
      </Feature>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    ["Add your children", "Pick each child's grade, and their subjects fill in. Change them anytime."],
    ["Plan the year", "Lay out lessons by number, import your plans, or build from a book's table of contents."],
    ["Teach, check, record", "Kids turn work in on their tablet, you grade, and your records build themselves."],
  ];
  return (
    <section id="how" style={ruled} className="border-y-2 py-16">
      <div className="max-w-5xl mx-auto px-6">
        <h2 className="text-center text-3xl md:text-4xl font-bold mb-10" style={{ color: C.ink }}>Up and running before lunch</h2>
        <ol className="grid md:grid-cols-3 gap-6">
          {steps.map(([t, d], i) => (
            <li key={t} className="rounded-2xl p-6" style={{ background: C.white, border: `2px solid ${C.ink}` }}>
              <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg mb-3" style={{ background: C.pencil, color: C.ink }}>{i + 1}</div>
              <h3 className="text-xl font-bold mb-2" style={{ color: C.ink }}>{t}</h3>
              <p className="leading-relaxed" style={{ color: C.ink }}>{d}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="pricing" className="max-w-3xl mx-auto px-6 py-16 text-center">
      <h2 className="text-3xl md:text-4xl font-bold mb-4" style={{ color: C.ink }}>{BRAND.beta ? "Free during the beta" : "Pricing"}</h2>
      <div className="rounded-2xl p-8" style={{ background: C.white, border: `2px solid ${C.ink}`, boxShadow: `6px 6px 0 ${C.pencil}` }}>
        <p className="text-lg leading-relaxed mb-6" style={{ color: C.ink }}>{BRAND.betaPricing}</p>
        <ul className="text-left inline-block mb-6 space-y-2" style={{ color: C.ink }}>
          {["Unlimited children", "Teacher and student views", "Calendar, planning, and automatic rescheduling", "Grading, reports, portfolios, and transcripts", "State requirement tracking for all 50 states and DC"].map((x) => <li key={x}>✓ {x}</li>)}
        </ul>
        <div><button onClick={() => go("signup")} className="rounded-lg px-6 py-3 font-bold text-lg" style={{ background: C.ink, color: C.white }}>{BRAND.beta ? "Join the free beta" : "Start free"}</button></div>
      </div>
    </section>
  );
}

function Faq() {
  const items = [
    ["Do I have to use Abeka?", "No. It's built around numbered daily lesson plans like Abeka's, and it works with any curriculum you can list by lesson or day. Subjects and schedules are fully editable."],
    ["Do my children need an email or their own account?", "No. You connect a family tablet once with a code. Kids just tap their name."],
    ["Is our information private?", "Each family's information is kept separate and locked to your account. Kids' tablets can't see answer keys or teacher tools. We don't sell your information or show ads."],
    ["How do the AI tools work?", "They're optional helpers for the teacher: suggested grades, practice questions, teaching ideas, and comment drafts. You review everything before your children see it, and kids never chat with an AI."],
    ["Which states does it cover?", "Plain-language summaries of the homeschool requirements for all 50 states and DC, with a yearly checklist. They're a guide, not legal advice, so check your state's official sources too."],
    ["Can I get my information out?", "Anytime. Download a complete backup, a spreadsheet log of all work, report cards, portfolios, and transcripts."],
  ];
  return (
    <section id="faq" className="max-w-3xl mx-auto px-6 pb-16">
      <h2 className="text-center text-3xl md:text-4xl font-bold mb-8" style={{ color: C.ink }}>Questions</h2>
      {items.map(([q, a]) => (
        <details key={q} className="border-b py-4" style={{ borderColor: C.rule }}>
          <summary className="cursor-pointer text-lg font-bold flex justify-between gap-4" style={{ color: C.ink }}>{q}<span aria-hidden="true" style={{ color: C.redpen }}>+</span></summary>
          <p className="mt-3 leading-relaxed" style={{ color: C.ink }}>{a}</p>
        </details>
      ))}
    </section>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b-2" style={{ background: "rgba(251,252,254,.95)", borderColor: C.ink, backdropFilter: "blur(6px)" }}>
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-4">
        <button onClick={() => go("")} aria-label={`${BRAND.name} home`}><Logo /></button>
        <nav className="hidden md:flex gap-6 font-semibold" style={{ color: C.ink }} aria-label="Sections">
          <a href="#features" onClick={(e) => { e.preventDefault(); document.getElementById("features")?.scrollIntoView({ behavior: "smooth" }); }}>Features</a>
          <a href="#how" onClick={(e) => { e.preventDefault(); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); }}>How it works</a>
          <a href="#pricing" onClick={(e) => { e.preventDefault(); document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" }); }}>Pricing</a>
          <a href="#faq" onClick={(e) => { e.preventDefault(); document.getElementById("faq")?.scrollIntoView({ behavior: "smooth" }); }}>Questions</a>
        </nav>
        <div className="flex gap-2">
          <button onClick={() => go("tablet")} className="hidden sm:inline-block rounded-lg px-3 py-2 font-semibold text-sm" style={{ color: C.ink }}>Student tablet</button>
          <button onClick={() => go("signin")} className="rounded-lg px-4 py-2 font-semibold text-sm" style={{ border: `1.5px solid ${C.ink}`, color: C.ink }}>Sign in</button>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t-2 py-10" style={{ borderColor: C.ink, background: C.white }}>
      <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row justify-between gap-6 text-sm" style={{ color: C.soft }}>
        <div>
          <Logo size={22} />
          <p className="mt-2">© {new Date().getFullYear()} {BRAND.company || BRAND.name}. All rights reserved.</p>
          <p className="mt-1 max-w-md">Abeka is a trademark of its owner. {BRAND.name} is an independent product and is not affiliated with or endorsed by Abeka.</p>
        </div>
        <nav className="flex flex-wrap gap-5 font-semibold" style={{ color: C.ink }} aria-label="Footer">
          <a href="#/privacy">Privacy</a><a href="#/terms">Terms</a><a href="#/signin">Sign in</a><a href="#/tablet">Student tablet</a>
          {BRAND.contactEmail && <a href={`mailto:${BRAND.contactEmail}`}>Contact</a>}
        </nav>
      </div>
    </footer>
  );
}

export default function Landing() {
  const data = useDemo();
  return (
    <div className="hs-site" style={{ background: C.paper, overflowX: "hidden" }}>
      <style>{FONT}</style>
      <SiteHeader />
      <main>
        <Hero data={data} />
        <Features data={data} />
        <HowItWorks />
        <Pricing />
        <Faq />
      </main>
      <SiteFooter />
    </div>
  );
}

/* ---------- Live demo: the full app with the sample family, saved only in this browser tab ---------- */
function memoryStorage(seed) {
  const mem = { "hs-tracker:data": JSON.stringify(seed) };
  return {
    async get(k) { return k in mem ? { key: k, value: mem[k] } : null; },
    async set(k, v) { mem[k] = v; return { key: k, value: v }; },
    async delete(k) { delete mem[k]; return { key: k, deleted: true }; },
    async list() { return { keys: Object.keys(mem) }; },
    subscribe() { return () => {}; },
  };
}
export function Demo() {
  const [view, setView] = useState("teacher");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const prev = window.storage;
    window.storage = memoryStorage(makeDemoData());
    setDemoMode(true); setReady(true);
    return () => { window.storage = prev; setDemoMode(false); };
  }, []);
  if (!ready) return null;
  return (
    <div className="hs-site">
      <style>{FONT}</style>
      <div className="px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-sm" style={{ background: C.pencil, color: C.ink }} role="region" aria-label="Demo controls">
        <span><strong>Live demo.</strong> Try anything; nothing is saved. AI tools work in a real account.</span>
        <span className="flex flex-wrap gap-2">
          <button onClick={() => setView(view === "teacher" ? "student" : "teacher")} className="rounded-md px-3 py-1 font-bold" style={{ background: C.white, color: C.ink }}>
            {view === "teacher" ? "See the kids' tablet" : "See the teacher view"}
          </button>
          <button onClick={() => go("signup")} className="rounded-md px-3 py-1 font-bold" style={{ background: C.ink, color: C.white }}>{BRAND.beta ? "Join the beta" : "Start free"}</button>
          <button onClick={() => go("")} className="rounded-md px-3 py-1 font-bold underline">Home</button>
        </span>
      </div>
      <HomeschoolTracker key={view} deviceRole={view} />
    </div>
  );
}

/* ---------- Privacy and terms (plain-language beta drafts) ---------- */
export function PolicyPage({ which }) {
  const name = BRAND.name;
  const contact = BRAND.contactEmail ? <a className="underline" href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a> : "the contact address on our website";
  const privacy = (
    <>
      <h1>Privacy</h1>
      <p>{name} helps families plan and record their homeschool. This page explains, in plain language, what we keep and why.</p>
      <h2>What we keep</h2>
      <ul>
        <li>The teacher's email address and password (stored securely by our sign-in provider; we never see your password).</li>
        <li>What you enter: your homeschool's name; your children's first names, grades, and subjects; lessons, grades, attendance, reading logs, calendar events, and notes.</li>
        <li>Photos and files you or your children upload, like completed work or answer keys.</li>
      </ul>
      <h2>Children</h2>
      <p>Children use {name} on a device the parent connects with a code. We don't ask children for email addresses or other contact information. A parent controls everything stored about their children and can remove it at any time.</p>
      <h2>How it's used</h2>
      <p>Only to run {name} for your family: showing your plans, syncing your devices, and producing your reports. We don't sell your information, show ads, or share it for marketing.</p>
      <h2>Optional AI tools</h2>
      <p>When a teacher chooses to use an AI tool (for example, suggesting a grade from a photo), the related text or images are sent to our AI provider, Anthropic, to produce the result. Children never use the AI tools directly.</p>
      <h2>Where it's stored</h2>
      <p>Your information is stored with our database provider, Supabase, and is separated so that only your family's signed-in teachers and connected devices can reach it.</p>
      <h2>Your choices</h2>
      <p>You can download a full backup at any time. To delete your account and everything in it, contact us at {contact}.</p>
    </>
  );
  const terms = (
    <>
      <h1>Terms</h1>
      <p>{name} is in beta. It's offered free while we test, as-is, and it may change. We'll give notice before any paid plans begin.</p>
      <h2>Your responsibilities</h2>
      <ul>
        <li>You're responsible for meeting your state's homeschool requirements. State summaries in {name} are a helpful guide, not legal advice.</li>
        <li>Keep your sign-in and tablet codes private, and keep your own backups.</li>
        <li>Upload only content you have the right to use.</li>
      </ul>
      <h2>Our responsibilities</h2>
      <p>We work to keep {name} available and your information safe and private, but we can't promise it will always be error-free or uninterrupted.</p>
      <h2>Questions</h2>
      <p>Contact us at {contact}.</p>
    </>
  );
  return (
    <div className="hs-site min-h-screen" style={{ background: C.paper }}>
      <style>{FONT + `.hs-policy h1{font-size:2rem;font-weight:700;margin:0 0 1rem} .hs-policy h2{font-size:1.25rem;font-weight:700;margin:1.75rem 0 .5rem} .hs-policy p,.hs-policy li{line-height:1.7;margin:.5rem 0} .hs-policy ul{list-style:disc;padding-left:1.4rem}`}</style>
      <SiteHeader />
      <article className="hs-policy max-w-2xl mx-auto px-6 py-12" style={{ color: C.ink }}>
        {which === "privacy" ? privacy : terms}
        <p className="mt-8 text-sm" style={{ color: C.soft }}>Beta version, {new Date().getFullYear()}.</p>
      </article>
      <SiteFooter />
    </div>
  );
}
