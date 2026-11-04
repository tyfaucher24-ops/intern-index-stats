/* Intern Index stats — admin-only usage dashboard.
   Reads two SECURITY DEFINER RPCs (admin_stats_v17, admin_live); every number is aggregated in
   Postgres. Nothing here can read a table directly: a non-admin call comes back "not found". */
(() => {
  'use strict';

  const Cloud = window.StatsCloud;
  const $ = id => document.getElementById(id);
  const main = $('app');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DASH = '<span class="dash" aria-label="no data">–</span>';
  /* null / undefined / NaN are "no number", never 0 */
  const num = n => (n == null || n === '' || !Number.isFinite(Number(n))) ? null : Number(n);
  const fmt = n => { const v = num(n); return v == null ? DASH : v.toLocaleString('en-US'); };
  const pct = (a, b) => { const x = num(a), y = num(b); return (x == null || y == null || !y) ? DASH : Math.round(100 * x / y) + '%'; };
  const day = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const timeOf = iso => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  };

  let range = null;
  let data = null;
  let live = null;
  let liveErr = null;
  let notAuthorized = false;
  let loading = false;
  let liveTimer = null;
  let clockTimer = null;
  let lastLiveOk = 0;
  let livePolls = 0;
  let signedOutNotice = '';

  const DEFAULT_DAYS = 90;

  /* ---------------- error classification ---------------- */
  const isMissingFn = e => {
    if (!e) return false;
    const c = String(e.code || ''), m = String(e.message || '').toLowerCase();
    return c === 'PGRST202' || c === '42883' || /could not find the function|function .* does not exist|schema cache/.test(m);
  };
  /* Postgres refusing EXECUTE ("permission denied for function ...") is a deployment gap,
     not an admin check: the RPC was never granted to the signed-in role yet. */
  const isNotGranted = e => {
    if (!e) return false;
    const c = String(e.code || ''), m = String(e.message || '').toLowerCase();
    return c === '42501' && /permission denied for function|permission denied for schema/.test(m);
  };

  const isSessionGone = e => !!e && (String(e.code) === 'session_expired' || String(e.code) === 'signed_out');
  const isPrivate = e => {
    if (!e || isSessionGone(e)) return false;
    const c = String(e.code || ''), m = String(e.message || '').toLowerCase();
    return e.status === 401 || e.status === 403 || c === '42501' || /^not found$/.test(m);
  };

  /* ---------------- screens ---------------- */

  function shell(inner, { wide = true } = {}) {
    main.innerHTML = wide ? `<div class="wrap">${inner}</div>` : `<div class="wrap"><div class="screen">${inner}</div></div>`;
  }

  function renderLoading() {
    shell(`<div class="panel" role="status"><h2>Loading…</h2><p class="sub">Checking your access.</p></div>`, { wide: false });
  }

  function renderSignIn(msg, tone) {
    document.title = 'Sign in · Intern Index stats';
    shell(`
<div class="panel">
  <h2>Intern Index stats</h2>
  <p class="sub">This page is private. Sign in with the account that has admin access.</p>
  ${Cloud.googleOn ? `
  <button type="button" class="gbtn" id="gBtn">
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.655z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
    <span>Continue with Google</span>
  </button>
  <div class="or" role="separator" aria-label="or"><span>or</span></div>` : ''}
  <form id="linkForm" novalidate>
    <label class="field" for="email">
      <span>Email</span>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required>
    </label>
    <button type="submit" id="linkBtn" style="width:100%">Email me a sign-in link</button>
  </form>
  <p class="msg" id="signMsg" role="status" aria-live="polite" ${tone ? `data-tone="${tone}"` : ''}>${msg ? esc(msg) : ''}</p>
  <p class="fineprint">No password. We email a one-time link. If you are not an admin, the page stays closed.</p>
</div>`);

    const say = (t, k) => { const n = $('signMsg'); n.textContent = t; if (k) n.dataset.tone = k; else delete n.dataset.tone; };
    const gb = $('gBtn');
    if (gb) gb.addEventListener('click', () => { say('Opening Google…'); Cloud.google(); });
    $('linkForm').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('linkBtn'), v = $('email').value;
      btn.disabled = true; say('Sending…');
      try {
        await Cloud.sendLink(v);
        say('Check your email for a sign-in link. It works once and expires.', 'ok');
        btn.disabled = false;
      } catch (err) {
        say(Cloud.friendly(err), 'err');
        btn.disabled = false;
      }
    });
  }

  function renderPrivate() {
    document.title = 'Private · Intern Index stats';
    shell(`
<div class="notice">
  <h2>This page is private.</h2>
  <p>Your account is signed in, but it does not have access to Intern Index stats. If you think that is wrong, ask Ty to add your email to the admin list.</p>
  <p><button type="button" class="btn-ghost" id="outBtn">Sign out</button></p>
</div>`, { wide: false });
    $('outBtn').addEventListener('click', async () => { await Cloud.signOut(); boot(); });
  }

  function renderNotSetUp(what) {
    shell(`
<div class="notice" data-tone="warn">
  <h2>Not set up yet</h2>
  <p>${esc(what)} isn’t answering yet on this Supabase project, so there is nothing to show.</p>
  <p class="muted">It needs to be created and granted to signed-in admins by the database migration. Once that is applied, reload this page.</p>
  <p><button type="button" class="btn-ghost" id="retryBtn">Try again</button></p>
</div>`, { wide: false });
    $('retryBtn').addEventListener('click', boot);
  }

  function renderPartialLive() {
    document.title = 'Intern Index stats';
    main.innerHTML = `<div class="wrap">
  ${HERO}
  <div class="notice" data-tone="warn" style="margin-top:18px">
    <h2>History isn’t set up yet</h2>
    <p>The stats function (<code>admin_stats_v17</code>) isn’t deployed on this Supabase project yet, so totals, charts and retention have nothing to read.</p>
    <p class="muted">The live count above comes from <code>admin_live</code>, which is a separate function.</p>
    <p><button type="button" class="btn-ghost" id="retryBtn">Try again</button></p>
  </div>
</div>`;
    fillLive();
    $('retryBtn').addEventListener('click', boot);
    startLive();
  }

  function renderOffline() {
    shell(`
<div class="notice">
  <h2>Can’t reach the stats service</h2>
  <p>The page loaded, but the database did not answer. Check your connection and try again.</p>
  <p><button type="button" class="btn-ghost" id="retryBtn">Try again</button></p>
</div>`, { wide: false });
    $('retryBtn').addEventListener('click', boot);
  }

  /* ---------------- live hero ---------------- */

  /* One stable skeleton; only the text inside it is patched, so the aria-live
     region is never destroyed and re-created (which would stop announcements). */
  const HERO = `
<section class="hero" aria-labelledby="liveH">
  <div class="hero-top">
    <span class="dot" id="liveDot" data-idle="1" aria-hidden="true"></span>
    <h2 class="hero-label" id="liveH">Live now</h2>
  </div>
  <p class="hero-n"><span id="liveNum" aria-live="polite" aria-atomic="true">–</span> <span class="hero-cap" id="liveCap">waiting for first heartbeat</span></p>
  <p class="hero-sub" id="liveSub" hidden></p>
  <div id="livePages"><p class="muted" id="livePagesEmpty" style="margin-top:10px">Page breakdown appears after the first heartbeat.</p></div>
  <div class="hero-foot">
    <span id="liveBeat">No heartbeat received yet</span>
    <span aria-hidden="true">·</span>
    <span id="liveStatus">Refreshes every 15 seconds while this tab is visible</span>
    <span style="margin-left:auto"><button type="button" class="btn-ghost btn-sm" data-csv="live">Export CSV</button></span>
  </div>
</section>`;

  function fillLive() {
    const l = live || {};
    const now = num(l.now);
    const nEl = $('liveNum'); if (!nEl) return;
    nEl.textContent = now == null ? '–' : now.toLocaleString('en-US');
    $('liveCap').textContent = now != null ? 'on the site right now'
      : liveErr && liveErr.kind === 'denied' ? 'live count not available yet'
      : liveErr && liveErr.kind === 'missing' ? 'live count not deployed yet'
      : 'waiting for first heartbeat';

    const dot = $('liveDot');
    dot.dataset.idle = now == null ? '1' : '0';

    const five = num(l.five_min);
    const signedIn = num(l.signed_in), anon = num(l.anon);
    const bits = [];
    if (five != null) bits.push(`<b>${five.toLocaleString('en-US')}</b> in the last 5 minutes`);
    if (signedIn != null && anon != null) bits.push(`<b>${signedIn.toLocaleString('en-US')}</b> signed in · <b>${anon.toLocaleString('en-US')}</b> not signed in`);
    else if (signedIn != null) bits.push(`<b>${signedIn.toLocaleString('en-US')}</b> signed in`);
    const sub = $('liveSub');
    sub.innerHTML = bits.join(' <span aria-hidden="true">·</span> ');
    sub.hidden = !bits.length;

    const pages = (Array.isArray(l.by_page) ? l.by_page : []).filter(p => p && p.page != null);
    const host = $('livePages');
    if (pages.length) {
      host.innerHTML = `<ul class="pagelist" aria-label="People on each page, last 90 seconds">${pages.map(p => `<li>${esc(p.page)} <b>${fmt(p.n)}</b></li>`).join('')}</ul>`;
    } else {
      host.innerHTML = `<p class="muted" style="margin-top:10px">${l && l.updated_at ? 'No page breakdown in the last heartbeat.' : 'Page breakdown appears after the first heartbeat.'}</p>`;
    }

    const beat = l.updated_at ? timeOf(l.updated_at) : null;
    $('liveBeat').textContent = beat ? 'Heartbeat ' + beat : 'No heartbeat received yet';
    const st = $('liveStatus');
    st.innerHTML = !liveErr ? 'Refreshes every 15 seconds while this tab is visible'
      : liveErr.kind === 'denied' ? '<span class="stale">Live count is not authorized yet</span>'
      : liveErr.kind === 'missing' ? '<span class="stale">Live count function is not deployed yet</span>'
      : '<span class="stale">Live count paused — last refresh failed</span>';
  }

  /* ---------------- KPI cards ---------------- */

  function cardsHTML(d) {
    const card = (label, value, sub) => `<div class="card"><p class="k">${label}</p><p class="v">${value}</p>${sub ? `<p class="s">${sub}</p>` : ''}</div>`;
    return `<div class="cards">
  ${card('Total users', fmt(d.users))}
  ${card('New signups', fmt(d.signups_7d), `7 days · ${fmt(d.signups_30d)} in 30 days`)}
  ${card('DAU / WAU / MAU', `${fmt(d.dau)}<small> / ${fmt(d.wau)} / ${fmt(d.mau)}</small>`)}
  ${card('Stickiness', pct(d.wau, d.mau), 'WAU ÷ MAU')}
  ${card('Saves this week', fmt(d.saves_7d))}
  ${card('Apply clicks this week', fmt(d.apply_clicks_7d))}
  ${card('Email subscribers', fmt(d.email_subscribers))}
</div>`;
  }

  /* ---------------- chart ---------------- */

  function chartHTML(daily) {
    const rows = (Array.isArray(daily) ? daily : []).filter(r => r && r.day);
    if (!rows.length) return `<p class="empty">No daily data in this range yet.</p>`;
    if (!rows.some(r => num(r.signups) || num(r.active))) return `<p class="empty">No visits or signups recorded in this range.</p>`;

    const W = 760, H = 220, P = 34, PB = 30;
    const mx = Math.max(1, ...rows.map(r => Math.max(num(r.active) || 0, num(r.signups) || 0)));
    const n = Math.max(1, rows.length - 1);
    const x = i => P + i * (W - 2 * P) / n;
    const y = v => H - PB - ((num(v) || 0) / mx) * (H - P - PB);
    const path = k => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(r[k]).toFixed(1)}`).join(' ');
    const area = `${path('active')} L${x(rows.length - 1).toFixed(1)} ${H - PB} L${x(0).toFixed(1)} ${H - PB} Z`;
    const ticks = [0, .5, 1].map(f => Math.round(mx * (1 - f)));
    const first = rows[0].day, last = rows[rows.length - 1].day;

    return `<div class="chart-scroll"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
  aria-label="Daily active visitors and signups from ${esc(first)} to ${esc(last)}. Peak ${mx}. Table of the same figures follows.">
  ${ticks.map(v => `<line class="grid" x1="${P}" x2="${W - P}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"></line><text class="t" x="${P - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`).join('')}
  <line class="ax" x1="${P}" y1="${H - PB}" x2="${W - P}" y2="${H - PB}"></line>
  <path class="a1" d="${area}"></path>
  <path class="l1" d="${path('active')}"></path>
  <path class="l2" d="${path('signups')}"></path>
  <text class="t" x="${P}" y="${H - 8}">${esc(first)}</text>
  <text class="t" x="${W - P}" y="${H - 8}" text-anchor="end">${esc(last)}</text>
</svg></div>
<p class="key"><span class="k1">Active (visitors + users)</span><span class="k2">Signups</span></p>
<details style="margin-top:12px"><summary class="muted" style="cursor:pointer">Show as a table</summary>
<div class="tscroll" style="margin-top:8px"><table><caption class="sr">Daily active visitors and signups</caption>
<thead><tr><th scope="col">Day</th><th scope="col" class="n">Active</th><th scope="col" class="n">Signups</th></tr></thead>
<tbody>${rows.slice().reverse().map(r => `<tr><th scope="row">${esc(r.day)}</th><td class="n">${fmt(r.active)}</td><td class="n">${fmt(r.signups)}</td></tr>`).join('')}</tbody></table></div></details>`;
  }

  /* ---------------- funnel ---------------- */

  function funnelHTML(f) {
    const steps = [['visit', 'Visited the site'], ['profile_built', 'Built a profile'], ['signup', 'Created an account'], ['first_save', 'Saved a role'], ['first_apply', 'Clicked apply']];
    if (!f || (num(f.visit) == null && num(f.signup) == null)) return `<p class="empty">No funnel data in this range yet.</p>`;
    const mx = Math.max(1, ...steps.map(s => num(f[s[0]]) || 0));
    return '<ol class="funnel">' + steps.map(([k, label], i) => {
      const v = num(f[k]);
      const prev = i ? num(f[steps[i - 1][0]]) : null;
      const drop = (i && v != null && prev) ? `${Math.round(100 * v / prev)}% of previous` : '';
      return `<li><span class="fl">${label}</span><span class="bar"><i style="width:${v == null ? 0 : Math.max(1, 100 * v / mx).toFixed(1)}%"></i></span><b>${fmt(v)}<span class="drop">${drop}</span></b></li>`;
    }).join('') + '</ol>';
  }

  /* ---------------- cohorts ---------------- */

  function cohortsHTML(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return `<p class="empty">No completed signup weeks yet.</p>`;
    const W = [1, 2, 3, 4, 5, 6, 7, 8];
    return `<div class="tscroll"><table>
<caption class="sr">Weekly retention by signup week</caption>
<thead><tr><th scope="col">Signup week</th><th scope="col" class="n">Users</th>${W.map(w => `<th scope="col" class="n">Wk ${w}</th>`).join('')}</tr></thead>
<tbody>${list.map(r => {
      const size = num(r.size);
      const wk = Array.isArray(r.weeks) ? r.weeks : [];
      const start = new Date(String(r.week) + 'T00:00:00');
      return `<tr><th scope="row">${esc(r.week)}</th><td class="n">${fmt(size)}</td>${W.map(w => {
        const hit = wk.find(x => x && num(x.w) === w);
        const future = !isNaN(start) && start.getTime() + w * 7 * 864e5 > Date.now();
        if (future || !hit) return `<td class="n"><span class="dash" aria-label="not yet">–</span></td>`;
        return `<td class="n">${pct(hit.n, size)}</td>`;
      }).join('')}</tr>`;
    }).join('')}</tbody></table></div>`;
  }

  /* ---------------- top lists ---------------- */

  function topHTML(rows, label) {
    const list = (Array.isArray(rows) ? rows : []).filter(r => r && r.name != null);
    if (!list.length) return `<p class="empty">No data in this range yet.</p>`;
    return `<div class="tscroll"><table>
<caption class="sr">${esc(label)} by number of users</caption>
<thead><tr><th scope="col" class="n">#</th><th scope="col">${esc(label)}</th><th scope="col" class="n">Users</th></tr></thead>
<tbody>${list.map((r, i) => `<tr><th scope="row" class="rank n" style="font-weight:500;color:var(--muted)">${i + 1}</th><td>${esc(r.name)}</td><td class="n">${fmt(r.n)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  /* ---------------- email ---------------- */

  function emailHTML(em) {
    const e = em || {};
    const unsub = (e.unsub_by_type && typeof e.unsub_by_type === 'object') ? Object.entries(e.unsub_by_type) : [];
    const any = num(e.sent) != null || num(e.clicks) != null || unsub.length;
    if (!any) return `<p class="empty">No emails sent in this range yet.</p>`;
    const card = (l, v, s) => `<div class="card"><p class="k">${l}</p><p class="v">${v}</p>${s ? `<p class="s">${s}</p>` : ''}</div>`;
    const unsubTxt = unsub.length
      ? `<span style="font-size:1rem;font-weight:550">${unsub.map(([k, v]) => `${esc(k)} ${fmt(v)}`).join(' · ')}</span>`
      : DASH;
    return `<div class="cards">
  ${card('Emails sent', fmt(e.sent))}
  ${card('Clicks', fmt(e.clicks))}
  ${card('Click-through rate', pct(e.clicks, e.sent), 'clicks ÷ sent')}
  ${card('Unsubscribes', unsubTxt, unsub.length ? 'by type' : '')}
</div>`;
  }

  /* ---------------- CSV ---------------- */

  function csv(name, head, rows) {
    const q = v => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const body = [head, ...rows].map(r => r.map(q).join(',')).join('\n') + '\n';
    const blob = new Blob([body], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const from = range ? range.from : 'all', to = range ? range.to : 'today';
    a.href = URL.createObjectURL(blob);
    a.download = `intern-index-${name}-${from}-to-${to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  const CSV = {
    live: () => [['page', 'people_last_90s'],
      [['total', live && live.now], ['five_min', live && live.five_min], ['signed_in', live && live.signed_in], ['anon', live && live.anon],
      ...((live && Array.isArray(live.by_page)) ? live.by_page.map(p => [p.page, p.n]) : [])]],
    daily: d => [['day', 'signups', 'active'], (d.daily || []).map(r => [r.day, r.signups, r.active])],
    funnel: d => [['step', 'count'], [['visit', d.funnel && d.funnel.visit], ['profile_built', d.funnel && d.funnel.profile_built],
      ['signup', d.funnel && d.funnel.signup], ['first_save', d.funnel && d.funnel.first_save], ['first_apply', d.funnel && d.funnel.first_apply]]],
    cohorts: d => [['week', 'users', ...[1, 2, 3, 4, 5, 6, 7, 8].map(w => 'wk' + w)],
      (d.cohorts || []).map(r => [r.week, r.size, ...[1, 2, 3, 4, 5, 6, 7, 8].map(w => { const h = (r.weeks || []).find(x => x && x.w === w); return h ? h.n : ''; })])],
    companies: d => [['company', 'users'], (d.top_companies || []).map(r => [r.name, r.n])],
    roles: d => [['role', 'users'], (d.top_roles || []).map(r => [r.name, r.n])],
    schools: d => [['school', 'users'], (d.top_schools || []).map(r => [r.name, r.n])],
    email: d => { const e = d.email || {}; return [['metric', 'value'], [['sent', e.sent], ['clicks', e.clicks], ['ctr', (num(e.clicks) != null && num(e.sent)) ? (e.clicks / e.sent) : ''],
      ...Object.entries(e.unsub_by_type || {}).map(([k, v]) => ['unsubscribe_' + k, v])]]; }
  };

  const exp = (k, label) => `<button type="button" class="btn-ghost btn-sm" data-csv="${k}" aria-label="Export CSV: ${label}">Export CSV</button>`;

  /* ---------------- dashboard ---------------- */

  function renderDashboard() {
    const d = data || {};
    document.title = 'Intern Index stats';
    const when = timeOf(new Date(lastLoadOk).toISOString());
    const who = Cloud.email();

    main.innerHTML = `
<div class="wrap">
  <form class="range" id="rangeForm" aria-label="Date range">
    <label for="from">From<input type="date" id="from" name="from" value="${esc(range ? range.from : '')}" max="${esc(day(new Date()))}"></label>
    <label for="to">To<input type="date" id="to" name="to" value="${esc(range ? range.to : '')}" max="${esc(day(new Date()))}"></label>
    <button type="submit" class="btn-ghost">Update</button>
    <button type="button" class="btn-ghost" id="resetRange">Last 90 days</button>
    <span class="stat" id="rangeStat" role="status">${loading ? 'Loading…' : (when ? 'Numbers loaded ' + esc(when) : '')}</span>
  </form>

  ${HERO}

  <h2 class="sr">Key numbers</h2>
  ${cardsHTML(d)}

  <section class="sec" aria-labelledby="hDaily">
    <div class="sec-h"><h2 id="hDaily">Daily signups and active users</h2>${exp('daily', 'daily activity')}</div>
    ${chartHTML(d.daily)}
  </section>

  <section class="sec" aria-labelledby="hFunnel">
    <div class="sec-h"><h2 id="hFunnel">Signup funnel</h2>${exp('funnel', 'the funnel')}</div>
    ${funnelHTML(d.funnel)}
  </section>

  <section class="sec" aria-labelledby="hCohorts">
    <div class="sec-h"><h2 id="hCohorts">Weekly retention</h2>${exp('cohorts', 'retention')}</div>
    <p class="muted" style="margin-bottom:10px">Share of each signup week still active in weeks 1–8. Future weeks show –.</p>
    ${cohortsHTML(d.cohorts)}
  </section>

  <div class="two">
    <section class="sec" aria-labelledby="hCo">
      <div class="sec-h"><h2 id="hCo">Most-saved companies</h2>${exp('companies', 'companies')}</div>
      ${topHTML(d.top_companies, 'Company')}
    </section>
    <section class="sec" aria-labelledby="hRoles">
      <div class="sec-h"><h2 id="hRoles">Most-saved roles</h2>${exp('roles', 'roles')}</div>
      ${topHTML(d.top_roles, 'Role')}
    </section>
  </div>

  <section class="sec" aria-labelledby="hSchools">
    <div class="sec-h"><h2 id="hSchools">Top schools</h2>${exp('schools', 'schools')}</div>
    <p class="muted" style="margin-bottom:10px">Schools with fewer than 5 users are hidden.</p>
    ${topHTML(d.top_schools, 'School')}
  </section>

  <section class="sec" aria-labelledby="hEmail">
    <div class="sec-h"><h2 id="hEmail">Email</h2>${exp('email', 'email stats')}</div>
    ${emailHTML(d.email)}
  </section>
</div>`;

    $('rangeForm').addEventListener('submit', e => {
      e.preventDefault();
      const f = $('from').value, t = $('to').value;
      if (!f || !t) return;
      if (f > t) { $('rangeStat').textContent = 'The start date is after the end date.'; return; }
      range = { from: f, to: t };
      loadStats();
    });
    $('resetRange').addEventListener('click', () => { range = defaultRange(); loadStats(); });
  }

  function stampUpdated() {
    const u = document.getElementById('updated');
    if (!u) return;
    const t = timeOf(new Date(Math.max(lastLoadOk, lastLiveOk)).toISOString());
    u.textContent = t ? 'Updated ' + t : '';
  }

  function patchLive() {
    if ($('liveNum')) fillLive();
  }

  /* ---------------- data ---------------- */

  let lastLoadOk = 0;

  function defaultRange() {
    const t = new Date();
    return { from: day(new Date(t.getTime() - (DEFAULT_DAYS - 1) * 864e5)), to: day(t) };
  }

  /* Is admin_live there? If it is, show the live hero on its own instead of a blank wall. */
  async function probeLive() {
    try {
      const r = await Cloud.rpc('admin_live', {});
      live = (r && typeof r === 'object') ? r : {};
      liveErr = null;
      renderPartialLive();
      return true;
    } catch (e) {
      if (isSessionGone(e)) { stopLive(); signedOutNotice = 'Your session ended. Sign in again to see the numbers.'; boot(); return false; }
      if (isPrivate(e)) { stopLive(); renderNotSetUp('The stats function (admin_stats_v17)'); return false; }
      if (isMissingFn(e)) { stopLive(); renderNotSetUp('The stats function (admin_stats_v17)'); return false; }
      if (String(e.code) === 'network') { stopLive(); renderOffline(); return false; }
      stopLive(); renderNotSetUp('The stats function (admin_stats_v17)'); return false;
    }
  }

  async function loadStats() {
    if (!range) range = defaultRange();
    loading = true;
    const stat = $('rangeStat');
    if (stat) stat.textContent = 'Loading…';
    try {
      const r = await Cloud.rpc('admin_stats_v17', { p_from: range.from, p_to: range.to });
      lastLoadOk = Date.now();
      stampUpdated();
      data = (r && typeof r === 'object') ? r : {};
      loading = false;
      renderDashboard();
      fillLive();
      startLive();
      return true;
    } catch (e) {
      loading = false;
      if (isSessionGone(e)) { stopLive(); signedOutNotice = 'Your session ended. Sign in again to see the numbers.'; boot(); return false; }
      if (isNotGranted(e)) { await probeLive(); return false; }
      if (isPrivate(e)) { notAuthorized = true; stopLive(); renderPrivate(); return false; }
      if (isMissingFn(e)) { await probeLive(); return false; }
      if (String(e.code) === 'network') { stopLive(); renderOffline(); return false; }
      // anything else: keep whatever we had, or show a calm note
      if (data) { const s = $('rangeStat'); if (s) s.textContent = 'Couldn’t refresh. Showing the last numbers.'; return false; }
      shell(`<div class="notice" data-tone="warn"><h2>Couldn’t load stats</h2><p>The database answered, but not with numbers. This is usually temporary.</p><p><button type="button" class="btn-ghost" id="retryBtn">Try again</button></p></div>`, { wide: false });
      $('retryBtn').addEventListener('click', boot);
      return false;
    }
  }

  async function fetchLive() {
    if (!Cloud.signedIn()) return;
    livePolls++;
    try {
      const r = await Cloud.rpc('admin_live', {});
      live = (r && typeof r === 'object') ? r : {};
      liveErr = null;
      lastLiveOk = Date.now();
      stampUpdated();
    } catch (e) {
      if (isSessionGone(e)) { stopLive(); signedOutNotice = 'Your session ended. Sign in again to see the numbers.'; boot(); return; }
      if (isMissingFn(e)) { stopLive(); liveErr = { kind: 'missing' }; if (!data) renderNotSetUp('The live function (admin_live)'); return; }
      if (isNotGranted(e) || isPrivate(e)) {
        /* The history RPC already gated this page, so this is an answer about admin_live
           itself (usually a grant that is not in place yet), not about the session.
           Keep the numbers on screen and say so in the live card. */
        stopLive();
        liveErr = { kind: 'denied' };
        if ($('liveNum')) fillLive();
        return;
      }
      liveErr = { kind: 'other' };
    }
    if (main.querySelector('.hero')) patchLive();
  }

  function startLive() {
    stopLive();
    const tick = () => { if (document.hidden) return; fetchLive(); };
    fetchLive();
    liveTimer = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', onVis);
  }
  function stopLive() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
    document.removeEventListener('visibilitychange', onVis);
  }
  function onVis() {
    if (!document.hidden && liveTimer) fetchLive();
  }

  /* ---------------- boot ---------------- */

  let bootSeq = 0;
  async function boot() {
    const seq = ++bootSeq;
    stopLive();
    notAuthorized = false;
    const notice = signedOutNotice;
    signedOutNotice = '';
    data = null; live = null; liveErr = null;

    if (!Cloud || !Cloud.enabled) {
      renderNotSetUp('The connection settings');
      return;
    }
    renderLoading();
    await Cloud.ready;
    if (seq !== bootSeq) return;
    if (!Cloud.signedIn()) {
      $('signOut').hidden = true; $('whoWrap').hidden = true;
      const u = document.getElementById('updated'); if (u) u.textContent = '';
      renderSignIn(notice, notice ? 'err' : '');
      return;
    }

    $('who').textContent = Cloud.email() || 'signed in';
    $('signOut').hidden = false;
    $('whoWrap').hidden = false;

    await loadStats();
  }

  $('signOut').addEventListener('click', async () => {
    const b = $('signOut');
    b.disabled = true; b.textContent = 'Signing out…';
    stopLive();
    await Cloud.signOut();     // emits stats:change, which re-boots into the sign-in screen
    b.disabled = false; b.textContent = 'Sign out';
  });

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-csv]');
    if (!b) return;
    const k = b.dataset.csv;
    try {
      if (k === 'live') { const [h, rows] = CSV.live(); csv('live', h, rows); return; }
      if (!data) return;
      const [h, rows] = CSV[k](data);
      csv(k, h, rows);
    } catch (err) { /* nothing to export */ }
  });

  document.addEventListener('stats:change', () => {
    if (!Cloud.signedIn()) { $('signOut').hidden = true; $('whoWrap').hidden = true; }
    boot();
  });

  document.addEventListener('stats:error', e => {
    const err = e.detail;
    if (notAuthorized) return;
    if (!Cloud.signedIn() && $('signMsg')) {
      $('signMsg').textContent = Cloud.friendly(err);
      $('signMsg').dataset.tone = 'err';
    }
  });

  boot();
})();
