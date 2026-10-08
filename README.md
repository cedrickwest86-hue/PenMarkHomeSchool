# West Homeschool

A homeschool planner built around numbered daily lesson plans like Abeka's: lesson planning, calendar, grading, student views, reports, and state records. Change the name in `src/brand.js`.

**Start here: [SETUP.md](SETUP.md)**

## What's in this folder

| Path | What it is |
|---|---|
| `src/brand.js` | Name, tagline, beta pricing text, contact email |
| `src/Landing.jsx` | Public home page, live demo, privacy and terms pages |
| `src/demoData.js` | The sample family used by the demo and home page pictures |
| `src/Tracker.jsx` | The app |
| `src/AuthGate.jsx` | Sign-in, family setup, student tablet pairing |
| `src/CalendarLinks.jsx` | Calendar subscription links (Setup screen) |
| `src/sync.js` | Saves to the database and keeps devices in sync |
| `src/platform.js` | Connection settings and the AI connection |
| `supabase/migrations/` | Database tables and security rules (Supabase applies these from GitHub) |
| `supabase/config.toml` | Supabase project settings for the GitHub integration |
| `worker/` | Cloudflare Worker: AI requests (holds the Anthropic key) and calendar links. Cloudflare deploys it from GitHub |
| `.github/workflows/deploy.yml` | Builds and publishes the site to GitHub Pages |

## Run on your own computer (optional)

Requires Node.js 20 or newer. Copy `.env.example` to `.env.local`, fill it in, then run `npm install` and `npm run dev`.
