/**
 * AIS Middle Grades - Boys · Behaviour Management System — database API
 * (Netlify Function + Netlify Blobs).
 *
 *   POST /api/login  { email, pin }   -> { token, sessionId, role }   (no separate access key needed)
 *   GET  /api/db?etags=...             -> collections that changed     (needs a valid sign-in token)
 *   POST /api/db  { op, path, data }   -> write one document           (needs a valid sign-in token)
 *
 * Sign-in is checked HERE, against the staff records, so staff passwords (E-numbers) are never sent to
 * browsers. A successful sign-in returns a pass (token) valid for 30 days on that device, signed with a
 * private key the server creates by itself on first run and keeps in Netlify Blobs. No setup needed.
 * (Optional: set an ACCESS_KEY environment variable to use your own key; changing it signs everyone out.)
 *
 * Permissions: teachers can read everything and write behaviour/skills records ("points") only.
 * Admins can write everything (students, staff, settings, points). Teachers never receive staff passwords.
 *
 * Each collection is ONE blob { docs: { id: data } }; every write is compare-and-swap on the blob's etag,
 * retried on conflict, so simultaneous saves from different teachers are never lost.
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

// ---- signed sign-in pass ----
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

/** Private signing key: ACCESS_KEY if set, otherwise generated once and stored with the data. */
async function signingSecret(store) {
  const fromEnv = env("ACCESS_KEY");
  if (fromEnv) return fromEnv;
  let s = await store.get("_signing_key", { type: "text" });
  if (!s) {
    await store.set("_signing_key", randomBytes(32).toString("hex"), { onlyIfNew: true }); // safe if two requests race
    s = await store.get("_signing_key", { type: "text" });
  }
  return s;
}

async function ensureSeeded(store) {
  for (const c of COLLECTIONS) {
    const meta = await store.getMetadata(c);
    if (!meta) await store.setJSON(c, { docs: (seed && seed[c]) || {} }, { onlyIfNew: true });
  }
}
const stripPins = docs => Object.fromEntries(Object.entries(docs).map(([id, d]) => { const { pin, ...rest } = d || {}; return [id, rest]; }));

async function handleLogin(req, store, secret) {
  let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  const email = String(body.email || "").trim().toLowerCase(), pin = String(body.pin || "").trim();
  if (!email || !pin) return json({ error: "Enter your email and password." }, 400);
  await new Promise(r => setTimeout(r, 250)); // slows down password guessing
  // Built-in accounts (change them with environment variables: see README)
  const builtIn = [
    { user: env("MASTER_ADMIN_USER", "admin2627"), pass: env("MASTER_ADMIN_PASSWORD", "2627"), sessionId: "MASTER_ADMIN", role: "admin" },
    { user: env("TEST_TEACHER_USER", "testteacher2627"), pass: env("TEST_TEACHER_PASSWORD", "2627"), sessionId: "MASTER_TEACHER", role: "teacher" },
  ];
  for (const b of builtIn) {
    if (b.user && b.pass && b.user.toLowerCase() !== "off" && email === b.user.toLowerCase() && pin === b.pass) {
      return json({ token: sign({ sid: b.sessionId, role: b.role, exp: Date.now() + TOKEN_DAYS * 864e5 }, secret), sessionId: b.sessionId, role: b.role });
    }
  }
  await ensureSeeded(store);
  const res = await store.getWithMetadata("staff", { type: "json" });
  const staff = Object.entries((res && res.data && res.data.docs) || {}).map(([id, s]) => ({ id, ...s }));
  const byEmail = staff.filter(s => String(s.email || "").trim().toLowerCase() === email);
  if (!byEmail.length) return json({ error: "No account found for that email." }, 401);
  const ok = byEmail.filter(s => s.pin && String(s.pin).toLowerCase() === pin.toLowerCase());
  if (!ok.length) return json({ error: "Incorrect password." }, 401);
  const found = ok.find(s => s.role === "admin") || ok[0];
  const role = found.role === "admin" ? "admin" : "teacher";
  return json({ token: sign({ sid: found.id, role, exp: Date.now() + TOKEN_DAYS * 864e5 }, secret), sessionId: found.id, role });
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
    const known = {};
    (url.searchParams.get("etags") || "").split(",").filter(Boolean).forEach(p => { const i = p.indexOf(":"); known[p.slice(0, i)] = p.slice(i + 1); });
    const collections = {};
    for (const c of COLLECTIONS) {
      const meta = await store.getMetadata(c);
      if (meta && known[c] && meta.etag === known[c]) continue;
      const res = await store.getWithMetadata(c, { type: "json" });
      let docs = res && res.data ? res.data.docs || {} : {};
      if (c === "staff" && !isAdmin) docs = stripPins(docs);
      collections[c] = { etag: res ? res.etag : "", docs };
    }
    return json({ collections });
  }

  if (req.method === "POST") {
    let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }
    const { op, path, data } = body || {};
    const [coll, id, ...rest] = String(path || "").split("/");
    if (!COLLECTIONS.includes(coll) || !id || rest.length) return json({ error: "Bad path" }, 400);
    if (!["set", "update", "delete"].includes(op)) return json({ error: "Bad op" }, 400);
    if (op !== "delete" && !isObj(data)) return json({ error: "Missing data" }, 400);
    if (!isAdmin && coll !== "points") return json({ error: "forbidden", message: "Only admins can change this." }, 403);

    await ensureSeeded(store);
    for (let attempt = 0; attempt < 12; attempt++) {
      const cur = await store.getWithMetadata(coll, { type: "json" });
      const docs = { ...((cur && cur.data && cur.data.docs) || {}) };
      if (op === "set") docs[id] = data;
      else if (op === "update") {
        if (!(id in docs)) return json({ error: "not_found", message: "Document does not exist" }, 404);
        docs[id] = deepMerge(docs[id], data);
      } else delete docs[id];
      const res = await store.setJSON(coll, { docs }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
      if (!res || res.modified !== false) {
        const after = await store.getMetadata(coll);
        const out = coll === "staff" && !isAdmin ? stripPins(docs) : docs;
        return json({ collection: coll, etag: (res && res.etag) || (after && after.etag) || "", docs: out });
      }
      await new Promise(r => setTimeout(r, 40 + Math.random() * 120));
    }
    return json({ error: "Busy, please retry" }, 409);
  }
  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: ["/api/db", "/api/login"] };
