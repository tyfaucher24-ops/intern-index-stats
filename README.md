# Intern Index stats

A private, admin-only dashboard for Intern Index usage, served on its own GitHub Pages URL:

**https://tyfaucher24-ops.github.io/intern-index-stats/**

It is completely separate from the Intern Index site (`tyfaucher24-ops/internship-radar`): its own repo,
its own URL, its own deploy. Nothing here is linked from, or embedded in, the product site. The numbers
Ty does not want on the public site live here instead.

## What it shows

- **Live now** — the hero. Distinct people on the site in the last 90 seconds, the 5-minute count,
  signed-in vs. not signed-in, and a per-page breakdown. Polls every 15 seconds while the tab is
  visible, pauses when the tab is hidden, and refreshes the moment it becomes visible again.
  If no heartbeat has ever arrived, it shows **–** with "waiting for first heartbeat" instead of a
  fake zero.
- **Listings (latest sync)** (V21): open listings (same count as the Find page), new today, closed today
  (New York day), and open listings by kind and by source. Read from the public `data/counts.json` that the
  Intern Index sync writes every run (fetched from the product origin with `?ts=`; no Supabase table needed).
- **Key numbers** — total users, new signups (7 days, with 30 days under it), DAU / WAU / MAU,
  stickiness (WAU ÷ MAU), saves this week, apply clicks this week, email subscribers.
- **Daily signups and active users** — plain inline SVG line chart, with the same figures available
  as a table under a disclosure.
- **Signup funnel** — visited → built a profile → created an account → saved a role → clicked apply.
- **Weekly retention** — signup cohorts, weeks 1–8. Weeks that have not happened yet show –.
- **Most-saved companies**, **most-saved roles**, **top schools** (schools with fewer than 5 users
  are hidden), and **email** (sent, clicks, click-through rate, unsubscribes by type).
- **Export CSV** on every section.

A date range picker refetches everything; the default is the last 90 days ending today.

## How to sign in

Either:

1. **Continue with Google**, or
2. enter your email and click **Email me a sign-in link** (no password; the link is one-time).

Only accounts listed as admins in the Supabase project can see numbers. Anyone else who signs in
successfully gets a plain **"This page is private."** screen — no error text, no partial data.
Signed-out visitors get the sign-in screen.

## Required Supabase setup (the one thing that is not in this repo)

1. **Redirect allow-list.** Both sign-in methods send `redirect_to` as exactly

   ```
   https://tyfaucher24-ops.github.io/intern-index-stats/
   ```

   Add that URL to **Supabase → Authentication → URL Configuration → Redirect URLs**. If it is not
   on the list, Supabase falls back to the project's Site URL and the link lands on the main site
   instead of here.

2. **The two RPCs.** The dashboard calls

   - `admin_stats_v17(p_from date, p_to date)` → the history object
   - `admin_live()` → `{now, five_min, signed_in, anon, by_page, updated_at}`

   Both must be `SECURITY DEFINER` and check the caller against the admin list, raising
   `not found` (SQLSTATE `42501`) for anyone else. Until they exist, the page shows a friendly
   **"Not set up yet"** state (or, if only `admin_live` exists, just the live hero) — never a crash
   and never a stack trace.

## Security and privacy

- The only credential in the repo is the Supabase **publishable (anon)** key, which is public by
  design. **No service_role key, no secret, anywhere.**
- All figures are aggregated inside Postgres. The browser never receives raw user rows.
- The page is marked `noindex, nofollow, noarchive` and `robots.txt` disallows everything.
- No analytics, telemetry, third-party fonts, CDN links, or external images. The Content Security
  Policy allows scripts, styles and images from this origin only, and network requests only to the
  Supabase project.
- Respects `prefers-color-scheme`; system font stack; readable on a phone; keyboard focus outlines;
  table headers with `scope`; the live number is an `aria-live="polite"` region.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The shell: header, `<main>`, footer, CSP, `noindex`. |
| `styles.css` | All styling, light and dark. |
| `cloud-config.js` | Supabase URL + publishable key. |
| `cloud.js` | Auth and PostgREST over `fetch`. No SDK, no dependencies. |
| `app.js` | Screens, data loading, live polling, charts, CSV export. |
| `robots.txt` | Disallows everything. |
| `.nojekyll` | Serve files as-is on GitHub Pages. |

## Local preview

```sh
python3 -m http.server 8000
# open http://127.0.0.1:8000/
```

`cloud.js` also accepts a `http://127.0.0.1:PORT` or `http://localhost:PORT` base URL, so you can
point `cloud-config.js` at a local mock of the two RPCs while working on the UI.
