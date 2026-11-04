// Sign-in, family setup, and student tablet pairing. Once signed in, it hands off to the tracker.
import { useEffect, useRef, useState } from "react";
import { supabase, FEATURES } from "./platform.js";
import { createSupabaseStorage, createChildStorage, confirmedRemoved } from "./sync.js";
import CalendarLinks from "./CalendarLinks.jsx";
import HomeschoolTracker from "./Tracker.jsx";
import { BRAND } from "./brand.js";
import Landing, { Demo, PolicyPage } from "./Landing.jsx";

const readRoute = () => window.location.hash.replace(/^#\/?/, "").split(/[?&]/)[0];

const C = { paper: "#FBFCFE", rule: "#D6E4F5", margin: "#E9A3A3", ink: "#1B2A4A", soft: "#5B6B88", pencil: "#F2B705", redpen: "#C8322B", white: "#FFFFFF" };
const ruled = {
  backgroundColor: C.paper,
  backgroundImage: `linear-gradient(to right, transparent 20px, ${C.margin} 20px, ${C.margin} 21px, transparent 21px), repeating-linear-gradient(to bottom, transparent 0, transparent 27px, ${C.rule} 27px, ${C.rule} 28px)`,
};
const input = "w-full rounded-md border px-3 py-2 text-base bg-white focus:outline-none focus:ring-2";
const inputStyle = { borderColor: "#C3D3EA", color: C.ink };
const FONT = `@import url('https://fonts.googleapis.com/css2?family=Andika:wght@400;700&display=swap');
.hs-gate, .hs-gate input, .hs-gate button { font-family: 'Andika', 'Trebuchet MS', system-ui, sans-serif; }
.hs-gate *:focus-visible { outline: 2px solid ${C.pencil}; outline-offset: 2px; }`;

function Button({ kind = "primary", className = "", ...p }) {
  const styles = {
    primary: { background: C.ink, color: C.white },
    pencil: { background: C.pencil, color: C.ink },
    ghost: { background: "transparent", color: C.ink, border: `1.5px solid ${C.ink}` },
    danger: { background: "transparent", color: C.redpen, border: `1.5px solid ${C.redpen}` },
  };
  return <button {...p} className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 font-semibold focus:outline-none focus:ring-2 disabled:opacity-50 ${className}`} style={{ ...styles[kind], ...(p.style || {}) }} />;
}
function Label({ text, children }) {
  return <label className="block mb-3"><span className="block text-sm mb-1" style={{ color: C.soft }}>{text}</span>{children}</label>;
}
function Shell({ title, children }) {
  return (
    <div className="hs-gate min-h-screen" style={ruled}>
      <style>{FONT}</style>
      <div className="max-w-md mx-auto px-6 pt-8 pb-10">
        <a href="#/" className="inline-block text-sm font-semibold underline mb-6" style={{ color: C.ink }}>← {BRAND.name} home</a>
        <h1 className="text-3xl font-bold mb-6" style={{ color: C.ink }}>{title}</h1>
        {children}
      </div>
    </div>
  );
}
const Card = ({ children }) => <div className="rounded-xl p-5" style={{ background: C.white, border: `1.5px solid ${C.ink}` }}>{children}</div>;
const friendly = (e) => {
  const m = e?.message || String(e || "");
  if (/anonymous sign-ins are disabled/i.test(m)) return "Student tablets aren't turned on yet. In Supabase, go to Authentication and allow anonymous sign-ins.";
  if (/invalid login credentials/i.test(m)) return "That email and password didn't match.";
  if (/email not confirmed/i.test(m)) return "Confirm your email first. Check your inbox for the link from Supabase.";
  if (/already (been )?registered|already exists|email_exists/i.test(m)) return "That email already has an account here. Use a different email, or ask the teacher to remove this device and add you by that email instead.";
  if (/rate limit|too many/i.test(m)) return "Too many tries. Wait a minute and try again.";
  if (/failed to fetch|network/i.test(m)) return "Can't reach the server. Check your internet connection.";
  return m.replace(/^.*?:\s(?=[A-Z])/, "") || "Something went wrong. Try again.";
};

function SignIn({ notice, initialTab = "teacher", initialMode = "signin" }) {
  const [tab, setTab] = useState(notice?.tab || initialTab);
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(notice?.text || "");
  const [err, setErr] = useState("");
  const here = window.location.origin + window.location.pathname;

  async function teacher(e) {
    e.preventDefault(); setBusy(true); setErr(""); setMsg("");
    try {
      if (mode === "reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: here });
        if (error) throw error;
        setMsg("Check your email for a link to choose a new password.");
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: here } });
        if (error) throw error;
        if (!data.session) setMsg("Almost done. Check your email and tap the confirmation link, then sign in here.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (e2) { setErr(friendly(e2)); }
    setBusy(false);
  }
  async function withCode(e) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const { error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      const { error: jErr } = await supabase.rpc("join_with_code", { p_code: code.trim() });
      if (jErr) { await supabase.auth.signOut(); throw jErr; }
      window.dispatchEvent(new Event("hs-membership-changed"));
    } catch (e2) { setErr(friendly(e2)); }
    setBusy(false);
  }

  return (
    <Shell title={mode === "signup" && tab === "teacher" ? (BRAND.beta ? "Join the beta" : "Create your account") : "Sign in"}>
      <div className="grid grid-cols-3 mb-4 rounded-lg overflow-hidden" style={{ border: `1.5px solid ${C.ink}` }}>
        {[["teacher", "Teacher"], ["coteacher", "Co-teacher"], ["tablet", "Student tablet"]].map(([id, label]) => (
          <button key={id} onClick={() => { setTab(id); setErr(""); setMsg(""); }} className="py-2 font-semibold focus:outline-none focus:ring-2"
            style={tab === id ? { background: C.ink, color: C.white } : { background: C.white, color: C.ink }}>{label}</button>
        ))}
      </div>
      <Card>
        {tab === "teacher" ? (
          <form onSubmit={teacher}>
            <Label text="Email"><input type="email" required autoComplete="email" className={input} style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} /></Label>
            {mode !== "reset" && (
              <Label text={mode === "signup" ? "Choose a password (8 or more characters)" : "Password"}>
                <input type="password" required minLength={mode === "signup" ? 8 : undefined} autoComplete={mode === "signup" ? "new-password" : "current-password"} className={input} style={inputStyle} value={password} onChange={(e) => setPassword(e.target.value)} />
              </Label>
            )}
            {err && <p className="mb-3" style={{ color: C.redpen }}>{err}</p>}
            {msg && <p className="mb-3" style={{ color: C.ink }}>{msg}</p>}
            <Button className="w-full" disabled={busy}>{busy ? "One moment…" : mode === "signup" ? "Create teacher account" : mode === "reset" ? "Email me a reset link" : "Sign in"}</Button>
            <div className="flex justify-between mt-3 text-sm">
              <button type="button" className="underline" style={{ color: C.ink }} onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setErr(""); setMsg(""); }}>
                {mode === "signup" ? "I have an account" : "Create an account"}
              </button>
              {mode !== "reset" && <button type="button" className="underline" style={{ color: C.soft }} onClick={() => { setMode("reset"); setErr(""); setMsg(""); }}>Forgot password?</button>}
              {mode === "reset" && <button type="button" className="underline" style={{ color: C.soft }} onClick={() => setMode("signin")}>Back to sign in</button>}
            </div>
          </form>
        ) : tab === "coteacher" ? (
          <form onSubmit={withCode}>
            <p className="mb-3 leading-relaxed" style={{ color: C.ink }}>Helping teach? Enter the co-teacher code the other teacher made for you. No email needed today; you can create your own login later from Setup.</p>
            <Label text="Co-teacher code">
              <input required autoCapitalize="characters" autoComplete="off" className={`${input} text-xl tracking-widest text-center`} style={inputStyle} placeholder="XXXXX-XXXXX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            </Label>
            {msg && <p className="mb-3" style={{ color: C.ink }}>{msg}</p>}
            {err && <p className="mb-3" style={{ color: C.redpen }}>{err}</p>}
            <Button className="w-full" disabled={busy || code.replace(/[^A-Z0-9]/gi, "").length < 10}>{busy ? "Joining…" : "Join as co-teacher"}</Button>
            <p className="text-xs mt-3" style={{ color: C.soft }}>Already have your own login? Use the Teacher tab.</p>
          </form>
        ) : (
          <form onSubmit={withCode}>
            <p className="mb-3 leading-relaxed" style={{ color: C.ink }}>Set up this device for the kids. It will only show their lessons, never the teacher tools.</p>
            <Label text="Tablet code from the teacher's Setup screen">
              <input required autoCapitalize="characters" autoComplete="off" className={`${input} text-xl tracking-widest text-center`} style={inputStyle} placeholder="XXXXX-XXXXX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            </Label>
            {msg && <p className="mb-3" style={{ color: C.ink }}>{msg}</p>}
            {err && <p className="mb-3" style={{ color: C.redpen }}>{err}</p>}
            <Button className="w-full" disabled={busy || code.replace(/[^A-Z0-9]/gi, "").length < 10}>{busy ? "Connecting…" : "Connect this tablet"}</Button>
          </form>
        )}
      </Card>
    </Shell>
  );
}

function NewPassword({ onDone }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  async function save(e) {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) setErr(friendly(error)); else onDone();
  }
  return (
    <Shell title="Choose a new password">
      <Card>
        <form onSubmit={save}>
          <Label text="New password (8 or more characters)"><input type="password" required minLength={8} autoComplete="new-password" className={input} style={inputStyle} value={password} onChange={(e) => setPassword(e.target.value)} /></Label>
          {err && <p className="mb-3" style={{ color: C.redpen }}>{err}</p>}
          <Button className="w-full">Save password</Button>
        </form>
      </Card>
    </Shell>
  );
}

function CreateFamily({ onDone }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function run(fn) {
    setBusy(true); setErr("");
    const { error } = await fn();
    if (error) setErr(friendly(error)); else onDone();
    setBusy(false);
  }
  return (
    <Shell title="Welcome!">
      <Card>
        <h2 className="text-lg font-bold mb-2" style={{ color: C.ink }}>Start your homeschool</h2>
        <Label text="Name (only you see this)"><input className={input} style={inputStyle} placeholder="e.g. West Family Homeschool" value={name} onChange={(e) => setName(e.target.value)} /></Label>
        <Button className="w-full" disabled={busy} onClick={() => run(() => supabase.rpc("create_family", { p_name: name }))}>Create it</Button>
        <div className="my-5 text-center text-sm" style={{ color: C.soft }}>or</div>
        <h2 className="text-lg font-bold mb-2" style={{ color: C.ink }}>Join as a co-teacher</h2>
        <Label text="Co-teacher code from the other teacher's Setup screen">
          <input autoCapitalize="characters" className={`${input} tracking-widest text-center`} style={inputStyle} placeholder="XXXXX-XXXXX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </Label>
        <Button kind="ghost" className="w-full" disabled={busy || code.replace(/[^A-Z0-9]/gi, "").length < 10} onClick={() => run(() => supabase.rpc("join_with_code", { p_code: code }))}>Join</Button>
        {err && <p className="mt-3" style={{ color: C.redpen }}>{err}</p>}
        <button className="block mx-auto mt-5 text-sm underline" style={{ color: C.soft }} onClick={() => supabase.auth.signOut()}>Sign out</button>
      </Card>
    </Shell>
  );
}

// Shown inside the tracker's Setup tab for teachers
// One code per child: a device connected with it shows only that child
function ChildDevices({ students }) {
  const [info, setInfo] = useState({});
  const [codes, setCodes] = useState({});
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState("");
  const [note, setNote] = useState("");
  const load = () => supabase.rpc("student_devices").then(({ data }) => setInfo(Object.fromEntries((data || []).map((r) => [r.student_id, r]))));
  useEffect(() => { load(); }, []);
  async function make(id) {
    setBusy(id); setNote("");
    const { data, error } = await supabase.rpc("new_student_code", { p_student: id });
    if (error) setNote(friendly(error)); else { setCodes((c) => ({ ...c, [id]: data })); load(); }
    setBusy("");
  }
  async function disconnect(id, name) {
    const { data, error } = await supabase.rpc("remove_child_devices", { p_student: id });
    setNote(error ? friendly(error) : `Disconnected ${data} ${data === 1 ? "device" : "devices"} for ${name}. Their code no longer works; make a new one to reconnect.`);
    setConfirm(""); setCodes((c) => ({ ...c, [id]: undefined })); load();
  }
  if (!students.length) return <p className="text-sm mb-2" style={{ color: C.soft }}>Add a student first, then make their code here.</p>;
  return (
    <div className="mb-2">
      {students.map((st) => {
        const r = info[st.id] || {};
        return (
          <div key={st.id} className="py-3 border-b" style={{ borderColor: C.rule }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="font-semibold" style={{ color: C.ink }}>{st.name}</div>
                <div className="text-xs" style={{ color: C.soft }}>
                  {r.devices ? `${r.devices} ${r.devices === 1 ? "device" : "devices"} connected` : "No devices yet"}{r.has_code ? "" : r.devices ? ", no active code" : ""}
                </div>
              </div>
              <div className="flex gap-2">
                <Button kind="ghost" className="text-sm" disabled={busy === st.id} onClick={() => make(st.id)}>{r.has_code || codes[st.id] ? "New code" : "Make code"}</Button>
                {(r.devices > 0 || r.has_code) && (
                  <Button kind="danger" className="text-sm" onClick={() => (confirm === st.id ? disconnect(st.id, st.name) : setConfirm(st.id))}>{confirm === st.id ? "Confirm" : "Disconnect"}</Button>
                )}
              </div>
            </div>
            {codes[st.id] && (
              <div className="rounded-lg p-3 mt-2 text-center" style={{ background: "#FFF6D6" }}>
                <div className="text-2xl font-bold tracking-widest" style={{ color: C.ink }}>{codes[st.id]}</div>
                <div className="text-xs mt-1" style={{ color: C.soft }}>Only {st.name}'s lessons, books, and stars appear on a device connected with this code. A new code retires this one; devices already connected stay connected.</div>
              </div>
            )}
          </div>
        );
      })}
      {note && <p className="text-sm my-2" style={{ color: C.ink }}>{note}</p>}
    </div>
  );
}

// A co-teacher who joined with only a code adds an email and password to the same login.
// Step 1: email (Supabase sends a confirmation link). Step 2: after confirming, choose a password.
function YourLogin({ user, compact = false }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [changing, setChanging] = useState(false);
  const here = window.location.origin + window.location.pathname;
  const meta = user?.user_metadata || {};
  const step = user?.is_anonymous ? (user.new_email && !changing ? "confirm" : "email") : meta.coteacher_upgrade && !meta.has_password ? "password" : "done";
  async function act(fn) {
    setBusy(true); setErr(""); setMsg("");
    try { await fn(); } catch (e) { setErr(friendly(e)); }
    setBusy(false);
  }
  const sendEmail = (e) => { e.preventDefault(); act(async () => {
    const { error } = await supabase.auth.updateUser({ email: email.trim(), data: { coteacher_upgrade: true } }, { emailRedirectTo: here });
    if (error) throw error;
    setChanging(false);
    await supabase.auth.refreshSession();
  }); };
  const checkConfirmed = () => act(async () => {
    const { data, error } = await supabase.auth.refreshSession();
    if (error) throw error;
    if (data.user?.is_anonymous) setMsg("Not confirmed yet. Open the link in the email, then tap this again.");
  });
  const resend = () => act(async () => {
    const { error } = await supabase.auth.resend({ type: "email_change", email: user.new_email, options: { emailRedirectTo: here } });
    if (error) throw error;
    setMsg("Sent again. Check your spam folder too.");
  });
  const savePassword = (e) => { e.preventDefault(); act(async () => {
    const { error } = await supabase.auth.updateUser({ password, data: { has_password: true } });
    if (error) throw error;
  }); };

  if (step === "done") {
    return compact ? null : <p className="text-sm mb-3" style={{ color: C.ink }}>Signed in as <strong>{user?.email}</strong>. You can sign in with this email on any device.</p>;
  }
  return (
    <div className="rounded-xl p-4 mb-4" style={{ background: "#FFF6D6", border: `1.5px solid ${C.pencil}` }}>
      {step === "email" && (
        <form onSubmit={sendEmail}>
          <div className="font-bold mb-1" style={{ color: C.ink }}>You're signed in on this device only</div>
          <p className="text-sm mb-3 leading-relaxed" style={{ color: C.ink }}>Create your own login so you can sign in on any phone or computer and won't lose access if this browser is cleared. Everything you've done stays.</p>
          <Label text="Your email"><input type="email" required autoComplete="email" className={input} style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} /></Label>
          {err && <p className="mb-3 text-sm" style={{ color: C.redpen }}>{err}</p>}
          <Button className="w-full" disabled={busy}>{busy ? "Sending…" : "Create my login"}</Button>
          <p className="text-xs mt-2" style={{ color: C.soft }}>Until then, the AI tools and making codes for devices are off for you.</p>
        </form>
      )}
      {step === "confirm" && (
        <div>
          <div className="font-bold mb-1" style={{ color: C.ink }}>Check your email</div>
          <p className="text-sm mb-3 leading-relaxed" style={{ color: C.ink }}>We sent a confirmation link to <strong>{user.new_email}</strong>. Open it (on this device if you can), then come back and choose a password.</p>
          {msg && <p className="mb-2 text-sm" style={{ color: C.ink }}>{msg}</p>}
          {err && <p className="mb-2 text-sm" style={{ color: C.redpen }}>{err}</p>}
          <Button className="w-full mb-2" disabled={busy} onClick={checkConfirmed}>I've confirmed it</Button>
          <div className="flex justify-between text-sm">
            <button type="button" className="underline" style={{ color: C.ink }} disabled={busy} onClick={resend}>Send it again</button>
            <button type="button" className="underline" style={{ color: C.soft }} onClick={() => { setChanging(true); setEmail(""); setMsg(""); setErr(""); }}>Use a different email</button>
          </div>
        </div>
      )}
      {step === "password" && (
        <form onSubmit={savePassword}>
          <div className="font-bold mb-1" style={{ color: C.ink }}>Last step: choose a password</div>
          <p className="text-sm mb-3" style={{ color: C.ink }}>Your email <strong>{user.email}</strong> is confirmed.</p>
          <Label text="Password (8 or more characters)"><input type="password" required minLength={8} autoComplete="new-password" className={input} style={inputStyle} value={password} onChange={(e) => setPassword(e.target.value)} /></Label>
          {err && <p className="mb-3 text-sm" style={{ color: C.redpen }}>{err}</p>}
          <Button className="w-full" disabled={busy}>Save password</Button>
        </form>
      )}
    </div>
  );
}

// Small reminder in the corner for a co-teacher who hasn't created a login yet
function DeviceOnlyPill({ user }) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const meta = user?.user_metadata || {};
  const pending = user?.is_anonymous || (meta.coteacher_upgrade && !meta.has_password);
  if (!pending || hidden) return null;
  return (
    <>
      <div className="hs-gate fixed z-40 flex items-center rounded-full text-xs font-semibold" style={{ right: 8, bottom: 76, background: C.pencil, color: C.ink, border: `1px solid ${C.ink}` }}>
        <button className="pl-3 pr-2 py-1.5 focus:outline-none focus:ring-2 rounded-full" onClick={() => setOpen(true)}>{user?.is_anonymous ? "This device only · Create my login" : "Finish your login"}</button>
        <button aria-label="Hide for now" className="pr-3 pl-1 py-1.5" onClick={() => setHidden(true)}>×</button>
      </div>
      {open && (
        <div className="hs-gate fixed inset-0 z-50 flex items-end sm:items-center justify-center p-3" style={{ background: "rgba(27,42,74,0.45)" }} onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-xl p-4" style={{ background: C.white }} onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-lg font-bold" style={{ color: C.ink }}>Your login</h2>
              <button aria-label="Close" className="text-xl px-2" style={{ color: C.ink }} onClick={() => setOpen(false)}>×</button>
            </div>
            <YourLogin user={user} compact />
            {!pending && <p style={{ color: C.ink }}>All set.</p>}
          </div>
        </div>
      )}
    </>
  );
}

// Everyone with teacher access, with Remove for co-teachers
function Teachers({ deviceOnly }) {
  const [list, setList] = useState(null);
  const [invites, setInvites] = useState([]);
  const [confirm, setConfirm] = useState("");
  const [note, setNote] = useState("");
  const load = () => {
    supabase.rpc("family_teachers").then(({ data }) => setList(data || []));
    supabase.rpc("open_teacher_invites").then(({ data }) => setInvites(data || []));
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { const f = () => load(); window.addEventListener("hs-teachers-changed", f); return () => window.removeEventListener("hs-teachers-changed", f); }, []);
  async function remove(t) {
    const { error } = await supabase.rpc("remove_teacher", { p_user: t.user_id });
    setNote(error ? friendly(error) : `Removed ${t.email || "that co-teacher"}. They no longer have access.`);
    setConfirm(""); load();
  }
  async function cancelInvites() {
    const { data, error } = await supabase.rpc("cancel_teacher_invites");
    setNote(error ? friendly(error) : `Canceled ${data} unused ${data === 1 ? "code" : "codes"}.`);
    load();
  }
  if (!list) return null;
  return (
    <div className="mb-2">
      {list.map((t) => (
        <div key={t.user_id} className="flex items-center justify-between gap-2 py-2 border-b" style={{ borderColor: C.rule }}>
          <div className="min-w-0">
            <div className="font-semibold truncate" style={{ color: C.ink }}>{t.email || "Co-teacher (this device only)"}{t.is_me ? " (you)" : ""}</div>
            <div className="text-xs" style={{ color: C.soft }}>
              {t.is_owner ? "Started this homeschool" : t.device_only ? "Joined with a code; no login yet" : "Co-teacher"}, since {new Date(t.joined).toLocaleDateString()}
            </div>
          </div>
          {!deviceOnly && !t.is_me && !t.is_owner && (
            <Button kind="danger" className="text-sm flex-shrink-0" onClick={() => (confirm === t.user_id ? remove(t) : setConfirm(t.user_id))}>{confirm === t.user_id ? "Confirm" : "Remove"}</Button>
          )}
        </div>
      ))}
      {invites.length > 0 && (
        <p className="text-xs mt-2" style={{ color: C.soft }}>
          {invites.length} unused co-teacher {invites.length === 1 ? "code" : "codes"}, good until {new Date(invites[invites.length - 1].expires_at).toLocaleDateString()}.{" "}
          {!deviceOnly && <button className="underline" style={{ color: C.redpen }} onClick={cancelInvites}>Cancel unused codes</button>}
        </p>
      )}
      {note && <p className="text-sm my-2" style={{ color: C.ink }}>{note}</p>}
    </div>
  );
}

function FamilyPanel({ membership, onSignOut, students = [], user }) {
  const deviceOnly = !!user?.is_anonymous;
  const [signOutWarn, setSignOutWarn] = useState(false);
  const [aiOn, setAiOn] = useState(null);
  useEffect(() => { supabase.rpc("can_use_ai").then(({ data }) => setAiOn(data === true)); }, []);
  const [codes, setCodes] = useState({});
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState("");
  async function makeCode(kind) {
    setBusy(kind); setNote("");
    const { data, error } = await supabase.rpc("new_join_code", { p_kind: kind });
    if (error) setNote(friendly(error)); else { setCodes((c) => ({ ...c, [kind]: data })); if (kind === "teacher") window.dispatchEvent(new Event("hs-teachers-changed")); }
    setBusy("");
  }
  async function removeTablets() {
    const { data, error } = await supabase.rpc("remove_student_devices");
    setNote(error ? friendly(error) : `Disconnected ${data} ${data === 1 ? "tablet" : "tablets"}. Make a new code to connect one again.`);
    setConfirm(false);
  }
  const CodeBox = ({ code, help }) => (
    <div className="rounded-lg p-3 my-2 text-center" style={{ background: "#FFF6D6" }}>
      <div className="text-2xl font-bold tracking-widest" style={{ color: C.ink }}>{code}</div>
      <div className="text-xs mt-1" style={{ color: C.soft }}>{help}</div>
    </div>
  );
  return (
    <div>
      <h3 className="text-lg font-bold mt-8 mb-1" style={{ color: C.ink }}>Devices and sign-in</h3>
      <p className="text-sm mb-3" style={{ color: C.soft }}>{membership.family_name}. Everything syncs between your devices automatically.</p>
      <YourLogin user={user} />
      {deviceOnly ? (
        <p className="text-sm mb-4 leading-relaxed" style={{ color: C.ink }}>Codes for the kids' devices and for other teachers can be made by a teacher with a login. Once you create yours, they'll appear here.</p>
      ) : (<>
      <div className="font-semibold mb-1" style={{ color: C.ink }}>Each child's own device</div>
      <p className="text-sm mb-2 leading-relaxed" style={{ color: C.ink }}>Make a code for a child, then on their iPad or phone open this site, tap <strong>Student tablet</strong>, and enter it. That device shows only that child: never a brother's or sister's work, grades, or photos.</p>
      <ChildDevices students={students} />
      <div className="font-semibold mt-4 mb-1" style={{ color: C.ink }}>Shared family tablet (optional)</div>
      <p className="text-sm mb-2 leading-relaxed" style={{ color: C.ink }}>One tablet the children take turns on. Each child taps their name, and every child's work is on it.</p>
      {codes.student && <CodeBox code={codes.student} help="Making a new code retires this one. Tablets already connected stay connected." />}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <Button kind="ghost" disabled={busy === "student"} onClick={() => makeCode("student")}>{codes.student ? "New code" : "Tablet code"}</Button>
        <Button kind="danger" onClick={() => (confirm ? removeTablets() : setConfirm(true))}>{confirm ? "Tap to confirm" : "Disconnect all"}</Button>
      </div>
      </>)}
      <div className="font-semibold mt-4 mb-1" style={{ color: C.ink }}>Teachers</div>
      <Teachers key={deviceOnly ? "device" : "full"} deviceOnly={deviceOnly} />
      {!deviceOnly && (<>
        <p className="text-sm mt-3 mb-2 leading-relaxed" style={{ color: C.ink }}>To add a co-teacher, make a code and give it to them. On this site they tap <strong>Sign in → Co-teacher</strong> and enter it. No account needed; they can create their own login later. Each code works once, within 7 days.</p>
        {codes.teacher && <CodeBox code={codes.teacher} help="Give this only to another adult. It grants full teacher access. Works once, for 7 days." />}
        <Button kind="ghost" className="w-full mb-2" disabled={busy === "teacher"} onClick={() => makeCode("teacher")}>{codes.teacher ? "Make another co-teacher code" : "Co-teacher code"}</Button>
      </>)}
      {note && <p className="text-sm my-2" style={{ color: C.ink }}>{note}</p>}
      <CalendarLinks students={students} />
      <p className="text-sm mt-6 mb-2" style={{ color: C.soft }}>AI tools: {!FEATURES.ai ? "off. They haven't been set up for this site yet." : deviceOnly ? "available after you create your login." : aiOn === null ? "checking…" : aiOn ? "on" : `not turned on for this account yet${BRAND.beta ? " (beta)" : ""}.`}</p>
      {signOutWarn && (
        <p className="text-sm mb-2 leading-relaxed" style={{ color: C.redpen }}>You're signed in on this device only. If you sign out, you'll need a new co-teacher code to get back in. Create your login above first.</p>
      )}
      <Button kind={signOutWarn ? "danger" : "ghost"} className="w-full" onClick={() => (deviceOnly && !signOutWarn ? setSignOutWarn(true) : onSignOut())}>{signOutWarn ? "Sign out anyway" : "Sign out of this device"}</Button>
    </div>
  );
}

function SyncBadge({ status }) {
  if (status === "saved") return null;
  const offline = status === "offline";
  return (
    <div className="fixed z-50 rounded-full px-3 py-1 text-xs font-semibold" role="status"
      style={{ left: 8, bottom: 76, background: offline ? "#FDF1F0" : C.white, color: offline ? C.redpen : C.soft, border: `1px solid ${offline ? C.redpen : C.rule}` }}>
      {offline ? "Offline. Your changes will save when you're back online." : "Saving…"}
    </div>
  );
}

export default function AuthGate() {
  const [phase, setPhase] = useState(supabase ? "loading" : "config");
  const [membership, setMembership] = useState(null);
  const [user, setUser] = useState(null);
  const [notice, setNotice] = useState(null);
  const [sync, setSync] = useState("saved");
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState(readRoute());
  const storageRef = useRef(null);
  useEffect(() => {
    const f = () => setRoute(readRoute());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  useEffect(() => { document.title = BRAND.name; }, []);

  async function loadMembership(session) {
    setUser(session?.user || null);
    if (!session) { setPhase("signin"); return; }
    const { data, error } = await supabase.rpc("my_membership");
    // Can't reach the database right now: keep the device signed in and try again shortly
    if (error || data == null) { setPhase("offline"); setTimeout(() => supabase.auth.getSession().then(({ data: d }) => loadMembership(d.session)), 5000); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (row) { setMembership(row); setPhase("ready"); }
    else if (session.user?.is_anonymous) {
      // A tablet is only signed out when the database clearly says it was disconnected
      if (await confirmedRemoved(supabase)) { await supabase.auth.signOut(); setPhase("signin"); }
      else loadMembership(session);
    }
    else setPhase("family");
  }

  useEffect(() => {
    if (!supabase) return;
    let current = null;
    supabase.auth.getSession().then(({ data }) => { current = data.session; loadMembership(current); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") { setPhase("newpassword"); return; }
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") { current = session; loadMembership(session); }
      else if (event === "TOKEN_REFRESHED") setUser(session?.user || null);
    });
    const again = () => supabase.auth.getSession().then(({ data }) => loadMembership(data.session));
    window.addEventListener("hs-membership-changed", again);
    return () => { sub.subscription.unsubscribe(); window.removeEventListener("hs-membership-changed", again); };
  }, []);

  // Connect the tracker's storage to this family's database
  useEffect(() => {
    if (phase !== "ready" || !membership) return;
    const storage = (membership.student_id ? createChildStorage : createSupabaseStorage)({
      supabase, familyId: membership.family_id, onStatus: setSync,
      onLostAccess: async () => {
        storageRef.current?.dispose(); window.storage = undefined; setReady(false);
        await supabase.auth.signOut();
        setNotice({ tab: "tablet", text: "This device was disconnected by the teacher. Enter a new tablet code to reconnect." });
        window.location.hash = "#/tablet";
      },
    });
    storageRef.current = storage;
    window.storage = storage;
    setReady(true);
    return () => { storage.dispose(); if (window.storage === storage) window.storage = undefined; setReady(false); };
  }, [phase, membership?.family_id]);

  async function signOut() {
    await storageRef.current?.flushAll();
    await supabase.auth.signOut();
  }

  // Public pages work before sign-in (and even before the database is connected)
  if (route === "privacy" || route === "terms") return <PolicyPage which={route} />;
  const signedOut = phase === "signin" || phase === "config" || phase === "loading";
  if (signedOut && route === "demo") return <Demo />;
  if (signedOut && !["signin", "signup", "tablet", "coteacher"].includes(route) && !notice) return <Landing />;

  if (phase === "config") {
    return (
      <Shell title="Almost there">
        <Card><p style={{ color: C.ink }}>This copy of the tracker isn't connected to a database yet. Add the SUPABASE_URL and SUPABASE_ANON_KEY variables in GitHub (step 4 of the setup guide), then run the deploy again.</p></Card>
      </Shell>
    );
  }
  if (phase === "offline") return <Shell title={BRAND.name}><p style={{ color: C.soft }}>Can't reach the internet right now. Still signed in; trying again…</p></Shell>;
  if (phase === "loading") return <Shell title={BRAND.name}><p style={{ color: C.soft }}>Loading…</p></Shell>;
  if (phase === "newpassword") return <NewPassword onDone={() => supabase.auth.getSession().then(({ data }) => loadMembership(data.session))} />;
  if (phase === "signin") return <SignIn key={(notice?.text || "") + route} notice={notice} initialTab={route === "tablet" || route === "coteacher" ? route : "teacher"} initialMode={route === "signup" ? "signup" : "signin"} />;
  if (phase === "family") return <CreateFamily onDone={() => supabase.auth.getSession().then(({ data }) => loadMembership(data.session))} />;
  if (!ready) return <Shell title={BRAND.name}><p style={{ color: C.soft }}>Connecting…</p></Shell>;
  return (
    <>
      <HomeschoolTracker
        key={membership.family_id}
        deviceRole={membership.role}
        studentId={membership.student_id || null}
        extraSetup={membership.role === "teacher" ? (data) => <FamilyPanel membership={membership} onSignOut={signOut} students={data.students} user={user} /> : null}
      />
      <SyncBadge status={sync} />
      {membership.role === "teacher" && !membership.student_id && <DeviceOnlyPill user={user} />}
    </>
  );
}
