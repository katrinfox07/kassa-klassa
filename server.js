'use strict';
// «Касса класса» — сервис для казначеев: много классов на одном сайте.
// Node 22.13+, встроенный SQLite, без внешних зависимостей.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const OWNER_EMAILS = (process.env.OWNER_EMAIL || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const PRICE = Number(process.env.PRICE_RUB) || 399;          // ₽ в год за класс
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS) || 30;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- База данных ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'kassa.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
  pass TEXT NOT NULL, consent_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paid_until TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL, days INTEGER NOT NULL, method TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS class_settings (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (class_id, key));
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL DEFAULT 0, due_date TEXT, pay_link TEXT NOT NULL DEFAULT '',
  closed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  payer TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', screenshot TEXT,
  source TEXT NOT NULL DEFAULT 'parent',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL, amount INTEGER NOT NULL,
  date TEXT NOT NULL, collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY, expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE, file TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_students ON students(class_id);
CREATE INDEX IF NOT EXISTS i_coll ON collections(class_id);
CREATE INDEX IF NOT EXISTS i_pay ON payments(class_id);
CREATE INDEX IF NOT EXISTS i_exp ON expenses(class_id);
`);
const q = (sql) => db.prepare(sql);
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
const getSettingRaw = k => q('SELECT value FROM meta WHERE key=?').get(k)?.value;
// миграция: полные данные ученика (видны только казначею)
for (const col of ['full_name', 'birth', 'parent', 'phone']) {
  try { db.exec(`ALTER TABLE students ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`); } catch {}
}
// телефоны отдельно от ФИО родителя
const PHONE_RE = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g;
const splitPhones = t => { const phones = String(t || '').match(PHONE_RE) || [];
  return { parent: String(t || '').replace(PHONE_RE, '').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/[\s,]+$/, '').replace(/\s{2,}/g, ' ').trim(), phone: phones.map(x => x.trim()).join(', ') }; };
for (const r of q("SELECT id, parent FROM students WHERE phone='' AND parent<>''").all()) {
  const x = splitPhones(r.parent); if (x.phone) q('UPDATE students SET parent=?, phone=? WHERE id=?').run(x.parent, x.phone, r.id);
}
// отдельные сборы (досбор на конкретное дело) не входят в кассу класса
try { db.exec('ALTER TABLE collections ADD COLUMN separate INTEGER NOT NULL DEFAULT 0'); } catch {}
if (!getSettingRaw('mig_photo_separate')) {
  db.exec("UPDATE collections SET separate=1 WHERE title='Фотографии' AND description LIKE '1 фото — 450%'");
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_photo_separate', '1')").run();
}
// исправление переноса 5Г: у троих «Внесено» было пусто; 1 400 ₽ — остаток прошлых сборов
if (!getSettingRaw('mig_5g_fix')) {
  const cl = q("SELECT id FROM classes WHERE slug='ekl-5g'").get();
  if (cl) {
    const k = q("SELECT id FROM collections WHERE class_id=? AND title='Взнос в фонд класса'").get(cl.id);
    if (k) for (const n of ['Бембель Михаил', 'Гордеева Дарья', 'Павлюченко Полина'])
      q("DELETE FROM payments WHERE collection_id=? AND source='treasurer' AND student_id=(SELECT id FROM students WHERE class_id=? AND name=?)").run(k.id, cl.id, n);
    q("INSERT INTO class_settings(class_id,key,value) VALUES(?,?,?) ON CONFLICT(class_id,key) DO NOTHING").run(cl.id, 'opening', JSON.stringify({ amount: 1400, note: 'Остаток прошлых сборов' }));
  }
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_5g_fix', '1')").run();
}
// каникулы 2026/27 для 5Г (из календарного графика МАОУ НЭЛ)
if (!getSettingRaw('mig_5g_holidays')) {
  const cl = q("SELECT id FROM classes WHERE slug='ekl-5g'").get();
  if (cl) {
    const info = getSetting(cl.id, 'info', DEFAULT_INFO);
    info.holidays = [
      { title: 'Осенние каникулы', from: '2026-11-01', to: '2026-11-08' },
      { title: 'Зимние каникулы', from: '2026-12-30', to: '2027-01-10' },
      { title: 'Весенние каникулы', from: '2027-03-28', to: '2027-04-04' },
      { title: 'Летние каникулы', from: '2027-05-27', to: '2027-08-31' },
    ];
    setSetting(cl.id, 'info', info);
  }
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_5g_holidays', '1')").run();
}
// убрать служебную пометку после переноса из таблицы
db.exec(`UPDATE collections SET description = trim(replace(replace(description, ' Перенесено из таблицы.', ''), 'Перенесено из таблицы.', '')) WHERE description LIKE '%Перенесено из таблицы.%'`);
// Строка из таблицы: «ФИО ребёнка [tab] дата рождения [tab] ФИО родителя» (или через пробелы)
function parseStudent(line) {
  let cells = String(line).split('\t').map(x => x.trim()).filter(Boolean);
  if (cells.length && /^\d+[.)]?$/.test(cells[0])) cells.shift();
  if (cells.length === 1) cells[0] = cells[0].replace(/^\s*\d+[.)]\s*/, '');
  let birth = '';
  const dre = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})|(\d{4})-(\d{2})-(\d{2})/;
  cells = cells.map(c => {
    const m = dre.exec(c);
    if (m && !birth) {
      birth = m[4] ? `${m[6]}.${m[5]}.${m[4]}` : `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3].length === 2 ? '20' + m[3] : m[3]}`;
      c = c.replace(m[0], ' ').trim();
    }
    return c.replace(/\s+/g, ' ');
  }).filter(c => /[A-Za-zА-Яа-яЁё]{2}/.test(c));
  let full = cells[0] || '', parent = cells.slice(1).join(', ');
  if (cells.length === 1) {
    const w = full.split(' ');
    if (w.length >= 5) { full = w.slice(0, 3).join(' '); parent = w.slice(3).join(' '); }
  }
  const sp = splitPhones(parent); parent = sp.parent.slice(0, 200); const phone = sp.phone.slice(0, 200);
  full = full.slice(0, 160);
  const name = full.split(' ').slice(0, 2).join(' ').slice(0, 120);
  return name ? { name, full, birth, parent, phone } : null;
}
const insStudent = (cid, st, sort) => q('INSERT INTO students(class_id, name, full_name, birth, parent, phone, sort) VALUES(?,?,?,?,?,?,?)')
  .run(cid, st.name, st.full, st.birth, st.parent, st.phone, sort);

const DEFAULT_INFO = {
  announcements: [],
  bells: [
    { n: 1, from: '08:00', to: '08:40' }, { n: 2, from: '08:50', to: '09:30' },
    { n: 3, from: '09:50', to: '10:30' }, { n: 4, from: '10:50', to: '11:30' },
    { n: 5, from: '11:40', to: '12:20' }, { n: 6, from: '12:30', to: '13:10' },
  ],
  holidays: [], teachers: [], links: [],
};
const getSetting = (cid, k, d) => { const r = q('SELECT value FROM class_settings WHERE class_id=? AND key=?').get(cid, k); return r ? JSON.parse(r.value) : d; };
const setSetting = (cid, k, v) => q('INSERT INTO class_settings(class_id,key,value) VALUES(?,?,?) ON CONFLICT(class_id,key) DO UPDATE SET value=excluded.value').run(cid, k, JSON.stringify(v));

// ---------- Утилиты ----------
const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const fail = (res, code, msg) => send(res, code, { error: msg });
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = msg => { throw new HttpError(400, msg); };

const readBody = (req, limit = 12 * 1024 * 1024) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Слишком большой файл')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'Неверные данные')); } });
  req.on('error', reject);
});

const hashPass = p => { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(p, salt, 32).toString('hex'); };
const checkPass = (p, stored) => {
  const [s, h] = stored.split(':');
  const calc = crypto.scryptSync(p, Buffer.from(s, 'hex'), 32);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
};
const cookie = (req, name) => { const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(req.headers.cookie || ''); return m ? decodeURIComponent(m[1]) : null; };
const SESSION_DAYS = 60;
function currentUser(req) {
  const t = cookie(req, 'kz'); if (!t) return null;
  const s = q('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(t, Date.now());
  if (s) s.is_owner = OWNER_EMAILS.includes(s.email);
  return s || null;
}
function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(token, userId, Date.now() + SESSION_DAYS * 864e5);
  q('DELETE FROM sessions WHERE expires<?').run(Date.now());
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `kz=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

const saveImage = (dataUrl, prefix) => {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) bad('Нужна картинка (jpeg/png)');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) bad('Картинка слишком большая');
  const name = `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return name;
};
const rmFile = f => { if (f) fs.rm(path.join(UPLOAD_DIR, path.basename(f)), { force: true }, () => {}); };
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const int = v => { const n = Math.round(Number(String(v ?? '').replace(',', '.').replace(/\s/g, ''))); return Number.isFinite(n) ? n : NaN; };
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const okLink = v => { v = str(v, 1000); if (!v) return ''; if (!/^https:\/\//i.test(v)) bad('Ссылка должна начинаться с https://'); return v; };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date((d > today() ? d : today()) + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// Адрес класса: латиница, цифры, дефис
const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
const slugify = s => String(s || '').toLowerCase().split('').map(c => TRANSLIT[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const RESERVED = new Set(['api', 'admin', 'owner', 'account', 'login', 'uploads', 'static', 'www', 'c', 'kassa', 'help', 'oferta', 'privacy']);
function freeSlug(base) {
  let s = slugify(base) || 'klass'; if (s.length < 3 || RESERVED.has(s)) s = 'klass-' + s;
  let cand = s, i = 2;
  while (q('SELECT 1 FROM classes WHERE slug=?').get(cand)) cand = `${s}-${i++}`;
  return cand;
}

// ---------- Данные класса ----------
function classState(c, admin) {
  const cid = c.id;
  const students = q('SELECT id, name, full_name, birth, parent, phone, active FROM students WHERE class_id=? ORDER BY sort, name').all(cid);
  const collections = q('SELECT * FROM collections WHERE class_id=? ORDER BY closed, COALESCE(due_date, created_at) DESC, id DESC').all(cid);
  const payments = q(`SELECT id, collection_id, student_id, amount, status, payer, note, source, created_at, decided_at,
    screenshot IS NOT NULL AS has_shot FROM payments WHERE class_id=? AND (status != 'rejected' OR ?) ORDER BY created_at DESC`).all(cid, admin ? 1 : 0);
  const expenses = q('SELECT * FROM expenses WHERE class_id=? ORDER BY date DESC, id DESC').all(cid);
  const receipts = q('SELECT r.expense_id, r.file FROM receipts r JOIN expenses e ON e.id=r.expense_id WHERE e.class_id=? ORDER BY r.id').all(cid);
  for (const e of expenses) e.receipts = receipts.filter(r => r.expense_id === e.id).map(r => '/uploads/' + r.file);
  const sep = new Set(collections.filter(k => k.separate).map(k => k.id));
  const opening = getSetting(cid, 'opening', { amount: 0, note: '' });
  const collected = (opening.amount || 0) + payments.filter(p => p.status === 'confirmed' && !sep.has(p.collection_id)).reduce((s, p) => s + p.amount, 0);
  const spent = expenses.filter(e => !sep.has(e.collection_id)).reduce((s, e) => s + e.amount, 0);
  const activeCount = students.filter(s => s.active).length;
  for (const k of collections) {
    const ps = payments.filter(p => p.collection_id === k.id);
    k.collected = ps.filter(p => p.status === 'confirmed').reduce((s, p) => s + p.amount, 0);
    k.pending = ps.filter(p => p.status === 'pending').length;
    k.expected = k.amount * activeCount;
    k.spent = expenses.filter(e => e.collection_id === k.id).reduce((s, e) => s + e.amount, 0);
  }
  return {
    class: { ...getSetting(cid, 'class', {}), title: c.title, slug: c.slug },
    subscription: admin ? { paid_until: c.paid_until, active: c.paid_until >= today(), price: PRICE } : undefined,
    info: getSetting(cid, 'info', DEFAULT_INFO),
    students: students.filter(s => s.active || admin).map(s => admin ? s : { id: s.id, name: s.name }),
    collections,
    payments: admin ? payments : payments.map(p => ({ collection_id: p.collection_id, student_id: p.student_id, amount: p.amount, status: p.status })),
    expenses,
    opening,
    totals: { collected, spent, balance: collected - spent },
  };
}

// ---------- Маршруты ----------
const routes = [];
// opts: auth — нужен вход; cls — маршрут класса (/api/c/:slug/...), admin — только хозяин класса; owner — только владелец сервиса
const route = (method, pattern, handler, opts = {}) => routes.push({
  method, handler, ...opts,
  re: new RegExp('^' + (opts.cls ? '/api/c/(?<slug>[a-z0-9-]+)' : '') + pattern.replace(/:(\w+)/g, '(?<$1>\\d+)') + '$'),
});

// --- Аккаунт ---
const rateHits = new Map();
function rate(req, key, max, windowMs) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const k = key + ':' + ip, now = Date.now();
  const hits = (rateHits.get(k) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) throw new HttpError(429, 'Слишком много попыток, попробуйте позже');
  rateHits.set(k, [...hits, now]);
}

route('GET', '/api/me', (req, res, b, p, u) => {
  if (!u) return send(res, 200, { user: null });
  const classes = q('SELECT slug, title, paid_until, EXISTS(SELECT 1 FROM subscriptions x WHERE x.class_id=c.id) AS paid FROM classes c WHERE user_id=? ORDER BY id').all(u.id);
  send(res, 200, { user: { email: u.email, name: u.name, owner: u.is_owner }, classes, price: PRICE, trialDays: TRIAL_DAYS });
});
route('GET', '/api/config', (req, res) => send(res, 200, { price: PRICE, trialDays: TRIAL_DAYS }));
route('POST', '/api/auth/register', async (req, res, b) => {
  rate(req, 'reg', 10, 3600e3);
  const email = str(b.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('Проверьте почту');
  if (String(b.password || '').length < 8) bad('Пароль не короче 8 символов');
  if (!b.consent) bad('Нужно согласие на обработку персональных данных');
  if (q('SELECT 1 FROM users WHERE email=?').get(email)) bad('Такая почта уже зарегистрирована. Войдите.');
  const r = q("INSERT INTO users(email, name, pass, consent_at) VALUES(?,?,?,datetime('now'))").run(email, str(b.name, 100), hashPass(String(b.password)));
  send(res, 200, { ok: true }, { 'Set-Cookie': startSession(req, res, r.lastInsertRowid) });
});
route('POST', '/api/auth/login', async (req, res, b) => {
  rate(req, 'login', 20, 900e3);
  await new Promise(r => setTimeout(r, 300));
  const u = q('SELECT * FROM users WHERE email=?').get(str(b.email, 200).toLowerCase());
  if (!u || !checkPass(String(b.password || ''), u.pass)) throw new HttpError(401, 'Неверная почта или пароль');
  send(res, 200, { ok: true }, { 'Set-Cookie': startSession(req, res, u.id) });
});
route('POST', '/api/auth/logout', (req, res) => {
  const t = cookie(req, 'kz'); if (t) q('DELETE FROM sessions WHERE token=?').run(t);
  send(res, 200, { ok: true }, { 'Set-Cookie': 'kz=; Path=/; Max-Age=0' });
});
route('POST', '/api/auth/password', (req, res, b, p, u) => {
  if (!checkPass(String(b.old || ''), u.pass)) bad('Старый пароль неверный');
  if (String(b.password || '').length < 8) bad('Новый пароль не короче 8 символов');
  q('UPDATE users SET pass=? WHERE id=?').run(hashPass(String(b.password)), u.id);
  send(res, 200, { ok: true });
}, { auth: true });

// Создать класс
route('POST', '/api/classes', (req, res, b, p, u) => {
  const title = str(b.title, 100); if (!title) bad('Как называется класс? Например: «Школа 12, 4 «А»»');
  if (q('SELECT COUNT(*) n FROM classes WHERE user_id=?').get(u.id).n >= 10) bad('Слишком много классов на одном аккаунте');
  const slug = freeSlug(b.slug || title);
  const r = q('INSERT INTO classes(slug, title, user_id, paid_until) VALUES(?,?,?,?)').run(slug, title, u.id, addDays(today(), TRIAL_DAYS));
  const cid = r.lastInsertRowid;
  setSetting(cid, 'class', { treasurer: u.name || '', payHint: '' });
  setSetting(cid, 'info', DEFAULT_INFO);
  String(b.students || '').split('\n').map(parseStudent).filter(Boolean).slice(0, 60).forEach((st, i) => insStudent(cid, st, i));
  send(res, 200, { ok: true, slug });
}, { auth: true });

// --- Публичная страница класса ---
route('GET', '/public', (req, res, b, p, u, c) => send(res, 200, classState(c, false)), { cls: true });
route('POST', '/report-payment', async (req, res, b, p, u, c) => {
  rate(req, 'report', 20, 3600e3);
  const k = q('SELECT * FROM collections WHERE id=? AND class_id=?').get(int(b.collection_id), c.id);
  const s = q('SELECT * FROM students WHERE id=? AND class_id=? AND active=1').get(int(b.student_id), c.id);
  if (!k || k.closed) bad('Сбор не найден или закрыт');
  if (!s) bad('Выберите ребёнка');
  const amount = int(b.amount);
  if (!(amount > 0 && amount < 1e7)) bad('Укажите сумму');
  const paidSum = q("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE collection_id=? AND student_id=? AND status='confirmed'").get(k.id, s.id).s;
  if (paidSum > 0 && (!k.amount || paidSum >= k.amount)) bad('Оплата за этого ребёнка уже подтверждена');
  const shot = b.image ? saveImage(b.image, 'pay') : null;
  const old = q("SELECT id, screenshot FROM payments WHERE collection_id=? AND student_id=? AND status='pending'").get(k.id, s.id);
  if (old) { rmFile(old.screenshot); q('DELETE FROM payments WHERE id=?').run(old.id); }
  q('INSERT INTO payments(class_id, collection_id, student_id, amount, payer, note, screenshot) VALUES(?,?,?,?,?,?,?)')
    .run(c.id, k.id, s.id, amount, str(b.payer, 120), str(b.note, 300), shot);
  send(res, 200, { ok: true });
}, { cls: true });

// --- Кабинет казначея (только хозяин класса или владелец сервиса) ---
const A = { cls: true, admin: true };
const W = { cls: true, admin: true, write: true }; // запись: только при действующей подписке
route('GET', '/admin/state', (req, res, b, p, u, c) => send(res, 200, classState(c, true)), A);
route('GET', '/admin/shot/:id', (req, res, b, p, u, c) => {
  const r = q('SELECT screenshot FROM payments WHERE id=? AND class_id=?').get(int(p.id), c.id);
  if (!r?.screenshot) throw new HttpError(404, 'Нет скриншота');
  serveFile(res, path.join(UPLOAD_DIR, path.basename(r.screenshot)), 'private, max-age=600');
}, A);

route('POST', '/admin/students', (req, res, b, p, u, c) => {
  const names = String(b.names || '').split('\n').map(parseStudent).filter(Boolean);
  if (!names.length) bad('Введите имя');
  if (q('SELECT COUNT(*) n FROM students WHERE class_id=?').get(c.id).n + names.length > 140) bad('Слишком много учеников');
  const max = q('SELECT COALESCE(MAX(sort),0) m FROM students WHERE class_id=?').get(c.id).m;
  // если ребёнок с такими фамилией и именем уже есть, дополняем его данные, а не создаём дубль
  let n = 0;
  names.forEach(st => {
    const ex = q('SELECT id FROM students WHERE class_id=? AND lower(name)=lower(?)').get(c.id, st.name);
    if (ex) q(`UPDATE students SET full_name=?, birth=CASE WHEN ?<>'' THEN ? ELSE birth END,
      parent=CASE WHEN ?<>'' THEN ? ELSE parent END, phone=CASE WHEN ?<>'' THEN ? ELSE phone END WHERE id=?`).run(st.full, st.birth, st.birth, st.parent, st.parent, st.phone, st.phone, ex.id);
    else insStudent(c.id, st, max + ++n);
  });
  send(res, 200, { ok: true });
}, W);
route('PUT', '/admin/students/:id', (req, res, b, p, u, c) => {
  const full = str(b.full_name || b.name, 160).replace(/\s+/g, ' ');
  const name = full.split(' ').slice(0, 2).join(' '); if (!name) bad('Введите имя');
  q('UPDATE students SET name=?, full_name=?, birth=?, parent=?, phone=?, active=? WHERE id=? AND class_id=?')
    .run(name, full, str(b.birth, 20), str(b.parent, 200), str(b.phone, 200), b.active ? 1 : 0, int(p.id), c.id);
  send(res, 200, { ok: true });
}, W);
route('DELETE', '/admin/students/:id', (req, res, b, p, u, c) => {
  if (q('SELECT COUNT(*) n FROM payments WHERE student_id=? AND class_id=?').get(int(p.id), c.id).n)
    bad('У ребёнка есть оплаты. Лучше отметьте «выбыл», чтобы история сохранилась.');
  q('DELETE FROM students WHERE id=? AND class_id=?').run(int(p.id), c.id);
  send(res, 200, { ok: true });
}, W);

const collectionFields = b => {
  const title = str(b.title, 150); if (!title) bad('Введите название сбора');
  const amount = int(b.amount || 0); if (!(amount >= 0 && amount < 1e7)) bad('Неверная сумма');
  return [title, str(b.description, 2000), amount, isDate(b.due_date) ? b.due_date : null, okLink(b.pay_link)];
};
route('POST', '/admin/collections', (req, res, b, p, u, c) => {
  q('INSERT INTO collections(title, description, amount, due_date, pay_link, separate, class_id) VALUES(?,?,?,?,?,?,?)').run(...collectionFields(b), b.separate ? 1 : 0, c.id);
  send(res, 200, { ok: true });
}, W);
route('PUT', '/admin/collections/:id', (req, res, b, p, u, c) => {
  q('UPDATE collections SET title=?, description=?, amount=?, due_date=?, pay_link=?, closed=?, separate=? WHERE id=? AND class_id=?')
    .run(...collectionFields(b), b.closed ? 1 : 0, b.separate ? 1 : 0, int(p.id), c.id);
  send(res, 200, { ok: true });
}, W);
route('DELETE', '/admin/collections/:id', (req, res, b, p, u, c) => {
  for (const r of q('SELECT screenshot FROM payments WHERE collection_id=? AND class_id=?').all(int(p.id), c.id)) rmFile(r.screenshot);
  q('DELETE FROM collections WHERE id=? AND class_id=?').run(int(p.id), c.id);
  send(res, 200, { ok: true });
}, W);

route('POST', '/admin/payments', (req, res, b, p, u, c) => {
  const k = q('SELECT id, amount FROM collections WHERE id=? AND class_id=?').get(int(b.collection_id), c.id);
  const s = q('SELECT id FROM students WHERE id=? AND class_id=?').get(int(b.student_id), c.id);
  if (!k || !s) bad('Не найден сбор или ребёнок');
  const amount = b.amount === undefined || b.amount === '' ? k.amount : int(b.amount);
  if (!(amount > 0)) bad('Укажите сумму');
  const pend = q("SELECT id FROM payments WHERE collection_id=? AND student_id=? AND status='pending'").get(k.id, s.id);
  if (pend) q("UPDATE payments SET status='confirmed', amount=?, decided_at=datetime('now') WHERE id=?").run(amount, pend.id);
  else q("INSERT INTO payments(class_id, collection_id, student_id, amount, status, source, note, decided_at) VALUES(?,?,?,?,'confirmed','treasurer',?,datetime('now'))")
    .run(c.id, k.id, s.id, amount, str(b.note, 300));
  send(res, 200, { ok: true });
}, W);
route('PUT', '/admin/payments/:id', (req, res, b, p, u, c) => {
  if (!['pending', 'confirmed', 'rejected'].includes(b.status)) bad('Неверный статус');
  const amount = b.amount !== undefined ? int(b.amount) : null;
  q("UPDATE payments SET status=?, amount=COALESCE(?, amount), decided_at=datetime('now') WHERE id=? AND class_id=?").run(b.status, amount > 0 ? amount : null, int(p.id), c.id);
  send(res, 200, { ok: true });
}, W);
route('DELETE', '/admin/payments/:id', (req, res, b, p, u, c) => {
  const r = q('SELECT screenshot FROM payments WHERE id=? AND class_id=?').get(int(p.id), c.id);
  if (r) { rmFile(r.screenshot); q('DELETE FROM payments WHERE id=?').run(int(p.id)); }
  send(res, 200, { ok: true });
}, W);

route('POST', '/admin/expenses', (req, res, b, p, u, c) => {
  const title = str(b.title, 200); if (!title) bad('На что потрачено?');
  const amount = int(b.amount); if (!(amount > 0)) bad('Укажите сумму');
  let cid = int(b.collection_id) > 0 ? int(b.collection_id) : null;
  if (cid && !q('SELECT 1 FROM collections WHERE id=? AND class_id=?').get(cid, c.id)) cid = null;
  const files = (Array.isArray(b.images) ? b.images.slice(0, 6) : []).map(i => saveImage(i, 'chek'));
  const r = q('INSERT INTO expenses(class_id, title, amount, date, collection_id, note) VALUES(?,?,?,?,?,?)')
    .run(c.id, title, amount, isDate(b.date) ? b.date : today(), cid, str(b.note, 1000));
  const ins = q('INSERT INTO receipts(expense_id, file) VALUES(?,?)');
  files.forEach(f => ins.run(r.lastInsertRowid, f));
  send(res, 200, { ok: true });
}, W);
route('DELETE', '/admin/expenses/:id', (req, res, b, p, u, c) => {
  if (!q('SELECT 1 FROM expenses WHERE id=? AND class_id=?').get(int(p.id), c.id)) return send(res, 200, { ok: true });
  for (const r of q('SELECT file FROM receipts WHERE expense_id=?').all(int(p.id))) rmFile(r.file);
  q('DELETE FROM expenses WHERE id=?').run(int(p.id));
  send(res, 200, { ok: true });
}, W);

route('PUT', '/admin/info', (req, res, b, p, u, c) => {
  const arr = (v, n = 100) => Array.isArray(v) ? v.slice(0, n) : [];
  setSetting(c.id, 'info', {
    announcements: arr(b.announcements, 30).map(a => ({ date: isDate(a.date) ? a.date : '', text: str(a.text, 3000) })).filter(a => a.text),
    bells: arr(b.bells, 12).map((x, i) => ({ n: i + 1, from: str(x.from, 5), to: str(x.to, 5) })).filter(x => x.from || x.to),
    holidays: arr(b.holidays).map(h => ({ title: str(h.title, 100), from: isDate(h.from) ? h.from : '', to: isDate(h.to) ? h.to : '' })).filter(h => h.title),
    teachers: arr(b.teachers).map(t => ({ role: str(t.role, 100), name: str(t.name, 150), contact: str(t.contact, 150) })).filter(t => t.name),
    timetable: arr(b.timetable, 7).map(d => ({ day: str(d.day, 30), lessons: str(d.lessons, 1000) })).filter(d => d.day || d.lessons),
    links: arr(b.links, 20).map(l => ({ title: str(l.title, 100), url: /^https:\/\//i.test(l.url || '') ? str(l.url, 1000) : '' })).filter(l => l.title && l.url),
  });
  send(res, 200, { ok: true });
}, W);
route('PUT', '/admin/class', (req, res, b, p, u, c) => {
  const title = str(b.title, 100) || c.title;
  q('UPDATE classes SET title=? WHERE id=?').run(title, c.id);
  setSetting(c.id, 'class', { treasurer: str(b.treasurer, 100), payHint: str(b.payHint, 1000) });
  if (b.opening !== undefined) setSetting(c.id, 'opening', { amount: Math.max(0, int(b.opening) || 0), note: str(b.openingNote, 200) });
  send(res, 200, { ok: true });
}, W);
route('GET', '/admin/export', (req, res, b, p, u, c) => send(res, 200, classState(c, true), {
  'Content-Disposition': `attachment; filename="kassa-${c.slug}-${today()}.json"` }), A);
route('DELETE', '/admin/class', (req, res, b, p, u, c) => {
  if (str(b.confirm) !== c.slug) bad('Для удаления введите адрес класса');
  for (const r of q('SELECT screenshot FROM payments WHERE class_id=?').all(c.id)) rmFile(r.screenshot);
  for (const r of q('SELECT r.file FROM receipts r JOIN expenses e ON e.id=r.expense_id WHERE e.class_id=?').all(c.id)) rmFile(r.file);
  q('DELETE FROM classes WHERE id=?').run(c.id);
  send(res, 200, { ok: true });
}, A);

// --- Кабинет владельца сервиса ---
const O = { auth: true, owner: true };
route('GET', '/api/owner/classes', (req, res) => {
  const rows = q(`SELECT c.id, c.slug, c.title, c.paid_until, c.created_at, u.email, u.name,
      (SELECT COUNT(*) FROM students s WHERE s.class_id=c.id AND s.active=1) kids,
      (SELECT COUNT(*) FROM collections k WHERE k.class_id=c.id) colls,
      (SELECT COALESCE(SUM(amount),0) FROM subscriptions x WHERE x.class_id=c.id) paid_total
    FROM classes c JOIN users u ON u.id=c.user_id ORDER BY c.id DESC`).all();
  const users = q('SELECT COUNT(*) n FROM users').get().n;
  const income = q('SELECT COALESCE(SUM(amount),0) s FROM subscriptions').get().s;
  send(res, 200, { classes: rows, users, income, today: today(), price: PRICE });
}, O);
route('POST', '/api/owner/classes/:id/extend', (req, res, b, p) => {
  const c = q('SELECT * FROM classes WHERE id=?').get(int(p.id)); if (!c) bad('Класс не найден');
  const days = int(b.days) || 365;
  const amount = int(b.amount ?? PRICE) || 0;
  q('UPDATE classes SET paid_until=? WHERE id=?').run(addDays(c.paid_until, days), c.id);
  q('INSERT INTO subscriptions(class_id, amount, days, method) VALUES(?,?,?,?)').run(c.id, amount, days, 'manual');
  send(res, 200, { ok: true });
}, O);

// ---------- Статика ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
function serveFile(res, file, cache = 'no-cache') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'Не найдено');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
    fs.createReadStream(file).pipe(res);
  });
}
const esc = t => String(t).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function sendManifest(res, { name, short, start, id }) {
  res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({
    name, short_name: short, start_url: start, id: id || start, scope: '/', display: 'standalone', lang: 'ru',
    background_color: '#f5f6f8', theme_color: '#2f6fde',
    icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
  }));
}
const PAGES = { '/': 'landing.html', '/account': 'account.html', '/owner': 'owner.html', '/oferta': 'oferta.html', '/privacy': 'privacy.html' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return fail(res, 400, 'Неверный адрес'); }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    if (p.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(p); if (!m) continue;
        const params = m.groups || {};
        const u = currentUser(req);
        if ((r.auth || r.admin) && !u) throw new HttpError(401, 'Нужно войти');
        if (r.owner && !u.is_owner) throw new HttpError(403, 'Нет доступа');
        let c = null;
        if (r.cls) {
          c = q('SELECT * FROM classes WHERE slug=?').get(params.slug);
          if (!c) throw new HttpError(404, 'Класс не найден');
          if (r.admin && c.user_id !== u.id && !u.is_owner) throw new HttpError(403, 'Это не ваш класс');
          if (r.write && c.paid_until < today() && !u.is_owner) throw new HttpError(402, `Подписка закончилась ${c.paid_until.split('-').reverse().join('.')}. Продлите её, чтобы вносить изменения. Данные сохранены.`);
        }
        const body = req.method === 'GET' || req.method === 'DELETE' && !+req.headers['content-length'] ? {} : await readBody(req);
        return await r.handler(req, res, body, params, u, c);
      }
      return fail(res, 404, 'Не найдено');
    }
    if (p.startsWith('/uploads/') && p.includes('/chek-')) return serveFile(res, path.join(UPLOAD_DIR, path.basename(p)), 'public, max-age=31536000, immutable');
    if (PAGES[p]) return serveFile(res, path.join(PUBLIC_DIR, PAGES[p]));
    if (p === '/manifest.webmanifest') return sendManifest(res, { name: 'Касса класса', short: 'Касса класса', start: '/account' });
    const mm = /^\/c\/([a-z0-9-]+)\/manifest\.webmanifest$/.exec(p);
    if (mm) {
      const c = q('SELECT slug, title FROM classes WHERE slug=?').get(mm[1]); if (!c) return fail(res, 404, 'Не найдено');
      const admin = url.searchParams.get('admin') === '1';
      return sendManifest(res, { name: (admin ? 'Казначей: ' : 'Касса: ') + c.title, short: admin ? 'Казначей' : 'Касса класса', start: `/c/${c.slug}${admin ? '/admin' : ''}`, id: `/c/${c.slug}${admin ? '/admin' : ''}` });
    }
    const cm = /^\/c\/([a-z0-9-]+)(\/admin)?\/?$/.exec(p);
    if (cm) {
      const c = q('SELECT slug, title FROM classes WHERE slug=?').get(cm[1]);
      if (!c) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><p style="font:18px system-ui;padding:24px">Класс не найден. Проверьте ссылку.</p><p style="font:16px system-ui;padding:0 24px"><a href="/">На главную</a></p>'); }
      const html = fs.readFileSync(path.join(PUBLIC_DIR, cm[2] ? 'admin.html' : 'index.html'), 'utf8')
        .replace('<!--HEAD-->', `<link rel="manifest" href="/c/${c.slug}/manifest.webmanifest${cm[2] ? '?admin=1' : ''}">`)
        .replace(/<title>[^<]*<\/title>/, `<title>${esc(cm[2] ? 'Казначей · ' + c.title : c.title)}</title>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || (file.endsWith('.html') && p !== '/offline.html')) return fail(res, 404, 'Не найдено');
    serveFile(res, file);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) fail(res, e.code || 500, e instanceof HttpError ? e.message : 'Ошибка сервера');
  }
});
if (require.main === module) server.listen(PORT, () => console.log(`Касса класса: http://localhost:${PORT}`));
module.exports = { server, db };
