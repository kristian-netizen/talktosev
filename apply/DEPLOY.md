# `/apply` deployment guide

One-time setup to get the apply form live at `talktosev.com/apply`.
Five steps, ~15 minutes if you have Supabase + Resend accounts already.

## 1. Run the Supabase SQL

1. Open your Supabase project → **SQL Editor** → **New query**
2. Paste the contents of [`../supabase-setup.sql`](../supabase-setup.sql)
3. Click **Run**

This creates the `leads` table, indexes, RLS policies, and the `lead_stats` view.

## 2. Configure Supabase Auth

In your Supabase project:

1. **Authentication → Providers**: enable **Email**. Turn OFF "Confirm email" (so magic links work on first click).
2. **Authentication → URL Configuration**: add `https://talktosev.com/apply/admin` to the **Redirect URLs** allowlist.
3. **Authentication → Email Templates → Magic Link**: optional but recommended — rewrite the subject/body so it reads like *you*, not the default Supabase template.

## 3. Grab the keys

From the Supabase dashboard:

- **Project Settings → API**
  - `Project URL` — looks like `https://xxxxxxxxxxx.supabase.co`
  - `anon` `public` key — safe to expose to the browser (RLS protects the data)
  - `service_role` key — **NEVER** put this in client-side code

From Resend (https://resend.com/api-keys):

- Create an API key with **Full access** (or restrict to "Sending access" only)
- Confirm your sending domain is verified (Domains → check status = Verified)

## 4. Set Vercel environment variables

Run from the repo root:

```bash
vercel env add SUPABASE_URL              production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add RESEND_API_KEY            production
vercel env add RESEND_FROM_EMAIL         production   # e.g. "Sev <sev@talktosev.com>"
vercel env add RESEND_REPLY_TO           production   # e.g. sev@sevspics.com
```

(Repeat each with `preview` if you want preview deploys to also work.)

## 5. Wire the admin page to Supabase

The admin page (`apply/admin.html`) needs the public Supabase URL + anon key
hard-coded so the browser can authenticate. These are safe to commit because
RLS policies enforce that only `sev@sevspics.com` can read any rows.

Open `apply/admin.html` and replace these two lines near the top of the script:

```js
const SUPABASE_URL  = window.SUPABASE_URL  || 'REPLACE_SUPABASE_URL';
const SUPABASE_ANON = window.SUPABASE_ANON || 'REPLACE_SUPABASE_ANON_KEY';
```

with your actual values:

```js
const SUPABASE_URL  = 'https://xxxxxxxxxxx.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJI...';
```

## 6. Deploy

```bash
vercel --prod --yes
```

That's it. Visit `https://talktosev.com/apply` to see the form,
and `https://talktosev.com/apply/admin` to sign in (you'll get a magic link emailed to `sev@sevspics.com`).

---

## Smoke test checklist

After deploy:

- [ ] `/apply` loads with the intro screen
- [ ] You can click through all 10 questions and submit
- [ ] You receive the confirmation email at the address you used
- [ ] The success screen shows the **Calendly** link if you selected `Over 20k p/m`
- [ ] The success screen shows the **Follow @sevspics** link if you selected `Under 20k p/m`
- [ ] `/apply/admin` redirects you to a sign-in screen
- [ ] Entering `sev@sevspics.com` sends a magic link
- [ ] Clicking the magic link signs you in and loads your test submission
- [ ] Clicking a row opens the detail drawer
- [ ] "Mark contacted" toggles the row badge
- [ ] "Export CSV" downloads a properly-formatted file

---

## What's where

```
/api/submit-lead.js      Vercel Function: validates → Supabase insert → Resend email
/apply/index.html        The 12-step Typeform-style survey at talktosev.com/apply
/apply/admin.html        Magic-link-gated admin dashboard at talktosev.com/apply/admin
/apply/DEPLOY.md         This file
/supabase-setup.sql      One-shot SQL to create the table, RLS, and stats view
```

## Where the data lives

- **Database**: Supabase `public.leads` table. Sev's the only person with read/write access (RLS enforced).
- **Email**: Resend handles outbound. The confirmation email is fire-and-forget — if Resend is down, the lead is still saved and you'll see it in the admin.
- **No analytics tracking, no third-party JS** other than the Supabase JS SDK (loaded only on `/apply/admin`, not on the public `/apply` form).

## Future things to layer on

- **SMS confirmation via Twilio**: add a second send in `api/submit-lead.js` after the Resend call.
- **Slack ping when a $20k+ lead comes in**: add a webhook POST in the same handler, gated on `qualified === true`.
- **Auto-tag leads in an existing CRM**: same idea — POST to your CRM's API alongside the Supabase insert.
- **Block duplicate submissions per email**: add a UNIQUE constraint on `email` in the SQL, and surface the conflict as a friendly error in the form.
