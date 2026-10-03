/**
 * AIS Middle Grades - Boys · Behaviour Management System — server (Netlify Function + Netlify Blobs).
 *
 *   POST /api/login  { email, pin }            -> { token, sessionId, role }
 *   GET  /api/db?c=points:42:<etag>,...        -> only what changed since the device's last copy
 *   POST /api/db  { op, path, data }           -> one write
 *   POST /api/db  { op: "batch", writes: [] }  -> several writes in one request (group entries)
 *
 * Sign-in is checked here against the staff records, so staff passwords (E-numbers) never reach
 * browsers. A sign-in pass lasts 30 days, signed with a private key the server creates itself
 * (or ACCESS_KEY, if you set one). Teachers can write behaviour/skills records only; admins everything.
 *
 * Storage: one blob per collection { docs, rev, del, seq }. Every change bumps seq and stamps the
 * document, so devices download only documents changed since their last copy, not the whole year.
 * Writes are compare-and-swap on the blob's etag and retried, so simultaneous saves are never lost.
 * set = replace a document; update = deep-merge (arrays replaced; fails if missing); delete = remove.
 */
import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import seed from "../../data/seed-data.json" with { type: "json" };

const COLLECTIONS = ["students", "staff", "points", "config"];
const STORE_NAME = "g8-discipline-tracker";
const TOKEN_DAYS = 30;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
function deepMerge(target, src) {
  const out = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(src)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}
function env(name, fallback) {
  try { if (globalThis.Netlify && Netlify.env) { const v = Netlify.env.get(name); if (v) return v; } } catch (e) {}
  return process.env[name] || fallback;
}

// ---- sign-in pass ----
const b64u = s => Buffer.from(s).toString("base64url");
function sign(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  return body + "." + createHmac("sha256", secret).update(body).digest("base64url");
}
function verify(token, secret) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const good = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== good.length || !timingSafeEqual(given, good)) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}
async function signingSecret(store) {
  const fromEnv = env("ACCESS_KEY");
  if (fromEnv) return fromEnv;
  let s = await store.get("_signing_key", { type: "text" });
  if (!s) {
    await store.set("_signing_key", randomBytes(32).toString("hex"), { onlyIfNew: true });
    s = await store.get("_signing_key", { type: "text" });
  }
  return s;
}

// ---- collections ----
async function ensureSeeded(store) {
  for (const c of COLLECTIONS) {
    const meta = await store.getMetadata(c);
    if (!meta) await store.setJSON(c, { docs: (seed && seed[c]) || {}, rev: {}, del: {}, seq: 1 }, { onlyIfNew: true });
  }
}
/** Older stored copies had only { docs }; give them change tracking without changing the data. */
const norm = d => ({ docs: (d && d.docs) || {}, rev: (d && d.rev) || {}, del: (d && d.del) || {}, seq: (d && d.seq) || 1 });
const stripPin = d => { if (!d) return d; const { pin, ...rest } = d; return rest; };
const stripPins = docs => Object.fromEntries(Object.entries(docs).map(([id, d]) => [id, stripPin(d)]));

async function handleLogin(req, store, secret) {
  let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  const email = String(body.email || "").trim().toLowerCase(), pin = String(body.pin || "").trim();
  if (!email || !pin) return json({ error: "Enter your email and password." }, 400);
  await new Promise(r => setTimeout(r, 250)); // slows down password guessing
  const builtIn = [
    { user: env("MASTER_ADMIN_USER", "admin2627"), pass: env("MASTER_ADMIN_PASSWORD", "2627"), sessionId: "MASTER_ADMIN", role: "admin" },
    { user: env("TEST_TEACHER_USER", "testteacher2627"), pass: env("TEST_TEACHER_PASSWORD", "2627"), sessionId: "MASTER_TEACHER", role: "teacher" },
  ];
  for (const b of builtIn) {
    if (b.user && b.pass && b.user.toLowerCase() !== "off" && email === b.user.toLowerCase() && pin === b.pass)
      return json({ token: sign({ sid: b.sessionId, role: b.role, exp: Date.now() + TOKEN_DAYS * 864e5 }, secret), sessionId: b.sessionId, role: b.role });
  }
  await ensureSeeded(store);
  const res = await store.getWithMetadata("staff", { type: "json" });
  const staff = Object.entries(norm(res && res.data).docs).map(([id, s]) => ({ id, ...s }));
  const byEmail = staff.filter(s => String(s.email || "").trim().toLowerCase() === email);
  if (!byEmail.length) return json({ error: "No account found for that email." }, 401);
  const ok = byEmail.filter(s => s.pin && String(s.pin).toLowerCase() === pin.toLowerCase());
  if (!ok.length) return json({ error: "Incorrect password." }, 401);
  const found = ok.find(s => s.role === "admin") || ok[0];
  const role = found.role === "admin" ? "admin" : "teacher";
  return json({ token: sign({ sid: found.id, role, exp: Date.now() + TOKEN_DAYS * 864e5 }, secret), sessionId: found.id, role });
}

/** Apply several writes to ONE collection atomically (compare-and-swap, retried). */
async function applyWrites(store, coll, writes) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const cur = await store.getWithMetadata(coll, { type: "json" });
    const b = norm(cur && cur.data);
    const docs = { ...b.docs }, rev = { ...b.rev }, del = { ...b.del };
    const results = [];
    let seq = b.seq;
    for (const w of writes) {
      if (w.op === "update" && !(w.id in docs)) { results.push({ ok: false, error: "not_found", message: "Document does not exist" }); continue; }
      seq++;
      if (w.op === "set") { docs[w.id] = w.data; rev[w.id] = seq; delete del[w.id]; }
      else if (w.op === "update") { docs[w.id] = deepMerge(docs[w.id], w.data); rev[w.id] = seq; }
      else { delete docs[w.id]; delete rev[w.id]; del[w.id] = seq; }
      results.push({ ok: true, id: w.id, op: w.op });
    }
    if (seq === b.seq) return { results, seq, docs }; // nothing changed (e.g. every update missed)
    const res = await store.setJSON(coll, { docs, rev, del, seq }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (!res || res.modified !== false) return { results, seq, docs };
    await new Promise(r => setTimeout(r, 40 + Math.random() * 120));
  }
  return { busy: true };
}

export default async (req) => {
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const secret = await signingSecret(store);
  const url = new URL(req.url);

  if (url.pathname.endsWith("/login")) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    return handleLogin(req, store, secret);
  }

  const auth = verify((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""), secret);
  if (!auth) return json({ error: "signed_out", message: "Please sign in again." }, 401);
  const isAdmin = auth.role === "admin";

  if (req.method === "GET") {
    await ensureSeeded(store);
    const known = {}; // coll -> { seq, etag }
    (url.searchParams.get("c") || "").split(",").filter(Boolean).forEach(p => {
      const [c, seq, ...etag] = p.split(":"); known[c] = { seq: +seq || 0, etag: etag.join(":") };
    });
    const collections = {};
    for (const c of COLLECTIONS) {
      const k = known[c];
      if (k && k.etag) { const meta = await store.getMetadata(c); if (meta && meta.etag === k.etag) continue; } // nothing new
      const res = await store.getWithMetadata(c, { type: "json" });
      const b = norm(res && res.data), etag = res ? res.etag : "";
      if (k && k.seq > 0 && k.seq <= b.seq) { // send only what changed since this device's copy
        const changed = {}, deleted = [];
        for (const [id, r] of Object.entries(b.rev)) if (r > k.seq && id in b.docs) changed[id] = c === "staff" && !isAdmin ? stripPin(b.docs[id]) : b.docs[id];
        for (const [id, r] of Object.entries(b.del)) if (r > k.seq) deleted.push(id);
        collections[c] = { seq: b.seq, etag, changed, deleted };
      } else {
        collections[c] = { seq: b.seq, etag, full: true, docs: c === "staff" && !isAdmin ? stripPins(b.docs) : b.docs };
      }
    }
    return json({ collections });
  }

  if (req.method === "POST") {
    let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }
    const list = body && body.op === "batch" ? (Array.isArray(body.writes) ? body.writes : []) : [body || {}];
    if (!list.length || list.length > 300) return json({ error: "Bad batch" }, 400);
    const parsed = [];
    for (const w of list) {
      const [coll, id, ...rest] = String(w.path || "").split("/");
      if (!COLLECTIONS.includes(coll) || !id || rest.length) return json({ error: "Bad path" }, 400);
      if (!["set", "update", "delete"].includes(w.op)) return json({ error: "Bad op" }, 400);
      if (w.op !== "delete" && !isObj(w.data)) return json({ error: "Missing data" }, 400);
      if (!isAdmin && coll !== "points") return json({ error: "forbidden", message: "Only admins can change this." }, 403);
      parsed.push({ coll, id, op: w.op, data: w.data });
    }
    await ensureSeeded(store);
    const byColl = {};
    parsed.forEach((w, i) => (byColl[w.coll] = byColl[w.coll] || []).push({ ...w, i }));
    const results = new Array(parsed.length);
    for (const [coll, ws] of Object.entries(byColl)) {
      const r = await applyWrites(store, coll, ws);
      if (r.busy) return json({ error: "Busy, please retry" }, 409);
      ws.forEach((w, j) => {
        const res = r.results[j];
        results[w.i] = res.ok
          ? { ok: true, collection: coll, id: w.id, deleted: w.op === "delete", doc: w.op === "delete" ? null : (coll === "staff" && !isAdmin ? stripPin(r.docs[w.id]) : r.docs[w.id]) }
          : { ok: false, collection: coll, id: w.id, error: res.error, message: res.message };
      });
    }
    if (body && body.op === "batch") return json({ results });
    const one = results[0];
    return one.ok ? json(one) : json({ error: one.error, message: one.message }, one.error === "not_found" ? 404 : 400);
  }
  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: ["/api/db", "/api/login"] };
