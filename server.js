'use strict';
// BBI Merch server: serves the phone app and stores designs, stock, sales and images in SQLite.
// No dependencies beyond Node itself (needs Node 22.13+ for node:sqlite).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 365;

if (!APP_PASSWORD) console.warn('APP_PASSWORD is not set: nobody can sign in until it is.');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set: sign-ins will reset on every restart.');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'bbi.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS designs (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sales (id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL, voided_at INTEGER);
  CREATE INDEX IF NOT EXISTS sales_at ON sales (at);
  CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, type TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL);
`);

const q = {
  designs: db.prepare('SELECT data FROM designs ORDER BY created_at, id'),
  design: db.prepare('SELECT data FROM designs WHERE id = ?'),
  upsertDesign: db.prepare('INSERT INTO designs (id, data, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
  deleteDesign: db.prepare('DELETE FROM designs WHERE id = ?'),
  sale: db.prepare('SELECT data, voided_at FROM sales WHERE id = ?'),
  insertSale: db.prepare('INSERT INTO sales (id, at, data) VALUES (?, ?, ?)'),
  voidSale: db.prepare('UPDATE sales SET voided_at = ? WHERE id = ?'),
  recentSales: db.prepare('SELECT data FROM sales WHERE voided_at IS NULL AND at >= ? ORDER BY at DESC LIMIT ?'),
  insertImage: db.prepare('INSERT INTO images (id, type, bytes, created_at) VALUES (?, ?, ?, ?)'),
  image: db.prepare('SELECT type, bytes FROM images WHERE id = ?'),
  deleteImage: db.prepare('DELETE FROM images WHERE id = ?'),
};

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------- Validation ---------- */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
const imgId = v => (typeof v === 'string' && ID_RE.test(v) ? v : null);

function cleanDesign(id, b, existing) {
  const styles = Array.isArray(b.styles) ? b.styles.slice(0, 30).map(st => ({
    id: ID_RE.test(String(st.id)) ? String(st.id) : crypto.randomBytes(5).toString('hex'),
    name: str(st.name, 60),
    price: num(st.price),
    mockup: imgId(st.mockup),
    sizes: (Array.isArray(st.sizes) ? st.sizes : []).slice(0, 30).map(z => {
      const o = { size: str(z.size, 20), stock: Math.round(num(z.stock)) };
      if (z.price != null && z.price !== '' && num(z.price) !== num(st.price)) o.price = num(z.price);
      return o;
    }).filter(z => z.size),
  })) : [];
  return {
    id, name: str(b.name, 120) || 'Untitled design',
    graphic: imgId(b.graphic), mockup: imgId(b.mockup), styles,
    createdAt: existing ? existing.createdAt : (Number(b.createdAt) || Date.now()),
    updatedAt: Date.now(),
  };
}
const imagesOf = d => [d.graphic, d.mockup, ...(d.styles || []).map(s => s.mockup)].filter(Boolean);

function getDesign(id) { const r = q.design.get(id); return r ? JSON.parse(r.data) : null; }
function putDesign(d) { q.upsertDesign.run(d.id, JSON.stringify(d), d.createdAt); }

// Apply a sale's items to stock. sign -1 sells, +1 puts back.
function applyItems(items, sign) {
  const touched = new Map();
  for (const it of items) {
    const d = touched.get(it.designId) || getDesign(it.designId);
    if (!d) continue;
    const z = (d.styles || []).find(s => s.id === it.styleId)?.sizes.find(x => x.size === it.size);
    if (z) z.stock = Math.max(0, (Number(z.stock) || 0) + sign * it.qty);
    touched.set(it.designId, d);
  }
  for (const d of touched.values()) { d.updatedAt = Date.now(); putDesign(d); }
}

/* ---------- Sessions ---------- */
function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function makeSession() { const exp = String(Date.now() + SESSION_DAYS * 864e5); return exp + '.' + sign(exp); }
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function authed(req) {
  const v = cookies(req).bbi_session; if (!v) return false;
  const [exp, mac] = v.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign(exp)), got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function passwordOk(p) {
  if (!APP_PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(p)).digest(), b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
const secureCookie = req => (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';

/* ---------- HTTP helpers ---------- */
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 1024 * 1024);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/index.html': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8', 'no-cache'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json', 'no-cache'],
  '/icon.svg': ['icon.svg', 'image/svg+xml', 'public, max-age=86400'],
};
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const failedLogins = new Map();

/* ---------- Routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, m = req.method;

  if (p === '/health') return send(res, 200, 'ok');
  if (m === 'GET' && STATIC[p]) {
    const [file, type, cache] = STATIC[p];
    return fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => err ? send(res, 404, 'Not found') : send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': cache }));
  }

  if (p === '/api/login' && m === 'POST') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const f = failedLogins.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) return send(res, 429, { error: 'Too many tries. Wait a minute and try again.' });
    const body = await readJson(req);
    if (!passwordOk(body.password)) {
      f.n++; if (f.n >= 5) { f.until = Date.now() + 60_000; f.n = 0; } failedLogins.set(ip, f);
      await new Promise(r => setTimeout(r, 400));
      return send(res, 401, { error: 'That password is wrong.' });
    }
    failedLogins.delete(ip);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `bbi_session=${makeSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secureCookie(req)}` });
  }
  if (p === '/api/logout' && m === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': `bbi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(req)}` });
  }

  if (!(p.startsWith('/api/') || p.startsWith('/img/'))) return send(res, 404, 'Not found');
  if (!authed(req)) return send(res, 401, { error: 'Sign in first.' });

  if (p === '/api/me' && m === 'GET') return send(res, 200, { ok: true });

  if (p === '/api/designs' && m === 'GET') return send(res, 200, q.designs.all().map(r => JSON.parse(r.data)));

  let mm;
  if ((mm = p.match(/^\/api\/designs\/([A-Za-z0-9_-]{1,64})$/))) {
    const id = mm[1];
    if (m === 'PUT') {
      const body = await readJson(req);
      const d = tx(() => {
        const existing = getDesign(id);
        const d = cleanDesign(id, body, existing);
        putDesign(d);
        if (existing) { const keep = new Set(imagesOf(d)); for (const img of imagesOf(existing)) if (!keep.has(img)) q.deleteImage.run(img); }
        return d;
      });
      return send(res, 200, d);
    }
    if (m === 'DELETE') {
      tx(() => { const d = getDesign(id); if (d) { for (const img of imagesOf(d)) q.deleteImage.run(img); q.deleteDesign.run(id); } });
      return send(res, 200, { ok: true });
    }
  }
  if ((mm = p.match(/^\/api\/designs\/([A-Za-z0-9_-]{1,64})\/stock$/)) && m === 'POST') {
    const body = await readJson(req);
    const d = tx(() => {
      const d = getDesign(mm[1]); if (!d) return null;
      const z = (d.styles || []).find(s => s.id === body.styleId)?.sizes.find(x => x.size === body.size);
      if (!z) return null;
      z.stock = Math.round(num(body.stock)); d.updatedAt = Date.now(); putDesign(d); return d;
    });
    return d ? send(res, 200, d) : send(res, 404, { error: 'That item or size no longer exists.' });
  }

  if (p === '/api/sales' && m === 'GET') {
    const since = Number(url.searchParams.get('since')) || Date.now() - 2 * 864e5;
    const limit = Math.min(5000, Number(url.searchParams.get('limit')) || 500);
    return send(res, 200, q.recentSales.all(since, limit).map(r => JSON.parse(r.data)));
  }
  if (p === '/api/sales' && m === 'POST') {
    const b = await readJson(req);
    if (!ID_RE.test(String(b.id))) return send(res, 400, { error: 'Bad sale id.' });
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 100).map(it => ({
      designId: str(it.designId, 64), designName: str(it.designName, 120), styleId: str(it.styleId, 64), styleName: str(it.styleName, 60),
      size: str(it.size, 20), qty: Math.max(1, Math.round(num(it.qty))), price: num(it.price),
    }));
    if (!items.length) return send(res, 400, { error: 'A sale needs at least one item.' });
    const sale = { id: b.id, at: Number(b.at) || Date.now(), items, total: items.reduce((a, it) => a + it.qty * it.price, 0), payment: b.payment === 'card' ? 'card' : 'cash' };
    const dup = tx(() => {
      if (q.sale.get(sale.id)) return true; // already recorded: a retry from a phone that lost signal
      q.insertSale.run(sale.id, sale.at, JSON.stringify(sale));
      applyItems(items, -1);
      return false;
    });
    return send(res, 200, { ok: true, duplicate: dup });
  }
  if ((mm = p.match(/^\/api\/sales\/([A-Za-z0-9_-]{1,64})\/void$/)) && m === 'POST') {
    tx(() => {
      const r = q.sale.get(mm[1]);
      if (!r || r.voided_at) return;
      q.voidSale.run(Date.now(), mm[1]);
      applyItems(JSON.parse(r.data).items, 1);
    });
    return send(res, 200, { ok: true });
  }

  if (p === '/api/images' && m === 'POST') {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!IMAGE_TYPES.has(type)) return send(res, 415, { error: 'Use a JPG, PNG, WebP or GIF image.' });
    const bytes = await readBody(req, 8 * 1024 * 1024);
    if (!bytes.length) return send(res, 400, { error: 'The image was empty.' });
    const id = crypto.randomBytes(12).toString('base64url');
    q.insertImage.run(id, type, bytes, Date.now());
    return send(res, 200, { id });
  }
  if ((mm = p.match(/^\/api\/images\/([A-Za-z0-9_-]{1,64})$/)) && m === 'DELETE') {
    q.deleteImage.run(mm[1]); return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/img\/([A-Za-z0-9_-]{1,64})$/)) && m === 'GET') {
    const r = q.image.get(mm[1]);
    if (!r) return send(res, 404, 'Not found');
    return send(res, 200, Buffer.from(r.bytes), { 'Content-Type': r.type, 'Cache-Control': 'private, max-age=31536000, immutable' });
  }

  return send(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status === 413 ? 'That file is too big.' : 'Something went wrong on the server.' });
  });
}).listen(PORT, () => console.log(`BBI Merch listening on ${PORT}, data in ${DATA_DIR}`));
