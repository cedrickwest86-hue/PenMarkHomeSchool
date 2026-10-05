import { useState, useEffect, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { aiFetch, FEATURES } from "./platform.js";
import { BRAND } from "./brand.js";
import {
  Plus, Upload, Check, Trash2, Paperclip, Sparkles, CalendarDays,
  ListChecks, BarChart3, Users, ChevronLeft, ChevronRight, Download, X, Loader2, FileSpreadsheet, Camera, Settings as SettingsIcon, UserRound,
} from "lucide-react";

/* ---------- constants ---------- */
const DATA_KEY = "hs-tracker:data";
const FILE_PREFIX = "hs-file:";
const KEY_PREFIX = "hs-akey:"; // answer keys: stored where student tablets can't read them
const MAX_FILE = 3.5 * 1024 * 1024; // base64 grows ~33%; keeps each file under the 5MB storage limit

const C = {
  paper: "#FBFCFE", rule: "#D6E4F5", margin: "#E9A3A3", ink: "#1B2A4A",
  soft: "#5B6B88", pencil: "#F2B705", redpen: "#C8322B", white: "#FFFFFF",
};
const DOTS = ["#2F6FB0", "#2F7D4F", "#B5651D", "#7A4FA3", "#C8322B", "#1F8A8A", "#9A7B00", "#5B6B88", "#A33D6B", "#3E5C2E"];
const GRADES = ["K4", "K5", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const TYPES = ["Lesson", "Seatwork", "Homework", "Reading", "Speed Drill", "Quiz", "Test", "Exam", "Book Report", "Memory Verse", "Review", "Project"];

function subjectsFor(g) {
  if (g === "K4" || g === "K5") return ["Bible", "Phonics & Reading", "Writing", "Numbers", "Science & Health", "History"];
  const n = parseInt(g, 10);
  if (n <= 3) return ["Bible", "Phonics", "Reading", "Language", "Spelling", "Cursive", "Arithmetic", "Science", "History & Geography", "Health"];
  if (n <= 6) return ["Bible", "Reading", "Language", "Spelling & Vocabulary", "Penmanship", "Arithmetic", "Science", "History & Geography", "Health"];
  if (n <= 8) return ["Bible", "Literature", "Grammar & Composition", "Vocabulary & Spelling", "Math", "Science", "History"];
  return ["Bible", "Literature", "Grammar & Composition", "Vocabulary", "Math", "Science", "History", "Elective"];
}

/* ---------- helpers ---------- */
const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};
const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const isWeekend = (iso) => [0, 6].includes(new Date(iso + "T12:00:00").getDay());
function schoolDayAfter(start, n) {
  let d = start;
  while (isWeekend(d)) d = addDays(d, 1);
  let left = n;
  while (left > 0) { d = addDays(d, 1); if (!isWeekend(d)) left--; }
  return d;
}
const fmtDate = (iso, long) =>
  new Date(iso + "T12:00:00").toLocaleDateString(undefined, long
    ? { weekday: "long", month: "long", day: "numeric" }
    : { weekday: "short", month: "short", day: "numeric" });
// Abeka Academy grading-period scale
const SCALE = [[99, "A+"], [96, "A"], [94, "A–"], [91, "B+"], [88, "B"], [85, "B–"], [82, "C+"], [79, "C"], [77, "C–"], [74, "D+"], [70, "D"]];
function letter(p) {
  if (p == null || Number.isNaN(p)) return "–";
  const hit = SCALE.find(([min]) => p >= min);
  return hit ? hit[1] : "F";
}
// Abeka grading periods: grades 2 and 3 use six (about 30 lessons each), grade 4 uses four. Editable per student.
const PERIOD_BOUNDS = { 4: [45, 90, 135, 170], 6: [30, 60, 90, 120, 150, 170] };
const periodCount = (s) => Number(s?.periods) || (["K4", "K5", "1", "2", "3"].includes(String(s?.grade)) ? 6 : 4);
function gradingPeriod(lesson, n = 4) {
  if (!lesson) return null;
  const b = PERIOD_BOUNDS[n] || PERIOD_BOUNDS[4];
  const i = b.findIndex((hi) => lesson <= hi);
  return i < 0 ? b.length : i + 1;
}
const periodRange = (p, n = 4) => { const b = PERIOD_BOUNDS[n] || PERIOD_BOUNDS[4]; return [p === 1 ? 1 : b[p - 2] + 1, b[p - 1]]; };
const WEEKDAY_LABELS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"]];
function dotColor(subject) {
  let h = 0; for (const ch of subject) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return DOTS[h % DOTS.length];
}

/* ---------- calendar & school-day engine ---------- */
// Event kinds and their defaults. "noLessons" days are skipped when lessons are scheduled.
const EVENT_KINDS = {
  "Field trip": { color: "#2F7D4F", noLessons: true, countsAsDay: true },
  "Holiday": { color: "#C8322B", noLessons: true, countsAsDay: false },
  "Sick day": { color: "#B5651D", noLessons: true, countsAsDay: false },
  "Outside lesson": { color: "#2F6FB0", noLessons: false, countsAsDay: false },
  "Co-op or class": { color: "#7A4FA3", noLessons: false, countsAsDay: false },
  "Sports": { color: "#1F8A8A", noLessons: false, countsAsDay: false },
  "Appointment": { color: "#5B6B88", noLessons: false, countsAsDay: false },
  "Other": { color: "#9A7B00", noLessons: false, countsAsDay: false },
};
const kindColor = (k) => (EVENT_KINDS[k] || EVENT_KINDS.Other).color;
function eventDates(ev) {
  const out = [];
  if (ev.repeatWeekly) {
    const until = ev.until || addDays(ev.date, 7 * 40);
    for (let d = ev.date, i = 0; d <= until && i < 60; d = addDays(d, 7), i++) out.push(d);
  } else {
    const end = ev.endDate && ev.endDate > ev.date ? ev.endDate : ev.date;
    for (let d = ev.date, i = 0; d <= end && i < 60; d = addDays(d, 1), i++) out.push(d);
  }
  return out;
}
const forStudent = (ev, sid) => !ev.studentIds?.length || ev.studentIds.includes(sid);
function eventsOn(events, date, sids) {
  return (events || []).filter((ev) => (!sids || sids.some((sid) => forStudent(ev, sid))) && eventDates(ev).includes(date))
    .sort((x, y) => (x.time || "").localeCompare(y.time || ""));
}
function blockedFn(events, sid) {
  const m = new Map();
  for (const ev of events || []) {
    if (!ev.noLessons || !forStudent(ev, sid)) continue;
    for (const d of eventDates(ev)) m.set(d, true);
  }
  return (d) => isWeekend(d) || m.has(d);
}
function nextSchoolDay(d, blocked) {
  let x = d;
  for (let i = 0; i < 400 && blocked(x); i++) x = addDays(x, 1);
  return x;
}
// The school days starting at `from`, skipping weekends and no-lesson days
function schoolDayList(from, count, blocked) {
  const out = [];
  let d = nextSchoolDay(from, blocked);
  while (out.length < count) { out.push(d); d = nextSchoolDay(addDays(d, 1), blocked); }
  return out;
}
function shiftSchool(d, n, blocked) {
  let x = d; const step = n < 0 ? -1 : 1; let left = Math.abs(n);
  for (let g = 0; left > 0 && g < 2000; g++) { x = addDays(x, step); if (!blocked(x)) left--; }
  return x;
}
// A subject that meets only some weekdays (Health on Mon/Wed/Fri) skips the other days too
const subjectDays = (students, sid, subject) => students?.find((x) => x.id === sid)?.schedule?.[subject];
function blockedFor(events, sid, days) {
  const b = blockedFn(events, sid);
  if (!days?.length || days.length >= 5) return b;
  return (d) => b(d) || !days.includes(new Date(d + "T12:00:00").getDay());
}
// When no-lesson days change, slide unfinished work so each subject keeps its lessons in order on its own meeting days.
function reflow(assignments, oldEvents, newEvents, from, students = []) {
  const keyOf = (a) => { const d = subjectDays(students, a.studentId, a.subject); return `${a.studentId}|${d?.length && d.length < 5 ? d.join("") : "all"}`; };
  const groups = {};
  let max = from;
  for (const a of assignments) {
    if (a.status === "done") continue;
    const last = a.dueBy && a.dueBy > a.due ? a.dueBy : a.due;
    if (last < from) continue;
    groups[keyOf(a)] ||= { sid: a.studentId, days: subjectDays(students, a.studentId, a.subject) };
    if (last > max) max = last;
  }
  const remapFor = {};
  for (const [k, g] of Object.entries(groups)) {
    const baseOld = blockedFn(oldEvents, g.sid), baseNew = blockedFn(newEvents, g.sid);
    const oldB = blockedFor(oldEvents, g.sid, g.days), newB = blockedFor(newEvents, g.sid, g.days);
    const oldList = [];
    for (let d = from; d <= max; d = addDays(d, 1)) if (!oldB(d)) oldList.push(d);
    const newList = schoolDayList(from, oldList.length + 5, newB);
    remapFor[k] = (date) => {
      if (!date || date < from) return date;
      // Work placed on an off day (a weekend or non-meeting day) stays put unless a new event now blocks that day
      if (oldB(date)) return !baseOld(date) && baseNew(date) ? nextSchoolDay(date, newB) : date;
      let lo = 0, hi = oldList.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (oldList[mid] <= date) lo = mid + 1; else hi = mid; }
      return newList[lo - 1] || date;
    };
  }
  let moved = 0;
  const next = assignments.map((a) => {
    if (a.status === "done") return a;
    const f = remapFor[keyOf(a)];
    if (!f) return a;
    const due = f(a.due), dueBy = a.dueBy ? f(a.dueBy) : a.dueBy;
    if (due === a.due && dueBy === a.dueBy) return a;
    moved++;
    return { ...a, due, dueBy };
  });
  return { assignments: next, moved };
}
// Attendance = days you marked, plus calendar events that count as a school day (up to today)
function attendanceDays(data, sid, upTo = todayISO()) {
  const set = new Set(data.attendance?.[sid] || []);
  for (const ev of data.events || []) {
    if (!ev.countsAsDay || !forStudent(ev, sid)) continue;
    for (const d of eventDates(ev)) if (d <= upTo) set.add(d);
  }
  return [...set].sort();
}
// Minutes logged on assignments plus outside activities (up to today)
function minutesLogged(data, sid, upTo = todayISO()) {
  let m = data.assignments.filter((a) => a.studentId === sid).reduce((t, a) => t + (Number(a.minutes) || 0), 0);
  for (const ev of data.events || []) {
    if (!ev.minutes || !forStudent(ev, sid)) continue;
    m += eventDates(ev).filter((d) => d <= upTo).length * Number(ev.minutes);
  }
  return m;
}
// Stars: one for finishing by the due date, one more for a score of 94 or higher
function starsFor(data, sid) {
  let earned = 0;
  for (const a of data.assignments) {
    if (a.studentId !== sid || a.status !== "done") continue;
    if (a.finishedOn && a.finishedOn <= dueOf(a)) earned++;
    if (a.score != null && a.score !== "" && Number(a.score) >= 94) earned++;
  }
  const spent = (data.redemptions || []).filter((r) => r.studentId === sid).reduce((t, r) => t + r.cost, 0);
  return { earned, balance: earned - spent };
}

// After deleting unfinished work, pull that subject's later work up into the emptied days (order and same-day groupings kept)
function closeGaps(assignments, deleted) {
  const groups = {};
  for (const a of deleted) if (a.status !== "done") (groups[`${a.studentId}|${a.subject}`] ||= []).push(a);
  const moved = [];
  let next = assignments;
  for (const del of Object.values(groups)) {
    const { studentId: sid, subject } = del[0];
    const from = del.map((a) => a.due).sort()[0];
    const inGroup = (a) => a.studentId === sid && a.subject === subject && a.status !== "done" && a.due >= from;
    const remaining = next.filter(inGroup);
    const D = [...new Set([...remaining, ...del].map((a) => a.due))].sort();
    const R = [...new Set(remaining.map((a) => a.due))].sort();
    const map = Object.fromEntries(R.map((d, i) => [d, D[i]]));
    next = next.map((a) => {
      if (!inGroup(a)) return a;
      const due = map[a.due] || a.due, dueBy = a.dueBy && map[a.dueBy] ? map[a.dueBy] : a.dueBy;
      if (due === a.due && dueBy === a.dueBy) return a;
      moved.push({ id: a.id, due: a.due, dueBy: a.dueBy });
      return { ...a, due, dueBy };
    });
  }
  return { assignments: next, moved };
}

/* ---------- AI helpers ---------- */
function parseJSONLoose(text) {
  const t = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(t); } catch {}
  const i = Math.min(...["[", "{"].map((c) => (t.indexOf(c) < 0 ? Infinity : t.indexOf(c))));
  const j = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
  return JSON.parse(t.slice(i, j + 1));
}
async function askClaude(content, extra = {}) {
  const res = await aiFetch({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content }], ...extra }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "request failed");
  return (j.content || []).map((c) => (c.type === "text" ? c.text : "")).join("\n").trim();
}
const fileBlock = async (file) => {
  const data = await fileToBase64(file);
  return file.type === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: file.type, data } };
};

async function loadData() {
  try { const r = await window.storage.get(DATA_KEY, false); return r ? JSON.parse(r.value) : null; }
  catch { return null; }
}
async function saveData(d) {
  try { await window.storage.set(DATA_KEY, JSON.stringify(d), false); }
  catch (e) { console.error("Save failed", e); }
}
const fileToBase64 = (f) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result.split(",")[1]);
  r.onerror = () => rej(new Error("That file couldn't be read. Try a different copy."));
  r.readAsDataURL(f);
});
async function storeFile(file, prefix = FILE_PREFIX) {
  if (file.size > MAX_FILE) throw new Error(`${file.name} is over 3.5 MB. Take a smaller photo or split the PDF.`);
  const data = await fileToBase64(file);
  const key = prefix + uid();
  await window.storage.set(key, JSON.stringify({ name: file.name, type: file.type, data }), false);
  return { key, name: file.name, type: file.type };
}
async function openFile(att) {
  const r = await window.storage.get(att.key, false);
  const f = JSON.parse(r.value);
  const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: f.type }));
  const a = document.createElement("a");
  a.href = url; a.download = f.name; a.target = "_blank"; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function cleanupFiles(before, after) {
  const refs = (list) => new Set(list.flatMap((a) => [...(a.attachments || []), ...(a.keyAttachments || [])].map((x) => x.key)));
  const kept = refs(after);
  for (const k of refs(before)) if (!kept.has(k)) { try { await window.storage.delete(k, false); } catch {} }
}

/* ---------- shared UI ---------- */
const inputCls = "w-full rounded-md border px-3 py-2 text-base bg-white focus:outline-none focus:ring-2";
const inputStyle = { borderColor: "#C3D3EA", color: C.ink };
const ruled = {
  backgroundColor: C.paper,
  backgroundImage: `linear-gradient(to right, transparent 20px, ${C.margin} 20px, ${C.margin} 21px, transparent 21px), repeating-linear-gradient(to bottom, transparent 0, transparent 27px, ${C.rule} 27px, ${C.rule} 28px)`,
};

function Btn({ kind = "primary", className = "", ...p }) {
  const styles = {
    primary: { background: C.ink, color: C.white },
    pencil: { background: C.pencil, color: C.ink },
    ghost: { background: "transparent", color: C.ink, border: `1.5px solid ${C.ink}` },
    danger: { background: "transparent", color: C.redpen, border: `1.5px solid ${C.redpen}` },
  };
  return (
    <button
      {...p}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 ${className}`}
      style={{ ...styles[kind], ...(p.style || {}) }}
    />
  );
}
function Field({ label, children }) {
  return (
    <label className="block mb-3">
      <span className="block text-sm mb-1" style={{ color: C.soft }}>{label}</span>
      {children}
    </label>
  );
}
function Sheet({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center" style={{ background: "rgba(27,42,74,.45)" }} onClick={onClose}>
      <div className="w-full sm:max-w-lg overflow-y-auto rounded-t-2xl sm:rounded-2xl p-5" style={{ background: C.white, maxHeight: "92vh" }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold" style={{ color: C.ink }}>{title}</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded focus:outline-none focus:ring-2"><X size={22} color={C.ink} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Empty({ children }) {
  return <p className="py-10 text-center" style={{ color: C.soft }}>{children}</p>;
}

/* ---------- ruler progress bar ---------- */
function Ruler({ value, max, tick = 10 }) {
  const pct = Math.min(100, max ? (value / max) * 100 : 0);
  const step = max ? (tick / max) * 100 : 100;
  return (
    <div className="relative h-4 rounded-sm overflow-hidden" style={{ border: `1.5px solid ${C.ink}`, background: C.white }} aria-label={`${value} of ${max}`}>
      <div className="absolute inset-y-0 left-0" style={{ width: pct + "%", background: C.pencil, transition: "width .4s" }} />
      <div className="absolute inset-0" style={{ backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent calc(${step}% - 1px), ${C.ink}66 calc(${step}% - 1px), ${C.ink}66 ${step}%)` }} />
    </div>
  );
}

/* ---------- due dates ---------- */
// a.due is the day the work is scheduled; a.dueBy is an optional later deadline (book reports, projects, tests to study for)
const TEST_TYPES = ["Quiz", "Test", "Exam"];
const dueOf = (a) => (a.dueBy && a.dueBy > a.due ? a.dueBy : a.due);
const daysBetween = (from, to) => Math.round((new Date(to + "T12:00:00") - new Date(from + "T12:00:00")) / 86400000);
function dueInfo(a, today = todayISO()) {
  if (a.status === "done") return null;
  const d = dueOf(a);
  const n = daysBetween(today, d);
  if (n < 0) return a.status === "submitted" ? null : { text: n === -1 ? "Overdue since yesterday" : `Overdue since ${fmtDate(d)}`, tone: "late" };
  if (n === 0) return { text: "Due today", tone: "soon" };
  if (n === 1) return { text: "Due tomorrow", tone: "soon" };
  if (n < 7) return { text: `Due ${new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "long" })}`, tone: "later" };
  return { text: `Due ${fmtDate(d)}`, tone: "later" };
}
function DueBadge({ a }) {
  const info = dueInfo(a);
  if (!info) return null;
  const style = info.tone === "late" ? { color: C.redpen, fontWeight: 700 }
    : info.tone === "soon" ? { color: C.ink, fontWeight: 700, background: "#FFF6D6", padding: "0 6px", borderRadius: 4 }
    : { color: C.soft };
  return <span style={style}>{info.text}</span>;
}
// Open work that isn't on the chosen day's list: multi-day work already started, plus quizzes and tests in the next week
function comingUp(list, day) {
  return list.filter((a) => a.status === "todo" && a.due !== day && dueOf(a) >= day &&
    (a.due < day || (TEST_TYPES.includes(a.type) && dueOf(a) <= addDays(day, 7))))
    .sort((x, y) => dueOf(x).localeCompare(dueOf(y)));
}

/* ---------- assignment row ---------- */
function Row({ a, student, showStudent, onToggle, onEdit, mode = "teacher" }) {
  const done = a.status === "done";
  const turnedIn = a.status === "submitted";
  const locked = mode === "student" && done;
  const label = mode === "student"
    ? (done ? "Checked by your teacher" : turnedIn ? "Undo turn in" : "Turn in")
    : (done ? "Mark not done" : "Mark done");
  return (
    <div className="flex items-start gap-3 py-3 border-b" style={{ borderColor: C.rule }}>
      <button
        onClick={() => !locked && onToggle(a.id)}
        aria-label={label}
        title={label}
        className="mt-1 flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center focus:outline-none focus:ring-2"
        style={{ border: `2px solid ${done ? C.redpen : turnedIn ? C.pencil : "#A9B8D0"}`, background: done ? "#FDF1F0" : turnedIn ? "#FFF6D6" : C.white, cursor: locked ? "default" : "pointer" }}
      >
        {done && <Check size={18} color={C.redpen} strokeWidth={3} />}
        {turnedIn && <Check size={16} color={C.ink} strokeWidth={3} />}
      </button>
      <button onClick={() => onEdit(a)} className="flex-1 text-left focus:outline-none focus:ring-2 rounded">
        <div className="font-semibold leading-snug" style={{ color: C.ink, textDecoration: done ? "line-through" : "none", textDecorationColor: C.redpen }}>
          {a.title || `${a.type}${a.lesson ? " " + a.lesson : ""}`}
        </div>
        <div className="text-sm mt-1 flex flex-wrap items-center gap-x-3 gap-y-1" style={{ color: C.soft }}>
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: dotColor(a.subject) }} />{a.subject}</span>
          {a.lesson ? <span>Lesson {a.lesson}</span> : null}
          <span>{a.type}</span>
          {showStudent && student && <span>{student.name}</span>}
          {turnedIn && <span className="font-semibold" style={{ color: C.ink }}>Turned in</span>}
          <DueBadge a={a} />
          {a.attachments?.length ? <span className="inline-flex items-center gap-1"><Paperclip size={13} />{a.attachments.length}</span> : null}
        </div>
      </button>
      {a.score != null && a.score !== "" && (
        <div className="text-right flex-shrink-0" style={{ color: C.redpen, fontWeight: 700 }}>
          <div className="text-lg leading-none">{a.score}</div>
          <div className="text-xs">{letter(Number(a.score))}</div>
        </div>
      )}
    </div>
  );
}

/* ---------- grading helpers ---------- */
// Abeka's letter-to-number conversions
const LETTER_NUM = [["A+", 100], ["A", 97], ["A–", 95], ["B+", 92], ["B", 90], ["B–", 86], ["C+", 83], ["C", 80], ["C–", 78], ["D+", 75], ["D", 72], ["F", 69]];
const IMG_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
async function loadStored(att) {
  const r = await window.storage.get(att.key, false);
  return JSON.parse(r.value);
}
async function toBlock(att) {
  try {
    const f = await loadStored(att);
    if (f.type === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } };
    if (IMG_TYPES.includes(f.type)) return { type: "image", source: { type: "base64", media_type: f.type, data: f.data } };
  } catch {}
  return null;
}
class GradeError extends Error {}
async function aiGrade(a) {
  const keyBlocks = (await Promise.all((a.keyAttachments || []).map(toBlock))).filter(Boolean);
  const workBlocks = (await Promise.all((a.attachments || []).map(toBlock))).filter(Boolean);
  if (!keyBlocks.length) throw new GradeError("Add a photo or PDF of the answer key first.");
  if (!workBlocks.length) throw new GradeError("There's no photo of the student's work to grade yet.");
  const prompt = `You are helping a homeschool parent grade an Abeka ${a.type.toLowerCase()} for ${a.subject}${a.lesson ? `, lesson ${a.lesson}` : ""}.
The first set of pages is the ANSWER KEY. The second set is the STUDENT'S WORK.
Compare each of the student's answers with the key. Use the point values printed on the key when they appear; otherwise weight each question equally so the whole paper is worth 100.
Abeka grades by subtracting points missed from 100.
If handwriting is unreadable or you can't find an answer, mark it "unclear" and do not deduct for it. The parent will check those.
Respond with ONLY a JSON object, no prose and no code fences:
{"pointsMissed": number, "score": number from 0 to 100, "items": [{"q": "question number or label", "student": "what the student wrote", "expected": "the key's answer", "result": "wrong" or "unclear", "points": points deducted}], "summary": "one or two plain sentences for the parent"}
List only wrong and unclear answers in items, not correct ones.`;
  let text = "";
  try {
    const res = await aiFetch({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 1000,
        messages: [{ role: "user", content: [{ type: "text", text: "ANSWER KEY:" }, ...keyBlocks, { type: "text", text: "STUDENT'S WORK:" }, ...workBlocks, { type: "text", text: prompt }] }],
      }),
    });
    const json = await res.json();
    text = (json.content || []).map((c) => (c.type === "text" ? c.text : "")).join("");
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const score = Math.max(0, Math.min(100, Math.round(Number(j.score))));
    if (!Number.isFinite(score)) throw new Error("bad score");
    return {
      score, pointsMissed: Number(j.pointsMissed) || 0, summary: String(j.summary || ""),
      items: (Array.isArray(j.items) ? j.items : []).slice(0, 60).map((x) => ({
        q: String(x.q ?? ""), student: String(x.student ?? ""), expected: String(x.expected ?? ""),
        result: x.result === "unclear" ? "unclear" : "wrong", points: Number(x.points) || 0,
      })),
      at: Date.now(),
    };
  } catch {
    throw new GradeError("The pages couldn't be compared. Try clearer, straight-on photos, or grade this one by hand.");
  }
}

function FileList({ label, items = [], onRemove, onAdd, busy, addLabel }) {
  return (
    <div className="mb-4">
      <div className="text-sm mb-2" style={{ color: C.soft }}>{label}</div>
      {items.map((att) => (
        <div key={att.key} className="flex items-center justify-between gap-2 py-1">
          <button className="text-left underline truncate focus:outline-none focus:ring-2 rounded" style={{ color: C.ink }} onClick={() => openFile(att).catch(() => {})}>{att.name}</button>
          <button aria-label={`Remove ${att.name}`} onClick={() => onRemove(att.key)} className="p-1 focus:outline-none focus:ring-2 rounded"><X size={16} color={C.redpen} /></button>
        </div>
      ))}
      <label className="inline-flex items-center gap-2 mt-1 cursor-pointer font-semibold" style={{ color: C.ink }}>
        {busy ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
        {busy ? "Saving file…" : addLabel}
        <input type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={onAdd} disabled={busy} />
      </label>
    </div>
  );
}

/* ---------- editor ---------- */
function Editor({ initial, students, allAssignments, onSave, onDelete, onClose, flash }) {
  const [a, setA] = useState({ keyAttachments: [], attachments: [], ...initial });
  const [busy, setBusy] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [fillGap, setFillGap] = useState(true);
  const [missed, setMissed] = useState("");
  const [shareKey, setShareKey] = useState(true);
  const [suggest, setSuggest] = useState(initial.aiReview || null);
  const [gradeErr, setGradeErr] = useState("");
  const student = students.find((s) => s.id === a.studentId);
  const subjects = student ? student.subjects : [];
  const set = (k, v) => setA((p) => ({ ...p, [k]: v }));
  const isNew = !initial.createdAt;
  const matches = allAssignments.filter((x) => x.id !== a.id && x.subject === a.subject && a.lesson && x.lesson === a.lesson && x.type === a.type && !(x.keyAttachments || []).length);
  const hasKey = (a.keyAttachments || []).length > 0;
  const hasWork = (a.attachments || []).length > 0;

  async function addFiles(e, field) {
    const files = [...e.target.files]; e.target.value = "";
    setBusy(field);
    try {
      const atts = [];
      for (const f of files) atts.push(await storeFile(f, field === "keyAttachments" ? KEY_PREFIX : FILE_PREFIX));
      setA((p) => ({ ...p, [field]: [...(p[field] || []), ...atts] }));
    } catch (err) { flash(err.message); }
    setBusy("");
  }
  const removeFile = (field) => (key) => setA((p) => ({ ...p, [field]: (p[field] || []).filter((x) => x.key !== key) }));

  async function grade() {
    setBusy("grade"); setGradeErr("");
    try { setSuggest(await aiGrade(a)); }
    catch (err) { setGradeErr(err instanceof GradeError ? err.message : "Something went wrong. Try again."); }
    setBusy("");
  }

  return (
    <Sheet title={isNew ? "New assignment" : "Edit assignment"} onClose={onClose}>
      <Field label="Student">
        <select className={inputCls} style={inputStyle} value={a.studentId}
          onChange={(e) => { const s = students.find((x) => x.id === e.target.value); setA((p) => ({ ...p, studentId: e.target.value, subject: s?.subjects.includes(p.subject) ? p.subject : s?.subjects[0] || "" })); }}>
          {students.map((s) => <option key={s.id} value={s.id}>{s.name} (grade {s.grade})</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Subject">
          <select className={inputCls} style={inputStyle} value={a.subject} onChange={(e) => set("subject", e.target.value)}>
            {subjects.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select className={inputCls} style={inputStyle} value={a.type} onChange={(e) => set("type", e.target.value)}>
            {TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Lesson number">
          <input type="number" min="1" inputMode="numeric" className={inputCls} style={inputStyle} value={a.lesson ?? ""} onChange={(e) => set("lesson", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
        <Field label="Do on">
          <input type="date" className={inputCls} style={inputStyle} value={a.due} onChange={(e) => set("due", e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3 items-start">
        <Field label="Due by (optional)">
          <input type="date" className={inputCls} style={inputStyle} value={a.dueBy || ""} min={a.due} onChange={(e) => set("dueBy", e.target.value || null)} />
        </Field>
        <p className="text-sm mt-6 leading-snug" style={{ color: a.dueBy && a.dueBy < a.due ? C.redpen : C.soft }}>
          {a.dueBy && a.dueBy < a.due ? "The due date is before the start date, so it will be ignored." : "For work that takes more than a day, like a book report, project, or test to study for."}
        </p>
      </div>
      <Field label="What to do">
        <input className={inputCls} style={inputStyle} placeholder="e.g. Seatwork pp. 42–43, oral drill" value={a.title} onChange={(e) => set("title", e.target.value)} />
      </Field>

      <div className="rounded-xl p-4 mb-4" style={{ background: "#FDF6F5", border: `1.5px solid ${C.rule}` }}>
        <div className="font-bold mb-2" style={{ color: C.redpen }}>Grade</div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Points missed">
            <input type="number" min="0" max="100" inputMode="decimal" className={inputCls} style={inputStyle} value={missed}
              onChange={(e) => { setMissed(e.target.value); if (e.target.value !== "") set("score", Math.max(0, 100 - Number(e.target.value))); }} />
          </Field>
          <Field label="Score (%)">
            <input type="number" min="0" max="100" inputMode="decimal" className={inputCls} style={inputStyle} value={a.score ?? ""}
              onChange={(e) => { setMissed(""); set("score", e.target.value === "" ? null : Number(e.target.value)); }} />
          </Field>
          <Field label="Or a letter">
            <select className={inputCls} style={inputStyle} value="" onChange={(e) => { setMissed(""); set("score", Number(e.target.value)); }}>
              <option value="">{a.score != null && a.score !== "" ? letter(Number(a.score)) : "–"}</option>
              {LETTER_NUM.map(([l, n]) => <option key={l} value={n}>{l} ({n})</option>)}
            </select>
          </Field>
        </div>
        <Field label="Status">
          <select className={inputCls} style={inputStyle} value={a.status} onChange={(e) => set("status", e.target.value)}>
            <option value="todo">Not done</option>
            <option value="submitted">Turned in</option>
            <option value="done">Done</option>
          </select>
        </Field>

        <FileList label="Student's work" items={a.attachments} busy={busy === "attachments"} addLabel="Attach a photo or PDF of the work"
          onAdd={(e) => addFiles(e, "attachments")} onRemove={removeFile("attachments")} />
        <FileList label="Answer key (students never see this)" items={a.keyAttachments} busy={busy === "keyAttachments"} addLabel="Attach the answer key"
          onAdd={(e) => addFiles(e, "keyAttachments")} onRemove={removeFile("keyAttachments")} />
        {hasKey && matches.length > 0 && (
          <label className="flex items-center gap-2 mb-3 text-sm" style={{ color: C.ink }}>
            <input type="checkbox" checked={shareKey} onChange={(e) => setShareKey(e.target.checked)} className="w-5 h-5" />
            Use this key for {matches.length} matching {matches.length === 1 ? "assignment" : "assignments"} (same subject, lesson, and type)
          </label>
        )}

        <Btn kind="pencil" className="w-full" disabled={!hasKey || !hasWork || busy === "grade"} onClick={grade}>
          {busy === "grade" ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
          {busy === "grade" ? "Comparing to the key…" : "Suggest a grade"}
        </Btn>
        {(!hasKey || !hasWork) && <p className="text-sm mt-2" style={{ color: C.soft }}>Attach the student's work and the answer key to get a suggested grade.</p>}
        {gradeErr && <p className="text-sm mt-2" style={{ color: C.redpen }}>{gradeErr}</p>}
        {suggest && (
          <div className="mt-3 rounded-lg p-3" style={{ background: C.white, border: `1.5px solid ${C.pencil}` }}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-bold" style={{ color: C.ink }}>Suggested: {suggest.score}% {letter(suggest.score)}</span>
              <span className="text-sm" style={{ color: C.soft }}>{suggest.pointsMissed} points missed</span>
            </div>
            {suggest.summary && <p className="text-sm mt-1 leading-relaxed" style={{ color: C.ink }}>{suggest.summary}</p>}
            {suggest.items.map((x, i) => (
              <div key={i} className="text-sm py-1 border-b" style={{ borderColor: C.rule, color: x.result === "unclear" ? C.soft : C.ink }}>
                <span className="font-semibold">{x.q}</span> {x.result === "unclear" ? "Couldn't read, please check" : `wrote “${x.student}”, key says “${x.expected}”`}
                {x.points ? <span style={{ color: C.redpen }}> −{x.points}</span> : null}
              </div>
            ))}
            <p className="text-xs mt-2" style={{ color: C.soft }}>Check the flagged answers yourself. Handwriting can be misread.</p>
            <div className="flex gap-2 mt-2">
              <Btn className="flex-1" onClick={() => { setMissed(""); setA((p) => ({ ...p, score: suggest.score, status: "done", aiReview: suggest })); }}>Use {suggest.score}%</Btn>
              <Btn kind="ghost" onClick={() => setSuggest(null)}>Dismiss</Btn>
            </div>
          </div>
        )}
      </div>

      {a.type === "Memory Verse" && (
        <Field label="Verse text (your child practices from this)">
          <textarea rows={4} className={inputCls} style={inputStyle} value={a.verseText || ""} onChange={(e) => set("verseText", e.target.value)} />
        </Field>
      )}
      <TeacherAI a={a} setA={setA} student={student} />
      <Field label="Minutes spent (the student's timer fills this in)">
        <input type="number" min="0" inputMode="numeric" className={inputCls} style={inputStyle} value={a.minutes ?? ""} onChange={(e) => set("minutes", e.target.value === "" ? null : Number(e.target.value))} />
      </Field>
      <Field label="Notes (students can see these)">
        <textarea rows={2} className={inputCls} style={inputStyle} value={a.notes || ""} onChange={(e) => set("notes", e.target.value)} />
      </Field>

      <div className="flex gap-3">
        <Btn className="flex-1" disabled={!!busy || !a.subject} onClick={() => onSave(a, shareKey && hasKey ? matches.map((m) => m.id) : [])}>Save assignment</Btn>
        {!isNew && (
          <Btn kind="danger" onClick={() => (confirmDel ? onDelete([a.id], fillGap && initial.status !== "done") : setConfirmDel(true))}>
            <Trash2 size={18} />{confirmDel ? "Delete it" : "Delete"}
          </Btn>
        )}
      </div>
      {confirmDel && (
        <div className="mt-3 rounded-lg p-3" style={{ border: `1.5px solid ${C.redpen}` }}>
          <p className="text-sm mb-2" style={{ color: C.ink }}>Tap Delete it again to remove this {a.type.toLowerCase()}. You can undo for a few seconds afterward.</p>
          {initial.status !== "done" && (
            <label className="flex items-start gap-2 text-sm" style={{ color: C.ink }}>
              <input type="checkbox" className="w-5 h-5 mt-0.5" checked={fillGap} onChange={(e) => setFillGap(e.target.checked)} />
              Move later {a.subject} work up to fill this day
            </label>
          )}
          <button className="text-sm underline mt-2" style={{ color: C.soft }} onClick={() => setConfirmDel(false)}>Keep it</button>
        </div>
      )}
    </Sheet>
  );
}

/* ---------- Today ---------- */
function TodayView({ data, activeStudents, day, setDay, onToggle, onEdit, onAttend, onNew, onShift, onAddEvent, onEditEvent, onPrint }) {
  const ids = new Set(activeStudents.map((s) => s.id));
  const carried = data.assignments.filter((a) => ids.has(a.studentId) && dueOf(a) < day && a.status === "todo").sort((x, y) => dueOf(x).localeCompare(dueOf(y)));
  const upcoming = comingUp(data.assignments.filter((a) => ids.has(a.studentId)), day);
  const review = data.assignments.filter((a) => ids.has(a.studentId) && a.status === "submitted").sort((x, y) => x.due.localeCompare(y.due));
  return (
    <div>
      {review.length > 0 && (
        <section className="mb-6 rounded-xl p-4" style={{ background: "#FFF6D6", border: `1.5px solid ${C.pencil}` }}>
          <h3 className="font-bold" style={{ color: C.ink }}>Turned in, ready to check ({review.length})</h3>
          <p className="text-sm mb-1" style={{ color: C.soft }}>Tap the circle to mark it done, or open it to add a score.</p>
          {review.map((a) => <Row key={a.id} a={a} student={data.students.find((s) => s.id === a.studentId)} showStudent onToggle={onToggle} onEdit={onEdit} />)}
        </section>
      )}
      <div className="flex items-center justify-between mb-4">
        <button aria-label="Previous day" onClick={() => setDay(addDays(day, -1))} className="p-2 rounded focus:outline-none focus:ring-2"><ChevronLeft color={C.ink} /></button>
        <button onClick={() => setDay(todayISO())} className="text-center focus:outline-none focus:ring-2 rounded px-2">
          <div className="text-lg font-bold" style={{ color: C.ink }}>{fmtDate(day, true)}</div>
          {day !== todayISO() && <div className="text-sm underline" style={{ color: C.soft }}>Back to today</div>}
        </button>
        <button aria-label="Next day" onClick={() => setDay(addDays(day, 1))} className="p-2 rounded focus:outline-none focus:ring-2"><ChevronRight color={C.ink} /></button>
      </div>

      {eventsOn(data.events, day, activeStudents.map((s) => s.id)).map((ev) => <EventLine key={ev.id} ev={ev} students={data.students} onClick={() => onEditEvent(ev)} />)}
      {activeStudents.map((s) => {
        const items = data.assignments.filter((a) => a.studentId === s.id && a.due === day);
        const attended = attendanceDays(data, s.id, "9999").includes(day);
        const blocking = eventsOn(data.events, day, [s.id]).find((ev) => ev.noLessons);
        const doneCount = items.filter((a) => a.status === "done").length;
        return (
          <section key={s.id} className="mb-6">
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="text-lg font-bold" style={{ color: C.ink }}>
                {s.name} <span className="font-normal text-base" style={{ color: C.soft }}>{items.length ? `${doneCount} of ${items.length} done` : ""}</span>
              </h3>
              <button onClick={() => onAttend(s.id, day)} className="text-sm font-semibold rounded-full px-3 py-1 focus:outline-none focus:ring-2"
                style={attended ? { background: C.pencil, color: C.ink } : { border: `1.5px solid ${C.ink}`, color: C.ink }}>
                {attended ? "School day ✓" : "Mark school day"}
              </button>
            </div>
            {blocking && <p className="text-sm font-semibold" style={{ color: "#2F7D4F" }}>No lessons: {blocking.title}</p>}
            {items.length ? items.map((a) => <Row key={a.id} a={a} onToggle={onToggle} onEdit={onEdit} />)
              : <p className="py-3" style={{ color: C.soft }}>Nothing assigned for this day.</p>}
          </section>
        );
      })}

      <div className="grid grid-cols-2 gap-3">
        <Btn kind="ghost" onClick={() => onNew(day)}><Plus size={18} />Add assignment</Btn>
        <Btn kind="ghost" onClick={() => onAddEvent(day)}><CalendarDays size={18} />Add event</Btn>
        <Btn kind="ghost" onClick={onShift}><ChevronRight size={18} />Shift schedule</Btn>
        <Btn kind="ghost" onClick={() => onPrint(day)}><Download size={18} />Checklist</Btn>
      </div>

      {carried.length > 0 && (
        <section className="mt-8">
          <h3 className="font-bold mb-1" style={{ color: C.redpen }}>Unfinished from earlier ({carried.length})</h3>
          {carried.map((a) => (
            <div key={a.id}>
              <div className="text-xs pt-2" style={{ color: C.soft }}>Was due {fmtDate(dueOf(a))}</div>
              <Row a={a} student={data.students.find((s) => s.id === a.studentId)} showStudent={activeStudents.length > 1} onToggle={onToggle} onEdit={onEdit} />
            </div>
          ))}
        </section>
      )}
      {upcoming.length > 0 && (
        <section className="mt-8">
          <h3 className="font-bold mb-1" style={{ color: C.ink }}>Coming up ({upcoming.length})</h3>
          <p className="text-sm" style={{ color: C.soft }}>Multi-day work in progress and quizzes or tests in the next week.</p>
          {upcoming.map((a) => <Row key={a.id} a={a} student={data.students.find((s) => s.id === a.studentId)} showStudent={activeStudents.length > 1} onToggle={onToggle} onEdit={onEdit} />)}
        </section>
      )}
    </div>
  );
}

/* ---------- All assignments ---------- */
function ListView({ data, activeStudents, onToggle, onEdit, onNew, onDeleteMany, onDoneMany }) {
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [confirmDel, setConfirmDel] = useState(false);
  const [fillGap, setFillGap] = useState(true);
  const toggleSel = (id) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const endSelect = () => { setSelecting(false); setSel(new Set()); setConfirmDel(false); };
  const [subject, setSubject] = useState("all");
  const [status, setStatus] = useState("todo");
  const ids = new Set(activeStudents.map((s) => s.id));
  const subjects = [...new Set(activeStudents.flatMap((s) => s.subjects))];
  const items = data.assignments
    .filter((a) => ids.has(a.studentId) && (subject === "all" || a.subject === subject) && (status === "all" || (status === "todo" ? a.status !== "done" : a.status === status)))
    .sort((x, y) => (status === "done" ? y.due.localeCompare(x.due) : x.due.localeCompare(y.due)));
  const [limit, setLimit] = useState(150);
  const groups = items.slice(0, limit).reduce((m, a) => ((m[a.due] ||= []).push(a), m), {});

  function exportCSV() {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    // Same columns the spreadsheet import reads, so an exported log can be re-imported
    const rows = [["Student", "Lesson", "Subject", "Type", "Assignment", "Date", "Due by", "Score", "Status", "Notes", "Grade"]];
    data.assignments.filter((a) => ids.has(a.studentId)).sort((x, y) => x.due.localeCompare(y.due)).forEach((a) => {
      const s = data.students.find((x) => x.id === a.studentId);
      rows.push([s?.name, a.lesson, a.subject, a.type, a.title, a.due, a.dueBy || "", a.score, a.status === "done" ? "Done" : a.status === "submitted" ? "Turned in" : "", a.notes, s?.grade]);
    });
    const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a"); el.href = url; el.download = `school-log-${todayISO()}.csv`;
    document.body.appendChild(el); el.click(); el.remove(); URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <select className={inputCls} style={inputStyle} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject">
          <option value="all">All subjects</option>
          {subjects.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className={inputCls} style={inputStyle} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="todo">Not done</option>
          <option value="submitted">Turned in</option>
          <option value="done">Done</option>
          <option value="all">Everything</option>
        </select>
      </div>
      <div className="flex gap-3 mb-4">
        <Btn className="flex-1" onClick={() => onNew(todayISO())}><Plus size={18} />Add assignment</Btn>
        <Btn kind="ghost" onClick={exportCSV} aria-label="Download log as spreadsheet"><Download size={18} />Log</Btn>
        <Btn kind={selecting ? "primary" : "ghost"} onClick={() => (selecting ? endSelect() : setSelecting(true))}>{selecting ? "Done" : "Select"}</Btn>
      </div>
      {selecting && (
        <div className="sticky z-20 rounded-xl p-3 mb-4" style={{ top: 8, background: C.white, border: `1.5px solid ${C.ink}`, boxShadow: "0 4px 14px rgba(27,42,74,.12)" }}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="font-semibold" style={{ color: C.ink }}>{sel.size} selected</span>
            <button className="text-sm underline" style={{ color: C.ink }} onClick={() => setSel(sel.size === items.length ? new Set() : new Set(items.map((a) => a.id)))}>
              {sel.size === items.length && items.length ? "Clear" : `Select all ${items.length}`}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Btn kind="ghost" disabled={!sel.size} onClick={() => { onDoneMany([...sel]); endSelect(); }}><Check size={18} />Mark done</Btn>
            <Btn kind="danger" disabled={!sel.size} onClick={() => (confirmDel ? (onDeleteMany([...sel], fillGap), endSelect()) : setConfirmDel(true))}>
              <Trash2 size={18} />{confirmDel ? `Delete ${sel.size}` : "Delete"}
            </Btn>
          </div>
          {confirmDel && (
            <label className="flex items-start gap-2 mt-2 text-sm" style={{ color: C.ink }}>
              <input type="checkbox" className="w-5 h-5 mt-0.5" checked={fillGap} onChange={(e) => setFillGap(e.target.checked)} />
              Move later work in the same subjects up to fill the emptied days. Tap Delete {sel.size} to confirm; you can undo right after.
            </label>
          )}
        </div>
      )}
      {Object.keys(groups).length === 0 && <Empty>No assignments match these filters.</Empty>}
      {Object.entries(groups).map(([due, list]) => (
        <div key={due} className="mb-4">
          <div className="text-sm font-bold pt-2" style={{ color: due < todayISO() && status !== "done" ? C.redpen : C.soft }}>{fmtDate(due)}</div>
          {list.map((a) => {
            const row = <Row key={a.id} a={a} student={data.students.find((s) => s.id === a.studentId)} showStudent={activeStudents.length > 1} onToggle={onToggle} onEdit={onEdit} />;
            return selecting ? (
              <div key={a.id} className="flex items-center gap-2">
                <input type="checkbox" className="w-5 h-5 flex-shrink-0" checked={sel.has(a.id)} onChange={() => toggleSel(a.id)} aria-label={`Select ${a.title || a.type}`} />
                <div className="flex-1 min-w-0">{row}</div>
              </div>
            ) : row;
          })}
        </div>
      ))}
      {items.length > limit && <Btn kind="ghost" className="w-full mt-2" onClick={() => setLimit((l) => l + 150)}>Show more ({items.length - limit} left)</Btn>}
    </div>
  );
}

/* ---------- Import with AI ---------- */
function PhotoImport({ students, onAdd, onMerge, flash, events = [], settings = {}, onSettings, data }) {
  const [studentId, setStudentId] = useState(students[0]?.id || "");
  const [byLesson, setByLesson] = useState(true);
  const [start, setStart] = useState(todayISO());
  const [files, setFiles] = useState([]);
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [keepCopy, setKeepCopy] = useState(true);
  const student = students.find((s) => s.id === studentId) || students[0];
  const lesson1 = settings.startDate || todayISO();
  const year = useMemo(() => schoolDayList(lesson1, 200, blockedFn(events, student.id)), [lesson1, events, student.id]);
  const fromStart = (n) => schoolDayList(start, n + 1, blockedFn(events, student.id))[n];
  const dateFor = (x) => (byLesson && x.lesson ? year[x.lesson - 1] || schoolDayList(lesson1, x.lesson, blockedFn(events, student.id))[x.lesson - 1] : fromStart(x.day));
  // A lesson already planned (e.g. "Language lesson 23") gets these page details instead of a duplicate
  const existingFor = (x) => (data?.assignments || []).find((a) => a.studentId === student.id && a.subject === x.subject && a.lesson && a.lesson === x.lesson && a.type === x.type && a.status !== "done");

  function pick(e) {
    const ok = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];
    const list = [...e.target.files].filter((f) => ok.includes(f.type)).slice(0, 12);
    e.target.value = "";
    if (!list.length) { setError("Use JPG, PNG, WEBP, or PDF files."); return; }
    setFiles(list); setItems(null); setError("");
  }

  async function read() {
    setError(""); const all = [];
    for (let p = 0; p < files.length; p++) {
      setBusy(`Reading page ${p + 1} of ${files.length}…`);
      try {
        const text = await askClaude([await fileBlock(files[p]), { type: "text", text: `This is a page from an Abeka homeschool resource for a grade ${student.grade} student: most likely the Curriculum Lesson Plans (a teacher/parent book organized by numbered lessons), or a daily schedule, assignment sheet, or workbook page.
The student's subjects are: ${student.subjects.join(", ")}.
Extract every assignment a parent would need to track, including quizzes, tests, exams, book reports, and homework, with their numbers (for example "Quiz 7" or "Test 3").
Respond with ONLY a JSON array, no prose:
[{"subject": the closest match from the student's subjects, "lesson": the Abeka lesson number printed on the page for this assignment as an integer, or null if none is shown, "type": one of ${JSON.stringify(TYPES)}, "title": a short plain description with page numbers if shown, "day": 0-based index of the day within this page if it covers several days and shows no lesson numbers, otherwise 0}]
If nothing on the page is an assignment, return [].` }]);
        const parsed = parseJSONLoose(text);
        for (const x of Array.isArray(parsed) ? parsed : []) {
          const subject = student.subjects.includes(x.subject) ? x.subject : matchSubject(x.subject, student.subjects) || student.subjects[0];
          const item = {
            page: p, subject,
            lesson: Number.isInteger(x.lesson) && x.lesson > 0 ? x.lesson : null,
            type: TYPES.includes(x.type) ? x.type : matchType(x.type),
            title: String(x.title || "").slice(0, 200),
            day: Number.isInteger(x.day) && x.day >= 0 ? x.day : 0,
          };
          item.pick = true;
          all.push(item);
        }
      } catch {
        setError(`Page ${p + 1} couldn't be read. Try a straight-on, well-lit photo of it.`);
      }
    }
    setBusy("");
    if (!all.length) setError((e) => e || "No assignments were found. Try clearer photos of the lesson plan pages.");
    setItems(all);
  }

  async function add() {
    const chosen = items.filter((x) => x.pick);
    if (!chosen.length) return;
    setBusy("Saving…");
    const pageAtt = {};
    if (keepCopy) {
      for (const p of new Set(chosen.map((x) => x.page))) {
        try { pageAtt[p] = await storeFile(files[p]); } catch (e) { flash(e.message); }
      }
    }
    const now = Date.now();
    const adds = [], updates = [];
    for (const x of chosen) {
      const ex = existingFor(x);
      const att = pageAtt[x.page] ? [pageAtt[x.page]] : [];
      if (ex) updates.push({ id: ex.id, title: x.title || ex.title, attachments: [...(ex.attachments || []), ...att] });
      else adds.push({ id: uid(), studentId: student.id, subject: x.subject, lesson: x.lesson, type: x.type, title: x.title, due: dateFor(x), status: "todo", score: null, notes: "", attachments: att, createdAt: now });
    }
    onMerge(adds, updates);
    setBusy(""); setItems(null); setFiles([]);
  }

  const upd = (i, k, v) => setItems((p) => p.map((x, n) => (n === i ? { ...x, [k]: v } : x)));
  const chosen = items ? items.filter((x) => x.pick) : [];
  const nUpdates = chosen.filter((x) => existingFor(x)).length;

  return (
    <div>
      <p className="mb-4 leading-relaxed" style={{ color: C.ink }}>
        Photograph pages from your Abeka Curriculum Lesson Plans (or any assignment page), up to 12 at a time. Each assignment is placed on the school day that matches its lesson number, and lessons you've already planned get the page details filled in.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Student">
          <select className={inputCls} style={inputStyle} value={student.id} onChange={(e) => setStudentId(e.target.value)}>
            {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Lesson 1 date">
          <input type="date" className={inputCls} style={inputStyle} value={lesson1} onChange={(e) => onSettings?.({ startDate: e.target.value })} />
        </Field>
      </div>
      <label className="flex items-start gap-2 mb-3" style={{ color: C.ink }}>
        <input type="checkbox" className="w-5 h-5 mt-0.5" checked={byLesson} onChange={(e) => setByLesson(e.target.checked)} />
        <span>Place by lesson number <span className="block text-sm" style={{ color: C.soft }}>Lesson 23 goes on the 23rd school day, skipping weekends and no-lesson days.</span></span>
      </label>
      {(!byLesson || (items && items.some((x) => !x.lesson))) && (
        <Field label={byLesson ? "Date for work with no lesson number" : "First school day on these pages"}>
          <input type="date" className={inputCls} style={inputStyle} value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
      )}

      <label className="flex flex-col items-center justify-center gap-2 rounded-xl p-6 mb-3 cursor-pointer text-center" style={{ border: `2px dashed ${C.soft}`, background: C.white, color: C.ink }}>
        <Upload size={28} />
        <span className="font-semibold">{files.length ? `${files.length} ${files.length === 1 ? "page" : "pages"} chosen` : "Choose photos or PDFs"}</span>
        <input type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={pick} />
      </label>

      <Btn kind="pencil" className="w-full mb-3" disabled={!files.length || !!busy} onClick={read}>
        {busy ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
        {busy || "Read assignments"}
      </Btn>
      {error && <p className="mb-3" style={{ color: C.redpen }}>{error}</p>}

      {items && items.length > 0 && (
        <div className="mt-2">
          <h3 className="font-bold mb-2" style={{ color: C.ink }}>Check these before adding</h3>
          {items.map((x, i) => {
            const ex = existingFor(x);
            return (
              <div key={i} className="flex gap-3 py-3 border-b" style={{ borderColor: C.rule }}>
                <input type="checkbox" checked={x.pick} onChange={(e) => upd(i, "pick", e.target.checked)} className="mt-2 w-5 h-5" aria-label="Include" />
                <div className="flex-1 space-y-2 min-w-0">
                  <input className={inputCls} style={inputStyle} value={x.title} onChange={(e) => upd(i, "title", e.target.value)} aria-label="Assignment" />
                  <div className="grid grid-cols-3 gap-2">
                    <select className={inputCls} style={inputStyle} value={x.subject} onChange={(e) => upd(i, "subject", e.target.value)} aria-label="Subject">
                      {student.subjects.map((s) => <option key={s}>{s}</option>)}
                    </select>
                    <input type="number" placeholder="Lesson" className={inputCls} style={inputStyle} value={x.lesson ?? ""} onChange={(e) => upd(i, "lesson", e.target.value === "" ? null : Number(e.target.value))} aria-label="Lesson number" />
                    <select className={inputCls} style={inputStyle} value={x.type} onChange={(e) => upd(i, "type", e.target.value)} aria-label="Type">
                      {TYPES.map((t) => <option key={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="text-sm" style={{ color: ex ? "#2F7D4F" : C.soft }}>
                    {ex ? `Fills in ${ex.title} (${fmtDate(ex.due)})` : `${fmtDate(dateFor(x))}${files.length > 1 ? `, page ${x.page + 1}` : ""}`}
                  </div>
                </div>
              </div>
            );
          })}
          <label className="flex items-center gap-2 my-3" style={{ color: C.ink }}>
            <input type="checkbox" checked={keepCopy} onChange={(e) => setKeepCopy(e.target.checked)} className="w-5 h-5" />
            Attach each page to its assignments
          </label>
          <Btn className="w-full" disabled={!!busy || !chosen.length} onClick={add}>
            {nUpdates ? `Add ${chosen.length - nUpdates}, update ${nUpdates}` : `Add ${chosen.length} assignments`}
          </Btn>
        </div>
      )}
    </div>
  );
}

/* ---------- Spreadsheet import (CSV / Excel) ---------- */
const HEADERS = {
  student: ["student", "name", "child", "studentname"],
  lesson: ["lesson", "lessonno", "lessonnumber", "lessonnum", "day", "dayno"],
  subject: ["subject", "course", "class"],
  type: ["type", "kind", "category", "assignmenttype"],
  title: ["assignment", "title", "description", "task", "work", "details"],
  due: ["date", "doon", "scheduled", "workon", "assigned"],
  dueBy: ["dueby", "due", "duedate", "deadline"],
  score: ["score", "percent", "points", "numericgrade"],
  status: ["status", "done", "complete", "completed"],
  notes: ["notes", "note", "comments"],
};
const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const SUBJECT_ALTS = { math: "arith", arithmetic: "math", english: "language", language: "english", grammar: "language", handwriting: "penmanship", cursive: "penmanship", penmanship: "cursive", phonics: "phonics", geography: "history" };

function matchSubject(raw, subjects) {
  const n = norm(raw);
  if (!n) return null;
  const ns = subjects.map((s) => [s, norm(s)]);
  return (ns.find(([, x]) => x === n)
    || ns.find(([, x]) => x.startsWith(n) || n.startsWith(x))
    || (SUBJECT_ALTS[n] && ns.find(([, x]) => x.includes(SUBJECT_ALTS[n])))
    || ns.find(([, x]) => x.includes(n) || n.includes(x)) || [null])[0];
}
function matchType(raw) {
  const n = norm(raw);
  if (!n) return "Lesson";
  const alias = { hw: "Homework", homework: "Homework", drill: "Speed Drill", verse: "Memory Verse", bookreport: "Book Report", worksheet: "Seatwork", final: "Exam" };
  if (alias[n]) return alias[n];
  return TYPES.find((t) => norm(t) === n) || TYPES.find((t) => n.startsWith(norm(t)) || norm(t).startsWith(n)) || "Lesson";
}
function parseDate(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildRows(raw, students, fallbackId, startDate, events = []) {
  if (!raw.length) return [];
  const lists = {};
  const lessonDay = (sid, n) => {
    const l = (lists[sid] ||= schoolDayList(startDate, 200, blockedFn(events, sid)));
    return l[n - 1] || schoolDayList(startDate, n, blockedFn(events, sid))[n - 1];
  };
  const keys = Object.keys(raw[0]);
  const col = {};
  for (const [field, aliases] of Object.entries(HEADERS)) col[field] = keys.find((k) => aliases.includes(norm(k)));
  const fallback = students.find((s) => s.id === fallbackId) || students[0];
  return raw.map((r) => {
    const get = (f) => (col[f] ? String(r[col[f]] ?? "").trim() : "");
    const warn = [];
    const name = get("student");
    let student = name ? students.find((s) => norm(s.name) === norm(name)) : fallback;
    if (!student) { student = fallback; warn.push(`No student named “${name}”, so it goes to ${fallback.name}`); }
    const rawSubject = get("subject");
    let subject = matchSubject(rawSubject, student.subjects);
    let newSubject = false;
    if (!subject && rawSubject) { subject = rawSubject; newSubject = true; warn.push(`Adds “${rawSubject}” as a new subject`); }
    const lessonNum = parseInt(get("lesson"), 10);
    const lesson = Number.isInteger(lessonNum) && lessonNum > 0 ? lessonNum : null;
    const dateGiven = parseDate(get("due"));
    const dueByGiven = parseDate(get("dueBy"));
    const due = dateGiven || (lesson ? lessonDay(student.id, lesson) : dueByGiven || lessonDay(student.id, 1));
    const scoreNum = parseFloat(get("score"));
    const title = get("title");
    return {
      pick: !!subject && !!(title || lesson),
      warn: !subject ? ["Missing a subject, so it's skipped"] : warn,
      studentId: student.id, studentName: student.name, subject, newSubject, lesson,
      type: matchType(get("type")), title, due,
      score: Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, scoreNum)) : null,
      status: /^(done|yes|y|x|complete|completed|true|1|✓)$/i.test(get("status")) ? "done" : /^(turned ?in|submitted)$/i.test(get("status")) ? "submitted" : "todo",
      notes: get("notes"),
      dueBy: dueByGiven && dueByGiven > due ? dueByGiven : null,
    };
  });
}

// Example: first two weeks (lessons 1–10) of Abeka Grade 4. Graded items sit on the lesson
// numbers from Abeka Academy's Grade 4 first-grading-period progress report.
function exampleRows(student = "") {
  const daily = [
    ["Bible", "Bible lesson and memory passage practice"],
    ["Language", "Language lesson and seatwork"],
    ["Reading", "Oral reading and story questions"],
    ["Spelling & Vocabulary", "Spelling list practice"],
    ["Penmanship", "Penmanship practice page"],
    ["Arithmetic", "Arithmetic lesson, speed drill, and homework"],
    ["Science", "Science reading and Comprehension Check"],
    ["History & Geography", "History reading and map work"],
  ];
  const graded = [
    [5, "History & Geography", "Quiz", "History Quiz 1"],
    [6, "Science", "Quiz", "Science Quiz 1"],
    [7, "Arithmetic", "Quiz", "Arithmetic Quiz 1"],
    [7, "Language", "Quiz", "Language Quiz 1"],
    [8, "History & Geography", "Quiz", "History Quiz 2"],
    [8, "Spelling & Vocabulary", "Test", "Spelling Test 1"],
    [9, "Penmanship", "Test", "Penmanship Test 1"],
    [10, "Science", "Quiz", "Science Quiz 2"],
    [10, "Reading", "Seatwork", "Reading comprehension skill sheet (graded)"],
  ];
  const rows = [];
  for (let n = 1; n <= 10; n++) {
    for (const [subject, text] of daily) rows.push({ Student: student, Lesson: n, Subject: subject, Type: "Lesson", Assignment: text, Date: "", "Due by": "", Score: "", Status: "", Notes: "" });
    for (const [l, subject, type, text] of graded) if (l === n) rows.push({ Student: student, Lesson: n, Subject: subject, Type: type, Assignment: text, Date: "", "Due by": "", Score: "", Status: "", Notes: "Graded" });
  }
  return rows;
}
function downloadTemplate() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exampleRows());
  ws["!cols"] = [{ wch: 12 }, { wch: 8 }, { wch: 22 }, { wch: 12 }, { wch: 44 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws, "Lesson plan");
  const how = XLSX.utils.aoa_to_sheet([
    ["How to fill in the Lesson plan sheet"],
    ["Student", "Leave blank to use the student picked in the app. Type a name to import for several children at once."],
    ["Lesson", "Abeka lesson number, 1–170. With no Date, the lesson is scheduled on that school day counting from your Lesson 1 date (weekends skipped)."],
    ["Subject", "Matches the student's subjects. Math finds Arithmetic, English finds Language, and so on. A new name is added as a subject."],
    ["Type", TYPES.join(", ")],
    ["Assignment", "What to do, such as pages or the quiz number."],
    ["Date", "Optional. The day to do the work. Overrides the lesson-number schedule."],
    ["Due by", "Optional. A later deadline for work that takes several days, like a book report or project."],
    ["Score", "Optional percent, 0–100."],
    ["Status", "Optional. Type Done for finished work."],
    ["Notes", "Optional."],
  ]);
  how["!cols"] = [{ wch: 12 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, how, "How to use");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const url = URL.createObjectURL(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a"); a.href = url; a.download = "abeka-lesson-plan-template.xlsx";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function SheetImport({ students, settings, onSettings, onAdd, flash, events }) {
  const [studentId, setStudentId] = useState(students[0]?.id || "");
  const [raw, setRaw] = useState(null);
  const [source, setSource] = useState("");
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const start = settings.startDate || todayISO();

  useEffect(() => { if (raw) setRows(buildRows(raw, students, studentId, start, events)); }, [raw, studentId, start, students, events]);

  async function pick(e) {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    setError("");
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false, dateNF: "yyyy-mm-dd" });
      if (!data.length) throw new Error("empty");
      const keys = Object.keys(data[0]).map(norm);
      if (!HEADERS.subject.some((h) => keys.includes(h))) {
        setError("The first row needs column names, including Subject. Download the template to see the layout.");
        return;
      }
      setSource(f.name); setRaw(data);
    } catch {
      setError("That file couldn't be opened. Save it as .xlsx or .csv and try again.");
    }
  }
  function loadExample() { setError(""); setSource("Example: Grade 4, lessons 1–10"); setRaw(exampleRows()); }

  function add() {
    const chosen = rows.filter((r) => r.pick);
    const now = Date.now();
    const newSubjects = {};
    chosen.forEach((r) => { if (r.newSubject) (newSubjects[r.studentId] ||= new Set()).add(r.subject); });
    onAdd(chosen.map((r) => ({
      id: uid(), studentId: r.studentId, subject: r.subject, lesson: r.lesson, type: r.type,
      title: r.title || `${r.subject} lesson ${r.lesson}`, due: r.due, dueBy: r.dueBy, status: r.status, score: r.score,
      notes: r.notes, attachments: [], createdAt: now,
    })), Object.fromEntries(Object.entries(newSubjects).map(([k, v]) => [k, [...v]])));
    setRaw(null); setRows(null); setSource("");
  }
  const toggle = (i) => setRows((p) => p.map((r, n) => (n === i ? { ...r, pick: !r.pick } : r)));
  const count = rows ? rows.filter((r) => r.pick).length : 0;
  const multi = rows && new Set(rows.map((r) => r.studentId)).size > 1;

  return (
    <div>
      <p className="mb-4 leading-relaxed" style={{ color: C.ink }}>
        Import a whole grading period from Excel or a CSV file. Abeka numbers every lesson 1–170 in each subject, and lesson 1 is day 1, so a lesson number is all it takes to put work on the right day.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Student (if the file has no Student column)">
          <select className={inputCls} style={inputStyle} value={studentId} onChange={(e) => setStudentId(e.target.value)}>
            {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Lesson 1 date">
          <input type="date" className={inputCls} style={inputStyle} value={start} onChange={(e) => onSettings({ startDate: e.target.value })} />
        </Field>
      </div>

      <label className="flex flex-col items-center justify-center gap-2 rounded-xl p-6 mb-3 cursor-pointer text-center" style={{ border: `2px dashed ${C.soft}`, background: C.white, color: C.ink }}>
        <FileSpreadsheet size={28} />
        <span className="font-semibold">{source || "Choose an .xlsx or .csv file"}</span>
        <input type="file" accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" className="hidden" onChange={pick} />
      </label>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Btn kind="ghost" onClick={downloadTemplate}><Download size={18} />Template</Btn>
        <Btn kind="pencil" onClick={loadExample}><Sparkles size={18} />Try example</Btn>
      </div>
      {error && <p className="mb-3" style={{ color: C.redpen }}>{error}</p>}

      {rows && (
        <div className="mt-2">
          <div className="flex items-baseline justify-between mb-1">
            <h3 className="font-bold" style={{ color: C.ink }}>{rows.length} rows found</h3>
            <button className="text-sm underline focus:outline-none focus:ring-2 rounded" style={{ color: C.soft }} onClick={() => setRows((p) => p.map((r) => ({ ...r, pick: !!r.subject && !count })))}>
              {count ? "Uncheck all" : "Check all"}
            </button>
          </div>
          <div className="mb-3">
            {rows.map((r, i) => (
              <label key={i} className="flex gap-3 py-2 border-b cursor-pointer" style={{ borderColor: C.rule }}>
                <input type="checkbox" checked={r.pick} disabled={!r.subject} onChange={() => toggle(i)} className="mt-1 w-5 h-5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold leading-snug" style={{ color: C.ink }}>{r.title || `${r.subject || "?"} lesson ${r.lesson ?? "?"}`}</div>
                  <div className="text-sm flex flex-wrap gap-x-3" style={{ color: C.soft }}>
                    {r.subject && <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: dotColor(r.subject) }} />{r.subject}</span>}
                    {r.lesson && <span>Lesson {r.lesson}</span>}
                    <span>{r.type}</span>
                    <span>{fmtDate(r.due)}</span>
                    {multi && <span>{r.studentName}</span>}
                  </div>
                  {r.warn.map((w, k) => <div key={k} className="text-sm" style={{ color: C.redpen }}>{w}</div>)}
                </div>
              </label>
            ))}
          </div>
          <Btn className="w-full" disabled={!count} onClick={add}>Add {count} assignments</Btn>
        </div>
      )}
    </div>
  );
}

/* ---------- Plan a subject from its book ---------- */
function DayChips({ days, onChange, label }) {
  const cur = days?.length ? days : [1, 2, 3, 4, 5];
  return (
    <div className="flex gap-1" role="group" aria-label={label}>
      {WEEKDAY_LABELS.map(([n, l]) => {
        const on = cur.includes(n);
        return (
          <button key={n} type="button" aria-pressed={on}
            onClick={() => { const next = on ? cur.filter((x) => x !== n) : [...cur, n].sort(); if (next.length) onChange(next.length === 5 ? null : next); }}
            className="rounded px-1.5 py-0.5 text-xs font-semibold focus:outline-none focus:ring-2"
            style={on ? { background: C.ink, color: C.white } : { background: C.white, color: C.soft, border: "1px solid #C3D3EA" }}>{l}</button>
        );
      })}
    </div>
  );
}
// Spread units across sessions in proportion to their weight, at least one session each
function expandUnits(units, n) {
  const us = units.slice(0, n);
  const w = us.map((u) => Math.max(0.1, Number(u.weight) || (u.startPage && u.endPage ? u.endPage - u.startPage + 1 : 1)));
  const total = w.reduce((a, b) => a + b, 0);
  const counts = w.map((x) => Math.max(1, Math.floor((x / total) * n)));
  let diff = n - counts.reduce((a, b) => a + b, 0);
  const order = w.map((x, i) => [x / total * n - Math.floor(x / total * n), i]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  for (let k = 0; diff > 0; k++, diff--) counts[order[k % order.length]]++;
  for (let k = 0; diff < 0 && k < 1000; k++) { const i = counts.indexOf(Math.max(...counts)); if (counts[i] > 1) { counts[i]--; diff++; } }
  const out = [];
  us.forEach((u, i) => {
    const k = counts[i];
    const hasPages = Number.isInteger(u.startPage) && Number.isInteger(u.endPage) && u.endPage >= u.startPage;
    for (let j = 0; j < k; j++) {
      const isReview = u.review && k >= 2 && j === k - 1;
      let title = u.title;
      if (isReview) title = `${u.title}: review`;
      else if (hasPages) {
        const span = u.endPage - u.startPage + 1, parts = u.review && k >= 2 ? k - 1 : k;
        const ps = u.startPage + Math.floor((j * span) / parts), pe = Math.max(ps, u.startPage + Math.floor(((j + 1) * span) / parts) - 1);
        title = `${u.title}, ${ps === pe ? `p. ${ps}` : `pp. ${ps}–${pe}`}`;
      } else if (k > 1) title = `${u.title} (part ${j + 1} of ${u.review ? k - 1 : k})`;
      out.push({ title, type: isReview ? "Review" : "Lesson" });
    }
  });
  return out;
}

function BookPlan({ data, student, onReplace, onUpdateStudent }) {
  const [subject, setSubject] = useState(student.subjects.find((x) => /health/i.test(x)) || student.subjects[0]);
  const [book, setBook] = useState("");
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(data.settings.lessonsPerYear || 170);
  const [photos, setPhotos] = useState([]);
  const [plan, setPlan] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [replace, setReplace] = useState(true);
  const days = student.schedule?.[subject];
  const setDays = (d) => { onUpdateStudent({ ...student, schedule: { ...(student.schedule || {}), [subject]: d || undefined } }); setPlan(null); };
  const sessions = useMemo(() => {
    if (!(to >= from)) return [];
    const year = schoolDayList(data.settings.startDate || todayISO(), to, blockedFn(data.events, student.id));
    const meets = (d) => !days?.length || days.includes(new Date(d + "T12:00:00").getDay());
    const out = [];
    for (let k = from; k <= to; k++) if (year[k - 1] && meets(year[k - 1])) out.push({ lesson: k, date: year[k - 1] });
    return out;
  }, [from, to, days?.join(), data.events, data.settings.startDate, student.id]);
  const existing = data.assignments.filter((a) => a.studentId === student.id && a.subject === subject && ["Lesson", "Review"].includes(a.type) && a.status === "todo" && !(a.attachments || []).length).length;

  async function build() {
    setBusy(true); setErr(""); setPlan(null);
    try {
      const blocks = [];
      for (const f of photos) blocks.push(await fileBlock(f));
      const n = sessions.length;
      const text = await askClaude([...blocks, { type: "text", text: `I homeschool a grade ${student.grade} student and need to spread the book "${book.trim()}" across ${n} class sessions of ${subject}.
${blocks.length
  ? "The attached photos are the book's table of contents. List its chapters or sections in order as units, with each unit's first and last page taken from the contents. Use each unit's number of pages as its weight. Set review to true only if the contents show a review, check-up, or test for that unit."
  : "I don't have the table of contents. List the book's main units in a sensible teaching order based only on what you reliably know about this book. Use null for every page number, and use general topic names instead of guessing chapter titles you aren't sure of. Give each unit a weight for how much class time it deserves, and set review to false."}
Use at most ${Math.min(n, 40)} units.
Respond with ONLY JSON: {"units": [{"title": "short unit title", "startPage": number or null, "endPage": number or null, "weight": number, "review": false}], "note": "one short sentence about anything the parent should double-check"}` }]);
      const j = parseJSONLoose(text);
      const units = (j.units || []).filter((u) => u && u.title).map((u) => ({
        title: String(u.title).slice(0, 80),
        startPage: Number.isInteger(u.startPage) ? u.startPage : null, endPage: Number.isInteger(u.endPage) ? u.endPage : null,
        weight: Number(u.weight) || 1, review: !!u.review && !!blocks.length,
      }));
      if (!units.length) throw new Error();
      setPlan(expandUnits(units, n));
      setNote(String(j.note || ""));
    } catch { setErr("The plan couldn't be built. Check the book title, or try clearer photos of the contents."); }
    setBusy(false);
  }
  function add() {
    const now = Date.now();
    const items = plan.map((p, i) => ({
      id: uid(), studentId: student.id, subject, lesson: sessions[i].lesson, type: p.type, title: p.title, book: book.trim(),
      due: sessions[i].date, status: "todo", score: null, notes: "", attachments: [], createdAt: now,
    }));
    onReplace(student.id, subject, items, replace);
    setPlan(null); setPhotos([]);
  }

  return (
    <div className="rounded-xl p-4 mt-8" style={{ background: C.white, border: `1.5px solid ${C.ink}` }}>
      <h3 className="text-lg font-bold mb-1" style={{ color: C.ink }}>Plan a subject from its book</h3>
      <p className="text-sm mb-3 leading-relaxed" style={{ color: C.ink }}>
        For books that don't run every day or all year. Add photos of the table of contents and the chapters and page ranges are spread across the right days.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Subject">
          <select className={inputCls} style={inputStyle} value={subject} onChange={(e) => { setSubject(e.target.value); setPlan(null); }}>
            {student.subjects.map((x) => <option key={x}>{x}</option>)}
          </select>
        </Field>
        <div className="mb-3">
          <span className="block text-sm mb-1" style={{ color: C.soft }}>Meets on</span>
          <DayChips days={days} onChange={setDays} label={`${subject} meeting days`} />
        </div>
      </div>
      <Field label="Book">
        <input className={inputCls} style={inputStyle} placeholder="e.g. Abeka Health, Safety, and Manners 2 (4th ed.)" value={book} onChange={(e) => { setBook(e.target.value); setPlan(null); }} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts at lesson"><input type="number" min="1" className={inputCls} style={inputStyle} value={from} onChange={(e) => { setFrom(Math.max(1, Number(e.target.value) || 1)); setPlan(null); }} /></Field>
        <Field label="Ends at lesson"><input type="number" min="1" className={inputCls} style={inputStyle} value={to} onChange={(e) => { setTo(Math.max(1, Number(e.target.value) || 1)); setPlan(null); }} /></Field>
      </div>
      <p className="text-xs -mt-1 mb-3 leading-relaxed" style={{ color: C.soft }}>
        Lesson numbers are the school year's days (1–170). Some books cover only part of the year; in Abeka grade 3, for example, Health runs lessons 121–170 in place of Science. Check the schedule page in your lesson plan book.
      </p>
      <label className="inline-flex items-center gap-2 mb-3 cursor-pointer font-semibold" style={{ color: C.ink }}>
        <Camera size={18} />{photos.length ? `${photos.length} contents ${photos.length === 1 ? "page" : "pages"} added` : "Photos of the table of contents"}
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple className="hidden" onChange={(e) => { setPhotos([...e.target.files].slice(0, 6)); setPlan(null); e.target.value = ""; }} />
      </label>
      {!photos.length && <p className="text-xs mb-3" style={{ color: C.redpen }}>Without the contents, you'll get a topic outline with no page numbers.</p>}
      <p className="mb-3" style={{ color: C.ink }}>
        {sessions.length ? `${sessions.length} class sessions, ${fmtDate(sessions[0].date)} to ${fmtDate(sessions[sessions.length - 1].date)}.` : "No class days in that range."}
      </p>
      <Btn kind="pencil" className="w-full" disabled={!book.trim() || !sessions.length || busy} onClick={build}>
        {busy ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}{busy ? "Planning the book…" : "Build the plan"}
      </Btn>
      {err && <p className="text-sm mt-2" style={{ color: C.redpen }}>{err}</p>}
      {plan && (
        <div className="mt-4">
          {note && <p className="text-sm mb-2 rounded-lg p-2" style={{ background: "#FFF6D6", color: C.ink }}>{note}</p>}
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            {plan.map((p, i) => (
              <div key={i} className="flex gap-3 py-1.5 border-b text-sm" style={{ borderColor: C.rule }}>
                <span className="flex-shrink-0" style={{ color: C.soft, width: 92 }}>{fmtDate(sessions[i].date)}</span>
                <span style={{ color: C.ink }}>{p.title}{p.type === "Review" && <span style={{ color: C.soft }}> (review)</span>}</span>
              </div>
            ))}
          </div>
          {existing > 0 && (
            <label className="flex items-start gap-2 my-3 text-sm" style={{ color: C.ink }}>
              <input type="checkbox" className="w-5 h-5 mt-0.5" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              Replace the {existing} unfinished {subject} lessons already planned (finished work and quizzes stay)
            </label>
          )}
          <Btn className="w-full mt-2" onClick={add}><Plus size={18} />Add {plan.length} {subject} lessons</Btn>
        </div>
      )}
    </div>
  );
}

/* ---------- Lesson planner ---------- */
function PlanLessons({ data, students, onAdd, onReplace, onUpdateStudent }) {
  const [sid, setSid] = useState(students[0]?.id);
  const s = students.find((x) => x.id === sid) || students[0];
  const [subs, setSubs] = useState(null);
  const chosen = subs ?? s.subjects;
  const [first, setFirst] = useState(1);
  const [last, setLast] = useState(data.settings.lessonsPerYear || 170);
  const [start, setStart] = useState(data.settings.startDate || todayISO());
  const plan = useMemo(() => {
    if (!(last >= first) || !chosen.length) return { items: [] };
    const days = schoolDayList(start, last - first + 1, blockedFn(data.events, s.id));
    const have = new Set(data.assignments.filter((a) => a.studentId === s.id && a.type === "Lesson" && a.lesson).map((a) => `${a.subject}|${a.lesson}`));
    const now = Date.now();
    const items = [];
    const meets = (sub, d) => { const ds = s.schedule?.[sub]; return !ds?.length || ds.includes(new Date(d + "T12:00:00").getDay()); };
    for (let n = first; n <= last; n++) {
      for (const sub of chosen) {
        if (have.has(`${sub}|${n}`) || !meets(sub, days[n - first])) continue;
        items.push({ id: uid(), studentId: s.id, subject: sub, lesson: n, type: "Lesson", title: `${sub} lesson ${n}`, due: days[n - first], status: "todo", score: null, notes: "", attachments: [], createdAt: now });
      }
    }
    return { items, from: days[0], to: days[days.length - 1] };
  }, [s.id, chosen.join("|"), first, last, start, data.events, data.assignments, JSON.stringify(s.schedule || {})]);

  return (
    <div>
      <p className="mb-4 leading-relaxed" style={{ color: C.ink }}>
        Abeka moves one lesson per subject each school day, so lesson 9 today means lesson 10 on the next school day. This lays out the year that way, skipping weekends and any calendar day marked "No regular lessons."
      </p>
      {students.length > 1 && (
        <Field label="Student">
          <select className={inputCls} style={inputStyle} value={s.id} onChange={(e) => { setSid(e.target.value); setSubs(null); }}>
            {students.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
      )}
      <div className="mb-3">
        <div className="text-sm mb-1" style={{ color: C.soft }}>Subjects</div>
        <div>
          {s.subjects.map((sub) => (
            <div key={sub} className="flex items-center justify-between gap-2 py-1">
              <label className="flex items-center gap-2" style={{ color: C.ink }}>
                <input type="checkbox" className="w-5 h-5" checked={chosen.includes(sub)} onChange={(e) => setSubs(e.target.checked ? [...chosen, sub] : chosen.filter((x) => x !== sub))} />{sub}
              </label>
              <DayChips days={s.schedule?.[sub]} label={`${sub} meeting days`} onChange={(d) => onUpdateStudent({ ...s, schedule: { ...(s.schedule || {}), [sub]: d || undefined } })} />
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="From lesson"><input type="number" min="1" className={inputCls} style={inputStyle} value={first} onChange={(e) => setFirst(Math.max(1, Number(e.target.value) || 1))} /></Field>
        <Field label="To lesson"><input type="number" min="1" className={inputCls} style={inputStyle} value={last} onChange={(e) => setLast(Math.max(1, Number(e.target.value) || 1))} /></Field>
        <Field label={`Lesson ${first} is on`}><input type="date" className={inputCls} style={inputStyle} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
      </div>
      {plan.items.length > 0 ? (
        <p className="mb-3" style={{ color: C.ink }}>Adds {plan.items.length} lessons, {fmtDate(plan.from)} to {fmtDate(plan.to)}. Lessons already in the tracker are left alone.</p>
      ) : (
        <p className="mb-3" style={{ color: C.soft }}>{last < first ? "The last lesson has to come after the first." : "Every one of these lessons is already in the tracker."}</p>
      )}
      <Btn className="w-full" disabled={!plan.items.length} onClick={() => onAdd(plan.items, {})}><CalendarDays size={18} />Add {plan.items.length} lessons</Btn>
      <p className="text-sm mt-3" style={{ color: C.soft }}>Tip: add holidays and field trips to the calendar first. Anything added later moves these lessons for you. A subject that meets only some days (tap the day buttons) gets lessons only on those days.</p>
      <BookPlan key={s.id} data={data} student={s} onReplace={onReplace} onUpdateStudent={onUpdateStudent} />
    </div>
  );
}

function ImportView(props) {
  const [mode, setMode] = useState("plan");
  const modes = [["plan", "Plan lessons", CalendarDays], ["sheet", "Spreadsheet", FileSpreadsheet], ["photo", "Photo", Camera]];
  const events = props.data.events || [];
  return (
    <div>
      <div className="grid grid-cols-3 mb-5 rounded-lg overflow-hidden" style={{ border: `1.5px solid ${C.ink}` }} role="tablist">
        {modes.map(([id, label, Icon]) => (
          <button key={id} role="tab" aria-selected={mode === id} onClick={() => setMode(id)}
            className="flex items-center justify-center gap-1 py-2 text-sm font-semibold focus:outline-none focus:ring-2"
            style={mode === id ? { background: C.ink, color: C.white } : { background: C.white, color: C.ink }}>
            <Icon size={16} />{label}
          </button>
        ))}
      </div>
      {mode === "plan" && <PlanLessons data={props.data} students={props.students} onAdd={props.onAdd} onReplace={props.onReplace} onUpdateStudent={props.onUpdateStudent} />}
      {mode === "sheet" && <SheetImport {...props} events={events} />}
      {mode === "photo" && <PhotoImport data={props.data} students={props.students} onAdd={(list) => props.onAdd(list, {})} onMerge={props.onMerge} flash={props.flash} events={events} settings={props.settings} onSettings={props.onSettings} />}
    </div>
  );
}

/* ---------- State requirements ---------- */
// Plain-language summaries of each state's most common homeschool option (reviewed Sept 2026).
// n = notice/filing, t = instruction time, d = days/yr, h = hours/yr, s = required subjects,
// a = assessment, r = records. Always verify against the linked HSLDA page.
const STATES = [
  { code: "AL", name: "Alabama", n: "Enroll in a church (cover) school, which files the enrollment form. A private tutor option also exists", t: "Set by your cover school (private tutor option: 140 days, 3 hours a day)", s: [], a: "Not required", r: "Attendance your cover school asks for" },
  { code: "AK", name: "Alaska", n: "None required", t: "None set", s: [], a: "Not required", r: "None required" },
  { code: "AZ", name: "Arizona", n: "One-time affidavit of intent to the county school superintendent within 30 days of starting", t: "None set", s: ["reading", "grammar", "math", "social studies", "science"], a: "Not required", r: "None required" },
  { code: "AR", name: "Arkansas", n: "Notice of intent to the superintendent each year (by Aug 15 for a fall start)", t: "None set", s: [], a: "Not required", r: "None required" },
  { code: "CA", name: "California", n: "Private school affidavit each year, filed Oct 1–15", t: "None set", s: ["language arts", "math", "social studies", "science", "fine arts", "health", "physical education"], a: "Not required", r: "Attendance register, courses of study, and instructor list" },
  { code: "CO", name: "Colorado", n: "Notice of intent 14 days before starting, then each year", t: "172 days, averaging 4 hours a day", d: 172, s: ["reading", "writing", "math", "history", "civics", "literature", "science"], a: "Standardized test or qualified evaluation in grades 3, 5, 7, 9, and 11", r: "Attendance, test or evaluation results, and immunizations" },
  { code: "CT", name: "Connecticut", n: "None required (an optional notice of intent is common)", t: "None set", s: ["reading", "writing", "spelling", "grammar", "geography", "math", "history", "civics"], a: "Not required (an optional annual portfolio review is offered)", r: "None required" },
  { code: "DE", name: "Delaware", n: "Register with the Department of Education, file enrollment each fall and attendance at year end", t: "180 days", d: 180, s: [], a: "Not required", r: "Attendance, reported each year" },
  { code: "DC", name: "District of Columbia", n: "Notice of intent 15 days before starting, then by Aug 15 each year", t: "None set", s: ["fine arts", "language arts", "math", "physical education", "science", "social studies"], a: "Not required", r: "Portfolio of materials and work, shown on request" },
  { code: "FL", name: "Florida", n: "One-time notice of intent to the county superintendent within 30 days of starting", t: "None set", s: [], a: "Annual evaluation filed with the superintendent: certified-teacher portfolio review, nationally normed test, state test, licensed psychologist, or another agreed method", r: "Portfolio: a log of activities made as you go with titles of reading materials, plus work samples, kept 2 years" },
  { code: "GA", name: "Georgia", n: "Declaration of intent within 30 days of starting, then by Sept 1 each year", t: "180 days, 4½ hours a day", d: 180, s: ["reading", "language arts", "math", "social studies", "science"], a: "Standardized test every 3 years starting after grade 3 (kept, not submitted), plus a written annual progress report", r: "Attendance, test results, and annual progress reports" },
  { code: "HI", name: "Hawaii", n: "One-time notice to the local principal", t: "None set", s: [], a: "Annual progress report (test or evaluation); standardized tests in grades 3, 5, 8, and 10", r: "Record of the planned curriculum" },
  { code: "ID", name: "Idaho", n: "None required", t: "None set", s: [], a: "Not required", r: "None required" },
  { code: "IL", name: "Illinois", n: "None required", t: "None set", s: ["language arts", "math", "science", "social studies", "fine arts", "physical education", "health"], a: "Not required", r: "None required" },
  { code: "IN", name: "Indiana", n: "None required unless the state asks for an enrollment report", t: "180 days", d: 180, s: [], a: "Not required", r: "Attendance records" },
  { code: "IA", name: "Iowa", n: "Independent private instruction: none. Competent private instruction: annual form by Sept 1", t: "Competent private instruction: 148 days, 37 each quarter. Independent: none set", d: 148, s: ["math", "reading", "language arts", "science", "social studies"], a: "Not required for independent instruction; options apply under competent private instruction", r: "Outline of instruction, provided on request" },
  { code: "KS", name: "Kansas", n: "One-time registration of a non-accredited private school with the state board", t: "Substantially equal to public school (about 186 days)", d: 186, s: [], a: "Not required", r: "None required" },
  { code: "KY", name: "Kentucky", n: "Notice to the local school board within 2 weeks of the school year starting, each year", t: "185 days (1,062 hours)", d: 185, h: 1062, s: ["reading", "writing", "spelling", "grammar", "history", "math", "science", "civics"], a: "Not required", r: "Attendance register and scholarship reports (report cards)" },
  { code: "LA", name: "Louisiana", n: "Home study application within 15 days of starting, renewed each year", t: "180 days", d: 180, s: [], a: "Renewal needs proof of progress: work samples, a standardized test, or a certified teacher's statement", r: "Whatever you'll submit for renewal" },
  { code: "ME", name: "Maine", n: "Notice within 10 days of starting, then by Sept 1 each year", t: "175 days", d: 175, s: ["language arts", "math", "science", "social studies", "physical education", "health", "library skills", "fine arts"], a: "Annual assessment, submitted with the next year's notice", r: "Copies of notices and assessments" },
  { code: "MD", name: "Maryland", n: "Notice 15 days before starting", t: "None set (regular, thorough instruction)", s: ["language arts", "math", "science", "social studies", "art", "music", "health", "physical education"], a: "Portfolio review by the district up to 3 times a year, or supervision by an umbrella program", r: "Portfolio of materials and work samples" },
  { code: "MA", name: "Massachusetts", n: "Approval from the local school committee, usually each year", t: "Comparable to public school (about 900 hours elementary, 990 secondary)", h: 900, s: ["reading", "writing", "grammar", "geography", "math", "art", "music", "history", "civics", "health", "physical education"], a: "As agreed with the district: test, progress report, or portfolio", r: "As agreed with the district" },
  { code: "MI", name: "Michigan", n: "None required", t: "None set", s: ["reading", "spelling", "math", "science", "history", "civics", "literature", "writing", "grammar"], a: "Not required", r: "None required" },
  { code: "MN", name: "Minnesota", n: "Initial report by Oct 1, then a letter of intent to continue each year", t: "None set", s: ["reading", "writing", "literature", "fine arts", "math", "science", "history", "geography", "economics", "civics", "health", "physical education"], a: "Annual nationally normed test (kept, not submitted)", r: "Subjects taught and test results" },
  { code: "MS", name: "Mississippi", n: "Certificate of enrollment by Sept 15 each year", t: "180 days", d: 180, s: [], a: "Not required", r: "None required" },
  { code: "MO", name: "Missouri", n: "None required", t: "1,000 hours: 600 in core subjects, 400 of those at home", h: 1000, s: ["reading", "math", "social studies", "language arts", "science"], a: "Not required", r: "Daily log or plan book, work samples, and evaluations" },
  { code: "MT", name: "Montana", n: "Notice to the county superintendent each year", t: "720 hours (grades 1–3) or 1,080 hours (grades 4–12)", h: 1080, s: [], a: "Not required", r: "Attendance and immunization records" },
  { code: "NE", name: "Nebraska", n: "Exempt school filing each year (by July 15, or 30 days before starting)", t: "1,032 hours elementary, 1,080 high school", h: 1032, s: ["language arts", "math", "science", "social studies", "health"], a: "Not required", r: "None required" },
  { code: "NV", name: "Nevada", n: "One-time notice of intent within 10 days of starting", t: "None set", s: ["language arts", "math", "science", "social studies"], a: "Not required", r: "Education plan" },
  { code: "NH", name: "New Hampshire", n: "One-time notice within 5 business days of starting", t: "None set", s: ["science", "math", "language arts", "civics", "history", "health", "reading", "writing", "spelling", "fine arts"], a: "Annual evaluation, kept 2 years (not submitted)", r: "Portfolio, kept 2 years" },
  { code: "NJ", name: "New Jersey", n: "None required", t: "None set", s: [], a: "Not required", r: "None required" },
  { code: "NM", name: "New Mexico", n: "Notice within 30 days of starting, then by April 1 each year", t: "Same as public school (about 180 days)", d: 180, s: ["reading", "language arts", "math", "social studies", "science"], a: "Not required", r: "Immunization records" },
  { code: "NY", name: "New York", n: "Notice by July 1 each year, then an instruction plan (IHIP) and quarterly reports", t: "900 hours (grades 1–6), 990 hours (grades 7–12)", h: 900, s: ["reading", "spelling", "writing", "language arts", "geography", "history", "math", "science", "health", "music", "art", "physical education"], a: "Annual assessment: test or written narrative, with tests required in more grades as students get older", r: "Attendance and quarterly reports" },
  { code: "NC", name: "North Carolina", n: "One-time notice of intent to operate a home school", t: "At least 9 calendar months on a regular schedule", s: [], a: "Annual nationally standardized test (results kept 1 year)", r: "Attendance, immunization, and test records" },
  { code: "ND", name: "North Dakota", n: "Statement of intent 14 days before starting, each year", t: "175 days, 4 hours a day", d: 175, s: [], a: "Testing rules changed recently; check the linked summary", r: "Check the linked summary" },
  { code: "OH", name: "Ohio", n: "Notification within 5 days of starting, then each year", t: "None set", s: ["language arts", "geography", "history", "civics", "math", "health", "physical education", "fine arts", "first aid", "science"], a: "Not required (removed in 2023)", r: "None required" },
  { code: "OK", name: "Oklahoma", n: "None required", t: "About 180 days (equivalent education)", d: 180, s: ["reading", "writing", "math", "science", "civics", "health", "physical education"], a: "Not required", r: "None required" },
  { code: "OR", name: "Oregon", n: "One-time notice to the education service district within 10 days of starting", t: "None set", s: [], a: "Standardized tests in grades 3, 5, 8, and 10", r: "Test results" },
  { code: "PA", name: "Pennsylvania", n: "Notarized affidavit by Aug 1 each year", t: "180 days, or 900 hours (elementary) / 990 hours (secondary)", d: 180, h: 900, s: ["reading", "writing", "spelling", "grammar", "math", "science", "history", "geography", "civics", "health", "physical education", "music", "art"], a: "Standardized tests in grades 3, 5, and 8; annual portfolio evaluation, with the evaluator's certification filed by June 30", r: "Portfolio: reading list, work samples, and test results" },
  { code: "RI", name: "Rhode Island", n: "Approval from the local school committee", t: "Substantially equal to public school (about 180 days)", d: 180, s: ["reading", "writing", "geography", "math", "history", "civics", "language arts", "health", "physical education"], a: "As agreed with the school committee", r: "Attendance register" },
  { code: "SC", name: "South Carolina", n: "Option 1: district approval. Options 2 and 3: join an accountability association", t: "180 days (4½ hours a day under option 1)", d: 180, s: ["reading", "writing", "math", "science", "social studies"], a: "Option 1: annual state test. Options 2 and 3: none", r: "Plan book, work samples, and semiannual progress reports" },
  { code: "SD", name: "South Dakota", n: "Notice within 30 days of starting", t: "None set", s: ["language arts", "math"], a: "Not required", r: "None required" },
  { code: "TN", name: "Tennessee", n: "Independent home school: notice by Aug 1 each year. Church-related umbrella school: enroll with the school", t: "180 days, 4 hours a day", d: 180, s: [], a: "Independent: tests in grades 5, 7, and 9 (umbrella schools set their own)", r: "Attendance, submitted at year end (independent)" },
  { code: "TX", name: "Texas", n: "None required", t: "None set", s: ["reading", "spelling", "grammar", "math", "civics"], a: "Not required", r: "Written curriculum (not submitted)" },
  { code: "UT", name: "Utah", n: "One-time signed affidavit to the school district", t: "None set", s: [], a: "Not required", r: "None required" },
  { code: "VT", name: "Vermont", n: "Enrollment notice each year", t: "None set", s: ["reading", "writing", "math", "civics", "history", "physical education", "health", "literature", "science", "fine arts"], a: "Annual assessment (kept)", r: "Assessment results" },
  { code: "VA", name: "Virginia", n: "Notice of intent by Aug 15 each year", t: "None set", s: ["math", "language arts"], a: "Proof of progress by Aug 1: a test at the 23rd percentile or higher, or an evaluation", r: "Curriculum description" },
  { code: "WA", name: "Washington", n: "Declaration of intent by Sept 15 each year", t: "About 1,000 hours", h: 1000, s: ["reading", "writing", "spelling", "language arts", "math", "science", "social studies", "history", "health", "fine arts", "occupational education"], a: "Annual test or assessment by a certified person (kept, not submitted)", r: "Test or assessment results and immunization records" },
  { code: "WV", name: "West Virginia", n: "Notice of intent to the county superintendent", t: "None set", s: ["reading", "language arts", "math", "science", "social studies"], a: "Academic assessment, with results submitted in certain grades", r: "Assessment results" },
  { code: "WI", name: "Wisconsin", n: "Form PI-1206 by Oct 15 each year", t: "875 hours", h: 875, s: ["reading", "language arts", "math", "social studies", "science", "health"], a: "Not required", r: "None required" },
  { code: "WY", name: "Wyoming", n: "Curriculum submitted to the local school board each year", t: "175 days", d: 175, s: ["reading", "writing", "math", "civics", "history", "literature", "science"], a: "Not required", r: "None required" },
];
const stateSlug = (name) => name.toLowerCase().replace(/ /g, "-");

// Which of a student's subjects satisfies a state's required subject
const SUBJECT_KEYS = {
  "reading": ["reading", "phonics", "literature"],
  "language arts": ["language", "english", "grammar", "spelling", "penmanship", "cursive", "writing", "phonics", "reading", "composition", "vocabulary", "literature"],
  "writing": ["writing", "penmanship", "cursive", "composition", "language", "english"],
  "spelling": ["spelling"],
  "grammar": ["grammar", "language", "english"],
  "literature": ["literature", "reading"],
  "math": ["math", "arith", "numbers", "algebra", "geometry", "calculus"],
  "science": ["science", "biology", "chemistry", "physics"],
  "social studies": ["history", "geography", "heritage", "government", "civics", "social"],
  "history": ["history", "heritage"],
  "geography": ["geography", "history"],
  "civics": ["civics", "government", "citizenship", "history"],
  "health": ["health"],
  "physical education": ["physical", "pe", "gym"],
  "fine arts": ["art", "music"],
  "art": ["art"],
  "music": ["music"],
  "economics": ["economics"],
};
function coveredBy(req, subjects) {
  const keys = SUBJECT_KEYS[req] || [req.toLowerCase().split(" ")[0]];
  return subjects.find((sub) => sub.toLowerCase().split(/[^a-z]+/).some((w) => w && keys.some((k) => w === k || (k.length > 3 && w.startsWith(k)))));
}
function schoolYearKey(startDate) {
  const y = parseInt((startDate || todayISO()).slice(0, 4), 10);
  return `${y}–${String((y + 1) % 100).padStart(2, "0")}`;
}

function Compliance({ data, activeStudents, onCheck }) {
  const st = STATES.find((x) => x.code === data.settings.state);
  if (!st) {
    return (
      <section className="mb-8 rounded-xl p-4" style={{ border: `1.5px dashed ${C.soft}` }}>
        <p style={{ color: C.ink }}>Choose your state in Setup to see its homeschool requirements and track them here.</p>
      </section>
    );
  }
  const year = schoolYearKey(data.settings.startDate);
  const hpd = data.settings.hoursPerDay || 5;
  const checks = data.checklist?.[year] || {};
  const items = [
    !/^None required/.test(st.n) && ["notice", "Notice or filing", st.n],
    !/^Not required/.test(st.a) && ["assess", "Assessment", st.a],
    !/^None required/.test(st.r) && ["records", "Records to keep", st.r],
  ].filter(Boolean);
  return (
    <section className="mb-8 pb-6 border-b-2" style={{ borderColor: C.ink }}>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h3 className="text-xl font-bold" style={{ color: C.ink }}>{st.name} requirements</h3>
        <span className="text-sm flex-shrink-0" style={{ color: C.soft }}>{year}</span>
      </div>
      <p className="mb-3 leading-relaxed" style={{ color: C.ink }}><span className="font-semibold">Instruction time:</span> {st.t}</p>
      {(st.d || st.h) && activeStudents.map((s) => {
        const days = attendanceDays(data, s.id).length;
        const logged = Math.round(minutesLogged(data, s.id) / 6) / 10;
        return (
          <div key={s.id} className="mb-3">
            <div className="flex justify-between gap-2 text-sm mb-1" style={{ color: C.ink }}>
              <span className="font-semibold">{s.name}</span>
              <span>{st.d ? `${days} of ${st.d} days` : `about ${days * hpd} of ${st.h} hours`}{logged ? `, ${logged} hrs timed` : ""}</span>
            </div>
            {st.d ? <Ruler value={days} max={st.d} /> : <Ruler value={days * hpd} max={st.h} tick={100} />}
          </div>
        );
      })}
      {st.h && !st.d && <p className="text-sm mb-3" style={{ color: C.soft }}>Hours are estimated at {hpd} per marked school day. Change that in Setup.</p>}

      {st.s.length > 0 && (
        <div className="mb-4">
          <div className="font-semibold" style={{ color: C.ink }}>Required subjects</div>
          <p className="text-sm mb-2" style={{ color: C.soft }}>{st.s.join(", ")}</p>
          {activeStudents.map((s) => {
            const missing = st.s.filter((x) => !coveredBy(x, s.subjects));
            return (
              <p key={s.id} className="text-sm mb-1" style={{ color: missing.length ? C.redpen : C.ink }}>
                {s.name}: {missing.length ? `add ${missing.join(", ")} to their subjects` : "every required subject is covered"}
              </p>
            );
          })}
        </div>
      )}

      {items.length > 0 && <div className="font-semibold mb-1" style={{ color: C.ink }}>This school year</div>}
      {items.map(([k, label, text]) => (
        <label key={k} className="flex gap-3 py-2 border-b cursor-pointer" style={{ borderColor: C.rule }}>
          <input type="checkbox" className="mt-1 w-5 h-5 flex-shrink-0" checked={!!checks[k]} onChange={(e) => onCheck(year, k, e.target.checked)} />
          <div>
            <div className="font-semibold" style={{ color: checks[k] ? C.soft : C.ink, textDecoration: checks[k] ? "line-through" : "none" }}>{label}</div>
            <div className="text-sm leading-relaxed" style={{ color: C.soft }}>{text}</div>
          </div>
        </label>
      ))}
      <p className="text-sm mt-3 leading-relaxed" style={{ color: C.soft }}>
        A plain-language summary of the most common homeschool option, not legal advice. Laws change, and many states offer more than one option.{" "}
        <a href={`https://hslda.org/legal/${stateSlug(st.name)}`} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: C.ink }}>Read the full {st.name} summary</a>
      </p>
    </section>
  );
}

/* ---------- Who's here / student view ---------- */
function WhoScreen({ students, hasPin, onStudent, onTeacher, allowTeacher = true }) {
  const [pinMode, setPinMode] = useState(false);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  function tryPin(e) {
    e?.preventDefault?.();
    if (onTeacher(pin)) return;
    setErr("That PIN doesn't match. Try again."); setPin("");
  }
  return (
    <div className="min-h-screen" style={ruled}>
      <div className="max-w-md mx-auto px-6 pt-12 pb-10">
        <h1 className="text-3xl font-bold mb-6" style={{ color: C.ink }}>Who's doing school?</h1>
        {!pinMode ? (
          <>
            <div className="grid grid-cols-2 gap-3 mb-8">
              {students.map((s) => (
                <button key={s.id} onClick={() => onStudent(s.id)} className="rounded-xl p-4 text-left focus:outline-none focus:ring-2"
                  style={{ background: C.white, border: `2px solid ${C.ink}` }}>
                  <div className="text-xl font-bold" style={{ color: C.ink }}>{s.name}</div>
                  <div className="text-sm" style={{ color: C.soft }}>Grade {s.grade}</div>
                </button>
              ))}
            </div>
            {allowTeacher && <Btn kind="ghost" className="w-full" onClick={() => (hasPin ? setPinMode(true) : onTeacher(""))}>Teacher</Btn>}
          </>
        ) : (
          <div className="rounded-xl p-5" style={{ background: C.white, border: `1.5px solid ${C.ink}` }}>
            <Field label="Teacher PIN">
              <input type="password" inputMode="numeric" autoFocus className={inputCls} style={inputStyle} value={pin}
                onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 6)); setErr(""); }}
                onKeyDown={(e) => e.key === "Enter" && tryPin()} />
            </Field>
            {err && <p className="mb-3" style={{ color: C.redpen }}>{err}</p>}
            <div className="flex gap-3">
              <Btn className="flex-1" disabled={pin.length < 4} onClick={tryPin}>Open teacher view</Btn>
              <Btn kind="ghost" onClick={() => { setPinMode(false); setPin(""); setErr(""); }}>Back</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StudentSheet({ a, onClose, onToggle, onAttach, flash, timerStart, onTimer, onPractice }) {
  const [busy, setBusy] = useState(false);
  const [practicing, setPracticing] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { if (!timerStart) return; const t = setInterval(() => tick((n) => n + 1), 15000); return () => clearInterval(t); }, [timerStart]);
  const running = timerStart ? Math.max(0, Math.round((Date.now() - timerStart) / 60000)) : 0;
  async function addFiles(e) {
    const files = [...e.target.files]; e.target.value = "";
    setBusy(true);
    try { for (const f of files) onAttach(a.id, await storeFile(f)); }
    catch (err) { flash(err.message); }
    setBusy(false);
  }
  const done = a.status === "done";
  return (
    <Sheet title={a.title || `${a.subject} lesson ${a.lesson ?? ""}`} onClose={onClose}>
      <div className="text-sm mb-4 flex flex-wrap gap-x-3" style={{ color: C.soft }}>
        <span>{a.subject}</span>{a.lesson ? <span>Lesson {a.lesson}</span> : null}<span>{a.type}</span>{a.dueBy && a.dueBy > a.due && <span>Start {fmtDate(a.due)}</span>}<span className="font-semibold" style={{ color: C.ink }}>Due {fmtDate(dueOf(a))}</span>
      </div>
      {a.notes && <p className="mb-4 leading-relaxed" style={{ color: C.ink }}>{a.notes}</p>}
      {done && a.score != null && a.score !== "" && (
        <p className="mb-4 text-lg font-bold" style={{ color: C.redpen }}>Score: {a.score}% {letter(Number(a.score))}</p>
      )}
      {a.verseText && <VersePractice text={a.verseText} />}
      {a.practice?.length > 0 && (
        <div className="mb-4">
          {practicing
            ? <PracticeQuiz questions={a.practice} onFinish={(score) => onPractice(a.id, score)} />
            : <Btn kind="pencil" className="w-full" onClick={() => setPracticing(true)}><Sparkles size={18} />Practice questions ({a.practice.length})</Btn>}
        </div>
      )}
      {!done && (
        <div className="flex items-center justify-between gap-3 mb-4 rounded-lg px-3 py-2" style={{ background: "#F3F7FC" }}>
          <span className="text-sm" style={{ color: C.ink }}>
            {timerStart ? `Timer running: ${running} min` : `Time spent: ${a.minutes || 0} min`}
          </span>
          <Btn kind={timerStart ? "danger" : "ghost"} onClick={() => onTimer(a.id, timerStart ? "stop" : "start")}>{timerStart ? "Stop timer" : "Start timer"}</Btn>
        </div>
      )}
      <div className="mb-5">
        {(a.attachments || []).map((att) => (
          <button key={att.key} className="block underline mb-1 text-left focus:outline-none focus:ring-2 rounded" style={{ color: C.ink }} onClick={() => openFile(att).catch(() => flash("That file is no longer saved."))}>{att.name}</button>
        ))}
        {!done && (
          <label className="inline-flex items-center gap-2 mt-1 cursor-pointer font-semibold" style={{ color: C.ink }}>
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Camera size={18} />}
            {busy ? "Saving…" : "Add a photo of my work"}
            <input type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={addFiles} disabled={busy} />
          </label>
        )}
      </div>
      {done ? (
        <p className="font-semibold" style={{ color: C.ink }}>Your teacher checked this one.</p>
      ) : (
        <Btn kind={a.status === "submitted" ? "ghost" : "primary"} className="w-full" onClick={() => onToggle(a.id)}>
          {a.status === "submitted" ? "Undo turn in" : "Turn it in"}
        </Btn>
      )}
    </Sheet>
  );
}

function StudentApp({ data, student, onToggle, onAttach, onSwitch, flash, onAddReading, onRemoveReading, onTimer, onPractice }) {
  const [tab, setTab] = useState("today");
  const [day, setDay] = useState(todayISO());
  const [openId, setOpenId] = useState(null);
  const mine = data.assignments.filter((a) => a.studentId === student.id);
  const open = mine.find((a) => a.id === openId);
  const today = todayISO();
  const items = mine.filter((a) => a.due === day);
  const earlier = mine.filter((a) => dueOf(a) < day && a.status === "todo").sort((x, y) => dueOf(x).localeCompare(dueOf(y)));
  const upcoming = comingUp(mine, day);
  const week = mine.filter((a) => a.due >= today && a.due <= addDays(today, 6)).sort((x, y) => x.due.localeCompare(y.due));
  const weekGroups = week.reduce((m, a) => ((m[a.due] ||= []).push(a), m), {});
  const left = items.filter((a) => a.status === "todo").length;
  const row = (a) => <Row key={a.id} a={a} mode="student" onToggle={onToggle} onEdit={(x) => setOpenId(x.id)} />;
  const tabs = [["today", "Today", CalendarDays], ["week", "This week", ListChecks], ["calendar", "Calendar", CalendarDays], ["progress", "My progress", BarChart3]];
  const todayEvents = eventsOn(data.events, day, [student.id]);
  const noLessons = todayEvents.find((ev) => ev.noLessons);

  return (
    <div className="min-h-screen pb-24" style={{ background: C.paper }}>
      <header style={{ ...ruled, borderBottom: `2px solid ${C.ink}` }}>
        <div className="max-w-2xl mx-auto pl-8 pr-4 pt-5 pb-4 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold" style={{ color: C.ink }}>Hi, {student.name}</h1>
          <button onClick={onSwitch} className="text-sm font-semibold underline focus:outline-none focus:ring-2 rounded" style={{ color: C.ink }}>Switch user</button>
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-4 pt-5">
        {tab === "today" && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <button aria-label="Previous day" onClick={() => setDay(addDays(day, -1))} className="p-2 rounded focus:outline-none focus:ring-2"><ChevronLeft color={C.ink} /></button>
              <button onClick={() => setDay(today)} className="text-center focus:outline-none focus:ring-2 rounded px-2">
                <div className="text-lg font-bold" style={{ color: C.ink }}>{fmtDate(day, true)}</div>
                {day !== today && <div className="text-sm underline" style={{ color: C.soft }}>Back to today</div>}
              </button>
              <button aria-label="Next day" onClick={() => setDay(addDays(day, 1))} className="p-2 rounded focus:outline-none focus:ring-2"><ChevronRight color={C.ink} /></button>
            </div>
            <p className="mb-2 text-center" style={{ color: C.soft }}>
              {items.length ? (left ? `${left} left to do. Tap the circle when you finish one.` : "All turned in. Nice work!") : ""}
            </p>
            {noLessons && <p className="mb-2 rounded-lg p-3 text-center font-semibold" style={{ background: "#EAF5EE", color: "#2F7D4F" }}>No lessons today: {noLessons.title}</p>}
            {todayEvents.map((ev) => <EventLine key={ev.id} ev={ev} students={data.students} />)}
            {items.length ? items.map(row) : !noLessons && <Empty>Nothing assigned for this day.</Empty>}
            {earlier.length > 0 && (
              <section className="mt-8">
                <h3 className="font-bold mb-1" style={{ color: C.redpen }}>Still to finish ({earlier.length})</h3>
                {earlier.map((a) => (
                  <div key={a.id}>
                    {row(a)}
                  </div>
                ))}
              </section>
            )}
            {upcoming.length > 0 && (
              <section className="mt-8">
                <h3 className="font-bold mb-1" style={{ color: C.ink }}>Coming up ({upcoming.length})</h3>
                <p className="text-sm" style={{ color: C.soft }}>Work you've started and tests to get ready for.</p>
                {upcoming.map(row)}
              </section>
            )}
          </div>
        )}
        {tab === "week" && (
          Object.keys(weekGroups).length === 0 ? <Empty>Nothing assigned for the next 7 days.</Empty> :
          Object.entries(weekGroups).map(([due, list]) => (
            <div key={due} className="mb-4">
              <div className="text-sm font-bold pt-2" style={{ color: C.soft }}>{due === today ? "Today" : fmtDate(due)}</div>
              {list.map(row)}
            </div>
          ))
        )}
        {tab === "calendar" && <MonthView data={data} sids={[student.id]} mode="student" renderRow={row} />}
        {tab === "progress" && (
          <>
            {data.settings.starsOn !== false && <StarsCard data={data} student={student} />}
            <ProgressView data={data} activeStudents={[student]} />
            <h3 className="text-xl font-bold mt-8 mb-3" style={{ color: C.ink }}>Books I've read</h3>
            <ReadingLog data={data} students={[student]} onAdd={onAddReading} onRemove={onRemoveReading} />
          </>
        )}
      </main>
      <nav className="fixed bottom-0 inset-x-0 z-30" style={{ background: C.white, borderTop: `2px solid ${C.ink}` }}>
        <div className="max-w-2xl mx-auto grid grid-cols-4">
          {tabs.map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id)} className="flex flex-col items-center py-2 text-xs font-semibold focus:outline-none focus:ring-2"
              style={{ color: tab === id ? C.ink : C.soft, background: tab === id ? "#FFF6D6" : "transparent" }} aria-current={tab === id ? "page" : undefined}>
              <Icon size={22} strokeWidth={tab === id ? 2.5 : 2} />{label}
            </button>
          ))}
        </div>
      </nav>
      {open && <StudentSheet a={open} onClose={() => setOpenId(null)} onToggle={onToggle} onAttach={onAttach} flash={flash} timerStart={data.timers?.[open.id]} onTimer={onTimer} onPractice={onPractice} />}
    </div>
  );
}

/* ---------- Progress ---------- */
function ProgressView({ data, activeStudents }) {
  const target = data.settings.schoolDays;
  const [period, setPeriod] = useState(0);
  const pcOf = (sid) => periodCount(data.students.find((x) => x.id === sid));
  const maxPeriods = Math.max(4, ...activeStudents.map(periodCount));
  const inPeriod = (a) => !period || gradingPeriod(a.lesson, pcOf(a.studentId)) === period;
  return (
    <div>
      <div className="flex gap-2 overflow-x-auto pb-1 mb-5" role="tablist" aria-label="Grading period">
        {["Whole year", ...Array.from({ length: maxPeriods }, (_, k) => `Period ${k + 1}`)].map((label, i) => (
          <button key={label} role="tab" aria-selected={period === i} onClick={() => setPeriod(i)}
            className="flex-shrink-0 rounded-full px-3 py-1 text-sm font-semibold focus:outline-none focus:ring-2"
            style={period === i ? { background: C.pencil, color: C.ink } : { color: C.ink, border: `1.5px solid ${C.ink}` }}>
            {label}
          </button>
        ))}
      </div>
      {activeStudents.map((s) => {
        const mine = data.assignments.filter((a) => a.studentId === s.id);
        const days = attendanceDays(data, s.id).length;
        const scored = mine.filter((a) => a.score != null && a.score !== "" && inPeriod(a));
        const overall = scored.length ? Math.round(scored.reduce((t, a) => t + Number(a.score), 0) / scored.length) : null;
        return (
          <section key={s.id} className="mb-8">
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-xl font-bold" style={{ color: C.ink }}>{s.name} <span className="text-base font-normal" style={{ color: C.soft }}>grade {s.grade}</span></h3>
              <span className="font-bold" style={{ color: C.redpen }}>{overall != null ? `${overall}% ${letter(overall)}` : ""}</span>
            </div>
            <div className="mb-4">
              <div className="flex justify-between text-sm mb-1" style={{ color: C.ink }}><span className="font-semibold">School days</span><span>{days} of {target}</span></div>
              <Ruler value={days} max={target} />
            </div>
            {s.subjects.map((sub) => {
              const list = mine.filter((a) => a.subject === sub);
              const lessons = new Set(list.filter((a) => a.status === "done" && a.lesson).map((a) => a.lesson)).size;
              const sc = list.filter((a) => a.score != null && a.score !== "" && inPeriod(a));
              const avg = sc.length ? Math.round(sc.reduce((t, a) => t + Number(a.score), 0) / sc.length) : null;
              return (
                <div key={sub} className="mb-3">
                  <div className="flex justify-between text-sm mb-1" style={{ color: C.ink }}>
                    <span className="inline-flex items-center gap-2"><span className="w-2 h-2 rounded-full" style={{ background: dotColor(sub) }} />{sub}</span>
                    <span>
                      {lessons} lessons
                      {avg != null && <span className="ml-2 font-bold" style={{ color: C.redpen }}>{avg}% {letter(avg)}</span>}
                    </span>
                  </div>
                  <Ruler value={lessons} max={data.settings.lessonsPerYear || 170} />
                </div>
              );
            })}
          </section>
        );
      })}
      <p className="text-sm" style={{ color: C.soft }}>Letters follow the Abeka Academy scale: A 94–100, B 85–93, C 77–84, D 70–76, F below 70. Grading periods follow lesson numbers: six of about 30 lessons (grades K–3) or four of about 45 (grade 4 and up). Change a child’s count in Setup. Each tick on a bar marks 10 lessons.</p>
    </div>
  );
}

/* ---------- downloads ---------- */
function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const PRINT_CSS = `body{font-family:Andika,'Trebuchet MS',system-ui,sans-serif;color:#1B2A4A;max-width:780px;margin:32px auto;padding:0 20px;line-height:1.5}
h1{font-size:28px;margin:0 0 4px}h2{font-size:20px;margin:28px 0 8px;border-bottom:2px solid #1B2A4A;padding-bottom:4px}
.meta{color:#5B6B88;margin:0 0 16px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #D6E4F5;vertical-align:top}
th{background:#F3F7FC}.grade{color:#C8322B;font-weight:700}.sample{break-inside:avoid;margin:0 0 20px}.sample img{max-width:100%;border:1px solid #D6E4F5}
.note{color:#5B6B88;font-size:13px}.sig{margin-top:48px;display:flex;gap:40px}.sig div{flex:1;border-top:1px solid #1B2A4A;padding-top:4px;font-size:13px}
@media print{body{margin:0}h2{break-after:avoid}}`;
const avg = (list) => {
  const sc = list.filter((a) => a.score != null && a.score !== "");
  return sc.length ? Math.round(sc.reduce((t, a) => t + Number(a.score), 0) / sc.length) : null;
};

function reportCardHTML(data, s, period, comments) {
  const mine = data.assignments.filter((a) => a.studentId === s.id);
  const pc = periodCount(s);
  const inP = (a) => !period || gradingPeriod(a.lesson, pc) === period;
  const st = STATES.find((x) => x.code === data.settings.state);
  const rows = s.subjects.map((sub) => {
    const list = mine.filter((a) => a.subject === sub);
    const lessons = new Set(list.filter((a) => a.status === "done" && a.lesson && inP(a)).map((a) => a.lesson)).size;
    const av = avg(list.filter(inP));
    return `<tr><td>${esc(sub)}</td><td>${lessons}</td><td>${av ?? "–"}</td><td class="grade">${av != null ? letter(av) : "–"}</td></tr>`;
  }).join("");
  const overall = avg(mine.filter(inP));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.name)} report card</title><style>${PRINT_CSS}</style></head><body>
<h1>${esc(s.name)}: Report card</h1>
<p class="meta">Grade ${esc(s.grade)}, ${esc(schoolYearKey(data.settings.startDate))} school year, ${period ? `grading period ${period} (lessons ${periodRange(period, pc).join("–")})` : "full year to date"}${st ? `, ${esc(st.name)}` : ""}</p>
<table><thead><tr><th>Subject</th><th>Lessons completed</th><th>Average</th><th>Letter</th></tr></thead><tbody>${rows}</tbody></table>
<p><strong>Overall average:</strong> <span class="grade">${overall != null ? `${overall}% ${letter(overall)}` : "–"}</span></p>
<p><strong>School days attended this year:</strong> ${attendanceDays(data, s.id).length}</p>
${comments ? `<h2>Teacher comments</h2><p>${esc(comments).replace(/\n/g, "<br>")}</p>` : ""}
<p class="note">Grading scale (Abeka): A 94–100, B 85–93, C 77–84, D 70–76, F below 70.</p>
<div class="sig"><div>Teacher</div><div>Date</div></div>
</body></html>`;
}

async function portfolioHTML(data, s, perSubject, withPhotos) {
  const mine = data.assignments.filter((a) => a.studentId === s.id).sort((x, y) => x.due.localeCompare(y.due));
  const today = todayISO();
  const st = STATES.find((x) => x.code === data.settings.state);
  const days = attendanceDays(data, s.id);
  const books = (data.readingLog || []).filter((b) => b.studentId === s.id).sort((x, y) => (x.date || "").localeCompare(y.date || ""));
  const readingAssignments = [...new Set(mine.filter((a) => ["Reading", "Book Report"].includes(a.type) && a.title).map((a) => a.title))];
  const logItems = mine.filter((a) => a.due <= today && a.status !== "todo").map((a) => ({ date: a.due, subject: a.subject, lesson: a.lesson ?? "", type: a.type, title: a.title, score: a.score ?? "" }));
  for (const ev of data.events || []) {
    if (!forStudent(ev, s.id) || !(ev.subject || ev.countsAsDay)) continue;
    for (const d of eventDates(ev)) if (d <= today) logItems.push({ date: d, subject: ev.subject || "", lesson: "", type: ev.kind, title: `${ev.title}${ev.minutes ? ` (${ev.minutes} min)` : ""}`, score: "" });
  }
  logItems.sort((x, y) => x.date.localeCompare(y.date));
  const logRows = logItems.map((x) => `<tr><td>${esc(x.date)}</td><td>${esc(x.subject)}</td><td>${x.lesson}</td><td>${esc(x.type)}</td><td>${esc(x.title)}</td><td class="grade">${x.score}</td></tr>`).join("");
  const hours = Math.round(minutesLogged(data, s.id) / 6) / 10;
  const summary = s.subjects.map((sub) => {
    const list = mine.filter((a) => a.subject === sub);
    const lessons = new Set(list.filter((a) => a.status === "done" && a.lesson).map((a) => a.lesson)).size;
    const av = avg(list);
    return `<tr><td>${esc(sub)}</td><td>${lessons}</td><td>${av != null ? `${av}% ${letter(av)}` : "–"}</td></tr>`;
  }).join("");

  let samples = "";
  if (withPhotos) {
    for (const sub of s.subjects) {
      const withWork = mine.filter((a) => a.subject === sub && (a.attachments || []).length);
      if (!withWork.length) continue;
      const n = Math.min(perSubject, withWork.length);
      const picks = [...new Set(Array.from({ length: n }, (_, i) => withWork[n === 1 ? withWork.length - 1 : Math.round((i * (withWork.length - 1)) / (n - 1))]))];
      samples += `<h3>${esc(sub)}</h3>`;
      for (const a of picks) {
        samples += `<div class="sample"><p><strong>${esc(a.due)}</strong>, ${a.lesson ? `lesson ${a.lesson}, ` : ""}${esc(a.title || a.type)}${a.score != null ? ` <span class="grade">${a.score}%</span>` : ""}</p>`;
        for (const att of a.attachments) {
          try {
            const f = await loadStored(att);
            samples += IMG_TYPES.includes(f.type) ? `<img src="data:${f.type};base64,${f.data}" alt="${esc(att.name)}">` : `<p class="note">Attached file: ${esc(att.name)} (saved in the tracker)</p>`;
          } catch { samples += `<p class="note">${esc(att.name)} is no longer saved.</p>`; }
        }
        samples += `</div>`;
      }
    }
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.name)} portfolio</title><style>${PRINT_CSS}</style></head><body>
<h1>${esc(s.name)}: Home education portfolio</h1>
<p class="meta">Grade ${esc(s.grade)}, ${esc(schoolYearKey(data.settings.startDate))} school year${st ? `, ${esc(st.name)}` : ""}. Curriculum: Abeka. Prepared ${esc(fmtDate(today, true))}.</p>
${st?.code === "FL" ? `<p class="note">Organized for Florida's portfolio requirement (s. 1002.41, F.S.): a log of educational activities kept as instruction happened, the titles of reading materials used, and samples of the student's work.</p>` : ""}
<h2>Attendance</h2><p>${days.length} school days${days.length ? `, from ${esc(days[0])} to ${esc(days[days.length - 1])}` : ""}.${hours ? ` ${hours} hours of timed work and activities logged.` : ""}</p>
<h2>Subjects</h2><table><thead><tr><th>Subject</th><th>Lessons completed</th><th>Average</th></tr></thead><tbody>${summary}</tbody></table>
<h2>Reading materials</h2>
${books.length || readingAssignments.length ? `<table><thead><tr><th>Title</th><th>Author</th><th>Finished</th><th>Notes</th></tr></thead><tbody>
${books.map((b) => `<tr><td>${esc(b.title)}</td><td>${esc(b.author)}</td><td>${esc(b.date)}</td><td>${esc(b.notes)}</td></tr>`).join("")}
${readingAssignments.map((t) => `<tr><td>${esc(t)}</td><td></td><td></td><td>Assigned reading</td></tr>`).join("")}</tbody></table>` : `<p class="note">No reading logged yet.</p>`}
<h2>Log of educational activities</h2>
${logRows ? `<table><thead><tr><th>Date</th><th>Subject</th><th>Lesson</th><th>Type</th><th>Activity</th><th>Score</th></tr></thead><tbody>${logRows}</tbody></table>` : `<p class="note">No completed work yet.</p>`}
${withPhotos ? `<h2>Work samples</h2>${samples || `<p class="note">No photos of work attached yet.</p>`}` : ""}
</body></html>`;
}

/* ---------- reading log ---------- */
function ReadingLog({ data, students, onAdd, onRemove }) {
  const [studentId, setStudentId] = useState(students[0]?.id || "");
  const [f, setF] = useState({ title: "", author: "", date: todayISO(), notes: "" });
  const [confirm, setConfirm] = useState(null);
  const ids = new Set(students.map((s) => s.id));
  const books = (data.readingLog || []).filter((b) => ids.has(b.studentId)).sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <div>
      <div className="rounded-xl p-4 mb-5" style={{ background: C.white, border: `1.5px solid ${C.ink}` }}>
        {students.length > 1 && (
          <Field label="Reader">
            <select className={inputCls} style={inputStyle} value={studentId} onChange={(e) => setStudentId(e.target.value)}>
              {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Book title"><input className={inputCls} style={inputStyle} value={f.title} onChange={(e) => set("title", e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Author"><input className={inputCls} style={inputStyle} value={f.author} onChange={(e) => set("author", e.target.value)} /></Field>
          <Field label="Finished"><input type="date" className={inputCls} style={inputStyle} value={f.date} onChange={(e) => set("date", e.target.value)} /></Field>
        </div>
        <Field label="Notes (optional)"><input className={inputCls} style={inputStyle} placeholder="e.g. read aloud together, book report" value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
        <Btn className="w-full" disabled={!f.title.trim()} onClick={() => { onAdd({ id: uid(), studentId: studentId || students[0].id, ...f, title: f.title.trim(), author: f.author.trim() }); setF({ title: "", author: "", date: todayISO(), notes: "" }); }}>
          <Plus size={18} />Add book
        </Btn>
      </div>
      {books.length === 0 && <Empty>No books logged yet.</Empty>}
      {books.map((b) => (
        <div key={b.id} className="flex items-start justify-between gap-3 py-3 border-b" style={{ borderColor: C.rule }}>
          <div>
            <div className="font-semibold" style={{ color: C.ink }}>{b.title}</div>
            <div className="text-sm" style={{ color: C.soft }}>
              {[b.author, b.date && fmtDate(b.date), students.length > 1 && data.students.find((s) => s.id === b.studentId)?.name, b.notes].filter(Boolean).join(", ")}
            </div>
          </div>
          <button onClick={() => (confirm === b.id ? onRemove(b.id) : setConfirm(b.id))} className="text-sm font-semibold px-2 py-1 rounded flex-shrink-0 focus:outline-none focus:ring-2" style={{ color: C.redpen }}>
            {confirm === b.id ? "Tap to remove" : <Trash2 size={16} />}
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------- reports ---------- */
function ReportsPanel({ data, students, flash, onSaveTranscript }) {
  const [drafting, setDrafting] = useState(false);
  const [studentId, setStudentId] = useState(students[0]?.id || "");
  const [period, setPeriod] = useState(0);
  const [comments, setComments] = useState("");
  const [perSubject, setPerSubject] = useState(3);
  const [withPhotos, setWithPhotos] = useState(true);
  const [busy, setBusy] = useState(false);
  const s = students.find((x) => x.id === studentId) || students[0];
  const slug = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  async function portfolio() {
    setBusy(true);
    try {
      const html = await portfolioHTML(data, s, perSubject, withPhotos);
      downloadFile(`${slug(s.name)}-portfolio-${todayISO()}.html`, html, "text/html");
    } catch { flash("The portfolio couldn't be built. Try again with fewer photos."); }
    setBusy(false);
  }

  async function draftComments() {
    setDrafting(true);
    try {
      setComments(await askClaude(`Write report card comments from a homeschool parent-teacher about their child, for ${period ? `grading period ${period}` : "the school year so far"}. Facts:\n${studentFacts(data, s, period)}\n\nWrite three or four warm, honest, specific sentences in the parent's voice: name one real strength, one area to work on, and close with encouragement. Use only these facts and don't invent details. Plain text only.`));
    } catch { flash("The comments couldn't be drafted. Try again."); }
    setDrafting(false);
  }
  return (
    <div>
      <WeeklySummary data={data} students={students} />
      {students.length > 1 && (
        <Field label="Student">
          <select className={inputCls} style={inputStyle} value={s.id} onChange={(e) => setStudentId(e.target.value)}>
            {students.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
      )}
      <h3 className="text-lg font-bold mt-2 mb-2" style={{ color: C.ink }}>Report card</h3>
      <Field label="Covers">
        <select className={inputCls} style={inputStyle} value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
          <option value={0}>Whole year to date</option>
          {Array.from({ length: periodCount(s) }, (_, k) => k + 1).map((n) => <option key={n} value={n}>Grading period {n} (lessons {periodRange(n, periodCount(s)).join("–")})</option>)}
        </select>
      </Field>
      <Field label="Teacher comments (optional)">
        <textarea rows={4} className={inputCls} style={inputStyle} value={comments} onChange={(e) => setComments(e.target.value)} />
      </Field>
      <Btn kind="ghost" className="w-full mb-3" disabled={drafting} onClick={draftComments}>
        {drafting ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}{drafting ? "Drafting…" : "Draft comments from grades"}
      </Btn>
      <Btn className="w-full" onClick={() => downloadFile(`${slug(s.name)}-report-card${period ? `-period-${period}` : ""}.html`, reportCardHTML(data, s, period, comments), "text/html")}>
        <Download size={18} />Download report card
      </Btn>

      <h3 className="text-lg font-bold mt-8 mb-1" style={{ color: C.ink }}>Year-end portfolio</h3>
      <p className="mb-3 leading-relaxed" style={{ color: C.ink }}>
        Attendance, a subject summary, the reading list, a dated log of completed work, and photos of work samples, ready for an evaluator or a district review.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Samples per subject">
          <select className={inputCls} style={inputStyle} value={perSubject} onChange={(e) => setPerSubject(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
          </select>
        </Field>
        <label className="flex items-center gap-2 mt-6" style={{ color: C.ink }}>
          <input type="checkbox" checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} className="w-5 h-5" />
          Include photos
        </label>
      </div>
      <Btn kind="pencil" className="w-full" disabled={busy} onClick={portfolio}>
        {busy ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}{busy ? "Building portfolio…" : "Download portfolio"}
      </Btn>
      <TranscriptSection data={data} s={s} onSave={onSaveTranscript} />
      <p className="text-sm mt-6" style={{ color: C.soft }}>Reports download as web pages. Open one and use Print, then Save as PDF, to get a PDF or a paper copy.</p>
    </div>
  );
}

function RecordsView({ data, activeStudents, onCheck, onAddReading, onRemoveReading, flash, onAdd, onToggle, onEdit, onSaveTranscript }) {
  const [view, setView] = useState("grades");
  const views = [["grades", "Grades"], ["reading", "Reading"], ["verses", "Verses"], ["reports", "Reports"]];
  return (
    <div>
      <div className="grid grid-cols-4 mb-5 rounded-lg overflow-hidden" style={{ border: `1.5px solid ${C.ink}` }} role="tablist">
        {views.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)} className="py-2 text-sm font-semibold focus:outline-none focus:ring-2"
            style={view === id ? { background: C.ink, color: C.white } : { background: C.white, color: C.ink }}>{label}</button>
        ))}
      </div>
      {view === "grades" && <><Compliance data={data} activeStudents={activeStudents} onCheck={onCheck} /><ProgressView data={data} activeStudents={activeStudents} /></>}
      {view === "reading" && <ReadingLog data={data} students={activeStudents} onAdd={onAddReading} onRemove={onRemoveReading} />}
      {view === "verses" && <VersesPanel data={data} students={activeStudents} onAdd={onAdd} onToggle={onToggle} onEdit={onEdit} flash={flash} />}
      {view === "reports" && <ReportsPanel data={data} students={activeStudents} flash={flash} onSaveTranscript={onSaveTranscript} />}
    </div>
  );
}

/* ---------- shift schedule ---------- */
function shiftSchoolDays(iso, n) {
  let d = iso; const step = n < 0 ? -1 : 1; let left = Math.abs(n);
  while (left > 0) { d = addDays(d, step); if (!isWeekend(d)) left--; }
  return d;
}
function ShiftSheet({ data, students, day, onShift, onClose }) {
  const [ids, setIds] = useState(students.map((s) => s.id));
  const [from, setFrom] = useState(day);
  const [n, setN] = useState(1);
  const [dir, setDir] = useState(1);
  const affected = data.assignments.filter((a) => ids.includes(a.studentId) && a.due >= from && a.status !== "done").length;
  return (
    <Sheet title="Shift the schedule" onClose={onClose}>
      <p className="mb-4 leading-relaxed" style={{ color: C.ink }}>Move unfinished work to later (or earlier) school days, for a sick day, a field trip, or a day off. Weekends and no-lesson days on the calendar are skipped, and finished work stays put.</p>
      {data.students.length > 1 && (
        <div className="mb-3">
          <div className="text-sm mb-1" style={{ color: C.soft }}>Students</div>
          {data.students.map((s) => (
            <label key={s.id} className="flex items-center gap-2 py-1" style={{ color: C.ink }}>
              <input type="checkbox" className="w-5 h-5" checked={ids.includes(s.id)} onChange={(e) => setIds((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))} />{s.name}
            </label>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        <Field label="Starting with">
          <input type="date" className={inputCls} style={inputStyle} value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Move">
          <select className={inputCls} style={inputStyle} value={dir} onChange={(e) => setDir(Number(e.target.value))}>
            <option value={1}>Later</option><option value={-1}>Earlier</option>
          </select>
        </Field>
        <Field label="School days">
          <input type="number" min="1" max="60" className={inputCls} style={inputStyle} value={n} onChange={(e) => setN(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} />
        </Field>
      </div>
      <Btn className="w-full" disabled={!affected} onClick={() => onShift(ids, from, n * dir, affected)}>
        Move {affected} {affected === 1 ? "assignment" : "assignments"} {n} school {n === 1 ? "day" : "days"} {dir > 0 ? "later" : "earlier"}
      </Btn>
    </Sheet>
  );
}

/* ---------- backup ---------- */
function BackupPanel({ data, onRestore, flash }) {
  const [busy, setBusy] = useState("");
  const [pending, setPending] = useState(null);
  async function backup() {
    setBusy("backup");
    const files = {};
    const keys = new Set(data.assignments.flatMap((a) => [...(a.attachments || []), ...(a.keyAttachments || [])].map((x) => x.key)));
    for (const k of keys) { try { const r = await window.storage.get(k, false); if (r) files[k] = r.value; } catch {} }
    downloadFile(`homeschool-backup-${todayISO()}.json`, JSON.stringify({ app: "homeschool-tracker", version: 1, exportedAt: new Date().toISOString(), data, files }), "application/json");
    setBusy("");
  }
  async function pick(e) {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try {
      const b = JSON.parse(await f.text());
      if (b.app !== "homeschool-tracker" || !Array.isArray(b.data?.students)) throw new Error();
      setPending({ b, name: f.name });
    } catch { flash("That isn't a backup from this tracker."); }
  }
  async function restore() {
    setBusy("restore");
    const { b } = pending;
    // Answer keys from older backups move into the teacher-only folder student tablets can't read
    const rename = {};
    for (const x of b.data.assignments || []) for (const att of x.keyAttachments || []) if (att.key.startsWith(FILE_PREFIX)) rename[att.key] = KEY_PREFIX + att.key.slice(FILE_PREFIX.length);
    const data = Object.keys(rename).length ? { ...b.data, assignments: b.data.assignments.map((x) => (x.keyAttachments?.length ? { ...x, keyAttachments: x.keyAttachments.map((att) => (rename[att.key] ? { ...att, key: rename[att.key] } : att)) } : x)) } : b.data;
    let failed = 0;
    for (const [k, v] of Object.entries(b.files || {})) { try { await window.storage.set(rename[k] || k, v, false); } catch { failed++; } }
    onRestore(data);
    if (failed) flash(`${failed} ${failed === 1 ? "file" : "files"} couldn't be copied. Try the restore again on a stronger connection.`);
    setPending(null); setBusy("");
  }
  return (
    <div>
      <h3 className="text-lg font-bold mt-8 mb-2" style={{ color: C.ink }}>Backup</h3>
      <p className="mb-3 leading-relaxed" style={{ color: C.ink }}>Download everything, including photos and answer keys, as one file. Keep a copy somewhere safe, like Google Drive, at least once each grading period.</p>
      <div className="grid grid-cols-2 gap-3">
        <Btn kind="ghost" disabled={!!busy} onClick={backup}>{busy === "backup" ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}Back up</Btn>
        <label className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 font-semibold cursor-pointer" style={{ color: C.ink, border: `1.5px solid ${C.ink}` }}>
          <Upload size={18} />Restore
          <input type="file" accept="application/json,.json" className="hidden" onChange={pick} />
        </label>
      </div>
      {pending && (
        <div className="mt-3 rounded-lg p-3" style={{ border: `1.5px solid ${C.redpen}` }}>
          <p className="mb-2" style={{ color: C.ink }}>Restoring <strong>{pending.name}</strong> replaces everything in the tracker now with that backup ({pending.b.data.students.length} students, {pending.b.data.assignments?.length || 0} assignments).</p>
          <div className="flex gap-2">
            <Btn kind="danger" className="flex-1" disabled={!!busy} onClick={restore}>{busy === "restore" ? "Restoring…" : "Replace with backup"}</Btn>
            <Btn kind="ghost" onClick={() => setPending(null)}>Cancel</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Calendar ---------- */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function monthCells(ym) {
  const first = ym + "-01";
  const start = addDays(first, -new Date(first + "T12:00:00").getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
function EventLine({ ev, students, onClick }) {
  const who = ev.studentIds?.length ? ev.studentIds.map((id) => students.find((s) => s.id === id)?.name).filter(Boolean).join(", ") : "Everyone";
  const time = ev.time ? new Date(`2000-01-01T${ev.time}`).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} className="w-full text-left flex gap-3 py-2 border-b focus:outline-none focus:ring-2 rounded" style={{ borderColor: C.rule }}>
      <span className="w-1.5 rounded-full flex-shrink-0" style={{ background: kindColor(ev.kind) }} />
      <span className="flex-1 min-w-0">
        <span className="block font-semibold" style={{ color: C.ink }}>{ev.title}</span>
        <span className="block text-sm" style={{ color: C.soft }}>
          {[time, ev.kind, who, ev.noLessons && "No lessons", ev.minutes && `${ev.minutes} min`].filter(Boolean).join(", ")}
        </span>
        {ev.notes && <span className="block text-sm" style={{ color: C.ink }}>{ev.notes}</span>}
      </span>
    </Tag>
  );
}

function MonthView({ data, sids, mode = "teacher", renderRow, onAddEvent, onEditEvent, onOpenDay, onSync, onPrint }) {
  const today = todayISO();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [sel, setSel] = useState(today);
  const key = sids.join(",");
  const byDay = useMemo(() => {
    const m = {};
    const slot = (d) => (m[d] ||= { work: 0, open: 0, tests: 0, deadlines: 0 });
    for (const a of data.assignments) {
      if (!sids.includes(a.studentId)) continue;
      const x = slot(a.due); x.work++; if (a.status !== "done") x.open++; if (TEST_TYPES.includes(a.type)) x.tests++;
      if (a.dueBy && a.dueBy > a.due) slot(a.dueBy).deadlines++;
    }
    return m;
  }, [data.assignments, key]);
  const evMap = useMemo(() => {
    const m = {};
    for (const ev of data.events || []) {
      if (!sids.some((s) => forStudent(ev, s))) continue;
      for (const d of eventDates(ev)) (m[d] ||= []).push(ev);
    }
    return m;
  }, [data.events, key]);
  const moveMonth = (n) => {
    const [y, mo] = month.split("-").map(Number);
    const d = new Date(y, mo - 1 + n, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const label = new Date(month + "-15T12:00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const dayEvents = (evMap[sel] || []).slice().sort((x, y) => (x.time || "").localeCompare(y.time || ""));
  const dayWork = data.assignments.filter((a) => sids.includes(a.studentId) && (a.due === sel || (a.dueBy === sel && a.dueBy > a.due)));

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button aria-label="Previous month" onClick={() => moveMonth(-1)} className="p-2 rounded focus:outline-none focus:ring-2"><ChevronLeft color={C.ink} /></button>
        <button onClick={() => { setMonth(today.slice(0, 7)); setSel(today); }} className="text-lg font-bold focus:outline-none focus:ring-2 rounded px-2" style={{ color: C.ink }}>{label}</button>
        <button aria-label="Next month" onClick={() => moveMonth(1)} className="p-2 rounded focus:outline-none focus:ring-2"><ChevronRight color={C.ink} /></button>
      </div>
      <div className="grid grid-cols-7 text-center text-xs font-semibold mb-1" style={{ color: C.soft }}>
        {WEEKDAYS.map((w) => <div key={w}>{w}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-px rounded-lg overflow-hidden" style={{ background: C.rule, border: `1.5px solid ${C.ink}` }}>
        {monthCells(month).map((d) => {
          const inMonth = d.slice(0, 7) === month;
          const evs = evMap[d] || [];
          const info = byDay[d];
          const noLessons = isWeekend(d) || evs.some((ev) => ev.noLessons && sids.every((s) => forStudent(ev, s)));
          const isSel = d === sel;
          return (
            <button key={d} onClick={() => { setSel(d); if (!inMonth) setMonth(d.slice(0, 7)); }}
              aria-label={`${fmtDate(d, true)}${evs.length ? `, ${evs.length} events` : ""}${info ? `, ${info.work} assignments` : ""}`}
              className="text-left p-1 focus:outline-none focus:ring-2 focus:z-10 relative"
              style={{ minHeight: 64, background: isSel ? "#FFF6D6" : noLessons ? "#F1F3F7" : C.white, opacity: inMonth ? 1 : 0.45, outline: isSel ? `2px solid ${C.pencil}` : "none" }}>
              <span className="text-xs font-bold inline-flex items-center justify-center rounded-full"
                style={{ width: 20, height: 20, color: d === today ? C.white : C.ink, background: d === today ? C.ink : "transparent" }}>{Number(d.slice(8))}</span>
              {evs.slice(0, 2).map((ev) => (
                <span key={ev.id} className="block truncate rounded px-1 mt-0.5" style={{ fontSize: 10, lineHeight: "14px", background: kindColor(ev.kind), color: C.white }}>{ev.title}</span>
              ))}
              {evs.length > 2 && <span className="block" style={{ fontSize: 10, color: C.soft }}>+{evs.length - 2} more</span>}
              {info && (info.work > 0 || info.deadlines > 0) && (
                <span className="flex items-center gap-1 mt-0.5" style={{ fontSize: 10, color: C.soft }}>
                  {info.work > 0 && <span style={{ color: info.open ? C.ink : C.soft }}>{info.open ? `${info.open} to do` : "✓ done"}</span>}
                  {(info.tests > 0 || info.deadlines > 0) && <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: C.redpen }} title="Test or deadline" />}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-xs mt-2" style={{ color: C.soft }}>Gray days have no lessons. A red dot marks a quiz, test, or deadline.</p>

      <div className="flex flex-wrap gap-2 mt-4">
        {mode === "teacher" && <Btn kind="ghost" onClick={() => onAddEvent(sel)}><Plus size={18} />Add event</Btn>}
        {mode === "teacher" && <Btn kind="ghost" onClick={() => onOpenDay(sel)}><CalendarDays size={18} />Open this day</Btn>}
        {mode === "teacher" && onSync && <Btn kind="ghost" onClick={onSync}><Upload size={18} />Google Calendar</Btn>}
        {mode === "teacher" && onPrint && <Btn kind="ghost" onClick={() => onPrint(sel)}><Download size={18} />Checklist</Btn>}
      </div>

      <section className="mt-5">
        <h3 className="text-lg font-bold mb-1" style={{ color: C.ink }}>{fmtDate(sel, true)}</h3>
        {dayEvents.map((ev) => <EventLine key={ev.id} ev={ev} students={data.students} onClick={mode === "teacher" ? () => onEditEvent(ev) : undefined} />)}
        {dayWork.map((a) => (
          <div key={a.id}>
            {a.dueBy === sel && a.due !== sel && <div className="text-xs pt-2 font-semibold" style={{ color: C.redpen }}>Due today, started {fmtDate(a.due)}</div>}
            {renderRow(a)}
          </div>
        ))}
        {!dayEvents.length && !dayWork.length && <Empty>Nothing on this day.</Empty>}
      </section>
    </div>
  );
}

function EventSheet({ initial, data, onSave, onDelete, onClose }) {
  const isNew = !initial.createdAt;
  const [ev, setEv] = useState(initial);
  const [shift, setShift] = useState(true);
  const [shiftBack, setShiftBack] = useState(true);
  const [confirmDel, setConfirmDel] = useState(false);
  const set = (k, v) => setEv((p) => ({ ...p, [k]: v }));
  const old = data.events || [];
  const evKey = JSON.stringify(ev);
  const preview = useMemo(() => {
    if (!ev.date || !ev.title) return 0;
    const next = isNew ? [...old, ev] : old.map((e) => (e.id === ev.id ? ev : e));
    return reflow(data.assignments, old, next, [ev.date, initial.date].filter(Boolean).sort()[0], data.students).moved;
  }, [evKey]);
  const delPreview = useMemo(() => (!isNew && initial.noLessons ? reflow(data.assignments, old, old.filter((e) => e.id !== ev.id), initial.date, data.students).moved : 0), []);
  const subjects = [...new Set([...data.students.flatMap((s) => s.subjects), "Physical Education", "Fine Arts", "Music", "Science", "History"])];
  const everyone = !ev.studentIds?.length;
  const toggleStudent = (id, on) => {
    const cur = ev.studentIds?.length ? ev.studentIds : data.students.map((s) => s.id);
    const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    set("studentIds", next.length === data.students.length ? [] : next);
  };

  return (
    <Sheet title={isNew ? "Add to the calendar" : "Edit event"} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="What">
          <input className={inputCls} style={inputStyle} autoFocus placeholder={ev.kind === "Field trip" ? "e.g. Science museum" : ev.kind === "Outside lesson" ? "e.g. Swim lessons" : ""} value={ev.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="Kind">
          <select className={inputCls} style={inputStyle} value={ev.kind}
            onChange={(e) => { const k = e.target.value; setEv((p) => ({ ...p, kind: k, ...(isNew ? { noLessons: EVENT_KINDS[k].noLessons, countsAsDay: EVENT_KINDS[k].countsAsDay } : {}) })); }}>
            {Object.keys(EVENT_KINDS).map((k) => <option key={k}>{k}</option>)}
          </select>
        </Field>
        <Field label="Date"><input type="date" className={inputCls} style={inputStyle} value={ev.date} onChange={(e) => set("date", e.target.value)} /></Field>
        <Field label="Time (optional)"><input type="time" className={inputCls} style={inputStyle} value={ev.time || ""} onChange={(e) => set("time", e.target.value)} /></Field>
      </div>
      <label className="flex items-center gap-2 mb-3" style={{ color: C.ink }}>
        <input type="checkbox" className="w-5 h-5" checked={!!ev.repeatWeekly} onChange={(e) => set("repeatWeekly", e.target.checked)} />Repeats every week
      </label>
      {ev.repeatWeekly ? (
        <Field label="Last week it happens"><input type="date" className={inputCls} style={inputStyle} min={ev.date} value={ev.until || ""} onChange={(e) => set("until", e.target.value)} /></Field>
      ) : (
        <Field label="Last day (for trips longer than one day)"><input type="date" className={inputCls} style={inputStyle} min={ev.date} value={ev.endDate || ""} onChange={(e) => set("endDate", e.target.value || null)} /></Field>
      )}
      {data.students.length > 1 && (
        <div className="mb-3">
          <div className="text-sm mb-1" style={{ color: C.soft }}>Who</div>
          <div className="flex flex-wrap gap-x-4">
            <label className="flex items-center gap-2 py-1" style={{ color: C.ink }}>
              <input type="checkbox" className="w-5 h-5" checked={everyone} onChange={(e) => set("studentIds", e.target.checked ? [] : [data.students[0].id])} />Everyone
            </label>
            {data.students.map((s) => (
              <label key={s.id} className="flex items-center gap-2 py-1" style={{ color: C.ink }}>
                <input type="checkbox" className="w-5 h-5" checked={everyone || ev.studentIds.includes(s.id)} onChange={(e) => toggleStudent(s.id, e.target.checked)} />{s.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="rounded-xl p-3 mb-3" style={{ background: "#F3F7FC" }}>
        <label className="flex items-start gap-2 mb-2" style={{ color: C.ink }}>
          <input type="checkbox" className="w-5 h-5 mt-0.5" checked={!!ev.noLessons} onChange={(e) => set("noLessons", e.target.checked)} />
          <span><span className="font-semibold">No regular lessons</span><span className="block text-sm" style={{ color: C.soft }}>Lessons scheduled on this day move to the next school day, and each subject stays in lesson order.</span></span>
        </label>
        <label className="flex items-start gap-2" style={{ color: C.ink }}>
          <input type="checkbox" className="w-5 h-5 mt-0.5" checked={!!ev.countsAsDay} onChange={(e) => set("countsAsDay", e.target.checked)} />
          <span><span className="font-semibold">Counts as a school day</span><span className="block text-sm" style={{ color: C.soft }}>Adds to attendance, like an educational field trip.</span></span>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Log it under (optional)">
          <input list="event-subjects" className={inputCls} style={inputStyle} placeholder="e.g. Physical Education" value={ev.subject || ""} onChange={(e) => set("subject", e.target.value)} />
          <datalist id="event-subjects">{subjects.map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
        <Field label="Minutes each time (optional)">
          <input type="number" min="0" inputMode="numeric" className={inputCls} style={inputStyle} value={ev.minutes || ""} onChange={(e) => set("minutes", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
      </div>
      <Field label="Notes"><input className={inputCls} style={inputStyle} value={ev.notes || ""} onChange={(e) => set("notes", e.target.value)} /></Field>
      {preview > 0 && (
        <label className="flex items-start gap-2 mb-3 rounded-lg p-3" style={{ color: C.ink, background: "#FFF6D6" }}>
          <input type="checkbox" className="w-5 h-5 mt-0.5" checked={shift} onChange={(e) => setShift(e.target.checked)} />
          <span>Move {preview} unfinished {preview === 1 ? "assignment" : "assignments"} to fit around this change</span>
        </label>
      )}
      <div className="flex gap-3">
        <Btn className="flex-1" disabled={!ev.title.trim() || !ev.date} onClick={() => onSave({ ...ev, title: ev.title.trim() }, shift && preview > 0)}>Save to calendar</Btn>
        {!isNew && <Btn kind="danger" onClick={() => (confirmDel ? onDelete(ev, shiftBack && delPreview > 0) : setConfirmDel(true))}><Trash2 size={18} />{confirmDel ? "Tap to confirm" : ""}</Btn>}
      </div>
      {confirmDel && delPreview > 0 && (
        <label className="flex items-center gap-2 mt-3 text-sm" style={{ color: C.ink }}>
          <input type="checkbox" className="w-5 h-5" checked={shiftBack} onChange={(e) => setShiftBack(e.target.checked)} />
          Also move {delPreview} assignments back to fill this day
        </label>
      )}
    </Sheet>
  );
}

/* ---------- Google Calendar sync ---------- */
function gcalItems(data, ids, weeks, inc) {
  const from = todayISO(), to = addDays(from, weeks * 7);
  const name = (id) => data.students.find((s) => s.id === id)?.name;
  const sent = data.gcalSent || {};
  const out = [];
  if (inc.events) {
    for (const ev of data.events || []) {
      const who = ev.studentIds?.length ? ev.studentIds.filter((i) => ids.includes(i)) : ids;
      if (!who.length) continue;
      for (const d of eventDates(ev)) {
        if (d < from || d > to) continue;
        out.push({ key: `ev:${ev.id}:${d}`, title: `${ev.title}${ev.studentIds?.length ? ` (${who.map(name).join(", ")})` : ""}`, date: d, time: ev.time || null, minutes: Number(ev.minutes) || 60, notes: ev.notes || "" });
      }
    }
  }
  if (inc.deadlines) {
    for (const a of data.assignments) {
      if (!ids.includes(a.studentId) || a.status === "done") continue;
      const d = dueOf(a);
      const big = TEST_TYPES.includes(a.type) || (a.dueBy && a.dueBy > a.due) || ["Book Report", "Project", "Memory Verse"].includes(a.type);
      if (!big || d < from || d > to) continue;
      out.push({ key: `as:${a.id}:${d}`, title: `${name(a.studentId)}: ${a.title || a.type}${TEST_TYPES.includes(a.type) ? "" : " due"}`, date: d, time: null, notes: `${a.subject}${a.lesson ? `, lesson ${a.lesson}` : ""}` });
    }
  }
  return out.filter((x) => !sent[x.key]);
}
function GcalSync({ data, students, onSent, onClose }) {
  const [weeks, setWeeks] = useState(4);
  const [ids, setIds] = useState(students.map((s) => s.id));
  const [inc, setInc] = useState({ events: true, deadlines: true });
  const [run, setRun] = useState(null);
  const items = useMemo(() => gcalItems(data, ids, weeks, inc), [data, ids.join(), weeks, inc.events, inc.deadlines]);
  async function sync() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let created = 0, skipped = 0;
    setRun({ done: 0, total: items.length });
    for (let i = 0; i < items.length; i += 6) {
      const batch = items.slice(i, i + 6);
      try {
        const text = await askClaude(
          `Add these items to my primary Google Calendar using the calendar tools. Items with a time are timed events lasting the given minutes, in the ${tz} time zone. Items without a time are all-day events. Before creating each one, check that day for an event with the same title and skip it if it's already there. Don't change or delete anything else on the calendar.
Items: ${JSON.stringify(batch.map(({ key, ...x }) => x))}
When you're done, reply with only JSON: {"created": number, "skipped": number}`,
          { mcp_servers: [{ type: "url", url: "https://calendarmcp.googleapis.com/mcp/v1", name: "google-calendar" }] });
        const r = parseJSONLoose(text);
        created += Number(r.created) || 0; skipped += Number(r.skipped) || 0;
        onSent(batch.map((b) => b.key));
        setRun({ done: Math.min(i + 6, items.length), total: items.length });
      } catch {
        setRun({ done: i, total: items.length, error: "Google Calendar couldn't be reached. Check that it's connected in Claude's settings, then try again. Anything already added won't be added twice." });
        return;
      }
    }
    setRun({ done: items.length, total: items.length, finished: true, created, skipped });
  }
  const busy = run && !run.finished && !run.error;
  return (
    <Sheet title="Add to Google Calendar" onClose={busy ? () => {} : onClose}>
      <p className="mb-4 leading-relaxed" style={{ color: C.ink }}>Sends calendar events, tests, and deadlines (not daily lessons) to your Google Calendar so reminders reach your phone. Items that were already sent are skipped. This works while the tracker is open in Claude.</p>
      {data.students.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-x-4">
          {data.students.map((s) => (
            <label key={s.id} className="flex items-center gap-2 py-1" style={{ color: C.ink }}>
              <input type="checkbox" className="w-5 h-5" checked={ids.includes(s.id)} onChange={(e) => setIds((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))} />{s.name}
            </label>
          ))}
        </div>
      )}
      <Field label="How far ahead">
        <select className={inputCls} style={inputStyle} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
          {[1, 2, 4, 8].map((w) => <option key={w} value={w}>Next {w} {w === 1 ? "week" : "weeks"}</option>)}
        </select>
      </Field>
      <label className="flex items-center gap-2 mb-1" style={{ color: C.ink }}><input type="checkbox" className="w-5 h-5" checked={inc.events} onChange={(e) => setInc((p) => ({ ...p, events: e.target.checked }))} />Calendar events</label>
      <label className="flex items-center gap-2 mb-4" style={{ color: C.ink }}><input type="checkbox" className="w-5 h-5" checked={inc.deadlines} onChange={(e) => setInc((p) => ({ ...p, deadlines: e.target.checked }))} />Tests and deadlines</label>
      {run?.error && <p className="mb-3" style={{ color: C.redpen }}>{run.error}</p>}
      {run?.finished ? (
        <div>
          <p className="mb-3 font-semibold" style={{ color: C.ink }}>Done. {run.created} added{run.skipped ? `, ${run.skipped} were already there` : ""}.</p>
          <Btn className="w-full" onClick={onClose}>Close</Btn>
        </div>
      ) : (
        <Btn className="w-full" disabled={!items.length || busy} onClick={sync}>
          {busy ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
          {busy ? `Adding ${run.done} of ${run.total}…` : items.length ? `Add ${items.length} ${items.length === 1 ? "item" : "items"}` : "Nothing new to add"}
        </Btn>
      )}
    </Sheet>
  );
}

/* ---------- printable checklist ---------- */
function weekOf(day) {
  const dow = new Date(day + "T12:00:00").getDay();
  const mon = addDays(day, dow === 0 ? 1 : 1 - dow);
  return [mon, addDays(mon, 4)];
}
function checklistHTML(data, students, from, to) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isWeekend(d)) days.push(d);
  const pages = students.map((s) => {
    const body = days.map((d) => {
      const evs = eventsOn(data.events, d, [s.id]);
      const work = data.assignments.filter((a) => a.studentId === s.id && (a.due === d || (a.dueBy === d && a.dueBy > a.due)));
      if (!evs.length && !work.length) return "";
      return `<h2>${esc(fmtDate(d, true))}</h2>
${evs.map((ev) => `<p class="ev">◆ ${esc(ev.title)}${ev.time ? `, ${esc(ev.time)}` : ""}${ev.noLessons ? " (no lessons)" : ""}</p>`).join("")}
<ul>${work.map((a) => `<li><span class="box">${a.status === "done" ? "✓" : ""}</span><span><strong>${esc(a.subject)}${a.lesson ? ` ${a.lesson}` : ""}</strong>: ${esc(a.title || a.type)}${a.dueBy === d && a.due !== d ? " <em>(due today)</em>" : a.dueBy && a.dueBy > a.due ? ` <em>(due ${esc(fmtDate(a.dueBy))})</em>` : ""}</span></li>`).join("")}</ul>`;
    }).join("");
    return `<section class="page"><h1>${esc(s.name)}'s checklist</h1><p class="meta">${esc(fmtDate(from, true))}${from !== to ? ` to ${esc(fmtDate(to, true))}` : ""}</p>${body || "<p>Nothing scheduled.</p>"}<p class="sig">Checked by ________________</p></section>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Checklist</title><style>${PRINT_CSS}
ul{list-style:none;padding:0;margin:0 0 8px}li{display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid #D6E4F5;font-size:16px}
.box{flex:0 0 20px;height:20px;border:2px solid #1B2A4A;border-radius:4px;text-align:center;line-height:18px;color:#C8322B;font-weight:700}
.ev{margin:4px 0;color:#2F7D4F;font-weight:700}.page{break-after:page}.sig{margin-top:24px;color:#5B6B88}</style></head><body>${pages}</body></html>`;
}
function PrintSheet({ data, students, day, onClose }) {
  const [range, setRange] = useState("week");
  const [ids, setIds] = useState(students.map((s) => s.id));
  const [from, to] = range === "day" ? [day, day] : weekOf(day);
  return (
    <Sheet title="Print a checklist" onClose={onClose}>
      <p className="mb-4" style={{ color: C.ink }}>A page per child with a box to check for each assignment. Download it, open it, and print.</p>
      <Field label="Covers">
        <select className={inputCls} style={inputStyle} value={range} onChange={(e) => setRange(e.target.value)}>
          <option value="day">{fmtDate(day, true)}</option>
          <option value="week">The week of {fmtDate(weekOf(day)[0])}</option>
        </select>
      </Field>
      {data.students.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-x-4">
          {data.students.map((s) => (
            <label key={s.id} className="flex items-center gap-2 py-1" style={{ color: C.ink }}>
              <input type="checkbox" className="w-5 h-5" checked={ids.includes(s.id)} onChange={(e) => setIds((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))} />{s.name}
            </label>
          ))}
        </div>
      )}
      <Btn className="w-full" disabled={!ids.length} onClick={() => { downloadFile(`checklist-${from}.html`, checklistHTML(data, data.students.filter((s) => ids.includes(s.id)), from, to), "text/html"); onClose(); }}>
        <Download size={18} />Download checklist
      </Btn>
    </Sheet>
  );
}

function CalendarTab({ data, activeStudents, onToggle, onEdit, onNew, onAddEvent, onEditEvent, onOpenDay, onSync, onPrint, onDeleteMany, onDoneMany }) {
  const [view, setView] = useState("month");
  const sids = activeStudents.map((s) => s.id);
  return (
    <div>
      <div className="grid grid-cols-2 mb-5 rounded-lg overflow-hidden" style={{ border: `1.5px solid ${C.ink}` }} role="tablist">
        {[["month", "Month"], ["list", "All assignments"]].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)} className="py-2 text-sm font-semibold focus:outline-none focus:ring-2"
            style={view === id ? { background: C.ink, color: C.white } : { background: C.white, color: C.ink }}>{label}</button>
        ))}
      </div>
      {view === "month"
        ? <MonthView data={data} sids={sids} renderRow={(a) => <Row a={a} student={data.students.find((s) => s.id === a.studentId)} showStudent={sids.length > 1} onToggle={onToggle} onEdit={onEdit} />}
            onAddEvent={onAddEvent} onEditEvent={onEditEvent} onOpenDay={onOpenDay} onSync={onSync} onPrint={onPrint} />
        : <ListView data={data} activeStudents={activeStudents} onToggle={onToggle} onEdit={onEdit} onNew={onNew} onDeleteMany={onDeleteMany} onDoneMany={onDoneMany} />}
    </div>
  );
}

/* ---------- practice & memory verses (student-facing, no AI) ---------- */
function PracticeQuiz({ questions, onFinish }) {
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState(null);
  const [right, setRight] = useState(0);
  const [done, setDone] = useState(false);
  const q = questions[i];
  if (done) {
    const pct = Math.round((right / questions.length) * 100);
    return (
      <div className="rounded-xl p-4" style={{ background: "#FFF6D6" }}>
        <p className="text-lg font-bold" style={{ color: C.ink }}>You got {right} of {questions.length} ({pct}%)</p>
        <p className="mb-3" style={{ color: C.ink }}>{pct >= 90 ? "Great job. You're ready!" : pct >= 70 ? "Good work. Look back over the ones you missed." : "Keep studying and try again."}</p>
        <Btn kind="ghost" onClick={() => { setI(0); setPicked(null); setRight(0); setDone(false); }}>Try again</Btn>
      </div>
    );
  }
  return (
    <div className="rounded-xl p-4" style={{ background: "#F3F7FC" }}>
      <div className="text-sm mb-1" style={{ color: C.soft }}>Question {i + 1} of {questions.length}</div>
      <p className="font-semibold mb-3 leading-snug" style={{ color: C.ink }}>{q.q}</p>
      {q.choices.map((c, k) => {
        const show = picked != null;
        const good = k === q.answer, mine = k === picked;
        return (
          <button key={k} disabled={show} onClick={() => { setPicked(k); if (k === q.answer) setRight((r) => r + 1); }}
            className="block w-full text-left rounded-lg px-3 py-2 mb-2 focus:outline-none focus:ring-2"
            style={{ border: `1.5px solid ${show && good ? "#2F7D4F" : show && mine ? C.redpen : "#C3D3EA"}`, background: show && good ? "#EAF5EE" : show && mine ? "#FDF1F0" : C.white, color: C.ink }}>
            {c}
          </button>
        );
      })}
      {picked != null && (
        <>
          <p className="text-sm mb-3" style={{ color: C.ink }}><strong>{picked === q.answer ? "Right!" : "Not quite."}</strong> {q.why}</p>
          <Btn className="w-full" onClick={() => { if (i + 1 < questions.length) { setI(i + 1); setPicked(null); } else { setDone(true); onFinish(Math.round(((right) / questions.length) * 100)); } }}>
            {i + 1 < questions.length ? "Next question" : "See my score"}
          </Btn>
        </>
      )}
    </div>
  );
}

function VersePractice({ text }) {
  const [level, setLevel] = useState(0);
  const [peek, setPeek] = useState({});
  const words = text.split(/\s+/).filter(Boolean);
  const levels = ["Read it", "Hide some", "Hide most", "First letters"];
  const hidden = (i, w) => !/^\[\d+\]$/.test(w) && (level === 1 ? i % 3 === 2 : level === 2 ? i % 3 !== 0 : level === 3);
  return (
    <div className="rounded-xl p-4 mb-4" style={{ background: "#F3F7FC" }}>
      <div className="grid grid-cols-4 gap-1 mb-3">
        {levels.map((l, k) => (
          <button key={l} onClick={() => { setLevel(k); setPeek({}); }} className="rounded-md py-1 text-xs font-semibold focus:outline-none focus:ring-2"
            style={level === k ? { background: C.ink, color: C.white } : { background: C.white, color: C.ink, border: `1px solid ${C.ink}` }}>{l}</button>
        ))}
      </div>
      <p className="leading-loose text-lg" style={{ color: C.ink, fontFamily: "Georgia, serif" }}>
        {words.map((w, i) => {
          if (/^\[\d+\]$/.test(w)) return <sup key={i} className="mr-1" style={{ color: C.soft }}>{w.slice(1, -1)}</sup>;
          if (!hidden(i, w) || peek[i]) return <span key={i}>{w} </span>;
          const core = w.replace(/[^A-Za-z']/g, "");
          const blank = level === 3 ? `${core[0] || ""}${"_".repeat(Math.max(1, core.length - 1))}` : "_".repeat(Math.max(2, core.length));
          return <button key={i} onClick={() => setPeek((p) => ({ ...p, [i]: true }))} className="focus:outline-none focus:ring-2 rounded" style={{ color: C.soft }} aria-label="Show this word">{blank} </button>;
        })}
      </p>
      {level > 0 && <p className="text-xs mt-2" style={{ color: C.soft }}>Say it out loud. Tap a blank to peek at a word.</p>}
    </div>
  );
}

/* ---------- teacher AI tools ---------- */
async function kjvText(ref) {
  const t = await askClaude(`Give the exact King James Version text of ${ref}. Put each verse number in square brackets before its verse, like [1]. Reply with only the verse text. If it isn't a real Bible reference, reply INVALID.`);
  if (/INVALID/.test(t) || !t) throw new Error("invalid");
  return t.replace(/^["“]|["”]$/g, "").trim();
}
function TeacherAI({ a, setA, student }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [topic, setTopic] = useState(a.title || "");
  const [count, setCount] = useState(8);
  const [pages, setPages] = useState([]);
  const grade = student?.grade || "";
  const where = `${a.subject}${a.lesson ? `, lesson ${a.lesson}` : ""}`;

  async function tips() {
    setBusy("tips"); setErr("");
    try {
      const t = await askClaude(`I'm a homeschool parent teaching a grade ${grade} student with the Abeka curriculum. Today's work is ${where}: "${a.title || a.type}".${a.notes ? ` My notes: ${a.notes}.` : ""}
In under 180 words, give me three short labeled parts: "Explain:" a simple way to teach the key idea, "Example:" one concrete example, and "Practice:" a quick 5-minute activity or game. Plain text, no markdown symbols.`);
      setA((p) => ({ ...p, tips: t }));
    } catch { setErr("The teaching ideas couldn't be written. Try again."); }
    setBusy("");
  }
  async function practice() {
    setBusy("practice"); setErr("");
    try {
      const blocks = [];
      for (const f of pages) blocks.push(await fileBlock(f));
      const text = await askClaude([...blocks, { type: "text", text: `Write ${count} multiple-choice review questions for a grade ${grade} homeschool student using the Abeka curriculum, for ${where}. Topic: ${topic || a.title || a.subject}.
${blocks.length ? "Base every question only on the attached study pages." : `Stick to what a grade ${grade} student would have been taught on this topic.`}
Give four choices each with exactly one correct answer, worded at a grade ${grade} reading level. For Bible questions, use the King James Version.
Respond with ONLY a JSON array, no prose: [{"q": "question", "choices": ["", "", "", ""], "answer": index of the correct choice, "why": "one short sentence explaining the answer"}]` }]);
      const qs = parseJSONLoose(text).filter((q) => q && typeof q.q === "string" && Array.isArray(q.choices) && q.choices.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length)
        .map((q) => ({ q: q.q, choices: q.choices.map(String), answer: q.answer, why: String(q.why || "") }));
      if (!qs.length) throw new Error();
      setA((p) => ({ ...p, practice: qs }));
    } catch { setErr("The practice questions couldn't be made. Try a clearer photo or a more specific topic."); }
    setBusy("");
  }
  const log = a.practiceLog || [];
  return (
    <div className="rounded-xl p-4 mb-4" style={{ background: "#F3F7FC", border: `1.5px solid ${C.rule}` }}>
      <div className="font-bold" style={{ color: C.ink }}>AI helpers</div>
      <p className="text-sm mb-3" style={{ color: C.soft }}>Only you see these tools. Look over what they write before your child uses it.</p>

      <Btn kind="ghost" className="w-full mb-2" disabled={!!busy} onClick={tips}>
        {busy === "tips" ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}{busy === "tips" ? "Thinking…" : a.tips ? "New teaching ideas" : "Teaching ideas for this lesson"}
      </Btn>
      {a.tips && (
        <div className="rounded-lg p-3 mb-3 text-sm leading-relaxed" style={{ background: C.white, color: C.ink, whiteSpace: "pre-wrap" }}>
          {a.tips}
          <button className="block mt-2 underline text-xs" style={{ color: C.soft }} onClick={() => setA((p) => ({ ...p, tips: "" }))}>Clear</button>
        </div>
      )}

      <div className="text-sm font-semibold mt-3 mb-1" style={{ color: C.ink }}>Practice questions for your child</div>
      <Field label="Topic">
        <input className={inputCls} style={inputStyle} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Test 3: fractions and mixed numbers" />
      </Field>
      <div className="grid grid-cols-2 gap-3 items-end">
        <label className="inline-flex items-center gap-2 mb-3 cursor-pointer text-sm font-semibold" style={{ color: C.ink }}>
          <Camera size={18} />{pages.length ? `${pages.length} study ${pages.length === 1 ? "page" : "pages"}` : "Study pages (optional)"}
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple className="hidden" onChange={(e) => { setPages([...e.target.files].slice(0, 5)); e.target.value = ""; }} />
        </label>
        <Field label="How many">
          <select className={inputCls} style={inputStyle} value={count} onChange={(e) => setCount(Number(e.target.value))}>{[5, 8, 10].map((n) => <option key={n}>{n}</option>)}</select>
        </Field>
      </div>
      <Btn kind="pencil" className="w-full" disabled={!!busy} onClick={practice}>
        {busy === "practice" ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}{busy === "practice" ? "Writing questions…" : a.practice?.length ? "Make new questions" : "Make practice questions"}
      </Btn>
      {err && <p className="text-sm mt-2" style={{ color: C.redpen }}>{err}</p>}
      {a.practice?.length > 0 && (
        <div className="mt-3">
          <p className="text-sm mb-1" style={{ color: C.soft }}>Your child sees these on the assignment.{log.length ? ` Practiced ${log.length} ${log.length === 1 ? "time" : "times"}, best ${Math.max(...log.map((x) => x.score))}%.` : ""}</p>
          {a.practice.map((q, k) => (
            <div key={k} className="flex gap-2 py-1 border-b text-sm" style={{ borderColor: C.rule }}>
              <span className="flex-1" style={{ color: C.ink }}>{k + 1}. {q.q} <span style={{ color: "#2F7D4F" }}>({q.choices[q.answer]})</span></span>
              <button aria-label="Remove question" onClick={() => setA((p) => ({ ...p, practice: p.practice.filter((_, x) => x !== k) }))}><X size={14} color={C.redpen} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- memory verses (teacher) ---------- */
function VersesPanel({ data, students, onAdd, onToggle, onEdit, flash }) {
  const [ids, setIds] = useState(students.map((s) => s.id));
  const [ref, setRef] = useState("");
  const [text, setText] = useState("");
  const [start, setStart] = useState(todayISO());
  const [by, setBy] = useState(addDays(todayISO(), 7));
  const [busy, setBusy] = useState(false);
  const sids = students.map((s) => s.id);
  const verses = data.assignments.filter((a) => a.type === "Memory Verse" && sids.includes(a.studentId)).sort((x, y) => dueOf(y).localeCompare(dueOf(x)));
  async function fill() {
    setBusy(true);
    try { setText(await kjvText(ref)); } catch { flash("That reference couldn't be looked up. Check the spelling, like Isaiah 53:1-6."); }
    setBusy(false);
  }
  function add() {
    const now = Date.now();
    onAdd(data.students.filter((s) => ids.includes(s.id)).map((s) => ({
      id: uid(), studentId: s.id, subject: s.subjects.find((x) => /bible/i.test(x)) || s.subjects[0], lesson: null, type: "Memory Verse",
      title: `Memorize ${ref.trim()}`, verseRef: ref.trim(), verseText: text.trim(), due: start, dueBy: by > start ? by : null,
      status: "todo", score: null, notes: "", attachments: [], createdAt: now,
    })), {});
    setRef(""); setText("");
  }
  return (
    <div>
      <div className="rounded-xl p-4 mb-5" style={{ background: C.white, border: `1.5px solid ${C.ink}` }}>
        {data.students.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-x-4">
            {data.students.map((s) => (
              <label key={s.id} className="flex items-center gap-2 py-1" style={{ color: C.ink }}>
                <input type="checkbox" className="w-5 h-5" checked={ids.includes(s.id)} onChange={(e) => setIds((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))} />{s.name}
              </label>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <div className="flex-1"><Field label="Passage"><input className={inputCls} style={inputStyle} placeholder="e.g. Isaiah 53:1-6" value={ref} onChange={(e) => setRef(e.target.value)} /></Field></div>
          <Btn kind="ghost" className="mb-3" disabled={!ref.trim() || busy} onClick={fill}>{busy ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}KJV text</Btn>
        </div>
        <Field label="Verse text (your child practices from this)">
          <textarea rows={4} className={inputCls} style={inputStyle} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type or paste the passage, or fill it in with the button above." />
        </Field>
        {text && <p className="text-xs -mt-2 mb-3" style={{ color: C.soft }}>If you used the button, check the text against your Bible before assigning it.</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start practicing"><input type="date" className={inputCls} style={inputStyle} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Recite by"><input type="date" className={inputCls} style={inputStyle} min={start} value={by} onChange={(e) => setBy(e.target.value)} /></Field>
        </div>
        <Btn className="w-full" disabled={!ref.trim() || !text.trim() || !ids.length} onClick={add}><Plus size={18} />Assign passage</Btn>
      </div>
      {verses.length === 0 && <Empty>No memory passages yet.</Empty>}
      {verses.map((a) => <Row key={a.id} a={a} student={data.students.find((s) => s.id === a.studentId)} showStudent={students.length > 1} onToggle={onToggle} onEdit={onEdit} />)}
      <p className="text-sm mt-3" style={{ color: C.soft }}>After your child recites, open the passage and record the grade.</p>
    </div>
  );
}

/* ---------- transcript ---------- */
const gpaPoints = (pct) => ({ A: 4, B: 3, C: 2, D: 1 }[letter(pct)[0]] ?? 0);
function gpaOf(rows) {
  const r = rows.filter((x) => x.grade !== "" && x.grade != null && Number(x.credits) > 0);
  const cr = r.reduce((t, x) => t + Number(x.credits), 0);
  return cr ? (r.reduce((t, x) => t + gpaPoints(Number(x.grade)) * Number(x.credits), 0) / cr).toFixed(2) : null;
}
function transcriptHTML(data, s, rows) {
  const years = [...new Set(rows.map((r) => r.year))];
  const credits = rows.reduce((t, x) => t + (Number(x.credits) || 0), 0);
  const st = STATES.find((x) => x.code === data.settings.state);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.name)} transcript</title><style>${PRINT_CSS}</style></head><body>
<h1>Official high school transcript</h1>
<p class="meta">Home education program${st ? `, ${esc(st.name)}` : ""}</p>
<table><tbody><tr><th>Student</th><td>${esc(s.name)}</td><th>Birthdate</th><td>__________</td></tr>
<tr><th>Curriculum</th><td>Abeka</td><th>Graduation date</th><td>__________</td></tr></tbody></table>
${years.map((y) => {
  const yr = rows.filter((r) => r.year === y);
  return `<h2>${esc(y)}</h2><table><thead><tr><th>Course</th><th>Credits</th><th>Final grade</th><th>Letter</th></tr></thead><tbody>
${yr.map((r) => `<tr><td>${esc(r.course)}</td><td>${esc(r.credits)}</td><td>${r.grade === "" || r.grade == null ? "In progress" : esc(r.grade)}</td><td class="grade">${r.grade === "" || r.grade == null ? "" : letter(Number(r.grade))}</td></tr>`).join("")}
</tbody></table><p>Year GPA: ${gpaOf(yr) ?? "–"}</p>`;
}).join("")}
<h2>Summary</h2><p><strong>Total credits:</strong> ${credits}. <strong>Cumulative GPA (unweighted, 4.0 scale):</strong> ${gpaOf(rows) ?? "–"}</p>
<p class="note">Grading scale: A 94–100 (4.0), B 85–93 (3.0), C 77–84 (2.0), D 70–76 (1.0), F below 70 (0).</p>
<div class="sig"><div>Parent / administrator signature</div><div>Date</div></div>
</body></html>`;
}
function TranscriptSection({ data, s, onSave }) {
  const rows = data.transcripts?.[s.id] || [];
  const yearLabel = `Grade ${s.grade}, ${schoolYearKey(data.settings.startDate)}`;
  const set = (id, k, v) => onSave(s.id, rows.map((r) => (r.id === id ? { ...r, [k]: v } : r)));
  function addYear() {
    const have = new Set(rows.filter((r) => r.year === yearLabel).map((r) => r.course));
    const add = s.subjects.filter((sub) => !have.has(sub)).map((sub) => ({ id: uid(), year: yearLabel, course: sub, credits: 1, grade: avg(data.assignments.filter((a) => a.studentId === s.id && a.subject === sub)) ?? "" }));
    onSave(s.id, [...rows, ...add]);
  }
  const gpa = gpaOf(rows);
  return (
    <div>
      <h3 className="text-lg font-bold mt-8 mb-1" style={{ color: C.ink }}>High school transcript</h3>
      <p className="mb-3 leading-relaxed" style={{ color: C.ink }}>For grades 9–12. Courses, credits, and GPA for college and scholarship applications. In Florida, parents issue the diploma, so this is your official record.</p>
      <div className="flex gap-2 mb-3">
        <Btn kind="ghost" onClick={addYear}><Plus size={18} />This year's courses</Btn>
        <Btn kind="ghost" onClick={() => onSave(s.id, [...rows, { id: uid(), year: yearLabel, course: "", credits: 1, grade: "" }])}><Plus size={18} />A course</Btn>
      </div>
      {rows.map((r) => (
        <div key={r.id} className="grid gap-2 py-2 border-b items-end" style={{ gridTemplateColumns: "1.3fr 1.6fr .7fr .8fr auto", borderColor: C.rule }}>
          <input aria-label="Year" className={`${inputCls} text-sm`} style={inputStyle} value={r.year} onChange={(e) => set(r.id, "year", e.target.value)} />
          <input aria-label="Course" className={`${inputCls} text-sm`} style={inputStyle} value={r.course} placeholder="Course" onChange={(e) => set(r.id, "course", e.target.value)} />
          <input aria-label="Credits" type="number" step="0.5" min="0" className={`${inputCls} text-sm`} style={inputStyle} value={r.credits} onChange={(e) => set(r.id, "credits", e.target.value)} />
          <input aria-label="Final grade percent" type="number" min="0" max="100" className={`${inputCls} text-sm`} style={inputStyle} value={r.grade} placeholder="%" onChange={(e) => set(r.id, "grade", e.target.value === "" ? "" : Number(e.target.value))} />
          <button aria-label="Remove course" className="p-2" onClick={() => onSave(s.id, rows.filter((x) => x.id !== r.id))}><X size={16} color={C.redpen} /></button>
        </div>
      ))}
      {rows.length > 0 && (
        <>
          <p className="my-3" style={{ color: C.ink }}><strong>{rows.reduce((t, x) => t + (Number(x.credits) || 0), 0)}</strong> credits, GPA <strong>{gpa ?? "–"}</strong></p>
          <Btn className="w-full" onClick={() => downloadFile(`${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-transcript.html`, transcriptHTML(data, s, rows), "text/html")}><Download size={18} />Download transcript</Btn>
        </>
      )}
    </div>
  );
}

/* ---------- AI report comments & weekly summary ---------- */
function studentFacts(data, s, period) {
  const inP = (a) => !period || gradingPeriod(a.lesson, periodCount(s)) === period;
  const mine = data.assignments.filter((a) => a.studentId === s.id && inP(a));
  const lines = s.subjects.map((sub) => {
    const list = mine.filter((a) => a.subject === sub);
    const done = new Set(list.filter((a) => a.status === "done" && a.lesson).map((a) => a.lesson)).size;
    const av = avg(list);
    return `${sub}: ${done} lessons completed${av != null ? `, average ${av}% (${letter(av)})` : ", no scores yet"}`;
  });
  const low = mine.filter((a) => a.score != null && a.score !== "" && Number(a.score) < 77).map((a) => `${a.title} (${a.score}%)`).slice(0, 5);
  const overdue = mine.filter((a) => a.status === "todo" && dueOf(a) < todayISO()).length;
  return `${s.name}, grade ${s.grade}.\n${lines.join("\n")}\nSchool days attended: ${attendanceDays(data, s.id).length}. Overdue assignments: ${overdue}. Books logged: ${(data.readingLog || []).filter((b) => b.studentId === s.id).length}.${low.length ? `\nLow scores: ${low.join("; ")}.` : ""}`;
}
function weekFacts(data, s) {
  const today = todayISO(), back = addDays(today, -7), ahead = addDays(today, 7);
  const mine = data.assignments.filter((a) => a.studentId === s.id);
  const done = mine.filter((a) => a.status === "done" && (a.finishedOn || a.due) >= back && (a.finishedOn || a.due) <= today);
  const scores = done.filter((a) => a.score != null && a.score !== "").map((a) => `${a.title} ${a.score}%`);
  const overdue = mine.filter((a) => a.status === "todo" && dueOf(a) < today).map((a) => `${a.title} (due ${a.due})`);
  const turnedIn = mine.filter((a) => a.status === "submitted").length;
  const coming = mine.filter((a) => a.status !== "done" && (TEST_TYPES.includes(a.type) || a.dueBy) && dueOf(a) >= today && dueOf(a) <= ahead).map((a) => `${a.title} on ${dueOf(a)}`);
  const evs = [];
  for (let d = today; d <= ahead; d = addDays(d, 1)) for (const ev of eventsOn(data.events, d, [s.id])) evs.push(`${ev.title} on ${d}`);
  return `${s.name} (grade ${s.grade}): completed ${done.length} assignments in the last 7 days.${scores.length ? ` Scores: ${scores.slice(0, 10).join(", ")}.` : ""} Waiting for you to check: ${turnedIn}. Overdue: ${overdue.length ? overdue.slice(0, 8).join(", ") : "none"}. Coming up: ${coming.length ? coming.slice(0, 8).join(", ") : "no tests or deadlines"}. Events: ${evs.length ? evs.slice(0, 6).join(", ") : "none"}.`;
}
function WeeklySummary({ data, students }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function go() {
    setBusy(true); setErr("");
    try {
      setText(await askClaude(`You're helping a homeschool parent review the week (today is ${fmtDate(todayISO(), true)}). For each child below, write two or three plain sentences: what got done, anything overdue or scored low, and what's coming up. Then end with one line starting "Next week:" with a practical suggestion. Use only these facts and don't invent anything. Plain text, no markdown symbols.\n\n${students.map((s) => weekFacts(data, s)).join("\n\n")}`));
    } catch { setErr("The summary couldn't be written. Try again."); }
    setBusy(false);
  }
  return (
    <div className="rounded-xl p-4 mb-6" style={{ background: "#F3F7FC", border: `1.5px solid ${C.rule}` }}>
      <div className="font-bold mb-1" style={{ color: C.ink }}>This week at a glance</div>
      <p className="text-sm mb-3" style={{ color: C.soft }}>A short write-up of the past week and the week ahead for {students.length === 1 ? students[0].name : "everyone"}.</p>
      <Btn kind="pencil" className="w-full" disabled={busy} onClick={go}>{busy ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}{busy ? "Writing…" : text ? "Write it again" : "Summarize the week"}</Btn>
      {err && <p className="text-sm mt-2" style={{ color: C.redpen }}>{err}</p>}
      {text && <div className="mt-3 rounded-lg p-3 leading-relaxed" style={{ background: C.white, color: C.ink, whiteSpace: "pre-wrap" }}>{text}</div>}
    </div>
  );
}

/* ---------- stars & rewards ---------- */
function StarsCard({ data, student }) {
  const { balance } = starsFor(data, student.id);
  const rewards = [...(data.rewards || [])].sort((x, y) => x.cost - y.cost);
  return (
    <section className="mb-8 rounded-xl p-4" style={{ background: "#FFF6D6", border: `1.5px solid ${C.pencil}` }}>
      <div className="text-3xl font-bold" style={{ color: C.ink }}>★ {balance} {balance === 1 ? "star" : "stars"}</div>
      <p className="text-sm mb-3" style={{ color: C.ink }}>Turn work in by its due date for a star. Score 94 or higher for another.</p>
      {rewards.map((r) => (
        <div key={r.id} className="mb-2">
          <div className="flex justify-between text-sm mb-1" style={{ color: C.ink }}><span className="font-semibold">{r.name}</span><span>{Math.min(balance, r.cost)} of {r.cost}</span></div>
          <Ruler value={Math.max(0, balance)} max={r.cost} tick={Math.max(1, Math.round(r.cost / 5))} />
        </div>
      ))}
      {!rewards.length && <p className="text-sm" style={{ color: C.soft }}>Ask your teacher what you're saving up for.</p>}
    </section>
  );
}
function RewardsSetup({ data, onSettings, onRewards, onRedeem }) {
  const [name, setName] = useState("");
  const [cost, setCost] = useState(20);
  const [pick, setPick] = useState({});
  const rewards = data.rewards || [];
  const on = data.settings.starsOn !== false;
  return (
    <div>
      <h3 className="text-lg font-bold mt-8 mb-2" style={{ color: C.ink }}>Stars and rewards</h3>
      <label className="flex items-center gap-2 mb-3" style={{ color: C.ink }}>
        <input type="checkbox" className="w-5 h-5" checked={on} onChange={(e) => onSettings({ starsOn: e.target.checked })} />Show stars to students
      </label>
      {on && (
        <>
          <p className="text-sm mb-3" style={{ color: C.soft }}>Kids earn a star for each assignment turned in by its due date and another for scores of 94 or higher. They see their stars and your rewards on their My progress screen.</p>
          {rewards.map((r) => (
            <div key={r.id} className="flex items-center justify-between py-2 border-b" style={{ borderColor: C.rule }}>
              <span style={{ color: C.ink }}>{r.name}, <strong>{r.cost} stars</strong></span>
              <button aria-label={`Remove ${r.name}`} onClick={() => onRewards(rewards.filter((x) => x.id !== r.id))}><X size={16} color={C.redpen} /></button>
            </div>
          ))}
          <div className="flex gap-2 items-end mt-2">
            <div className="flex-1"><Field label="Reward"><input className={inputCls} style={inputStyle} placeholder="e.g. Pick Friday's dinner" value={name} onChange={(e) => setName(e.target.value)} /></Field></div>
            <div style={{ width: 80 }}><Field label="Stars"><input type="number" min="1" className={inputCls} style={inputStyle} value={cost} onChange={(e) => setCost(Math.max(1, Number(e.target.value) || 1))} /></Field></div>
            <Btn className="mb-3" disabled={!name.trim()} onClick={() => { onRewards([...rewards, { id: uid(), name: name.trim(), cost }]); setName(""); }}>Add</Btn>
          </div>
          {data.students.map((s) => {
            const { balance } = starsFor(data, s.id);
            const choice = rewards.find((r) => r.id === pick[s.id]);
            return (
              <div key={s.id} className="py-2 border-b" style={{ borderColor: C.rule }}>
                <div className="flex items-center justify-between gap-2">
                  <span style={{ color: C.ink }}><strong>{s.name}</strong>: ★ {balance}</span>
                  <button className="text-sm font-semibold underline" style={{ color: C.ink }} onClick={() => onRedeem(s.id, { name: "Bonus star", cost: -1 })}>+1 bonus star</button>
                </div>
                {rewards.length > 0 && (
                  <div className="flex gap-2 mt-2">
                    <select className={`${inputCls} flex-1`} style={inputStyle} value={pick[s.id] || ""} onChange={(e) => setPick((p) => ({ ...p, [s.id]: e.target.value }))}>
                      <option value="">Give a reward…</option>
                      {rewards.map((r) => <option key={r.id} value={r.id} disabled={r.cost > balance}>{r.name} ({r.cost})</option>)}
                    </select>
                    <Btn disabled={!choice || choice.cost > balance} onClick={() => { onRedeem(s.id, choice); setPick((p) => ({ ...p, [s.id]: "" })); }}>Give</Btn>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/* ---------- Students ---------- */
function StudentForm({ initial, onSave, onCancel }) {
  const [name, setName] = useState(initial?.name || "");
  const [grade, setGrade] = useState(initial?.grade || "1");
  const [subjects, setSubjects] = useState((initial?.subjects || subjectsFor(initial?.grade || "1")).join(", "));
  const [touched, setTouched] = useState(!!initial);
  const [periods, setPeriods] = useState(initial?.periods || "");
  return (
    <div>
      <Field label="Name"><input className={inputCls} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Field label="Grade">
        <select className={inputCls} style={inputStyle} value={grade} onChange={(e) => { setGrade(e.target.value); if (!touched) setSubjects(subjectsFor(e.target.value).join(", ")); }}>
          {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </Field>
      <Field label="Subjects (separate with commas)">
        <textarea rows={3} className={inputCls} style={inputStyle} value={subjects} onChange={(e) => { setSubjects(e.target.value); setTouched(true); }} />
      </Field>
      <Field label="Grading periods">
        <select className={inputCls} style={inputStyle} value={periods} onChange={(e) => setPeriods(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Abeka default for grade {grade} ({periodCount({ grade })})</option>
          <option value={6}>6 periods of about 30 lessons</option>
          <option value={4}>4 periods of about 45 lessons</option>
        </select>
      </Field>
      <div className="flex gap-3">
        <Btn className="flex-1" disabled={!name.trim()} onClick={() => onSave({ ...(initial || { id: uid() }), name: name.trim(), grade, periods: periods || undefined, subjects: subjects.split(",").map((x) => x.trim()).filter(Boolean) })}>
          {initial ? "Save student" : "Add student"}
        </Btn>
        {onCancel && <Btn kind="ghost" onClick={onCancel}>Cancel</Btn>}
      </div>
    </div>
  );
}
function PinSetup({ pin, onSettings }) {
  const [draft, setDraft] = useState("");
  return (
    <div>
      <h3 className="text-lg font-bold mt-8 mb-2" style={{ color: C.ink }}>Teacher and student views</h3>
      <p className="mb-3 leading-relaxed" style={{ color: C.ink }}>
        {pin
          ? "The tracker opens to a Who's doing school? screen. Each child taps their name to see only their own work, and your PIN opens this teacher view."
          : "Set a PIN to give each child their own view. They'll see only their lessons and can turn work in; grades, editing, and everyone else's work stay behind your PIN."}
      </p>
      <div className="flex gap-3 items-end">
        <div className="flex-1">
          <Field label={pin ? "New PIN (4–6 digits)" : "PIN (4–6 digits)"}>
            <input type="password" inputMode="numeric" className={inputCls} style={inputStyle} value={draft} onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 6))} />
          </Field>
        </div>
        <Btn className="mb-3" disabled={draft.length < 4} onClick={() => { onSettings({ pin: draft }); setDraft(""); }}>{pin ? "Change PIN" : "Set PIN"}</Btn>
      </div>
      {pin && <Btn kind="danger" onClick={() => onSettings({ pin: "" })}>Remove PIN</Btn>}
      <p className="text-sm mt-3" style={{ color: C.soft }}>The PIN keeps kids out of the teacher view on a shared family device. It isn't a password for sensitive information.</p>
    </div>
  );
}

function StudentsView({ data, onSaveStudent, onRemoveStudent, onSettings, onRestore, flash, onRewards, onRedeem, extraSetup }) {
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  return (
    <div>
      <h3 className="text-lg font-bold mb-1" style={{ color: C.ink }}>Students</h3>
      {data.students.map((s) => (
        <div key={s.id} className="flex items-center justify-between py-3 border-b" style={{ borderColor: C.rule }}>
          <button className="text-left focus:outline-none focus:ring-2 rounded" onClick={() => setEditing(s)}>
            <div className="font-bold" style={{ color: C.ink }}>{s.name}</div>
            <div className="text-sm" style={{ color: C.soft }}>Grade {s.grade}, {s.subjects.length} subjects</div>
          </button>
          <button onClick={() => (confirm === s.id ? onRemoveStudent(s.id) : setConfirm(s.id))} className="text-sm font-semibold px-2 py-1 rounded focus:outline-none focus:ring-2" style={{ color: C.redpen }}>
            {confirm === s.id ? "Tap to remove with all work" : "Remove"}
          </button>
        </div>
      ))}
      <Btn kind="ghost" className="w-full mt-4" onClick={() => setEditing("new")}><Plus size={18} />Add student</Btn>
      <h3 className="text-lg font-bold mt-8 mb-2" style={{ color: C.ink }}>State</h3>
      <Field label="Where you homeschool">
        <select className={inputCls} style={inputStyle} value={data.settings.state || ""}
          onChange={(e) => { const st = STATES.find((x) => x.code === e.target.value); onSettings({ state: e.target.value, ...(st?.d ? { schoolDays: st.d } : {}) }); }}>
          <option value="">Choose a state</option>
          {STATES.map((st) => <option key={st.code} value={st.code}>{st.name}</option>)}
        </select>
      </Field>
      <p className="text-sm mb-2" style={{ color: C.soft }}>Requirements and a yearly checklist appear at the top of Progress. States with a day count set your school-day goal automatically.</p>

      <h3 className="text-lg font-bold mt-8 mb-2" style={{ color: C.ink }}>School year</h3>
      <div className="grid grid-cols-2 gap-3">
        <Field label="School-day goal">
          <input type="number" min="1" className={inputCls} style={inputStyle} value={data.settings.schoolDays} onChange={(e) => onSettings({ schoolDays: Math.max(1, Number(e.target.value) || 1) })} />
        </Field>
        <Field label="Lesson 1 date">
          <input type="date" className={inputCls} style={inputStyle} value={data.settings.startDate || todayISO()} onChange={(e) => onSettings({ startDate: e.target.value })} />
        </Field>
        <Field label="Lessons per subject">
          <input type="number" min="1" className={inputCls} style={inputStyle} value={data.settings.lessonsPerYear || 170} onChange={(e) => onSettings({ lessonsPerYear: Math.max(1, Number(e.target.value) || 1) })} />
        </Field>
        <Field label="Hours per school day">
          <input type="number" min="1" max="12" step="0.5" className={inputCls} style={inputStyle} value={data.settings.hoursPerDay || 5} onChange={(e) => onSettings({ hoursPerDay: Math.max(0.5, Number(e.target.value) || 5) })} />
        </Field>
      </div>

      <RewardsSetup data={data} onSettings={onSettings} onRewards={onRewards} onRedeem={onRedeem} />
      {extraSetup}
      <PinSetup pin={data.settings.pin} onSettings={onSettings} />
      <BackupPanel data={data} onRestore={onRestore} flash={flash} />
      {editing && (
        <Sheet title={editing === "new" ? "Add student" : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <StudentForm initial={editing === "new" ? null : editing} onSave={(s) => { onSaveStudent(s); setEditing(null); }} onCancel={() => setEditing(null)} />
        </Sheet>
      )}
    </div>
  );
}

/* ---------- App ---------- */
export default function HomeschoolTracker({ deviceRole = "teacher", extraSetup = null }) {
  const studentDevice = deviceRole === "student";
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("today");
  const [active, setActive] = useState("all");
  const [day, setDay] = useState(todayISO());
  const [editing, setEditing] = useState(null);
  const [toast, setToast] = useState("");
  const [role, setRole] = useState(null); // null = who's here screen, "teacher", or a student id
  const [shifting, setShifting] = useState(false);
  const [eventEditing, setEventEditing] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [printing, setPrinting] = useState(null);
  const loaded = useRef(false);
  const dataRef = useRef(null);
  const undoRef = useRef(null);
  const undoTimer = useRef(null);
  const toastTimer = useRef(null);

  useEffect(() => {
    (async () => {
      const d = await loadData();
      const init = d || { students: [], assignments: [], attendance: {}, settings: { schoolDays: 180, lessonsPerYear: 170, hoursPerDay: 5, startDate: todayISO(), state: "", pin: "" } };
      setData(init);
      if (!init.settings.pin && !studentDevice) setRole("teacher");
    })();
  }, []);
  useEffect(() => {
    if (!data) return;
    if (!loaded.current) { loaded.current = true; return; }
    saveData(data);
  }, [data]);
  // Changes saved on another device (or merged after editing at the same time) flow in here
  useEffect(() => window.storage?.subscribe?.(DATA_KEY, (value) => {
    try { setData(JSON.parse(value)); } catch {}
  }), []);

  dataRef.current = data;
  const flash = (m, action) => {
    clearTimeout(toastTimer.current);
    setToast({ m, action });
    toastTimer.current = setTimeout(() => setToast(""), action ? 8000 : 2600);
  };
  // Deleted files are only removed once the undo window has passed
  const finishDelete = () => {
    const u = undoRef.current;
    if (!u) return;
    undoRef.current = null; clearTimeout(undoTimer.current);
    const cur = dataRef.current?.assignments || [];
    cleanupFiles([...cur, ...u.del], cur);
  };
  const undoDelete = () => {
    const u = undoRef.current;
    if (!u) return;
    undoRef.current = null; clearTimeout(undoTimer.current);
    const back = Object.fromEntries(u.moved.map((m) => [m.id, m]));
    setData((p) => ({ ...p, assignments: [...p.assignments.map((a) => (back[a.id] ? { ...a, due: back[a.id].due, dueBy: back[a.id].dueBy } : a)), ...u.del] }));
    flash("Restored");
  };
  const deleteMany = (ids, fillGap) => {
    finishDelete();
    const idSet = new Set(ids);
    const del = data.assignments.filter((a) => idSet.has(a.id));
    if (!del.length) return;
    let rest = data.assignments.filter((a) => !idSet.has(a.id)), moved = [];
    if (fillGap) ({ assignments: rest, moved } = closeGaps(rest, del));
    setData((p) => ({ ...p, assignments: rest }));
    undoRef.current = { del, moved };
    undoTimer.current = setTimeout(finishDelete, 8500);
    setEditing(null);
    flash(`Deleted ${del.length === 1 ? (del[0].title || "1 item") : `${del.length} items`}${moved.length ? `, moved ${moved.length} up` : ""}`, { label: "Undo", run: undoDelete });
  };
  const doneMany = (ids) => { const idSet = new Set(ids); setData((p) => ({ ...p, assignments: p.assignments.map((a) => (idSet.has(a.id) && a.status !== "done" ? stamp({ ...a, status: "done" }) : a)) })); flash(`Marked ${ids.length} done`); };

  const activeStudents = useMemo(() => {
    if (!data) return [];
    return active === "all" ? data.students : data.students.filter((s) => s.id === active);
  }, [data, active]);

  if (!data) {
    return <div className="min-h-screen flex items-center justify-center" style={{ ...ruled, color: C.soft }}><Loader2 className="animate-spin" /></div>;
  }

  const stamp = (a) => (a.status === "todo" ? { ...a, finishedOn: null } : a.finishedOn ? a : { ...a, finishedOn: todayISO() });
  const saveAssignment = (raw, shareKeyIds = []) => {
    const a = stamp(raw);
    setData((p) => {
      const exists = p.assignments.some((x) => x.id === a.id);
      let next = exists ? p.assignments.map((x) => (x.id === a.id ? a : x)) : [...p.assignments, { ...a, createdAt: Date.now() }];
      if (shareKeyIds.length) next = next.map((x) => (shareKeyIds.includes(x.id) ? { ...x, keyAttachments: a.keyAttachments } : x));
      cleanupFiles(p.assignments, next);
      return { ...p, assignments: next };
    });
    setEditing(null); flash("Assignment saved");
  };

  const toggle = (id) => setData((p) => ({ ...p, assignments: p.assignments.map((a) => (a.id === id ? stamp({ ...a, status: a.status === "done" ? "todo" : "done" }) : a)) }));
  const studentToggle = (id) => setData((p) => ({ ...p, assignments: p.assignments.map((a) => (a.id === id && a.status !== "done" ? stamp({ ...a, status: a.status === "submitted" ? "todo" : "submitted" }) : a)) }));
  const onTimer = (id, action) => setData((p) => {
    const timers = { ...(p.timers || {}) };
    let assignments = p.assignments;
    if (action === "start") timers[id] = Date.now();
    else {
      const mins = timers[id] ? Math.max(1, Math.round((Date.now() - timers[id]) / 60000)) : 0;
      delete timers[id];
      assignments = p.assignments.map((a) => (a.id === id ? { ...a, minutes: (Number(a.minutes) || 0) + mins } : a));
    }
    return { ...p, timers, assignments };
  });
  const onPractice = (id, score) => setData((p) => ({ ...p, assignments: p.assignments.map((a) => (a.id === id ? { ...a, practiceLog: [...(a.practiceLog || []), { date: todayISO(), score }] } : a)) }));
  const newEvent = (date) => setEventEditing({ id: uid(), title: "", kind: "Outside lesson", date, time: "", studentIds: [], ...EVENT_KINDS["Outside lesson"], subject: "", minutes: null, notes: "" });
  const saveEvent = (ev, doShift) => {
    const old = data.events || [];
    const prev = old.find((e) => e.id === ev.id);
    const next = prev ? old.map((e) => (e.id === ev.id ? ev : e)) : [...old, { ...ev, createdAt: Date.now() }];
    let assignments = data.assignments, moved = 0;
    if (doShift) ({ assignments, moved } = reflow(data.assignments, old, next, [ev.date, prev?.date].filter(Boolean).sort()[0], data.students));
    setData((p) => ({ ...p, events: next, assignments }));
    setEventEditing(null); flash(moved ? `Saved. Moved ${moved} assignments` : "Saved to the calendar");
  };
  const deleteEvent = (ev, doShift) => {
    const old = data.events || [];
    const next = old.filter((e) => e.id !== ev.id);
    let assignments = data.assignments, moved = 0;
    if (doShift) ({ assignments, moved } = reflow(data.assignments, old, next, ev.date, data.students));
    setData((p) => ({ ...p, events: next, assignments }));
    setEventEditing(null); flash(moved ? `Removed. Moved ${moved} assignments back` : "Removed from the calendar");
  };
  const markSent = (keys) => setData((p) => ({ ...p, gcalSent: { ...(p.gcalSent || {}), ...Object.fromEntries(keys.map((k) => [k, true])) } }));
  const saveTranscript = (sid, rows) => setData((p) => ({ ...p, transcripts: { ...(p.transcripts || {}), [sid]: rows } }));
  const setRewards = (rewards) => setData((p) => ({ ...p, rewards }));
  const redeem = (sid, r) => { setData((p) => ({ ...p, redemptions: [...(p.redemptions || []), { id: uid(), studentId: sid, name: r.name, cost: r.cost, date: todayISO() }] })); flash(r.cost < 0 ? "Bonus star added" : `${r.name}: ${r.cost} stars used`); };
  const attach = (id, att) => setData((p) => ({ ...p, assignments: p.assignments.map((a) => (a.id === id ? { ...a, attachments: [...(a.attachments || []), att] } : a)) }));
  const setCheck = (year, key, val) => setData((p) => ({ ...p, checklist: { ...(p.checklist || {}), [year]: { ...(p.checklist?.[year] || {}), [key]: val } } }));
  const switchUser = () => { setEditing(null); if (studentDevice) { setRole(null); return; } setRole(data.settings.pin ? null : "teacher"); if (!data.settings.pin) flash("Set a PIN in Setup to turn on student views"); };
  const attend = (sid, d) => setData((p) => {
    const list = p.attendance[sid] || [];
    return { ...p, attendance: { ...p.attendance, [sid]: list.includes(d) ? list.filter((x) => x !== d) : [...list, d] } };
  });
  const addMany = (list, newSubjects = {}) => {
    setData((p) => ({
      ...p,
      students: p.students.map((s) => (newSubjects[s.id] ? { ...s, subjects: [...s.subjects, ...newSubjects[s.id].filter((x) => !s.subjects.includes(x))] } : s)),
      assignments: [...p.assignments, ...list],
    }));
    flash(`Added ${list.length} assignments`); setTab("calendar");
  };
  const updateSettings = (s) => setData((p) => ({ ...p, settings: { ...p.settings, ...s } }));
  const mergeItems = (adds, updates) => {
    const byId = Object.fromEntries(updates.map((u) => [u.id, u]));
    setData((p) => ({ ...p, assignments: [...p.assignments.map((a) => (byId[a.id] ? { ...a, ...byId[a.id] } : a)), ...adds] }));
    flash([adds.length && `Added ${adds.length}`, updates.length && `updated ${updates.length}`].filter(Boolean).join(", ") || "Nothing to add");
    setTab("calendar");
  };
  const replaceSubject = (sid, subject, items, replace) => {
    setData((p) => {
      const keep = replace ? p.assignments.filter((a) => !(a.studentId === sid && a.subject === subject && ["Lesson", "Review"].includes(a.type) && a.status === "todo" && !(a.attachments || []).length)) : p.assignments;
      return { ...p, assignments: [...keep, ...items] };
    });
    flash(`Added ${items.length} ${subject} lessons`); setTab("calendar");
  };
  const addReading = (b) => { setData((p) => ({ ...p, readingLog: [...(p.readingLog || []), b] })); flash("Book added"); };
  const removeReading = (id) => setData((p) => ({ ...p, readingLog: (p.readingLog || []).filter((b) => b.id !== id) }));
  const shift = (ids, from, n, count) => {
    const cache = {};
    const fn = (a) => (cache[`${a.studentId}|${a.subject}`] ||= blockedFor(data.events, a.studentId, subjectDays(data.students, a.studentId, a.subject)));
    setData((p) => ({ ...p, assignments: p.assignments.map((a) => (ids.includes(a.studentId) && a.due >= from && a.status !== "done"
      ? { ...a, due: shiftSchool(a.due, n, fn(a)), dueBy: a.dueBy && a.dueBy >= from ? shiftSchool(a.dueBy, n, fn(a)) : a.dueBy } : a)) }));
    setShifting(false); flash(`Moved ${count} assignments`);
  };
  const restore = (d) => {
    setData((p) => { cleanupFiles(p.assignments, d.assignments || []); return { readingLog: [], checklist: {}, attendance: {}, assignments: [], ...d }; });
    setActive("all"); setRole(d.settings?.pin ? null : "teacher"); flash("Backup restored");
  };
  const saveStudent = (s) => setData((p) => ({ ...p, students: p.students.some((x) => x.id === s.id) ? p.students.map((x) => (x.id === s.id ? s : x)) : [...p.students, s] }));
  const removeStudent = (sid) => {
    setData((p) => {
      const next = p.assignments.filter((a) => a.studentId !== sid);
      cleanupFiles(p.assignments, next);
      const att = { ...p.attendance }; delete att[sid];
      return { ...p, students: p.students.filter((s) => s.id !== sid), assignments: next, attendance: att };
    });
    setActive("all");
  };
  const newAssignment = (due) => {
    const s = activeStudents[0] || data.students[0];
    setEditing({ id: uid(), studentId: s.id, subject: s.subjects[0] || "", lesson: null, type: "Lesson", title: "", due, status: "todo", score: null, notes: "", attachments: [] });
  };

  const fontCss = `@import url('https://fonts.googleapis.com/css2?family=Andika:wght@400;700&display=swap');
    .hs-root, .hs-root input, .hs-root select, .hs-root textarea, .hs-root button { font-family: 'Andika', 'Trebuchet MS', system-ui, sans-serif; }
    .hs-root *:focus-visible { outline: 2px solid ${C.pencil}; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .hs-root * { transition: none !important; animation: none !important; } }`;

  /* first run */
  if (data.students.length === 0) {
    return (
      <div className="hs-root min-h-screen" style={ruled}>
        <style>{fontCss}</style>
        <div className="max-w-md mx-auto px-6 pt-12 pb-10">
          <h1 className="text-3xl font-bold mb-2" style={{ color: C.ink }}>{BRAND.name}</h1>
          <p className="mb-6 leading-relaxed" style={{ color: C.ink }}>Add your first student. Subjects fill in to match the Abeka lineup for their grade, and you can change them anytime.</p>
          <div className="rounded-xl p-5" style={{ background: C.white, border: `1.5px solid ${C.ink}` }}>
            <StudentForm onSave={saveStudent} />
          </div>
        </div>
      </div>
    );
  }

  if (studentDevice && (role === null || role === "teacher")) {
    return (
      <div className="hs-root"><style>{fontCss}</style>
        <WhoScreen students={data.students} allowTeacher={false} onStudent={(id) => setRole(id)} onTeacher={() => false} />
      </div>
    );
  }
  if (role === null && data.settings.pin) {
    return (
      <div className="hs-root"><style>{fontCss}</style>
        <WhoScreen students={data.students} hasPin
          onStudent={(id) => setRole(id)}
          onTeacher={(pin) => { if (pin === data.settings.pin) { setRole("teacher"); return true; } return false; }} />
      </div>
    );
  }
  const asStudent = role && role !== "teacher" ? data.students.find((s) => s.id === role) : null;
  if (asStudent) {
    return (
      <div className="hs-root"><style>{fontCss}</style>
        <StudentApp data={data} student={asStudent} onToggle={studentToggle} onAttach={attach} onSwitch={switchUser} flash={flash} onAddReading={addReading} onRemoveReading={removeReading} onTimer={onTimer} onPractice={onPractice} />
        {toast && <div className="fixed left-1/2 z-50 rounded-lg px-4 py-2 font-semibold" style={{ bottom: 84, transform: "translateX(-50%)", background: C.ink, color: C.white }} role="status">{toast.m}</div>}
      </div>
    );
  }

  const tabs = [
    { id: "today", label: "Today", icon: CalendarDays },
    { id: "calendar", label: "Calendar", icon: ListChecks },
    { id: "import", label: "Import", icon: Sparkles },
    { id: "progress", label: "Records", icon: BarChart3 },
    { id: "students", label: "Setup", icon: SettingsIcon },
  ];

  return (
    <div className="hs-root min-h-screen pb-24" style={{ background: C.paper }}>
      <style>{fontCss}</style>
      <header style={{ ...ruled, borderBottom: `2px solid ${C.ink}` }}>
        <div className="max-w-2xl mx-auto pl-8 pr-4 pt-5 pb-3">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h1 className="text-2xl font-bold" style={{ color: C.ink }}>{BRAND.name}</h1>
            <button onClick={switchUser} className="inline-flex items-center gap-1 text-sm font-semibold underline focus:outline-none focus:ring-2 rounded" style={{ color: C.ink }}>
              <UserRound size={16} />Switch user
            </button>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {[{ id: "all", name: "Everyone" }, ...data.students].map((s) => (
              <button key={s.id} onClick={() => setActive(s.id)}
                className="flex-shrink-0 rounded-full px-4 py-1 font-semibold focus:outline-none focus:ring-2"
                style={active === s.id ? { background: C.ink, color: C.white } : { background: C.white, color: C.ink, border: `1.5px solid ${C.ink}` }}>
                {s.name}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5">
        {tab === "today" && <TodayView data={data} activeStudents={activeStudents} day={day} setDay={setDay} onToggle={toggle} onEdit={setEditing} onAttend={attend} onNew={newAssignment} onShift={() => setShifting(true)} onAddEvent={newEvent} onEditEvent={setEventEditing} onPrint={setPrinting} />}
        {tab === "calendar" && <CalendarTab data={data} activeStudents={activeStudents} onToggle={toggle} onEdit={setEditing} onNew={newAssignment}
          onAddEvent={newEvent} onEditEvent={setEventEditing} onOpenDay={(d) => { setDay(d); setTab("today"); }} onSync={FEATURES.gcal ? () => setSyncing(true) : undefined} onPrint={setPrinting} onDeleteMany={deleteMany} onDoneMany={doneMany} />}
        {tab === "import" && <ImportView data={data} onMerge={mergeItems} onReplace={replaceSubject} onUpdateStudent={saveStudent} students={activeStudents.length ? activeStudents : data.students} settings={data.settings} onSettings={updateSettings} onAdd={addMany} flash={flash} />}
        {tab === "progress" && <RecordsView data={data} activeStudents={activeStudents} onCheck={setCheck} onAddReading={addReading} onRemoveReading={removeReading} flash={flash}
          onAdd={(list) => { setData((p) => ({ ...p, assignments: [...p.assignments, ...list] })); flash(list.length === 1 ? "Passage assigned" : `Assigned to ${list.length} students`); }}
          onToggle={toggle} onEdit={setEditing} onSaveTranscript={saveTranscript} />}
        {tab === "students" && <StudentsView data={data} onSaveStudent={saveStudent} onRemoveStudent={removeStudent} onSettings={updateSettings} onRestore={restore} flash={flash} onRewards={setRewards} onRedeem={redeem} extraSetup={extraSetup} />}
      </main>

      <nav className="fixed bottom-0 inset-x-0 z-30" style={{ background: C.white, borderTop: `2px solid ${C.ink}` }}>
        <div className="max-w-2xl mx-auto grid grid-cols-5">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setTab(id)} className="flex flex-col items-center py-2 text-xs font-semibold focus:outline-none focus:ring-2"
              style={{ color: tab === id ? C.ink : C.soft, background: tab === id ? "#FFF6D6" : "transparent" }} aria-current={tab === id ? "page" : undefined}>
              <Icon size={22} strokeWidth={tab === id ? 2.5 : 2} />
              {label}
            </button>
          ))}
        </div>
      </nav>

      {eventEditing && <EventSheet initial={eventEditing} data={data} onSave={saveEvent} onDelete={deleteEvent} onClose={() => setEventEditing(null)} />}
      {syncing && <GcalSync data={data} students={activeStudents} onSent={markSent} onClose={() => setSyncing(false)} />}
      {printing && <PrintSheet data={data} students={activeStudents} day={printing} onClose={() => setPrinting(null)} />}
      {shifting && <ShiftSheet data={data} students={activeStudents} day={day} onShift={shift} onClose={() => setShifting(false)} />}
      {editing && <Editor initial={editing} students={data.students} allAssignments={data.assignments} onSave={saveAssignment} onDelete={deleteMany} onClose={() => setEditing(null)} flash={flash} />}
      {toast && (
        <div className="fixed left-1/2 z-50 rounded-lg pl-4 pr-2 py-2 font-semibold flex items-center gap-3" style={{ bottom: 84, transform: "translateX(-50%)", background: C.ink, color: C.white, maxWidth: "92vw" }} role="status">
          <span className="truncate">{toast.m}</span>
          {toast.action && <button className="rounded px-3 py-1 font-bold flex-shrink-0 focus:outline-none focus:ring-2" style={{ background: C.pencil, color: C.ink }} onClick={() => { toast.action.run(); }}>{toast.action.label}</button>}
        </div>
      )}
    </div>
  );
}

// Shared with the home page pictures and the live demo
export { DATA_KEY, TodayView, MonthView, StudentApp, Compliance, ProgressView, Row, StarsCard, VersePractice, schoolDayList, blockedFn, todayISO, addDays, isWeekend, fmtDate, reportCardHTML };
