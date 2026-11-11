# Family Maintenance Tracker (Supabase)

A shared maintenance log for your family. Every record lives in Supabase PostgreSQL;
the browser holds no data of its own (no localStorage / sessionStorage / IndexedDB for records).

## Files
| File | Purpose |
|---|---|
| `schema.sql` | Tables, triggers, invite function, Row Level Security, Realtime publication |
| `config.js` | Your Supabase URL + **anon** key |
| `index.html`, `app.js` | The app (plain JavaScript modules, official `@supabase/supabase-js` v2) |

## Setup
1. Create a project at https://supabase.com.
2. **SQL Editor → New query**, paste all of `schema.sql`, **Run**.
3. **Authentication → Providers → Email**: keep "Confirm email" **on** (membership is granted only after the email is confirmed).
4. **Authentication → URL Configuration**: set *Site URL* to the address where you host the app (e.g. `http://localhost:3000` while testing).
5. **Project Settings → API**: copy the *Project URL* and the *anon / publishable* key into `config.js`.
6. Serve the folder over HTTP (ES modules don't work from `file://`), e.g. `npx serve .`, or deploy to any static host (Netlify, Vercel, GitHub Pages, Cloudflare Pages).
7. **Create your account first.** The first confirmed account becomes the family admin. Then use **Members → Invite** to authorize everyone else.

## How access works
- Anyone can create an auth account, but data is only visible to rows in `family_members`.
- Membership is granted automatically only if the confirmed email was invited by an admin (or it's the very first account).
- RLS: members can read/add/edit records; delete is allowed for the record's creator or an admin; only admins can manage members and invites. Anonymous visitors have no table privileges at all.
- Audit columns (`created_by`, `updated_by`, `updated_at`) are enforced by database triggers.

## Security notes
- The **anon key is public by design** and safe in frontend code *because of* RLS. Never put the `service_role`/secret key in any frontend file.
- Supabase's client keeps the *login token* in the browser so you stay signed in. That is authentication only; the maintenance records themselves are never stored locally, and signing in on another device shows the same data.
- Optional hardening: after your family has joined, disable new sign-ups under Authentication → Sign In / Providers, and invite people from the dashboard instead.

## Realtime
`maintenance_records` and `family_members` are added to the `supabase_realtime` publication. The app subscribes after sign-in, applies INSERT/UPDATE/DELETE events live, and re-fetches after a dropped connection.
