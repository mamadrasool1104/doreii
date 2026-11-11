# سرویس خودرو خانواده (پراید) — Family Car Maintenance

A Persian, right-to-left web app for tracking the family car's maintenance.
Static site (HTML/CSS/JavaScript) hosted on **GitHub Pages**; **Supabase** (PostgreSQL + Auth + Realtime) is the single, shared, permanent database. No backend server.

## Files
| File | Purpose |
|---|---|
| `schema.sql` | Tables, seed schedule, security rules (RLS), realtime. Safe to re-run; never deletes records. |
| `config.js` | Your Supabase **URL** and **anon (public)** key |
| `index.html`, `styles.css`, `app.js` | The application |

## 1. Create the Supabase project
1. Sign up at https://supabase.com → **New project**.
2. **SQL Editor → New query**, paste the whole `schema.sql`, click **Run**. This creates the tables, the Pride vehicle, the standard 5k/10k/20k/40k km checklist, RLS policies and realtime publication.

## 2. Authentication settings
In **Authentication**:
- **Sign In / Providers → Email**: enabled, keep **Confirm email = ON**.
- **URL Configuration**
  - *Site URL*: `https://YOUR-USERNAME.github.io/YOUR-REPO/`
  - *Redirect URLs*: add the same address (and `http://localhost:3000/` for local testing).

## 3. Credentials (secure setup)
**Project Settings → API**: copy the *Project URL* and the **anon / publishable** key into `config.js`.

- The anon key is **public by design**; it is safe in a public GitHub repository because Row Level Security blocks every non-member.
- **Never** put the `service_role` / secret key in `config.js`, the repository, or any frontend file.

## 4. Deploy to GitHub Pages
1. Create a GitHub repository and upload these files to the repository root (`index.html` at the top level).
2. **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**, branch `main`, folder `/ (root)` → Save.
3. After a minute the site is live at `https://YOUR-USERNAME.github.io/YOUR-REPO/` — share this single link with the family.

Local test: `npx serve .` (ES modules need HTTP, not `file://`).

## 5. Add the family
1. **Create your own account first** (open the site → «ساخت حساب جدید», confirm the email). The first confirmed account becomes the **admin**.
2. Click **اعضای خانواده → دعوت** and enter each family member's email.
3. Each person creates an account with that email and confirms it; access is granted automatically. Anyone not invited sees «دسترسی هنوز فعال نشده است» and no data.
4. Optional hardening: after everyone has joined, turn off *Allow new users to sign up* in Authentication settings.

## How it works
- **Dashboard**: vehicle name (پراید), current mileage (editable), last service date and mileage, overdue warnings, upcoming and completed services, latest history.
- **Checklist**: the schedule from your spec. Ticking an unchecked item asks for date, mileage and notes and records who registered it. A task shows **overdue / near due / on schedule** from `last service km + interval` versus current mileage; the tick clears automatically when the next interval is reached — old records stay. Ticking a checked item opens its record for editing. Custom tasks can be added (optionally with a km interval).
- **Service history**: create a record (date, mileage, shop, multiple tasks, parts, cost, notes). Records can be edited later and **each new note is appended** with its author and time. Search, filter by date / mileage / category, export the (filtered) list to CSV that opens in Excel.
- **Dates** are stored as ISO dates and displayed in the Persian (Jalali) calendar; numbers accept Persian or English digits.
- **Sync**: all reads/writes go to Supabase; every change is pushed to other open devices via Supabase Realtime (reconnect re-syncs). The browser only keeps the login session token — no records.
- **Never deleted**: the app has no delete button for service records, and the database grants no delete permission on them. (Admins can still delete rows manually in the Supabase dashboard if ever needed.)

## Test scenario (your section 10)
1. Member A signs in on Chrome, ticks «تعویض روغن موتور», enters mileage and a note → saved.
2. A closes Chrome. Member B opens the site on another device → sees the same record, mileage, note and «ثبت: A».
3. A signs in days later → everything is still there.

## Security summary
RLS is enabled on every table. Members can read/add/edit; anonymous users have no table access; only admins manage members; audit columns (`created_by`, `updated_by`) are set by database triggers, not the browser; the last admin can't be removed.
