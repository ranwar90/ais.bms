/**
 * Connects the app to the Netlify API, keeping the same interface as the original
 * (window.claude.use('db' | 'downloads')). Staff sign in once with email + E-number;
 * the server returns a sign-in pass kept on this device for 30 days. No access key prompt.
 * Other teachers' changes arrive every 60 s while the tab is visible (every 2 min on a hallway display),
 * and immediately when the tab regains focus. Your own changes save instantly. Low usage keeps hosting costs down.
 */
(function () {
  const API = '/api/db', LOGIN = '/api/login', POLL_MS = 60000, DISPLAY_POLL_MS = 120000, TOKEN_KEY = 'g8_token';
  const cols = {}, etags = {}, listeners = [];
  let pollTimer = null, inFlight = null;
  try { localStorage.removeItem('g8_access_key'); } catch (e) {} // old shared-key prompt is gone

  const token = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } };
  function signedOut() {
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem('g8_staff_session'); } catch (e) {}
    if (typeof window.logout === 'function') window.logout(); else location.reload();
  }
  async function call(method, body, query) {
    const res = await fetch(API + (query || ''), {
      method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token() },
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { signedOut(); throw new Error('Signed out'); }
    if (!res.ok) { const err = new Error(data.message || data.error || ('HTTP ' + res.status)); err.code = data.error; err.status = res.status; throw err; }
    return data;
  }

  function snapshotFor(l) {
    const docs = cols[l.coll] || {};
    if (l.id) return { exists: l.id in docs, id: l.id, data: () => docs[l.id] };
    return { docs: Object.keys(docs).map(id => ({ id, data: () => docs[id] })) };
  }
  function apply(name, etag, docs) {
    cols[name] = docs; etags[name] = etag;
    listeners.filter(l => l.coll === name).forEach(l => { try { l.cb(snapshotFor(l)); } catch (e) { console.error(e); } });
  }
  function banner(msg) {
    let el = document.getElementById('syncBanner');
    if (!msg) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div'); el.id = 'syncBanner';
      el.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:999;background:#B91C1C;color:#fff;' +
        'padding:10px 14px;border-radius:10px;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center;max-width:92vw';
      document.body.appendChild(el);
    }
    el.innerHTML = '';
    const t = document.createElement('span'); t.textContent = msg; el.appendChild(t);
    const b = document.createElement('button'); b.textContent = 'Retry'; b.onclick = () => poll();
    b.style.cssText = 'background:#fff;color:#B91C1C;border:0;border-radius:6px;padding:4px 10px;font-weight:700;cursor:pointer'; el.appendChild(b);
  }
  async function poll() {
    if (!token()) return;
    if (inFlight) return inFlight;
    const q = '?etags=' + encodeURIComponent(Object.keys(etags).map(k => k + ':' + etags[k]).join(','));
    inFlight = call('GET', null, q).then(r => {
      Object.entries(r.collections || {}).forEach(([name, c]) => apply(name, c.etag, c.docs));
      banner(null);
    }).catch(e => {
      if (e.message === 'Signed out') return;
      console.error('Sync failed', e);
      banner(Object.keys(cols).length ? 'Offline — changes from other teachers will appear when the connection returns.'
                                      : 'Can\'t reach the database (' + e.message + ').');
    }).finally(() => { inFlight = null; });
    return inFlight;
  }
  function onDisplay() {
    try { return !!(window.state && state.disp && (state.disp.mode === 'broadcast' || state.disp.present)); } catch (e) { return false; }
  }
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { if (!document.hidden && token()) poll(); schedule(); }, onDisplay() ? DISPLAY_POLL_MS : POLL_MS);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('focus', () => poll());

  function listen(l) {
    listeners.push(l);
    if (cols[l.coll]) setTimeout(() => l.cb(snapshotFor(l)), 0);
    else if (token()) { poll(); schedule(); }
    return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
  }
  async function write(op, path, data) {
    const r = await call('POST', { op, path, data });
    apply(r.collection, r.etag, r.docs);
  }

  window.netlifyAuth = {
    hasToken: () => !!token(),
    async login(email, pin) {
      const res = await fetch(LOGIN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, pin }), cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || 'Sign-in failed');
      try { localStorage.setItem(TOKEN_KEY, data.token); localStorage.setItem('g8_staff_session', data.sessionId); } catch (e) {}
      poll(); schedule();
      return data;
    },
    logout() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} },
  };

  const db = {
    collection: name => ({ onSnapshot: (cb, err) => listen({ coll: name, cb, err }) }),
    doc: path => {
      const [coll, id] = path.split('/');
      return {
        onSnapshot: (cb, err) => listen({ coll, id, cb, err }),
        set: data => write('set', path, data),
        update: data => write('update', path, data),
        delete: () => write('delete', path),
      };
    },
  };
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
  };
  window.claude = { use: async name => name === 'db' ? db : name === 'downloads' ? downloads : null };
})();
