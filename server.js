'use strict';
// «Касса класса» - сервис для казначеев: много классов на одном сайте.
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
const BOOK_DIR = path.join(DATA_DIR, 'books');
fs.mkdirSync(BOOK_DIR, { recursive: true });

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
try { db.exec("ALTER TABLE collections ADD COLUMN qr TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec('ALTER TABLE collections ADD COLUMN flex INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE collections ADD COLUMN skip TEXT NOT NULL DEFAULT '[]'"); } catch {}
if (!getSettingRaw('mig_photo_flex')) {
  db.exec("UPDATE collections SET flex=1 WHERE title='Фотографии' AND description LIKE '1 фото%'");
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_photo_flex', '1')").run();
}
if (!getSettingRaw('mig_hyphen')) {
  for (const [t, cols] of [['collections', ['title', 'description']], ['expenses', ['title', 'note']], ['payments', ['note']], ['class_settings', ['value']], ['classes', ['title']]])
    for (const col of cols) for (const ch of [8211, 8212]) db.exec(`UPDATE ${t} SET ${col}=replace(${col}, char(${ch}), '-') WHERE instr(${col}, char(${ch})) > 0`);
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_hyphen', '1')").run();
}
if (!getSettingRaw('mig_short_dash')) {
  for (const [t, cols] of [['collections', ['title', 'description']], ['expenses', ['title', 'note']], ['payments', ['note']], ['class_settings', ['value']], ['classes', ['title']]])
    for (const col of cols) db.exec(`UPDATE ${t} SET ${col}=replace(${col}, char(8212), char(8211)) WHERE instr(${col}, char(8212)) > 0`);
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_short_dash', '1')").run();
}
if (!getSettingRaw('mig_photo_separate')) {
  db.exec("UPDATE collections SET separate=1 WHERE title='Фотографии' AND description LIKE '1 фото - 450%'");
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_photo_separate', '1')").run();
}
// исправление переноса 5Г: у троих «Внесено» было пусто; 1 400 ₽ - остаток прошлых сборов
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
// 5Г: вернуть ссылку Сбера рядом с Т-Банком во «Взносе в фонд класса» (просьба казначея)
if (!getSettingRaw('mig_5g_sber')) {
  const cl = q("SELECT id FROM classes WHERE slug='ekl-5g'").get();
  const k = cl && q("SELECT id, pay_link FROM collections WHERE class_id=? AND title='Взнос в фонд класса'").get(cl.id);
  const SBER = 'https://messenger.sbrf.ru/sl/UI7lqmKtdxFRu3R47';
  if (k && !k.pay_link.includes(SBER)) q('UPDATE collections SET pay_link=? WHERE id=?').run([SBER, ...k.pay_link.split(/\s+/).filter(Boolean)].join('\n'), k.id);
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_5g_sber', '1')").run();
}
// 5Г: добавить ссылку Озон Банка во «Взнос в фонд класса» (просьба казначея)
if (!getSettingRaw('mig_5g_ozon')) {
  const cl = q("SELECT id FROM classes WHERE slug='ekl-5g'").get();
  const k = cl && q("SELECT id, pay_link FROM collections WHERE class_id=? AND title='Взнос в фонд класса'").get(cl.id);
  const OZON = 'https://finance.ozon.ru/apps/sbp/ozonbankpay/7ddcbd0b-e5b6-4953-a318-7070a275bace';
  if (k && !k.pay_link.includes(OZON)) q('UPDATE collections SET pay_link=? WHERE id=?').run([...k.pay_link.split(/\s+/).filter(Boolean), OZON].join('\n'), k.id);
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_5g_ozon', '1')").run();
}
// 5Г: оставить только ссылку Озон Банка (перевод по СБП из любого банка) - просьба казначея
if (!getSettingRaw('mig_5g_ozon_only')) {
  const cl = q("SELECT id FROM classes WHERE slug='ekl-5g'").get();
  const k = cl && q("SELECT id FROM collections WHERE class_id=? AND title='Взнос в фонд класса'").get(cl.id);
  if (k) q('UPDATE collections SET pay_link=? WHERE id=?').run('https://finance.ozon.ru/apps/sbp/ozonbankpay/7ddcbd0b-e5b6-4953-a318-7070a275bace', k.id);
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_5g_ozon_only', '1')").run();
}
// 5Г: убрать почту классного руководителя (просьба казначея)
if (!getSettingRaw('mig_5g_noemail')) {
  const cl = q("SELECT id FROM classes WHERE slug='ekl-5g'").get();
  const row = cl && q("SELECT value FROM class_settings WHERE class_id=? AND key='info'").get(cl.id);
  if (row) {
    const info = JSON.parse(row.value);
    (info.teachers || []).forEach(t => { if (/olesin\.2011@mail\.ru/i.test(t.contact || '')) t.contact = ''; });
    q("UPDATE class_settings SET value=? WHERE class_id=? AND key='info'").run(JSON.stringify(info), cl.id);
  }
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_5g_noemail', '1')").run();
}
// 5Г: день рождения классного руководителя - 12 ноября (со слов казначея)
if (!getSettingRaw('mig_5g_klbday')) {
  const cl = q("SELECT id FROM classes WHERE slug='ekl-5g'").get();
  const row = cl && q("SELECT value FROM class_settings WHERE class_id=? AND key='info'").get(cl.id);
  if (row) {
    const info = JSON.parse(row.value);
    (info.teachers || []).forEach(t => { if (/классн\S*\s+рук/i.test(t.role || '') && !t.birth) t.birth = '12.11'; });
    q("UPDATE class_settings SET value=? WHERE class_id=? AND key='info'").run(JSON.stringify(info), cl.id);
  }
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_5g_klbday', '1')").run();
}
// код для списка класса: каждому классу случайный, казначей видит и меняет его в «Настройках»
if (!getSettingRaw('mig_list_code')) {
  for (const r of q("SELECT class_id, value FROM class_settings WHERE key='class'").all()) {
    const v = JSON.parse(r.value || '{}');
    if (!v.listCode) { v.listCode = String(crypto.randomInt(1000, 10000)); q("UPDATE class_settings SET value=? WHERE class_id=? AND key='class'").run(JSON.stringify(v), r.class_id); }
  }
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_list_code', '1')").run();
}
// 5Г: список класса открыт родителям без кода (решение казначея)
if (!getSettingRaw('mig_5g_open_list')) {
  const cl = q("SELECT id FROM classes WHERE slug='ekl-5g'").get();
  const row = cl && q("SELECT value FROM class_settings WHERE class_id=? AND key='class'").get(cl.id);
  if (row) { const v = JSON.parse(row.value || '{}'); v.listCode = ''; q("UPDATE class_settings SET value=? WHERE class_id=? AND key='class'").run(JSON.stringify(v), cl.id); }
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_5g_open_list', '1')").run();
}
// 5Г: после 4 урока - столовая, перекус (со слов казначея)
if (!getSettingRaw('mig_5g_lunch')) {
  const cl = q("SELECT id FROM classes WHERE slug='ekl-5g'").get();
  const row = cl && q("SELECT value FROM class_settings WHERE class_id=? AND key='info'").get(cl.id);
  if (row) {
    const info = JSON.parse(row.value);
    const b4 = (info.bells || []).find(b => Number(b.n) === 4) || (info.bells || [])[3];
    if (b4) { b4.after = 'столовая, перекус'; q("UPDATE class_settings SET value=? WHERE class_id=? AND key='info'").run(JSON.stringify(info), cl.id); }
  }
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_5g_lunch', '1')").run();
}
// 5Г: телефон классного руководителя (со слов казначея)
if (!getSettingRaw('mig_5g_klphone')) {
  const cl = q("SELECT id FROM classes WHERE slug='ekl-5g'").get();
  const row = cl && q("SELECT value FROM class_settings WHERE class_id=? AND key='info'").get(cl.id);
  if (row) {
    const info = JSON.parse(row.value);
    const head = (info.teachers || []).find(t => /классн\S*\s+рук/i.test(t.role || ''));
    if (head && !head.contact) head.contact = '+7 993 789-44-70';
    q("UPDATE class_settings SET value=? WHERE class_id=? AND key='info'").run(JSON.stringify(info), cl.id);
  }
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_5g_klphone', '1')").run();
}
// каникулы 2026/27 для 5Г (из календарного графика МАОУ НЭЛ)
if (!getSettingRaw('mig_5g_holidays')) {
  const cl = q("SELECT id FROM classes WHERE slug='ekl-5g'").get();
  if (cl) {
    const row = q("SELECT value FROM class_settings WHERE class_id=? AND key='info'").get(cl.id);
    const info = row ? JSON.parse(row.value) : {};
    info.holidays = [
      { title: 'Осенние каникулы', from: '2026-11-01', to: '2026-11-08' },
      { title: 'Зимние каникулы', from: '2026-12-30', to: '2027-01-10' },
      { title: 'Весенние каникулы', from: '2027-03-28', to: '2027-04-04' },
      { title: 'Летние каникулы', from: '2027-05-27', to: '2027-08-31' },
    ];
    q("INSERT INTO class_settings(class_id,key,value) VALUES(?,'info',?) ON CONFLICT(class_id,key) DO UPDATE SET value=excluded.value").run(cl.id, JSON.stringify(info));
  }
  q("INSERT OR IGNORE INTO meta(key, value) VALUES('mig_5g_holidays', '1')").run();
}
db.exec("UPDATE expenses SET note='' WHERE note LIKE 'Точная сумма:%'");
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
const okLinks = v => String(v || '').split(/[\s,]+/).filter(Boolean).slice(0, 6).map(okLink).join('\n');
const okLink = v => { v = str(v, 1000); if (!v) return ''; if (!/^https:\/\//i.test(v)) bad('Ссылка должна начинаться с https://'); return v; };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date((d > today() ? d : today()) + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// Адрес класса: латиница, цифры, дефис
const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
const slugify = s => String(s || '').toLowerCase().split('').map(c => TRANSLIT[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const RESERVED = new Set(['api', 'admin', 'owner', 'account', 'login', 'uploads', 'static', 'www', 'c', 'kassa', 'help', 'oferta', 'privacy']);
const skipList = v => JSON.stringify((Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger).slice(0, 200));
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
    try { k.skip = JSON.parse(k.skip || '[]'); } catch { k.skip = []; }
    const ps = payments.filter(p => p.collection_id === k.id);
    k.collected = ps.filter(p => p.status === 'confirmed').reduce((s, p) => s + p.amount, 0);
    k.pending = ps.filter(p => p.status === 'pending').length;
    k.expected = k.flex ? 0 : k.amount * students.filter(x => x.active && !k.skip.includes(x.id)).length;
    k.spent = expenses.filter(e => e.collection_id === k.id).reduce((s, e) => s + e.amount, 0);
  }
  return {
    class: (({ listCode, ...rest }) => ({ ...rest, ...(admin ? { listCode } : { hasList: !!listCode }), title: c.title, slug: c.slug }))(getSetting(cid, 'class', {})),
    subscription: admin ? { paid_until: c.paid_until, active: c.paid_until >= today(), price: PRICE } : undefined,
    info: getSetting(cid, 'info', DEFAULT_INFO),
    students: students.filter(s => s.active || admin).map(s => admin ? s : { id: s.id, name: s.name }),
    birthdays: !admin && getSetting(cid, 'class', {}).showBirthdays ? students.filter(s => s.active).map(s => {
      const m = /^(\d{2})\.(\d{2})\./.exec(s.birth || ''); return m ? { name: s.name, md: `${m[2]}-${m[1]}` } : null; }).filter(Boolean) : undefined,
    collections,
    payments: admin ? payments : payments.map(p => ({ collection_id: p.collection_id, student_id: p.student_id, amount: p.amount, status: p.status })),
    expenses,
    books: q("SELECT id, title, pages, status, error FROM books WHERE class_id=? AND (status='ready' OR ?) ORDER BY sort, id").all(cid, admin ? 1 : 0),
    opening,
    totals: { collected, spent, balance: collected - spent },
  };
}

// ---------- Маршруты ----------
const routes = [];
// opts: auth - нужен вход; cls - маршрут класса (/api/c/:slug/...), admin - только хозяин класса; owner - только владелец сервиса
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
  if (!u) return send(res, 200, { user: null, signup: process.env.SIGNUP === 'open' });
  const classes = q('SELECT slug, title, paid_until, EXISTS(SELECT 1 FROM subscriptions x WHERE x.class_id=c.id) AS paid FROM classes c WHERE user_id=? ORDER BY id').all(u.id);
  send(res, 200, { user: { email: u.email, name: u.name, owner: u.is_owner }, classes, price: PRICE, trialDays: TRIAL_DAYS });
});
route('GET', '/api/config', (req, res) => send(res, 200, { price: PRICE, trialDays: TRIAL_DAYS }));
route('POST', '/api/auth/register', async (req, res, b) => {
  if (process.env.SIGNUP !== 'open') bad('Регистрация пока закрыта');
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
  setSetting(cid, 'class', { treasurer: u.name || '', payHint: '', listCode: String(crypto.randomInt(1000, 10000)) });
  setSetting(cid, 'info', DEFAULT_INFO);
  String(b.students || '').split('\n').map(parseStudent).filter(Boolean).slice(0, 60).forEach((st, i) => insStudent(cid, st, i));
  send(res, 200, { ok: true, slug });
}, { auth: true });

// --- Публичная страница класса ---
route('GET', '/public', (req, res, b, p, u, c) => send(res, 200, classState(c, false)), { cls: true });
// Полный список класса для родителей - только по коду класса
route('POST', '/roster', (req, res, b, p, u, c) => {
  rate(req, 'roster', 20, 600e3);
  const code = getSetting(c.id, 'class', {}).listCode || '';
  if (code && str(b.code, 40).toLowerCase() !== code.toLowerCase()) bad('Неверный код. Спросите его у казначея в чате класса.');
  send(res, 200, { students: q('SELECT name, full_name, birth, parent, phone FROM students WHERE class_id=? AND active=1 ORDER BY sort, name').all(c.id) });
}, { cls: true });
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
  pushClass(c.id, { title: `💰 ${s.name} - ${amount.toLocaleString('ru-RU')} ₽`, body: k.title + (str(b.payer, 120) ? ' · платил(а): ' + str(b.payer, 120) : '') + (shot ? ' · есть скриншот' : ''),
    ts: Date.now(), url: '/c/' + c.slug + '/admin#проверить' }).catch(() => {});
}, { cls: true });

// --- Кабинет казначея (только хозяин класса или владелец сервиса) ---
const A = { cls: true, admin: true };
const W = { cls: true, admin: true, write: true }; // запись: только при действующей подписке

// --- Уведомления на телефон казначею (Web Push, без сторонних библиотек) ---
db.exec(`CREATE TABLE IF NOT EXISTS push_subs (id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
const b64u = buf => Buffer.from(buf).toString('base64url');
const VAPID = (() => {
  let jwk = getSettingRaw('vapid_jwk');
  if (!jwk) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    jwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
    q('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('vapid_jwk', jwk);
  }
  const j = JSON.parse(jwk);
  return { key: crypto.createPrivateKey({ key: j, format: 'jwk' }),
    pub: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')])) };
})();
function vapidAuth(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://www.kassa-klassa.ru' }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: VAPID.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${VAPID.pub}`;
}
function encryptPush(sub, text) { // RFC 8291, aes128gcm
  const ua = Buffer.from(sub.p256dh, 'base64url'), auth = Buffer.from(sub.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const as = ecdh.getPublicKey(), shared = ecdh.computeSecret(ua), salt = crypto.randomBytes(16);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const ci = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([ci.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), ci.final(), ci.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([as.length]), as, enc]);
}
async function pushClass(classId, data) {
  const subs = q('SELECT * FROM push_subs WHERE class_id=?').all(classId);
  await Promise.all(subs.map(async sub => {
    try {
      const r = await fetch(sub.endpoint, { method: 'POST', body: encryptPush(sub, JSON.stringify(data)),
        headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high', Authorization: vapidAuth(sub.endpoint) } });
      if (r.status === 404 || r.status === 410) q('DELETE FROM push_subs WHERE id=?').run(sub.id);
      else if (!r.ok) console.warn('push', r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.warn('push error', e.message); }
  }));
}
route('GET', '/admin/push', (req, res, b, p, u, c) => send(res, 200, { key: VAPID.pub, count: q('SELECT COUNT(*) n FROM push_subs WHERE class_id=?').get(c.id).n }), A);
route('POST', '/admin/push', (req, res, b, p, u, c) => {
  const ep = str(b.endpoint, 1000), k = b.keys || {};
  if (!/^https:\/\//.test(ep) || !k.p256dh || !k.auth) bad('Неверная подписка');
  q('INSERT INTO push_subs(class_id, endpoint, p256dh, auth) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET class_id=excluded.class_id, p256dh=excluded.p256dh, auth=excluded.auth')
    .run(c.id, ep, str(k.p256dh, 200), str(k.auth, 100));
  if (b.test) pushClass(c.id, { title: '🔔 Уведомления включены', body: 'Так будут приходить отметки родителей об оплате.', url: '/c/' + c.slug + '/admin#проверить' });
  send(res, 200, { ok: true });
}, A);
route('POST', '/admin/push/off', (req, res, b, p, u, c) => { q('DELETE FROM push_subs WHERE endpoint=? AND class_id=?').run(str(b.endpoint, 1000), c.id); send(res, 200, { ok: true }); }, A);
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
  return [title, str(b.description, 2000), amount, isDate(b.due_date) ? b.due_date : null, okLinks(b.pay_link)];
};
route('POST', '/admin/collections', (req, res, b, p, u, c) => {
  const r = q('INSERT INTO collections(title, description, amount, due_date, pay_link, separate, flex, skip, class_id) VALUES(?,?,?,?,?,?,?,?,?)').run(...collectionFields(b), b.separate ? 1 : 0, b.flex ? 1 : 0, skipList(b.skip), c.id);
  if (b.qr) q('UPDATE collections SET qr=? WHERE id=?').run(saveImage(b.qr, 'qr'), r.lastInsertRowid);
  send(res, 200, { ok: true });
}, W);
route('PUT', '/admin/collections/:id', (req, res, b, p, u, c) => {
  q('UPDATE collections SET title=?, description=?, amount=?, due_date=?, pay_link=?, closed=?, separate=?, flex=?, skip=? WHERE id=? AND class_id=?')
    .run(...collectionFields(b), b.closed ? 1 : 0, b.separate ? 1 : 0, b.flex ? 1 : 0, skipList(b.skip), int(p.id), c.id);
  if (b.qr || b.qr_remove) {
    const old = q('SELECT qr FROM collections WHERE id=? AND class_id=?').get(int(p.id), c.id);
    if (old) { rmFile(old.qr); q('UPDATE collections SET qr=? WHERE id=?').run(b.qr ? saveImage(b.qr, 'qr') : '', int(p.id)); }
  }
  send(res, 200, { ok: true });
}, W);
route('DELETE', '/admin/collections/:id', (req, res, b, p, u, c) => {
  for (const r of q('SELECT screenshot FROM payments WHERE collection_id=? AND class_id=?').all(int(p.id), c.id)) rmFile(r.screenshot);
  rmFile(q('SELECT qr FROM collections WHERE id=? AND class_id=?').get(int(p.id), c.id)?.qr);
  q('DELETE FROM collections WHERE id=? AND class_id=?').run(int(p.id), c.id);
  send(res, 200, { ok: true });
}, W);

route('POST', '/admin/payments', (req, res, b, p, u, c) => {
  const k = q('SELECT id, amount FROM collections WHERE id=? AND class_id=?').get(int(b.collection_id), c.id);
  const s = q('SELECT id FROM students WHERE id=? AND class_id=?').get(int(b.student_id), c.id);
  if (!k || !s) bad('Не найден сбор или ребёнок');
  const amount = b.amount === undefined || b.amount === '' ? k.amount : int(b.amount);
  if (!(amount > 0)) bad('Укажите сумму');
  const shot = b.image ? saveImage(b.image, 'pay') : null;
  const pend = q("SELECT id, screenshot FROM payments WHERE collection_id=? AND student_id=? AND status='pending'").get(k.id, s.id);
  if (pend) {
    if (shot) rmFile(pend.screenshot);
    q("UPDATE payments SET status='confirmed', amount=?, screenshot=COALESCE(?, screenshot), decided_at=datetime('now') WHERE id=?").run(amount, shot, pend.id);
  } else q("INSERT INTO payments(class_id, collection_id, student_id, amount, status, source, note, screenshot, decided_at) VALUES(?,?,?,?,'confirmed','treasurer',?,?,datetime('now'))")
    .run(c.id, k.id, s.id, amount, str(b.note, 300), shot);
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
    bells: arr(b.bells, 12).map((x, i) => ({ n: i + 1, from: str(x.from, 5), to: str(x.to, 5), after: str(x.after, 60) })).filter(x => x.from || x.to),
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
  const prevCls = getSetting(c.id, 'class', {});
  setSetting(c.id, 'class', { treasurer: str(b.treasurer, 100), payHint: str(b.payHint, 1000), showBirthdays: !!b.showBirthdays,
    listCode: b.listCode !== undefined ? str(b.listCode, 20) : prevCls.listCode || '' });
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

// --- Ежедневная копия на Яндекс.Диск: REST API по OAuth-токену (основной путь) или WebDAV по паролю приложения ---
const YD = process.env.YADISK_URL || 'https://webdav.yandex.ru';
const YAPI = process.env.YADISK_API || 'https://cloud-api.yandex.net/v1/disk';
const localDay = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); // по Новосибирску
const ydFail = (what, st) => {
  if (st === 401 || st === 403) return new Error('Яндекс не принял токен или пароль - получите новый');
  if (st === 507) return new Error('На Яндекс.Диске закончилось место');
  if (st === 423) return new Error('Яндекс заблокировал запись (423). Подключите Диск по токену - инструкция в кабинете');
  if (st === 429) return new Error('Яндекс просит подождать (429), попробуйте через пару минут');
  return new Error(what + ' (' + st + ')');
};
function ydDriver(cfg) {
  if (cfg.token) {
    const H = { Authorization: 'OAuth ' + cfg.token };
    const call = (method, p, qs = '') => fetch(`${YAPI}/resources${p}?path=${encodeURIComponent('disk:' + qs)}`, { method, headers: H });
    return {
      mkdir: async d => { const r = await fetch(`${YAPI}/resources?path=${encodeURIComponent('disk:' + d)}`, { method: 'PUT', headers: H }); if (![201, 409].includes(r.status)) throw ydFail('Не удалось создать папку на Диске', r.status); },
      put: async (p, data) => {
        const r = await fetch(`${YAPI}/resources/upload?overwrite=true&path=${encodeURIComponent('disk:' + p)}`, { headers: H });
        if (!r.ok) throw ydFail('Не удалось загрузить файл', r.status);
        const up = await fetch((await r.json()).href, { method: 'PUT', body: data });
        if (!up.ok) throw ydFail('Не удалось загрузить файл', up.status);
      },
      list: async d => {
        const r = await fetch(`${YAPI}/resources?limit=10000&fields=_embedded.items.name&path=${encodeURIComponent('disk:' + d)}`, { headers: H });
        if (!r.ok) throw ydFail('Не удалось прочитать папку', r.status);
        return ((await r.json())._embedded?.items || []).map(i => i.name);
      },
    };
  }
  const req = (method, p, body, headers = {}) => fetch(YD + p.split('/').map(encodeURIComponent).join('/'), { method, body,
    headers: { Authorization: 'Basic ' + Buffer.from(cfg.login + ':' + cfg.pass).toString('base64'), ...headers } });
  return {
    mkdir: async d => { const r = await req('MKCOL', d + '/'); if (![201, 405, 409].includes(r.status)) throw ydFail('Не удалось создать папку на Диске', r.status); },
    put: async (p, data) => { const r = await req('PUT', p, data, { 'Content-Type': 'application/octet-stream' }); if (!r.ok) throw ydFail('Не удалось загрузить файл', r.status); },
    list: async d => { const r = await req('PROPFIND', d + '/', null, { Depth: '1' }); if (r.status >= 400) throw ydFail('Не удалось прочитать папку', r.status);
      return [...(await r.text()).matchAll(/<d:displayname>([^<]*)<\/d:displayname>/gi)].map(m => m[1]); },
  };
}
const ydOn = cfg => !!(cfg && (cfg.token || (cfg.login && cfg.pass)));
async function backupClass(c) {
  const cfg = getSetting(c.id, 'yadisk', null);
  if (!ydOn(cfg)) throw new Error('Яндекс.Диск не подключён');
  const yd = ydDriver(cfg);
  const root = '/Касса класса', dir = `${root}/${c.slug}`, fdir = `${dir}/файлы`;
  for (const d of [root, dir, fdir]) await yd.mkdir(d);
  const day = localDay();
  await yd.put(`${dir}/kassa-${c.slug}-${day}.json`, JSON.stringify(classState(c, true), null, 1));
  // чеки, скриншоты оплат и QR - докачиваем только новые
  const files = new Set([
    ...q('SELECT screenshot f FROM payments WHERE class_id=? AND screenshot IS NOT NULL').all(c.id).map(r => r.f),
    ...q('SELECT r.file f FROM receipts r JOIN expenses e ON e.id=r.expense_id WHERE e.class_id=?').all(c.id).map(r => r.f),
    ...q("SELECT qr f FROM collections WHERE class_id=? AND qr != ''").all(c.id).map(r => r.f),
  ].filter(Boolean).map(f => path.basename(f)));
  const have = new Set(await yd.list(fdir));
  let added = 0;
  for (const f of files) {
    if (have.has(f)) continue;
    const fp = path.join(UPLOAD_DIR, f);
    if (!fs.existsSync(fp)) continue;
    await yd.put(`${fdir}/${f}`, fs.readFileSync(fp)); added++;
  }
  setSetting(c.id, 'yadisk', { ...cfg, last: new Date().toISOString(), lastDay: day, error: '' });
  return { day, added, files: files.size };
}
async function backupAll() {
  if (new Date(Date.now() + 7 * 3600e3).getUTCHours() < 3) return; // после 3 ночи
  for (const c of q("SELECT c.* FROM classes c JOIN class_settings s ON s.class_id=c.id AND s.key='yadisk'").all()) {
    const cfg = getSetting(c.id, 'yadisk', {});
    if (!ydOn(cfg) || cfg.lastDay === localDay()) continue;
    try { await backupClass(c); } catch (e) { setSetting(c.id, 'yadisk', { ...cfg, error: e.message, lastDay: localDay() }); console.error('backup', c.slug, e.message); }
  }
}
if (require.main === module) { setInterval(() => backupAll().catch(() => {}), 3600e3); setTimeout(() => backupAll().catch(() => {}), 60e3); }
const ydPublic = c => { const y = getSetting(c.id, 'yadisk', {}); return { login: y.login || '', connected: ydOn(y), last: y.last || '', error: y.error || '' }; };
route('GET', '/admin/yadisk', (req, res, b, p, u, c) => send(res, 200, ydPublic(c)), A);
route('POST', '/admin/yadisk', async (req, res, b, p, u, c) => {
  if (b.off) { q("DELETE FROM class_settings WHERE class_id=? AND key='yadisk'").run(c.id); return send(res, 200, ydPublic(c)); }
  const prev = getSetting(c.id, 'yadisk', {});
  let cfg = prev;
  if (!b.resend) {
    // токен можно вставить целиком, вместе с адресом страницы (…#access_token=…)
    const token = (str(b.token, 2000).match(/access_token=([^&\s]+)/)?.[1] || str(b.token, 2000)).replace(/\s/g, '');
    if (token) {
      const r = await fetch(YAPI + '/', { headers: { Authorization: 'OAuth ' + token } }).catch(() => null);
      if (!r || !r.ok) bad(r ? ydFail('Яндекс не принял токен', r.status).message : 'Не удалось связаться с Яндексом');
      const d = await r.json();
      cfg = { token, login: d.user?.login || d.user?.display_name || 'Яндекс.Диск', last: prev.last || '' };
    } else {
      const login = str(b.login, 100).replace(/@(yandex|ya)\.(ru|com)$/i, ''), pass = str(b.pass, 100).replace(/\s/g, '');
      if (!login || !pass) bad('Вставьте токен');
      cfg = { login, pass, last: prev.last || '' };
    }
  }
  setSetting(c.id, 'yadisk', cfg);
  try { const r = await backupClass(c); send(res, 200, { ...ydPublic(c), result: r }); }
  catch (e) {
    if (ydOn(prev)) setSetting(c.id, 'yadisk', { ...prev, error: e.message }); else q("DELETE FROM class_settings WHERE class_id=? AND key='yadisk'").run(c.id);
    bad(e.message);
  }
}, A);

// --- Учебники: PDF -> страницы-картинки (pdftoppm), читаются прямо на сайте ---
db.exec(`CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL, pages INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'processing', error TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
const { spawn } = require('node:child_process');
const bookQueue = [];
let bookBusy = false;
function convertNext() {
  if (bookBusy || !bookQueue.length) return;
  bookBusy = true;
  const id = bookQueue.shift(), dir = path.join(BOOK_DIR, String(id)), pdf = path.join(dir, 'src.pdf');
  const done = (err) => {
    try {
      if (err) throw err;
      const files = fs.readdirSync(dir).filter(f => /^p-\d+\.jpg$/.test(f)).sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));
      if (!files.length) throw new Error('Не удалось прочитать PDF');
      files.forEach((f, i) => fs.renameSync(path.join(dir, f), path.join(dir, (i + 1) + '.jpg')));
      q("UPDATE books SET status='ready', pages=?, error='' WHERE id=?").run(files.length, id);
    } catch (e) { q("UPDATE books SET status='error', error=? WHERE id=?").run(String(e.message || e).slice(0, 200), id); }
    fs.rm(pdf, { force: true }, () => {});
    bookBusy = false; convertNext();
  };
  if (!fs.existsSync(pdf)) return done(new Error('Файл не найден'));
  const pr = spawn('pdftoppm', ['-jpeg', '-jpegopt', 'quality=55,progressive=y', '-scale-to', '1300', pdf, path.join(dir, 'p')], { stdio: 'ignore' });
  pr.on('error', () => done(new Error('На сервере нет pdftoppm')));
  pr.on('close', code => done(code ? new Error('PDF не открылся (код ' + code + ')') : null));
}
// при перезапуске доделываем начатое
for (const b of q("SELECT id FROM books WHERE status='processing'").all()) bookQueue.push(b.id);
setTimeout(convertNext, 3000);
route('POST', '/admin/books', async (req, res, b, p, u, c) => {
  const title = str(new URL(req.url, 'http://x').searchParams.get('title'), 120) || 'Учебник';
  const id = q("INSERT INTO books(class_id, title, sort) VALUES(?,?, (SELECT COALESCE(MAX(sort),0)+1 FROM books WHERE class_id=?))").run(c.id, title, c.id).lastInsertRowid;
  const dir = path.join(BOOK_DIR, String(id)); fs.mkdirSync(dir, { recursive: true });
  const pdf = path.join(dir, 'src.pdf');
  try {
    await new Promise((resolve, reject) => {
      let size = 0, head = null;
      const out = fs.createWriteStream(pdf);
      req.on('data', ch => {
        if (!head) head = ch.subarray(0, 5).toString();
        size += ch.length;
        if (size > 400 * 1024 * 1024) { reject(new HttpError(413, 'Файл больше 400 МБ')); req.destroy(); out.destroy(); }
      });
      req.pipe(out);
      out.on('finish', () => head === '%PDF-' ? resolve() : reject(new HttpError(400, 'Это не PDF-файл')));
      out.on('error', reject); req.on('error', reject);
    });
  } catch (e) { q('DELETE FROM books WHERE id=?').run(id); fs.rm(dir, { recursive: true, force: true }, () => {}); throw e; }
  bookQueue.push(id); convertNext();
  send(res, 200, { ok: true, id });
}, { ...W, raw: true });
route('PUT', '/admin/books-order', (req, res, b, p, u, c) => {
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 500);
  ids.forEach((id, i) => q('UPDATE books SET sort=? WHERE id=? AND class_id=?').run(i + 1, id, c.id));
  send(res, 200, { ok: true });
}, W);
route('PUT', '/admin/books/:id', (req, res, b, p, u, c) => {
  q('UPDATE books SET title=? WHERE id=? AND class_id=?').run(str(b.title, 120) || 'Учебник', int(p.id), c.id);
  send(res, 200, { ok: true });
}, W);
route('DELETE', '/admin/books/:id', (req, res, b, p, u, c) => {
  const r = q('DELETE FROM books WHERE id=? AND class_id=?').run(int(p.id), c.id);
  if (r.changes) fs.rm(path.join(BOOK_DIR, String(int(p.id))), { recursive: true, force: true }, () => {});
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
    icons: [{ src: '/icon-192.png?v=2', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
  }));
}
const SIGNUP_OPEN = process.env.SIGNUP === 'open'; // пока сервис закрыт: без регистрации и рекламы на главной
const PAGES = { '/': SIGNUP_OPEN ? 'landing.html' : 'soon.html', '/account': 'account.html', '/owner': 'owner.html', '/oferta': 'oferta.html', '/privacy': 'privacy.html' };


// --- Закрываем сайт от поисковиков, ИИ-ботов и скриптов ---
const BOT_UA = /bot\b|bot\/|crawl|spider|slurp|scrap|GPTBot|ChatGPT|OAI-SearchBot|Claude|anthropic|CCBot|Google-Extended|Googlebot|Gemini|PerplexityBot|Perplexity|Bytespider|Amazonbot|Applebot|YandexBot|YandexImages|YandexAdditional|bingbot|DuckDuck|Baiduspider|Sogou|Exabot|SemrushBot|AhrefsBot|MJ12bot|DotBot|PetalBot|Diffbot|Omgili|ImagesiftBot|cohere|YouBot|Timpibot|Meta-ExternalAgent|FacebookBot|DataForSeo|python-requests|python-urllib|aiohttp|httpx|scrapy|curl\/|wget|Go-http-client|okhttp|libwww|HeadlessChrome|PhantomJS|axios|node-fetch|java\//i;
// превью ссылок в мессенджерах оставляем (только заголовок страницы)
const PREVIEW_UA = /TelegramBot|WhatsApp|vkShare|MAX|OdklBot|Viber|Slackbot|Discordbot/i;
const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n\n' + ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-Web', 'Claude-User', 'anthropic-ai', 'CCBot', 'Google-Extended', 'Googlebot', 'PerplexityBot', 'Bytespider', 'Amazonbot', 'Applebot-Extended', 'YandexBot', 'YandexAdditional', 'Bingbot', 'Meta-ExternalAgent', 'cohere-ai']
  .map(b => `User-agent: ${b}\nDisallow: /\n`).join('\n');
const hitMap = new Map();
setInterval(() => hitMap.clear(), 60e3).unref?.();
function guard(req, res) {
  const ua = String(req.headers['user-agent'] || '');
  if (!ua.trim() || (BOT_UA.test(ua) && !PREVIEW_UA.test(ua))) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Доступ закрыт'); return false; }
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const n = (hitMap.get(ip) || 0) + 1; hitMap.set(ip, n);
  if (n > 600) { res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' }); res.end('Слишком много запросов, подождите минуту'); return false; }
  return true;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return fail(res, 400, 'Неверный адрес'); }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate, noai, noimageai');
  if (p === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(ROBOTS_TXT); }
  if (!guard(req, res)) return;
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
        const body = r.raw || req.method === 'GET' || req.method === 'DELETE' && !+req.headers['content-length'] ? {} : await readBody(req);
        return await r.handler(req, res, body, params, u, c);
      }
      return fail(res, 404, 'Не найдено');
    }
    if (p.startsWith('/uploads/') && (p.includes('/chek-') || p.includes('/qr-'))) return serveFile(res, path.join(UPLOAD_DIR, path.basename(p)), 'public, max-age=31536000, immutable');
    const bm = /^\/b\/(\d+)\/(\d+)\.jpg$/.exec(p);
    if (bm) { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); return serveFile(res, path.join(BOOK_DIR, bm[1], bm[2] + '.jpg'), 'public, max-age=31536000, immutable'); }
    if (PAGES[p]) return serveFile(res, path.join(PUBLIC_DIR, PAGES[p]));
    if (p === '/manifest.webmanifest') return sendManifest(res, { name: 'Касса класса', short: 'Касса класса', start: '/account' });
    const mm = /^\/c\/([a-z0-9-]+)\/manifest\.webmanifest$/.exec(p);
    if (mm) {
      const c = q('SELECT slug, title FROM classes WHERE slug=?').get(mm[1]); if (!c) return fail(res, 404, 'Не найдено');
      const admin = url.searchParams.get('admin') === '1', teacher = url.searchParams.get('t') === '1';
      if (teacher) return sendManifest(res, { name: 'Учитель: ' + c.title, short: c.title, start: `/c/${c.slug}/uchitel`, id: `/c/${c.slug}/uchitel` });
      return sendManifest(res, { name: (admin ? 'Казначей: ' : 'Касса: ') + c.title, short: admin ? 'Казначей' : 'Касса класса', start: `/c/${c.slug}${admin ? '/admin' : ''}`, id: `/c/${c.slug}${admin ? '/admin' : ''}` });
    }
    const cm = /^\/c\/([a-z0-9-]+)(\/admin|\/uchitel)?\/?$/.exec(p);
    if (cm) {
      const c = q('SELECT slug, title FROM classes WHERE slug=?').get(cm[1]);
      if (!c) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><p style="font:18px system-ui;padding:24px">Класс не найден. Проверьте ссылку.</p><p style="font:16px system-ui;padding:0 24px"><a href="/">На главную</a></p>'); }
      const isAdm = cm[2] === '/admin', isT = cm[2] === '/uchitel';
      const html = fs.readFileSync(path.join(PUBLIC_DIR, isAdm ? 'admin.html' : 'index.html'), 'utf8')
        .replace('<!--HEAD-->', `<link rel="manifest" href="/c/${c.slug}/manifest.webmanifest${isAdm ? '?admin=1' : isT ? '?t=1' : ''}">`)
        .replace(/<title>[^<]*<\/title>/, `<title>${esc(isAdm ? 'Казначей · ' + c.title : c.title)}</title>`);
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
