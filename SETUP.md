# West Homeschool: setup guide

About 30–40 minutes, once. Because Supabase and Cloudflare are already connected to your GitHub, both deploy straight from your repository. After setup, any change you push to GitHub updates the site, the database, and the AI worker automatically.

**Keep a note open** to paste these as you go:

| What | Where it comes from |
|---|---|
| Supabase Project URL | Step 1 |
| Supabase anon (publishable) key | Step 1 |
| Your site address | Step 2 |
| AI worker address | Step 5 |

Never paste the Supabase **service_role / secret** key or your **Anthropic API key** into GitHub or into any file. The Anthropic key goes only into Cloudflare, as a Secret.

---

## Step 1. Create the database project (Supabase)

1. In Supabase, click **New project**. Name it (e.g. *homeschool*), create a strong database password and save it somewhere safe, and choose the **East US** region. Wait a minute while it sets up.
2. **Authentication** → **Sign In / Providers**:
   - Make sure **Email** is on.
   - Turn on **Allow anonymous sign-ins**. This is how student tablets connect with a code instead of an email. (The setting in the project files only covers test copies, so this switch is required.)
3. **Project Settings** → **API Keys** (or **API**). Copy the **Project URL** and the **anon** / **publishable** key (the one marked safe for browsers).

## Step 2. Create the website (GitHub)

1. **+** → **New repository**. Name it `homeschool-tracker`, choose **Private**, and create it.
2. Click **uploading an existing file**, drag in everything from the unzipped `hs` folder, and click **Commit changes**.
3. Check that the `.github` folder uploaded (computers hide folders starting with a dot). If it's missing: **Add file** → **Create new file**, name it `.github/workflows/deploy.yml`, paste that file's contents, and commit.
4. **Settings** → **Pages** → set **Source** to **GitHub Actions**.
5. **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → add:
   - `SUPABASE_URL` = your Project URL
   - `SUPABASE_ANON_KEY` = your anon/publishable key
6. **Actions** → **Deploy site** → **Run workflow**. After about 2 minutes (green check), your site is at
   `https://YOUR-GITHUB-NAME.github.io/homeschool-tracker/`
7. Back in Supabase: **Authentication** → **URL Configuration**. Set **Site URL** to that address and add it under **Redirect URLs**.

## Step 3. Let Supabase set up the database from GitHub

1. In your Supabase project: **Project Settings** → **Integrations** → **GitHub**. Choose the `homeschool-tracker` repository.
2. Set **Supabase directory** to `supabase` and **production branch** to `main`.
3. Turn on **Deploy to production** and save.
4. The setup runs the next time something is pushed to `main`. To trigger it now, open `README.md` on GitHub, click the pencil, add a blank line, and commit.
5. Confirm it worked: Supabase **Table Editor** should list `families`, `members`, and `kv`, and **Storage** should show a `family-files` bucket.

**If the tables don't appear within a few minutes:** open **SQL Editor** → **New query**, paste the whole file `supabase/migrations/20261005000000_homeschool_setup.sql`, and click **Run**. It's safe to run even if the integration already did.

The site works at this point, without the AI tools. You can sign in and start (step 7).

## Step 4. Get an Anthropic API key

1. At **console.anthropic.com**, add a payment method under **Billing**.
2. Under **Limits**, set a **monthly spend limit**. This is your safety net.
3. **API Keys** → **Create Key**. Copy it now (it's shown once) and keep it private.

## Step 5. Deploy the AI worker from GitHub (Cloudflare)

1. In Cloudflare: **Workers & Pages** → **Create** → **Import a repository** → choose `homeschool-tracker`.
2. Set:
   - **Project name:** `homeschool-ai` (must match exactly)
   - **Root directory** (under advanced/build settings): `worker`
   - **Build command:** leave blank
   - **Deploy command:** `npx wrangler deploy`
   - **Build watch paths** (optional): `worker/*`, so only worker changes redeploy it
3. Click **Deploy**.
4. Open the worker → **Settings** → **Variables and Secrets** and add:

   | Name | Type | Value |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | **Secret** | your Anthropic key |
   | `ALLOWED_ORIGINS` | Text | `https://YOUR-GITHUB-NAME.github.io` (no path, no ending slash) |
   | `SUPABASE_URL` | Text | your Project URL |
   | `SUPABASE_ANON_KEY` | Text | your anon/publishable key |
   | `MODEL` | Text | `claude-sonnet-5-5` |

   These survive future deploys because the project includes `keep_vars = true`.
5. Copy the worker's address from its overview (like `https://homeschool-ai.your-name.workers.dev`).

## Step 6. Turn on the AI tools

1. GitHub: **Settings** → **Secrets and variables** → **Actions** → **Variables** → add `AI_URL` = the worker address.
2. **Actions** → **Deploy site** → **Run workflow**.

3. **Who gets AI.** After you run the billing update (see "Selling it" below), AI follows each family's plan: Plus plans and free trials have it, within a monthly limit. Your own family and beta testers become free accounts; in the **admin portal → Families**, use **Make free (Plus)** to give a family AI. (Before the billing update, this was the `ai_enabled` switch in the `families` table.)

In the site, **Setup** → *Devices and sign-in* should now say **AI tools: on**.

## Step 7. First use

1. Open your site. You'll see the home page with the features, pictures, and a **Try the live demo** button. Click **Join the free beta** (or **Sign in** at the top) → **Create an account**. Confirm the email Supabase sends, then sign in.
2. Name your homeschool.
3. **Bring over your data:** in the Claude version, **Setup** → **Back up**. In the new site, **Setup** → **Restore** and pick that file. Answer keys move into the teacher-only area automatically.
4. **Each child's device:** **Setup** → *Devices and sign-in* → **Make code** next to a child. On that child's iPad or phone, open the site → **Student tablet** → enter the code. That device shows only that child. (A **Shared family tablet** code, where every child taps their name, is still available below it.)
5. **Co-teacher (optional):** **Setup** → *Teachers* → **Co-teacher code**. On their phone or computer they open the site → **Sign in** → **Co-teacher** → enter the code. No account needed to start. Each code works once, within 7 days.
   - Until they create a login (the yellow **Create my login** box in their Setup), they're "this device only": lessons, grading, and the calendar all work, but the AI tools and making device codes are off for them, and signing out or clearing the browser loses access.
   - **Create my login:** they enter their email, open the confirmation link, then choose a password. Everything they've done stays. The link brings them back to your **Site URL** (Step 2, item 7), so make sure that's set.
   - You can see every teacher and **Remove** a co-teacher under *Teachers*.

---

## Calendar reminders on phones, iPads, and computers

School can show up in the calendar app each person already uses, with reminders: the day's work at 7:30 a.m., and a heads-up at 6 p.m. the evening before tests, due dates, and events.

1. In the site: **Setup** → *Calendar on your devices*. Tap **Make link** next to **Whole family** (for you) or a child's name.
2. **On an iPhone or iPad:** tap **Add to this device** on that device, or scan the code with its Camera. Then tap **Subscribe**.
   - For reminders: **Settings** → **Calendar** → **Accounts** → **Subscribed Calendars** → pick the calendar → make sure **Remove Alarms** is off.
3. **Google Calendar on a computer:** **Copy link** → in Google Calendar, **Other calendars** → **+** → **From URL** → paste. Google uses its own reminder settings for the calendar: open its **Settings** and set **All-day event notifications**.
4. **Outlook:** **Copy link** → **Add calendar** → **Subscribe from web** → paste.

Good to know:
- Calendar apps check for changes about once an hour (Google can take longer), so a change you make now shows up later.
- Finished work drops off the calendar.
- A link shows lessons, tests, due dates, and events only: never grades, notes, answer keys, or photos.
- If a link gets shared too widely, tap **Make a new link** (the old one stops working) or **Turn off**.
- Calendar links run on the Cloudflare worker, so they need step 5 done. They don't use AI and cost nothing extra.

## Make it yours (testing now, selling later)

- **Change the name:** on GitHub, open `src/brand.js`, click the pencil, change `name` (and the tagline if you like), and commit. The home page, sign-in, app header, and browser tab all update in about 2 minutes. `contactEmail` and `company` fill in the footer and policy pages when you're ready.
- **Rename the repository to match:** **Settings** → **General** → **Repository name**. Your site address changes to the new name, so update **Site URL** and **Redirect URLs** in Supabase. (Cloudflare's `ALLOWED_ORIGINS` stays the same.)
- **Beta testers:** anyone can join from the home page and sees only their own family. Leave sign-ups on, because student tablets need them. New families can't use AI until you switch it on.
- **Before you charge anyone,** plan for:
  - a trademark search on the final name (USPTO and app stores)
  - an attorney's review of the Privacy and Terms pages, especially for children's information
  - payments (for example, Stripe)
  - Supabase's paid plan, so projects never pause and you get daily backups
  - a custom domain
  - a budget for AI use per family

## Good to know

- **Updating later:** change a file on GitHub and commit. The site rebuilds itself, Supabase applies new files added to `supabase/migrations`, and Cloudflare redeploys the worker when `worker/` changes.
- **Syncing:** changes save within a second; other devices pick them up within about 15 seconds or as soon as the app is reopened. If two devices edit at once, both changes are kept.
- **Offline:** an "Offline" note appears and changes save when you're back online. Keep the page open until it goes away.
- **Who sees what:** student tablets get the kids' views only. They can't read answer keys, use the AI tools, or open teacher screens. Anyone who finds the site's address sees only a sign-in screen.
- **Lost or replaced tablet:** **Setup** → **Disconnect tablets**, then make a new code.
- **Costs:** GitHub Pro (your plan). Supabase and Cloudflare free tiers cover a family. Anthropic bills per AI use, capped by your spend limit.
- **Supabase free projects can pause after about a week of no use** (summer break, for example). If the site can't connect, open the Supabase dashboard and click **Restore project**.
- **Backups:** **Setup** → **Back up** each grading period. Keep the file somewhere safe and never upload it to GitHub.
- **Changing the AI model:** edit `MODEL` in the Cloudflare worker's settings. Nothing else changes.
- **Not in this version yet:** Google Calendar sync.

---

## Selling it: plans, billing, and the admin portal

Do these in order. Use Stripe's **Test mode** first (toggle at the top of the Stripe dashboard); switch to live mode only after the test checklist at the end passes.

### 1. Supabase
1. **SQL Editor → New query**, paste `supabase/migrations/20261106000000_billing_admin.sql`, **Run**.
   - Every family that already exists (yours and your beta testers) becomes a **free ("comp") account**: Plus if you had turned AI on for them, Essentials otherwise. New sign-ups get a 14-day free trial.
2. Make yourself an admin. In a new query, with the email you sign in with:
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'YOUR-LOGIN-EMAIL';
   ```
   Then in the app, **Setup → Devices and sign-in → Open the admin portal** (or go to `#/admin`).
3. **Project Settings → API Keys**: copy the **secret** key (older projects call it `service_role`). It goes only into Cloudflare (step 3), never into GitHub or the site.
4. When you launch: **Organization → Billing → upgrade to Pro** ($25/month).

### 2. Stripe
1. Create an account at stripe.com (use your business details).
2. **Product catalog → Add product**, twice:
   - **Essentials**: a recurring price of **$7.99 monthly**, and another of **$75 yearly**.
   - **Plus**: **$12.99 monthly** and **$119 yearly**.
   Copy each price's ID (starts with `price_`). If you choose different prices, also change them in `src/brand.js` so the app shows the same numbers.
3. **Settings → Billing → Customer portal**: turn on *Cancel subscriptions* (choose **at the end of the billing period**), *Switch plans* (add both products and all four prices), *Update payment methods*, and *Invoice history*. Save.
4. **Developers → Webhooks → Add endpoint**:
   - URL: `https://YOUR-WORKER.workers.dev/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - After saving, copy the **Signing secret** (starts with `whsec_`).
5. **Developers → API keys**: copy the **Secret key** (`sk_test_…` in test mode, `sk_live_…` in live mode).
6. Optional: **Product catalog → Coupons** to give beta families a founding-family discount; checkout accepts promotion codes.

### 3. Cloudflare worker settings
Worker → **Settings → Variables and Secrets → Add**. Secrets are marked **Secret**; the rest are **Text**.

| Name | Type | Value |
|---|---|---|
| `SUPABASE_SERVICE_KEY` | Secret | the Supabase secret key from step 1.3 |
| `STRIPE_SECRET_KEY` | Secret | from step 2.5 |
| `STRIPE_WEBHOOK_SECRET` | Secret | from step 2.4 |
| `PRICE_ESSENTIALS_MONTHLY` | Text | `price_…` |
| `PRICE_ESSENTIALS_YEARLY` | Text | `price_…` |
| `PRICE_PLUS_MONTHLY` | Text | `price_…` |
| `PRICE_PLUS_YEARLY` | Text | `price_…` |
| `SITE_URL` | Text | your site's address, e.g. `https://cedrickwest86-hue.github.io/PenMarkHomeSchool/` |

The worker also runs once a day on its own (set in `wrangler.toml`): it sends reminder emails and permanently deletes accounts that have been closed for more than 12 months, including their photos.

### 4. Email (recommended before launch)
Supabase's built-in email only sends a few messages an hour, which isn't enough once families sign up. Use **Resend** (free for 3,000 emails a month):
1. Sign up at resend.com, add and verify your domain, and create an API key.
2. **Supabase → Authentication → Emails → SMTP Settings**: turn on custom SMTP. Host `smtp.resend.com`, port `465`, username `resend`, password = your Resend API key, sender = e.g. `help@yourdomain.com`.
3. Add to the Cloudflare worker: `RESEND_API_KEY` (Secret), `EMAIL_FROM` (Text, e.g. `West Homeschool <help@yourdomain.com>`), and `ADMIN_EMAIL` (Text, where contact-form messages go). This turns on trial-ending reminders, the 30-day "your records will be deleted" warning, and emailing you each contact-form message.

### 5. Turn off "beta"
In `src/brand.js`, set `beta: false` and fill in `contactEmail` and `company`. The home page then shows the two plans side by side with the free-trial button.

### How cancellation works (what families see)
- **Free trial**: 14 days with every Plus feature, no card. Choosing a plan during the trial doesn't charge until the trial ends.
- **Cancel** (Setup → Your plan → *Change plan, update card, or cancel*, which opens Stripe's billing page): they keep full access until the end of the time they paid for.
- Then **10 days read-only**: they can look at everything, **Download my records** (a backup file they can restore later), and print report cards and transcripts from Records. Changes aren't saved.
- Then **paused**: signing in shows "Your homeschool is paused" with the plans. Kids' devices show "School is paused." Calendar links stop.
- Records are kept **12 months** after the read-only window, with an email warning 30 days before deletion. Choosing a plan any time before that brings everything back exactly as it was.
- A trial that ends without a plan follows the same read-only → paused → 12-month path.

### Admin portal (`#/admin`)
- **Overview**: paying families by plan, estimated monthly revenue, AI cost this month, an estimated net, trials ending soon, past-due payments, new messages, and app errors.
- **Families**: search, see each family's plan, status, last visit, children and devices, and AI use. Extend a trial, make a family free (your family, beta testers), block AI, or change a family's monthly AI limit. Refunds and paid-plan changes are done in Stripe.
- **Messages**: what families sent from *Setup → Help and contact*, with a *Reply by email* button.
- **Errors**: problems the app ran into on families' devices, grouped so repeated bugs stand out.
- It never shows a family's lessons, grades, or files.

### AI limits
Plus includes about **$6 of AI a month** per family (roughly 150 lesson-plan pages); trials get $1.50. When a family reaches the limit, AI tools say so until the 1st of the next month. You can raise one family's limit in the admin portal. The defaults are in `ai_cap()` in the SQL file.

### Test checklist (Stripe test mode)
1. Sign up as a new family in a private browser window: you should see the free trial in **Setup → Your plan**.
2. Choose **Plus, Yearly**. Pay with test card `4242 4242 4242 4242`, any future date, any CVC. You return to the app with "Thank you! Your plan is active."
3. In the admin portal, that family shows **active · plus**.
4. **Change plan, update card, or cancel** → cancel. Setup shows "canceled; full access until …".
5. In Stripe (test mode), open that subscription → **Cancel immediately**. The app turns read-only with the red banner; **Download my records** works.
6. Admin portal → that family → it shows read-only and its deletion date. Choose a plan again: everything comes back.
