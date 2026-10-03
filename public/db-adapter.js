/**
 * Connects the app to the Netlify server with the same interface as the original
 * (window.claude.use('db' | 'downloads')). Staff sign in once with email + E-number (30 days per device).
 * Light on data: devices download only records that changed since their last copy; several saves made
 * at the same moment (e.g. a group deduction) travel as one request. Updates from other teachers arrive
 * every 60 s while visible (2 min on a hallway display) and straight away when the tab regains focus.
 */
(function () {
  const API = '/api/db', LOGIN = '/api/login', POLL_MS = 60000, DISPLAY_POLL_MS = 120000, TOKEN_KEY = 'g8_token';
  const cols = {}, seqs = {}, etags = {}, listeners = [];
  let pollTimer = null, inFlight = null;
  try { localStorage.removeItem('g8_access_key'); } catch (e) {}

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
  function notify(name) { listeners.filter(l => l.coll === name).forEach(l => { try { l.cb(snapshotFor(l)); } catch (e) { console.error(e); } }); }
  function applyServer(name, c) {
    if (c.full) cols[name] = c.docs || {};
    else {
      const docs = Object.assign({}, cols[name] || {});
      Object.entries(c.changed || {}).forEach(([id, d]) => { docs[id] = d; });
      (c.deleted || []).forEach(id => { delete docs[id]; });
      cols[name] = docs;
    }
    seqs[name] = c.seq; etags[name] = c.etag;
    notify(name);
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
    const q = '?c=' + encodeURIComponent(Object.keys(seqs).map(k => k + ':' + seqs[k] + ':' + (etags[k] || '')).join(','));
    inFlight = call('GET', null, q).then(r => {
      Object.entries(r.collections || {}).forEach(([name, c]) => applyServer(name, c));
      banner(null);
    }).catch(e => {
      if (e.message === 'Signed out') return;
      console.error('Sync failed', e);
      banner(Object.keys(cols).length ? 'Offline — changes from other teachers will appear when the connection returns.'
                                      : 'Can\'t reach the database (' + e.message + ').');
    }).finally(() => { inFlight = null; });
    return inFlight;
  }
  function onDisplay() { try { return !!(window.state && state.disp && (state.disp.mode === 'broadcast' || state.disp.present)); } catch (e) { return false; } }
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

  /* Saves made in the same moment are sent together as one request. */
  let queue = [], flushTimer = null;
  function write(op, path, data) {
    return new Promise((resolve, reject) => {
      queue.push({ w: { op, path, data }, resolve, reject });
      if (!flushTimer) flushTimer = setTimeout(flush, 0);
    });
  }
  async function flush() {
    const items = queue; queue = []; flushTimer = null;
    const applyResult = (r, it) => {
      if (!r.ok) { const e = new Error(r.message || r.error); e.code = r.error; it.reject(e); return; }
      const docs = Object.assign({}, cols[r.collection] || {});
      if (r.deleted) delete docs[r.id]; else docs[r.id] = r.doc;
      cols[r.collection] = docs; // own change shows at once; the next sync confirms it
      it.resolve();
    };
    try {
      if (items.length === 1) {
        const r = await call('POST', items[0].w).then(x => Object.assign({ ok: true }, x), e => ({ ok: false, error: e.code, message: e.message }));
        applyResult(r, items[0]);
      } else {
        const res = await call('POST', { op: 'batch', writes: items.map(i => i.w) });
        res.results.forEach((r, k) => applyResult(r, items[k]));
      }
      [...new Set(items.map(i => i.w.path.split('/')[0]))].forEach(notify);
    } catch (e) { items.forEach(i => i.reject(e)); }
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
