/* Intern Index stats — Supabase auth + PostgREST over plain fetch.
   Same approach as the Intern Index site (cloud.js / cloud-config.js): no SDK, no dependency,
   session in localStorage, token refresh, magic-link hash return, Google via /auth/v1/authorize.
   All numbers come from SECURITY DEFINER RPCs that check public.admins server-side. */
window.StatsCloud = (() => {
  const C = window.STATS_CONFIG || {};
  const enabled = !!(C.url && C.anonKey && /^https:\/\/[a-z0-9-]+\.supabase\.co$|^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(C.url));
  const SK = 'iistats__session';
  const api = { enabled, url: C.url || '', googleOn: !!C.google };

  let sess = null;
  try { sess = JSON.parse(localStorage.getItem(SK) || 'null'); } catch { sess = null; }

  const save = s => {
    sess = s;
    try { s ? localStorage.setItem(SK, JSON.stringify(s)) : localStorage.removeItem(SK); } catch {}
  };
  const emit = (n, d) => document.dispatchEvent(new CustomEvent('stats:' + n, { detail: d }));

  async function http(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const h = { apikey: C.anonKey, 'content-type': 'application/json', ...headers };
    if (auth) {
      const t = await token();
      if (t) h.authorization = 'Bearer ' + t;
    }
    let r;
    try {
      r = await fetch(C.url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (x) {
      const e = new Error('network'); e.code = 'network'; throw e;
    }
    const txt = await r.text();
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch {}
    if (!r.ok) {
      const code = String((j && (j.code || j.error_code || (typeof j.error === 'string' ? j.error : ''))) || '');
      const msg = (j && (j.msg || j.message || j.error_description)) || ('HTTP ' + r.status);

      /* A 401 is only "your session ended" when the token itself was rejected.
         42501 / "permission denied" is an authorization answer about the RPC, not the
         session: it must surface as "not authorized" and must NOT sign the user out. */
      const permDenied = code === '42501' || /permission denied/i.test(msg);
      const tokenBad = r.status === 401 && !permDenied &&
        (code === 'PGRST301' || code === 'PGRST302' ||
          /jwt|token is expired|invalid claim|invalid signature|cryptographic/i.test(msg + ' ' + code));

      if (tokenBad && auth) {
        save(null); emit('change');
        const e = new Error('session expired'); e.code = 'session_expired'; e.status = 401; throw e;
      }

      const e = new Error(msg);
      e.status = r.status;
      e.code = code;
      e.detail = j;
      throw e;
    }
    return j;
  }

  async function token() {
    if (!sess) return null;
    if (sess.expires_at && sess.expires_at * 1000 - Date.now() < 60000) {
      try {
        const j = await http('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: sess.refresh_token } });
        save(toSess(j));
      } catch (e) {
        if (e.status >= 400 && e.status < 500) { save(null); emit('change'); }
        return null;
      }
    }
    return sess && sess.access_token;
  }

  const toSess = j => ({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (+j.expires_in || 3600),
    user: { id: j.user && j.user.id, email: j.user && j.user.email, created_at: j.user && j.user.created_at }
  });

  /* The one URL Supabase must allow-list: the page itself, no hash, no query. */
  const redirect = () => location.origin + location.pathname;

  // magic link / Google return: tokens arrive in the URL hash; errors in the hash or query
  function readReturn() {
    const h = location.hash, q = location.search;
    const hp = new URLSearchParams(h.slice(1)), qp = new URLSearchParams(q.slice(1));
    const errP = hp.get('error') || hp.get('error_description') ? hp
      : qp.get('error') || qp.get('error_description') ? qp : null;
    if (!/access_token=/.test(h) && !errP) return null;
    if (errP) {
      const em = errP.get('error_description') || errP.get('error');
      const ec = errP.get('error_code') || errP.get('error') || '';
      ['error', 'error_code', 'error_description'].forEach(k => qp.delete(k));
      const qs = qp.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
      const e = new Error(em); e.code = ec; e.oauth = true;
      return { error: e };
    }
    history.replaceState(null, '', location.pathname + location.search);
    return {
      access_token: hp.get('access_token'),
      refresh_token: hp.get('refresh_token'),
      expires_at: +hp.get('expires_at') || Math.floor(Date.now() / 1000) + (+hp.get('expires_in') || 3600)
    };
  }

  /* Plain-words messages. A raw server string is never shown. */
  api.friendly = e => {
    const m = String((e && e.message) || e || '').toLowerCase();
    const c = String((e && e.code) || '').toLowerCase();
    const st = +(e && e.status) || 0;
    if (c === 'network' || (typeof navigator !== 'undefined' && navigator.onLine === false) || /failed to fetch|networkerror|load failed/.test(m))
      return "You seem to be offline. Check your connection and try again.";
    if (c === 'cooldown') return 'Please wait a minute before asking for another link.';
    if (/otp_expired|expired|already used|invalid.*(link|token|grant)/.test(c + ' ' + m) && c !== 'session_expired')
      return 'That sign-in link has expired or was already used. Ask for a new one.';
    if (c === 'bad_email' || c === 'email_address_invalid' || (c === 'validation_failed' && /email/.test(m)) || /invalid.*email|email.*invalid/.test(m))
      return "That email address doesn't look right. Check it and try again.";
    if (/rate.?limit/.test(c + ' ' + m) || st === 429)
      return 'Too many sign-in emails right now. ' + (api.googleOn ? 'Try Continue with Google, or try again in a bit.' : 'Try again in a bit.');
    if (/provider/.test(c + ' ' + m) && /not enabled|disabled|unsupported/.test(c + ' ' + m))
      return "Google sign-in isn't available right now. Use the email link instead.";
    if (c === 'access_denied' || /access.?denied|cancel/.test(m)) return 'Google sign-in was cancelled. You can try again or use the email link.';
    if (c === 'session_expired' || c === 'signed_out') return 'Your session ended. Please sign in again.';
    if (/signup.*(disabled|not allowed)/.test(c + ' ' + m)) return 'New sign-ups are paused right now. Try again later.';
    if (st >= 500 || /server_error|temporarily_unavailable/.test(c)) return 'Sign-in is having trouble right now. Try again in a few minutes.';
    return 'That did not work. Check your connection and try again.';
  };

  let lastLink = 0;
  api.user = () => sess && sess.user;
  api.signedIn = () => !!(sess && sess.access_token);
  api.email = () => (sess && sess.user && sess.user.email) || '';

  api.sendLink = async email => {
    email = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { const e = new Error('bad email'); e.code = 'bad_email'; throw e; }
    if (Date.now() - lastLink < 60000) { const e = new Error('cooldown'); e.code = 'cooldown'; throw e; }
    lastLink = Date.now();
    await http('/auth/v1/otp?redirect_to=' + encodeURIComponent(redirect()), { method: 'POST', auth: false, body: { email, create_user: true } });
  };

  api.google = () => {
    if (!api.googleOn) return;
    location.href = C.url + '/auth/v1/authorize?provider=google&redirect_to=' + encodeURIComponent(redirect());
  };

  api.signOut = async () => {
    try { await http('/auth/v1/logout', { method: 'POST' }); } catch {}
    save(null);
    emit('change');
  };

  api.rpc = (fn, body) => http('/rest/v1/rpc/' + encodeURIComponent(fn), { method: 'POST', body: body || {} });

  async function onReturn(ret) {
    if (!ret) return false;
    if (ret.error) { emit('error', ret.error); return true; }
    if (ret.access_token) {
      save({ ...ret, user: null });
      try {
        const u = await http('/auth/v1/user');
        save({ ...sess, user: { id: u.id, email: u.email, created_at: u.created_at } });
        emit('change');
      } catch (e) {
        save(null); emit('error', e);
      }
      return true;
    }
    return false;
  }

  const chk = () => { const r = readReturn(); if (r) onReturn(r); };
  window.addEventListener('popstate', chk);
  window.addEventListener('hashchange', chk);

  /* Resolves once any magic-link / Google return has been processed. */
  api.ready = (async () => {
    if (await onReturn(readReturn())) return;
    if (api.signedIn() && (!sess.user || !sess.user.email)) {
      try {
        const u = await http('/auth/v1/user');
        save({ ...sess, user: { id: u.id, email: u.email, created_at: u.created_at } });
      } catch {}
    }
  })();

  return api;
})();
