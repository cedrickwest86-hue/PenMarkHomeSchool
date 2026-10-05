// A sample family for the live demo and the home page pictures. Dates are always relative to today.
import { schoolDayList, blockedFn, todayISO, addDays, isWeekend } from "./Tracker.jsx";

const PSALM_23 = "[1] The LORD is my shepherd; I shall not want. [2] He maketh me to lie down in green pastures: he leadeth me beside the still waters. [3] He restoreth my soul: he leadeth me in the paths of righteousness for his name's sake.";
const rand = (seed) => { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); };
const weekday = (d) => new Date(d + "T12:00:00").getDay();
const onWeekday = (d) => { let x = d; while (isWeekend(x)) x = addDays(x, 1); return x; };

export function makeDemoData() {
  const today = todayISO();
  let start = addDays(today, -44);
  while (isWeekend(start)) start = addDays(start, 1);
  let tuesday = start;
  while (weekday(tuesday) !== 2) tuesday = addDays(tuesday, 1);
  let trip = addDays(today, 6);
  while (isWeekend(trip)) trip = addDays(trip, 1);

  const students = [
    { id: "grace", name: "Grace", grade: "2", subjects: ["Bible", "Phonics", "Reading", "Spelling", "Arithmetic", "Health"], schedule: { Health: [1, 3, 5] } },
    { id: "caleb", name: "Caleb", grade: "5", subjects: ["Bible", "Language", "Reading", "Arithmetic", "Science", "History & Geography"] },
  ];
  const events = [
    { id: "ev-swim", title: "Swim lessons", kind: "Outside lesson", date: tuesday, time: "16:00", repeatWeekly: true, until: addDays(today, 90), studentIds: [], noLessons: false, countsAsDay: false, subject: "Physical Education", minutes: 45, notes: "", createdAt: 1 },
    { id: "ev-trip", title: "Science museum", kind: "Field trip", date: trip, studentIds: [], noLessons: true, countsAsDay: true, subject: "Science", minutes: 240, notes: "Pack lunches", createdAt: 1 },
  ];
  const titles = {
    Phonics: (n) => `Phonics lesson ${n}: blends and seatwork`, Reading: (n) => `Reading lesson ${n}: oral reading`, Spelling: (n) => `Spelling list practice, lesson ${n}`,
    Arithmetic: (n) => `Arithmetic lesson ${n}: speed drill and seatwork`, Bible: (n) => `Bible lesson ${n}`, Health: (n) => `Health lesson ${n}`,
    Language: (n) => `Language lesson ${n}: pp. ${2 * n + 3}–${2 * n + 4}`, Science: (n) => `Science lesson ${n}: reading and Comprehension Check`, "History & Geography": (n) => `History lesson ${n}: reading and map work`,
  };
  const assignments = [];
  let seed = 1;
  for (const s of students) {
    const year = schoolDayList(start, 60, blockedFn(events, s.id));
    year.forEach((d, i) => {
      if (d > addDays(today, 14)) return;
      const n = i + 1;
      for (const sub of s.subjects) {
        const days = s.schedule?.[sub];
        if (days && !days.includes(weekday(d))) continue;
        const past = d < today, isToday = d === today;
        const done = past || (isToday && rand(seed) < 0.4);
        assignments.push({
          id: `a${seed++}`, studentId: s.id, subject: sub, lesson: n, type: "Lesson", title: titles[sub](n), due: d,
          status: done ? "done" : "todo", score: null, notes: "", attachments: [], finishedOn: done ? d : null, createdAt: 1,
        });
      }
      const graded = s.id === "caleb"
        ? [[7, "Arithmetic", "Quiz", "Arithmetic Quiz 1"], [12, "Arithmetic", "Test", "Arithmetic Test 1"], [17, "Arithmetic", "Quiz", "Arithmetic Quiz 2"], [8, "Language", "Quiz", "Language Quiz 1"], [16, "Language", "Quiz", "Language Quiz 2"], [22, "Arithmetic", "Test", "Arithmetic Test 2"], [26, "Science", "Quiz", "Science Quiz 3"], [30, "Arithmetic", "Quiz", "Arithmetic Quiz 3"], [36, "Language", "Test", "Language Test 2"]]
        : [[5, "Spelling", "Test", "Spelling Test 1"], [10, "Spelling", "Test", "Spelling Test 2"], [15, "Spelling", "Test", "Spelling Test 3"], [20, "Phonics", "Test", "Phonics Test 2"], [25, "Spelling", "Test", "Spelling Test 5"], [30, "Arithmetic", "Test", "Arithmetic Test 3"], [35, "Spelling", "Test", "Spelling Test 7"]];
      for (const [ln, sub, type, title] of graded) {
        if (ln !== n) continue;
        const past = d < today;
        assignments.push({
          id: `a${seed++}`, studentId: s.id, subject: sub, lesson: n, type, title, due: d,
          status: past ? "done" : "todo", score: past ? 82 + Math.round(rand(seed) * 18) : null, notes: "", attachments: [], finishedOn: past ? d : null, createdAt: 1,
          ...(title === "Language Test 2" ? { practice: [
            { q: "Which word is a proper noun?", choices: ["city", "Florida", "river", "school"], answer: 1, why: "Florida names one particular place, so it's capitalized." },
            { q: "Choose the complete sentence.", choices: ["Running to the park.", "The dog barked loudly.", "After the storm.", "Because we were late."], answer: 1, why: "It has a subject (dog) and a verb (barked) and a complete thought." },
          ] } : {}),
        });
      }
    });
  }
  // Something turned in today and waiting to be checked
  const turnIn = assignments.find((a) => a.studentId === "caleb" && a.due === today && a.type === "Lesson");
  if (turnIn) Object.assign(turnIn, { status: "submitted", finishedOn: today });
  assignments.push({ id: "verse1", studentId: "grace", subject: "Bible", lesson: null, type: "Memory Verse", title: "Memorize Psalm 23:1-3", verseRef: "Psalm 23:1-3", verseText: PSALM_23, due: onWeekday(addDays(today, -2)), dueBy: onWeekday(addDays(today, 5)), status: "todo", score: null, notes: "", attachments: [], createdAt: 1 });
  assignments.push({ id: "br1", studentId: "caleb", subject: "Reading", lesson: null, type: "Book Report", title: "Book report: Heidi", due: onWeekday(addDays(today, -5)), dueBy: onWeekday(addDays(today, 4)), status: "todo", score: null, notes: "Short format", attachments: [], createdAt: 1 });

  const attendance = {};
  for (const s of students) attendance[s.id] = schoolDayList(start, 60, blockedFn([], s.id)).filter((d) => d < today);
  return {
    students, assignments, events, attendance,
    readingLog: [
      { id: "b1", studentId: "caleb", title: "Heidi", author: "Johanna Spyri", date: addDays(today, -10), notes: "Read aloud together" },
      { id: "b2", studentId: "grace", title: "The Little House", author: "Virginia Lee Burton", date: addDays(today, -6), notes: "" },
    ],
    checklist: {}, timers: {}, transcripts: {},
    rewards: [{ id: "r1", name: "Pick Friday's dinner", cost: 25 }, { id: "r2", name: "Extra hour of game time", cost: 10 }],
    redemptions: [],
    settings: { state: "FL", schoolDays: 180, startDate: start, hoursPerDay: 5, pin: "", lessonsPerYear: 170, starsOn: true },
  };
}
