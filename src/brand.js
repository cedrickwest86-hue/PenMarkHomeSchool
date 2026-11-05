// Everything about the product's name and public face lives here. Change it any time;
// commit, and the site updates everywhere (home page, sign-in, app header, browser tab).
export const BRAND = {
  name: "West Homeschool",               // run a USPTO trademark search before launch
  tagline: "The homeschool planner that keeps pace with your lesson plans",
  short: "Plan the year, grade faster, keep your state records, and give every child their own view.",
  beta: true,                            // shows "Beta" badges and beta pricing
  betaPricing: "Free while we test. Families who join the beta get a founding-family rate when we launch.",
  contactEmail: "",                      // e.g. "hello@yourdomain.com"; leave empty to hide
  company: "",                           // legal name for the footer, e.g. "West Homeschool LLC"
  trialDays: 14,
  // Prices shown in the app and on the home page. They must match the prices you create in Stripe.
  plans: {
    essentials: {
      name: "Essentials", month: 7.99, year: 75,
      blurb: "Everything to plan, teach, and keep records.",
    },
    plus: {
      name: "Plus", month: 12.99, year: 119,
      blurb: "Essentials, plus AI that reads your lesson plans and helps you grade.",
    },
  },
  // Side-by-side comparison: [feature, in Essentials, in Plus]
  compare: [
    ["All your children, one price", true, true],
    ["Lesson planning and calendar; Abeka lessons laid out for the year", true, true],
    ["Spreadsheet import (Excel or CSV) and your own subjects", true, true],
    ["Each child's own device code", true, true],
    ["Grades, report cards, transcripts, and attendance", true, true],
    ["State and Step Up For Students checklists", true, true],
    ["Calendar on your phone, with reminders for lessons and activities", true, true],
    ["Co-teachers", true, true],
    ["Read lesson plans from photos and PDFs", false, true],
    ["AI grading assistant and report card comments", false, true],
    ["Plan a course from a book's name", false, true],
  ],
  aiAllowance: "about 150 lesson-plan pages a month",
};
