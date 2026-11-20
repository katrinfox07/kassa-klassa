'use strict';
// Общие помощники для обеих страниц
const $ = (s, el = document) => el.querySelector(s);

// Страницы класса живут по адресу /c/<адрес-класса>/; запросы класса уходят на /api/c/<адрес>/...
const SLUG = (/^\/c\/([a-z0-9-]+)/.exec(location.pathname) || [])[1] || null;
const GLOBAL_API = /^\/api\/(auth|me|config|classes|owner)(\/|$)/;
const apiUrl = url => (SLUG && url.startsWith('/api/') && !GLOBAL_API.test(url)) ? '/api/c/' + SLUG + url.slice(4) : url;
const classUrl = (slug = SLUG) => location.origin + '/c/' + slug;

async function api(method, url, body) {
  const r = await fetch(apiUrl(url), {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(data.error || 'Ошибка связи'), { status: r.status });
  return data;
}

// h('div.card', {onclick}, child, 'text', [children])
function h(tag, attrs, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = k => { if (k == null || k === false) return; if (Array.isArray(k)) k.forEach(add); else el.append(k instanceof Node ? k : document.createTextNode(String(k))); };
  kids.forEach(add);
  return el;
}

const rub = n => (Number(n) || 0).toLocaleString('ru-RU') + ' ₽';
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const fdate = d => { if (!d) return ''; const [y, m, day] = d.slice(0, 10).split('-').map(Number); const now = new Date().getFullYear(); return `${day} ${MONTHS[m - 1]}${y !== now ? ' ' + y : ''}`; };
const fdatetime = d => { if (!d) return ''; const t = new Date(d.replace(' ', 'T') + 'Z'); return t.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const daysLeft = d => Math.ceil((new Date(d + 'T23:59:59') - new Date()) / 86400000);

// Сжимаем фото на телефоне перед отправкой: длинная сторона до 1600px
function compressImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('Не удалось открыть картинку'));
    img.src = URL.createObjectURL(file);
  });
}

// Модальное окно (снизу на телефоне)
function modal(title, body, { wide } = {}) {
  const close = () => { back.remove(); document.body.classList.remove('noscroll'); };
  const back = h('div.modal-back', { onclick: e => { if (e.target === back) close(); } },
    h('div.modal' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true' },
      h('div.modal-head', h('h2', title), h('button.icon-btn', { 'aria-label': 'Закрыть', onclick: close }, '✕')),
      h('div.modal-body', body)));
  document.body.append(back);
  document.body.classList.add('noscroll');
  return close;
}

function toast(msg, bad) {
  const t = h('div.toast' + (bad ? '.bad' : ''), msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

function viewImage(src) {
  modal('Чек', h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img.full-img', { src, alt: 'Фото чека' })), { wide: true });
}

// Вкладки с запоминанием в адресной строке (#сборы)
function tabs(el, list, onChange) {
  const bar = h('nav.tabs', { role: 'tablist' });
  const pick = id => {
    [...bar.children].forEach(b => b.setAttribute('aria-selected', b.dataset.id === id));
    history.replaceState(null, '', '#' + id);
    onChange(id);
  };
  list.forEach(t => bar.append(h('button.tab', { role: 'tab', 'data-id': t.id, onclick: () => pick(t.id) }, t.label, t.badge ? h('span.badge', t.badge) : null)));
  el.replaceChildren(bar);
  const cur = decodeURIComponent(location.hash.slice(1));
  pick(list.some(t => t.id === cur) ? cur : list[0].id);
}

// участвует ли ребёнок в сборе (администратор может снять галочку)
const inColl = (c, s) => !(c.skip || []).includes(s.id);
function statusOf(st, collection, studentId) {
  const ps = st.payments.filter(p => p.collection_id === collection.id && p.student_id === studentId);
  const conf = ps.filter(p => p.status === 'confirmed');
  if (conf.length) {
    const amount = conf.reduce((a, p) => a + p.amount, 0);
    if (collection.amount && amount < collection.amount) return { s: 'partial', amount, debt: collection.amount - amount, pending: ps.some(p => p.status === 'pending'), list: ps };
    return { s: 'paid', amount, list: ps };
  }
  if (ps.some(p => p.status === 'pending')) return { s: 'pending', list: ps };
  return { s: 'none', list: ps };
}

function progress(c) {
  const pct = c.expected ? Math.min(100, Math.round(c.collected / c.expected * 100)) : 0;
  return h('div.progress', { title: pct + '%' }, h('div', { style: `width:${pct}%` }));
}

// Информационный раздел: одинаковый вид для родителей и предпросмотра у администратора
function renderInfo(info) {
  const wrap = h('div.stack');
  if (info.announcements?.length) wrap.append(h('section.card', h('h3', 'Объявления'),
    info.announcements.map(a => h('div.announce', a.date ? h('div.muted.small', fdate(a.date)) : null, h('p.pre', a.text)))));
  if (info.bells?.length || info.timetable?.length) wrap.append(scheduleCard(info));
  if (info.holidays?.length) {
    const t0 = new Date(new Date().toDateString());
    const D = x => new Date(x + 'T00:00:00');
    const days = n => n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'день' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дня' : 'дней');
    const next = info.holidays.filter(x => x.from && D(x.to || x.from) >= t0).sort((a, b) => a.from.localeCompare(b.from))[0];
    wrap.append(h('section.card', h('h3', '🌴 Каникулы'),
      next ? (D(next.from) <= t0 ? h('div.hol-now', '🎉 Сейчас идут: ', h('b', next.title), ', до ' + fdate(next.to))
        : h('div.hol-now', h('b', next.title), ' через ', h('b', days(Math.round((D(next.from) - t0) / 864e5))))) : null,
      h('div.hols', info.holidays.map(x => {
        const past = D(x.to || x.from) < t0, cur = x === next;
        return h('div.hol' + (past ? '.past' : '') + (cur ? '.next' : ''), h('b', x.title),
          h('span', (x.from ? fdate(x.from) : '') + (x.to && x.to !== x.from ? ' - ' + fdate(x.to) : '')),
          x.from && x.to ? h('span.muted.small', days(Math.round((D(x.to) - D(x.from)) / 864e5) + 1)) : null);
      }))));
  }
  if (info.teachers?.length) {
    const isHead = t => /классн\S*\s+рук/i.test(t.role || '');
    const head = info.teachers.find(isHead), rest = info.teachers.filter(t => t !== head);
    const subj = t => (t.role || '').replace(/[;,]?\s*классн\S*\s+руководитель/i, '').trim();
    wrap.append(h('section.card', h('h3', 'Учителя'),
      head ? h('div.headteacher', h('div', h('div.ht-label', 'Классный руководитель'), h('div.ht-name', head.name),
        subj(head) ? h('div.muted.small', subj(head)) : null, head.contact ? h('div.small', linkify(head.contact)) : null)) : null,
      h('ul.plain.teachers', rest.map(t => h('li', h('div.muted.small', t.role), h('div', t.name), t.contact ? h('div.small', linkify(t.contact)) : null)))));
  }
  if (info.links?.length) wrap.append(h('section.card', h('h3', 'Полезные ссылки'),
    h('ul.plain', info.links.map(l => h('li', h('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.title))))));
  if (!wrap.children.length) wrap.append(h('p.empty', 'Информация пока не добавлена.'));
  return wrap;
}
function scheduleCard(info) {
  const bells = info.bells || [], days = (info.timetable || []).filter(d => d.day);
  const toM = t => { const [a, b] = (t || '').split(':').map(Number); return a * 60 + b; };
  const dayNames = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const isDay = (d, n) => d.day.trim().toLowerCase() === n;
  let cur = Math.max(0, days.findIndex(d => isDay(d, dayNames[new Date().getDay()])));
  const short = d => ({ 'понедельник': 'Пн', 'вторник': 'Вт', 'среда': 'Ср', 'четверг': 'Чт', 'пятница': 'Пт', 'суббота': 'Сб', 'воскресенье': 'Вс' })[d.trim().toLowerCase()] || d.slice(0, 2);
  const left = m => m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
  const chips = h('div.daychips'), todayEl = h('div.sched-today'), sum = h('div.sched-sum'), list = h('div.lessons');
  const draw = anim => {
    const now = new Date(), mins = now.getHours() * 60 + now.getMinutes(), todayName = dayNames[now.getDay()];
    todayEl.replaceChildren('Сегодня, ', h('b', now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })));
    chips.replaceChildren(...days.map((d, i) => h('button.daychip' + (i === cur ? '.on' : '') + (isDay(d, todayName) ? '.today' : ''),
      { type: 'button', onclick: () => { if (cur !== i) { cur = i; draw(true); } } }, short(d.day))));
    const isToday = days[cur] && isDay(days[cur], todayName);
    const lessons = days.length ? days[cur].lessons.split('\n').map(x => x.trim()) : [];
    while (lessons.length && !lessons[lessons.length - 1]) lessons.pop();
    const n = days.length ? lessons.length : bells.length;
    const todayOn = days.length ? isToday : now.getDay() % 6;
    const isEmpty = i => days.length && (!lessons[i] || /^[-\u2013\u2014]+$/.test(lessons[i]));
    let first = 0; while (first < n && isEmpty(first)) first++;
    const real = [...Array(n).keys()].filter(i => !isEmpty(i));
    const rows = [];
    let k = 0; const st = () => ({ style: `--i:${k++}` });
    for (let i = 0; i < n; i++) {
      const b = bells[i] || {}, subj = days.length ? lessons[i] : '', empty = isEmpty(i);
      const from = toM(b.from), to = toM(b.to);
      const live = todayOn && b.from && mins >= from && mins < to, past = todayOn && b.to && mins >= to;
      const pct = live ? Math.round((mins - from) / (to - from) * 100) : 0;
      rows.push(h('div.lesson' + (empty ? '.empty' : '') + (live ? '.live' : '') + (past && !empty ? '.past' : ''), st(),
        h('span.ln', past ? '✓' : i + 1),
        h('span.lt', b.from ? h('b', b.from) : '', b.to ? h('small', b.to) : ''),
        h('span.ls', days.length ? (empty ? (i < first ? 'нет урока' : 'окно') : subj) : ''),
        live ? h('span.lleft', h('i.pdot'), 'ещё ' + left(to - mins)) : h('span'),
        live ? h('div.lbar', h('div', { style: `width:${pct}%` })) : null));
      const nb = bells[i + 1];
      if (i < n - 1 && b.to && nb?.from) {
        const len = toM(nb.from) - toM(b.to);
        const bl = todayOn && mins >= toM(b.to) && mins < toM(nb.from);
        if (len > 0) rows.push(h('div.brk' + (bl ? '.live' : '') + (b.after ? '.food' : ''), st(), h('span.brk-line'),
          h('span.brk-t', b.after ? '🍽 ' : '', `перемена ${len} мин`, b.after ? h('b', ' · ' + b.after) : null),
          bl ? h('span.brk-now', 'ещё ' + left(toM(nb.from) - mins)) : null));
      }
    }
    if (days.length && real.length) {
      const fb = bells[real[0]] || {}, lb = bells[real[real.length - 1]] || {};
      const endM = toM(lb.to);
      sum.replaceChildren(...[
        h('span', `${real.length} ${real.length === 1 ? 'урок' : real.length < 5 ? 'урока' : 'уроков'}`),
        fb.from ? h('span', `${fb.from}-${lb.to || ''}`) : null,
        first > 0 ? h('span.sched-late', `с ${first + 1}-го урока`) : null,
        isToday && endM && mins >= endM ? h('span.sched-done', 'уроки закончились') : null].filter(Boolean));
    } else sum.replaceChildren(days.length ? h('span', 'уроков нет') : '');
    list.replaceChildren(...rows);
    list.classList.toggle('anim', !!anim);
  };
  draw(true);
  setInterval(() => { if (list.isConnected) draw(false); }, 30e3);
  return h('section.card.sched', h('h3', '📅 Расписание из электронного журнала'), h('p.sched-warn', 'Необходимо сверять с ежедневным расписанием из школьного канала MAX'), todayEl, days.length ? chips : null, sum, list);
}
function linkify(s) {
  if (/^\+?[\d\s()-]{7,}$/.test(s)) return h('a', { href: 'tel:' + s.replace(/[^\d+]/g, '') }, s);
  if (/^\S+@\S+\.\S+$/.test(s)) return h('a', { href: 'mailto:' + s }, s);
  return s;
}

// ---------- Приложение на телефоне (PWA) ----------
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; document.querySelectorAll('.install-btn').forEach(b => b.hidden = false); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
function installButton() {
  if (isStandalone()) return null;
  const b = h('button.btn.small.install-btn', {
    hidden: false,
    onclick: async () => {
      if (installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; b.hidden = true; return; }
      const step = (...x) => h('div.step', h('div', ...x));
      const ua = navigator.userAgent;
      const steps = isIOS()
        ? [step('Нажмите кнопку ', h('b', '«Поделиться»'), ' в Safari (квадрат со стрелкой).'), step('Выберите ', h('b', '«На экран Домой»'), '.'), step('Нажмите ', h('b', '«Добавить»'), '.')]
        : /android/i.test(ua)
          ? [step('Откройте меню браузера ', h('b', '⋮'), ' (три точки справа вверху).'), step('Выберите ', h('b', '«Добавить на главный экран»'), ' или ', h('b', '«Установить приложение»'), '.'), step('Подтвердите. Иконка появится на экране телефона.')]
          : /edg\//i.test(ua)
            ? [step('Откройте меню браузера ', h('b', '⋯'), ' (справа вверху).'), step('Выберите ', h('b', '«Приложения» → «Установить этот сайт как приложение»'), '.'), step('Нажмите ', h('b', '«Установить»'), '.')]
            : [step('Нажмите значок установки в адресной строке или откройте меню браузера ', h('b', '⋮'), '.'), step('Выберите ', h('b', '«Установить приложение»'), '.')];
      modal('Установить приложение', h('div.steps', ...steps, h('p.hint', 'Удобнее всего установить на телефон: откройте эту страницу на телефоне.')));
    },
  }, '📲 Установить');
  return b;
}

// ---------- Анимация: цифры в итогах «набегают» при первом показе ----------
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let done = false;
  const run = el => {
    const target = Number(el.textContent.replace(/[^\d-]/g, '')) || 0, t0 = performance.now(), dur = 1100;
    const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = rub(Math.round(target * e)); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };
  const start = () => {
    const box = document.getElementById('totals'); if (!box) return;
    new MutationObserver((_, obs) => {
      const vals = box.querySelectorAll('.value'); if (!vals.length || done) return;
      done = true; obs.disconnect(); vals.forEach(run);
    }).observe(box, { childList: true });
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
})();

// Компактная строка расхода: миниатюра чека, название, дата, сумма
function expRow(e, coll, extra) {
  const r = e.receipts || [];
  return h('div.exprow',
    r.length ? h('button.expthumb', { onclick: () => r.length > 1 ? modal('Чеки: ' + e.title, h('div.stack', r.map(src => h('img.full-img', { src, alt: 'Чек' })))) : viewImage(r[0]), 'aria-label': 'Открыть чек' },
      h('img', { src: r[0], alt: 'Чек', loading: 'lazy' }), r.length > 1 ? h('span.expcount', r.length) : null)
      : h('div.expthumb.none', { title: 'Чек не приложен' }, '-'),
    h('div.expmain', h('div.exptitle', e.title), h('div.expmeta', fdate(e.date) + (coll ? ' · ' + coll : '') + (e.note ? ' · ' + e.note : ''))),
    h('div.expsum', rub(e.amount)), extra || null);
}

// ---------- Поле для фото: перетащите файлы или нажмите, с миниатюрами ----------
function enhanceFileInput(inp) {
  if (inp.dataset.dz) return; inp.dataset.dz = '1';
  const multi = inp.multiple, isPdf = /pdf/.test(inp.accept || '');
  const empty = isPdf ? 'Перетащите PDF сюда' : 'Перетащите фото сюда';
  const text = h('div.dz-text', h('b', empty), h('span', 'или нажмите, чтобы выбрать' + (!isPdf && (isIOS() || /android/i.test(navigator.userAgent)) ? ' / сфотографировать' : '')));
  const previews = h('div.dz-previews');
  const zone = h('div.dropzone', h('div.dz-icon', isPdf ? '📄' : '📷'), text, previews);
  inp.replaceWith(zone); zone.prepend(inp);
  const show = () => {
    if (isPdf) { previews.replaceChildren(); zone.classList.toggle('has', inp.files.length > 0); text.firstChild.textContent = inp.files[0] ? `${inp.files[0].name} (${Math.round(inp.files[0].size / 1048576)} МБ)` : empty; return; }
    previews.replaceChildren(...[...inp.files].map(f => { const u = URL.createObjectURL(f); return h('img', { src: u, alt: f.name, onload: () => URL.revokeObjectURL(u) }); }));
    zone.classList.toggle('has', inp.files.length > 0);
    text.firstChild.textContent = inp.files.length ? `Выбрано: ${inp.files.length}` : empty;
  };
  inp.addEventListener('change', show);
  ['dragenter', 'dragover'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', e => {
    const files = [...e.dataTransfer.files].filter(f => isPdf ? f.type === 'application/pdf' : f.type.startsWith('image/')); if (!files.length) return;
    const dt = new DataTransfer();
    if (multi) [...inp.files].forEach(f => dt.items.add(f));
    (multi ? files : files.slice(0, 1)).forEach(f => dt.items.add(f));
    inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
new MutationObserver(() => document.querySelectorAll('input[type=file]:not([data-dz])').forEach(enhanceFileInput))
  .observe(document.documentElement, { childList: true, subtree: true });
// не даём браузеру открыть файл, если промахнулись мимо поля
['dragover', 'drop'].forEach(t => window.addEventListener(t, e => { if (!e.target.closest?.('.dropzone')) e.preventDefault(); }));

// ---------- Банки сборов ----------
const BANKS = [
  { re: /(^|\.)(sberbank|sber|sbrf|sberbank-online)\.(ru|com)$/, name: 'Сбер', color: '#21A038', note: 'для клиентов Сбера' },
  { re: /(^|\.)vtb\.ru$/, name: 'ВТБ', color: '#0A2896' },
  { re: /(^|\.)(tbank|tinkoff|tb)\.ru$|(^|\.)tbank-online\.com$/, name: 'Т-Банк', color: '#FFDD2D', ink: '#222', note: 'для клиентов Т-Банка' },
  { re: /(^|\.)alfabank\.ru$|(^|\.)alfa\.me$/, name: 'Альфа-Банк', color: '#EF3124' },
  { re: /(^|\.)(ozon|ozonbank|finance\.ozon)\.ru$/, name: 'Озон Банк', color: '#005BFF', title: 'Перевод по СБП', note: 'из любого банка' },
  { re: /(^|\.)gazprombank\.ru$/, name: 'Газпромбанк', color: '#0F2D69' },
  { re: /(^|\.)yoomoney\.ru$/, name: 'ЮMoney', color: '#8B3FFD' },
];
function bankOf(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { }
  const b = BANKS.find(x => x.re.test(host));
  return b ? { ...b, url } : { name: host || 'Банк', color: '#6b7280', url };
}
function payLinks(c) { return String(c.pay_link || '').split(/\s+/).filter(Boolean).map(bankOf); }
function bankButton(b) {
  return h('a.bankbtn', { href: b.url, target: '_blank', rel: 'noopener', style: `--bk:${b.color};--bkink:${b.ink || '#fff'}` },
    h('span.bankic.inv', b.name.replace(/^Т-/, 'Т').slice(0, 1)),
    h('span.grow', h('b', b.title || 'Оплатить через ' + b.name), b.note ? h('span.small', b.note) : null), h('span.go', '↗'));
}
function bankIcon(b) {
  return h('span.bankic', { style: `background:${b.color};color:${b.ink || '#fff'}` }, b.name.replace(/^Т-/, 'Т').slice(0, 1));
}


// ---------- Календарь и дни рождения ----------
const pad2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function calEvents(st, admin) {
  const bdays = [];
  if (admin) st.students.filter(s => s.active).forEach(s => {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s.birth || ''); if (m) bdays.push({ name: s.name, md: `${m[2]}-${m[1]}`, year: +m[3], kid: true });
  });
  else (st.birthdays || []).forEach(b => bdays.push({ ...b, kid: true }));
  (st.info?.teachers || []).forEach(t => {
    const m = /^(\d{1,2})\.(\d{1,2})/.exec(t.birth || ''); if (m && t.name) bdays.push({ name: t.name, md: `${pad2(m[2])}-${pad2(m[1])}`, teacher: true, role: t.role });
  });
  return { bdays, holidays: st.info?.holidays || [], colls: (st.collections || []).filter(c => c.due_date && !c.closed) };
}
function upcomingBdays(ev, within = 3) {
  const t0 = new Date(new Date().toDateString()), out = [];
  for (let i = 0; i <= within; i++) {
    const d = new Date(t0); d.setDate(d.getDate() + i);
    const md = ymd(d).slice(5);
    ev.bdays.filter(b => b.md === md).forEach(b => out.push({ ...b, in: i, age: b.year ? d.getFullYear() - b.year : null }));
  }
  return out;
}
const inDays = n => n === 0 ? 'сегодня' : n === 1 ? 'завтра' : n === 2 ? 'послезавтра' : `через ${n} дня`;
function bdayBanner(ev) {
  const list = upcomingBdays(ev, 3); if (!list.length) return null;
  return h('section.card.bday-banner', h('span.bb-ic', '🎂'), h('div', list.map(b => h('div',
    h('b', inDays(b.in)[0].toUpperCase() + inDays(b.in).slice(1)), ' день рождения: ', h('b', b.name), b.teacher ? h('span.muted', ' (учитель)') : null,
    b.age ? h('span.muted', `, исполнится ${b.age}`) : null))));
}
function calendarCard(st, admin) {
  const ev = calEvents(st, admin);
  let cur = new Date(); cur = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const box = h('section.card.cal');
  const draw = () => {
    const y = cur.getFullYear(), m = cur.getMonth();
    const first = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
    const todayS = ymd(new Date());
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(h('div.cal-c.empty'));
    const items = [];
    for (let d = 1; d <= days; d++) {
      const ds = `${y}-${pad2(m + 1)}-${pad2(d)}`, md = ds.slice(5);
      const b = ev.bdays.filter(x => x.md === md);
      const hol = ev.holidays.find(x => x.from && ds >= x.from && ds <= (x.to || x.from));
      const due = ev.colls.filter(c => c.due_date === ds);
      const dow = (first + d - 1) % 7;
      cells.push(h('div.cal-c' + (ds === todayS ? '.today' : '') + (hol ? '.hol' : '') + (dow === 6 ? '.sun' : ''), { title: [hol?.title, ...b.map(x => 'ДР: ' + x.name), ...due.map(c => 'Сдать: ' + c.title)].filter(Boolean).join('\n') },
        h('span.cal-d', d), b.length ? h('span.cal-e', '🎂') : due.length ? h('span.cal-e', '💰') : null));
      b.forEach(x => items.push(h('li', h('span.cal-day', d), h('span', '🎂 ' + x.name, x.teacher ? h('span.muted', ' · учитель') : null))));
      due.forEach(c => items.push(h('li', h('span.cal-day', d), h('span', '💰 сдать «' + c.title + '»'))));
      if (hol && (ds === hol.from || d === 1)) items.push(h('li', h('span.cal-day', d), h('span', '🌴 ' + hol.title, hol.to ? h('span.muted', ' до ' + fdate(hol.to)) : null)));
    }
    box.replaceChildren(
      h('div.row.between.cal-head', h('button.icon-btn', { type: 'button', 'aria-label': 'Назад', onclick: () => { cur = new Date(y, m - 1, 1); draw(); } }, '‹'),
        h('h3', MONTHS_NOM[m] + ' ' + y), h('button.icon-btn', { type: 'button', 'aria-label': 'Вперёд', onclick: () => { cur = new Date(y, m + 1, 1); draw(); } }, '›')),
      h('div.cal-grid', ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(x => h('div.cal-w', x)), cells),
      items.length ? h('ul.plain.cal-list', items) : h('p.small.muted', 'В этом месяце событий нет.'));
  };
  draw();
  return box;
}
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

// родитель и его телефон рядом; если телефонов меньше, чем родителей, они относятся к последним в списке
function parentRows(s) {
  const names = (s.parent || '').split(',').map(x => x.trim()).filter(Boolean);
  const phones = (s.phone || '').split(',').map(x => x.trim()).filter(Boolean);
  const call = x => h('a.call', { href: 'tel:' + x.replace(/[^\d+]/g, ''), onclick: e => e.stopPropagation() }, '📞 ' + x);
  if (!names.length && !phones.length) return h('div.muted', 'родитель не указан');
  const n = Math.max(names.length, phones.length), off = names.length - phones.length;
  return h('div.parents', Array.from({ length: n }, (_, i) => {
    const ph = off >= 0 ? phones[i - off] : phones[i];
    return h('div.prow', h('span', names[i] || ''), ph ? call(ph) : null);
  }));
}

// ---------- Учебники: обложки и читалка ----------
function booksGrid(books, onOpen) {
  if (!books.length) return h('p.muted', 'Учебников пока нет.');
  return h('div.books', books.map(b => h('button.book', { type: 'button', 'data-id': b.id, onclick: () => (onOpen || openReader)(b) },
    b.status === 'ready' ? h('img', { src: `/b/${b.id}/1.jpg`, alt: '', loading: 'lazy' }) : h('div.book-ph', b.status === 'error' ? '⚠' : '⏳'),
    h('span.book-t', b.title), h('span.book-n', b.status === 'ready' ? b.pages + ' стр.' : b.status === 'error' ? 'ошибка' : 'обрабатывается…'))));
}
function openReader(b) {
  const N = b.pages, src = n => `/b/${b.id}/${n}.jpg`, key = 'book-page-' + b.id;
  let page = 1; try { page = Math.min(N, Math.max(1, +localStorage.getItem(key) || 1)); } catch {}
  let ar = 0.74, zoom = 1, busy = false;
  const isSpread = () => innerWidth >= 760 && innerWidth > innerHeight * 1.15;
  // в развороте: обложка одна справа, дальше пары 2-3, 4-5...
  const spreadOf = n => n <= 1 ? [0, 1] : (n % 2 === 0 ? [n, n + 1 <= N ? n + 1 : 0] : [n - 1, n]);
  const cache = new Map();
  const img = n => { if (!n || n > N) return null; if (!cache.has(n)) { const i = new Image(); i.src = src(n); i.alt = 'Страница ' + n; i.draggable = false; cache.set(n, i); } return cache.get(n); };
  const pg = n => { const d = h('div.fp-page'); const i = img(n); if (i) d.append(i.cloneNode()); else d.classList.add('blank'); return d; };
  const preload = () => { for (let d = -2; d <= 4; d++) img(page + d); };

  const cnt = h('input.rd-page', { type: 'number', min: 1, max: N, value: page, inputmode: 'numeric', 'aria-label': 'Страница' });
  const zl = h('span.rd-zl', '100%');
  const book = h('div.fp-book');
  const stage = h('div.fp-stage', book);
  const prevB = h('button.fp-nav.prev', { 'aria-label': 'Назад', onclick: () => flip(-1) }, '‹');
  const nextB = h('button.fp-nav.next', { 'aria-label': 'Вперёд', onclick: () => flip(1) }, '›');
  const view = h('div.fp-view', stage, prevB, nextB);

  const size = () => {
    const sp = isSpread(), vw = view.clientWidth - (sp ? 120 : 16), vh = view.clientHeight - 16;
    let ph = Math.min(vh, (sp ? vw / 2 : vw) / ar), pw = ph * ar;
    book.style.width = (sp ? pw * 2 : pw) * zoom + 'px'; book.style.height = ph * zoom + 'px';
    book.classList.toggle('spread', sp);
    stage.classList.toggle('zoomed', zoom > 1);
  };
  const render = () => {
    const sp = isSpread();
    book.replaceChildren();
    if (sp) { const [l, r] = spreadOf(page); book.append(h('div.fp-half.left', pg(l)), h('div.fp-half.right', pg(r))); }
    else book.append(h('div.fp-half.single', pg(page)));
    cnt.value = page; prevB.disabled = page <= 1; nextB.disabled = sp ? spreadOf(page)[1] >= N || !spreadOf(page)[1] : page >= N;
    try { localStorage.setItem(key, page); } catch {}
    preload(); size();
  };
  const target = d => {
    if (!isSpread()) return page + d;
    const [l, r] = spreadOf(page);
    return d > 0 ? (r || l) + 1 : (l <= 1 ? 1 : l - 1);
  };
  // перелистывание с анимацией листа
  function flip(d) {
    if (busy || zoom > 1) return;
    const t = target(d); if (t < 1 || t > N) return;
    busy = true;
    const sp = isSpread(), oldPage = page;
    page = t;
    if (sp) {
      const [ol, or] = spreadOf(oldPage), [nl, nr] = spreadOf(page);
      // под листом сразу показываем новые страницы с нужной стороны
      book.replaceChildren(
        h('div.fp-half.left', pg(d > 0 ? ol : nl)), h('div.fp-half.right', pg(d > 0 ? nr : or)));
      const leaf = h('div.fp-leaf' + (d > 0 ? '.fwd' : '.back'),
        h('div.fp-face.front', pg(d > 0 ? or : ol)), h('div.fp-face.backside', pg(d > 0 ? nl : nr)));
      book.append(leaf);
      requestAnimationFrame(() => requestAnimationFrame(() => leaf.classList.add('go')));
    } else {
      const under = h('div.fp-half.single', pg(d > 0 ? page : oldPage));
      const leaf = h('div.fp-leaf.single' + (d > 0 ? '.fwd' : '.back'), h('div.fp-face.front', pg(d > 0 ? oldPage : page)));
      book.replaceChildren(under, leaf);
      requestAnimationFrame(() => requestAnimationFrame(() => leaf.classList.add('go')));
    }
    setTimeout(() => { busy = false; render(); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 620);
  }
  const go = n => { page = Math.min(N, Math.max(1, n | 0)); render(); };
  const setZoom = z => { zoom = z; zl.textContent = Math.round(zoom * 100) + '%'; size(); };

  // жесты: свайп, тап по краю, двойной тап и щипок двумя пальцами для увеличения
  const zoomAt = (z, cx, cy) => {
    z = Math.min(4, Math.max(1, z));
    const r = stage.getBoundingClientRect();
    const fx = (stage.scrollLeft + (cx ?? r.left + r.width / 2) - r.left) / (stage.scrollWidth || 1);
    const fy = (stage.scrollTop + (cy ?? r.top + r.height / 2) - r.top) / (stage.scrollHeight || 1);
    setZoom(z);
    stage.scrollLeft = fx * stage.scrollWidth - ((cx ?? r.left + r.width / 2) - r.left);
    stage.scrollTop = fy * stage.scrollHeight - ((cy ?? r.top + r.height / 2) - r.top);
  };
  const pts = new Map();
  let sx = null, sy = 0, st = 0, lastTap = 0, tapTimer = null, pinch = null, pan = null;
  view.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, c] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - c.x, a.y - c.y), z: zoom, cx: (a.x + c.x) / 2, cy: (a.y + c.y) / 2 };
      sx = null; pan = null; clearTimeout(tapTimer);
      return;
    }
    sx = e.clientX; sy = e.clientY; st = Date.now(); pan = { x: e.clientX, y: e.clientY };
  });
  view.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      e.preventDefault();
      const [a, c] = [...pts.values()];
      const z = pinch.z * Math.hypot(a.x - c.x, a.y - c.y) / (pinch.d || 1);
      if (Math.abs(z - zoom) > .04) zoomAt(z, pinch.cx, pinch.cy);
    } else if (zoom > 1 && pts.size === 1 && pan) { // двигаем увеличенную страницу пальцем
      stage.scrollLeft -= e.clientX - pan.x; stage.scrollTop -= e.clientY - pan.y; pan = { x: e.clientX, y: e.clientY };
    }
  });
  const up = e => {
    pts.delete(e.pointerId); pan = null;
    if (pinch) { if (pts.size < 2) { pinch = null; if (zoom < 1.08) setZoom(1); } return; }
    if (sx === null || e.type === 'pointercancel') { sx = null; return; }
    const dx = e.clientX - sx, dy = e.clientY - sy; sx = null;
    if (zoom === 1 && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) return flip(dx < 0 ? 1 : -1);
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && Date.now() - st < 400) {
      const now = Date.now(), cx = e.clientX, cy = e.clientY;
      if (now - lastTap < 320) { // двойной тап
        clearTimeout(tapTimer); lastTap = 0;
        zoomAt(zoom > 1 ? 1 : 2.5, cx, cy);
        return;
      }
      lastTap = now;
      if (zoom > 1) return;
      const r = view.getBoundingClientRect(), x = (cx - r.left) / r.width;
      tapTimer = setTimeout(() => { if (x < .3) flip(-1); else if (x > .7) flip(1); }, 300);
    }
  };
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
  view.addEventListener('dblclick', e => e.preventDefault());
  view.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); zoomAt(zoom * (e.deltaY < 0 ? 1.15 : 0.87), e.clientX, e.clientY); } }, { passive: false });

  cnt.addEventListener('change', () => go(+cnt.value));
  const close = () => { wrap.remove(); document.body.classList.remove('noscroll'); removeEventListener('resize', onResize); document.removeEventListener('keydown', onKey); };
  const onResize = () => render();
  const onKey = e => {
    if (e.target === cnt) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); flip(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); flip(-1); }
  };
  const wrap = h('div.reader', { role: 'dialog', 'aria-modal': 'true' },
    h('div.rd-bar',
      h('button.icon-btn', { onclick: close, 'aria-label': 'Закрыть' }, '✕'),
      h('b.rd-title', b.title),
      h('span.rd-pg', cnt, h('span', ' / ' + N)),
      h('span.rd-zoom', h('button.icon-btn', { onclick: () => zoomAt(zoom - .5), 'aria-label': 'Мельче' }, '−'), zl,
        h('button.icon-btn', { onclick: () => zoomAt(zoom + .5), 'aria-label': 'Крупнее' }, '+'))),
    view);
  document.body.append(wrap); document.body.classList.add('noscroll');
  addEventListener('resize', onResize); document.addEventListener('keydown', onKey);
  const first = img(1);
  const start = () => { if (first.naturalWidth) ar = first.naturalWidth / first.naturalHeight; render(); };
  if (first.complete && first.naturalWidth) start(); else { first.onload = start; first.onerror = start; render(); }
}

// ---------- Учёт на уроке: отметки учителей ----------
const localISO = (d = new Date()) => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const MARK = {
  good: { label: 'Хорошо', icon: '🙂' },
  star: { label: 'Умница', icon: '⭐' },
  note: { label: 'Замечание', icon: '💬' },
};
const PHRASES = {
  star: ['Активно работал(а) на уроке', 'Помог(ла) однокласснику', 'Отличный ответ', 'Старался(ась) весь урок', 'Хорошо выполнил(а) задание'],
  note: ['Отвлекался(ась) во время объяснения', 'Не успел(а) выполнить задание', 'Разговаривал(а) на уроке', 'Нужна помощь с темой', 'Постарается в следующий раз'],
  ready: ['Нет учебника', 'Нет тетради', 'Не сделано домашнее задание', 'Нет формы'],
};
// страница учителя «Сегодня на уроке»: tok - личный код учителя
// уроки дня по расписанию класса: [{n, subject, start, end}]
function lessonsFor(info, dateStr) {
  const bells = info?.bells || [], days = (info?.timetable || []).filter(d => d.day);
  const names = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const wd = names[new Date(dateStr + 'T12:00').getDay()];
  const day = days.find(d => d.day.trim().toLowerCase() === wd);
  if (day) return day.lessons.split('\n').map((x, i) => ({ n: i + 1, subject: x.trim(), start: bells[i]?.start, end: bells[i]?.end }))
    .filter(l => l.subject && !/^[-\u2013\u2014]+$/.test(l.subject));
  const cnt = days.length ? 0 : (bells.length || 7);
  return Array.from({ length: cnt }, (_, i) => ({ n: i + 1, subject: '', start: bells[i]?.start, end: bells[i]?.end }));
}
function lessonView(tok, opts = {}) {
  const box = h('div.stack');
  let date = localISO(), lesson = null;
  const toM = t => { const [a, b] = (t || '').split(':').map(Number); return a * 60 + b; };
  // какой урок выбрать сразу: идущий сейчас, иначе первый по предмету учителя, иначе первый
  const pick = list => {
    if (!list.length) return null;
    if (date === localISO()) {
      const now = new Date(), m = now.getHours() * 60 + now.getMinutes();
      const cur = list.find(l => l.start && l.end && m >= toM(l.start) - 10 && m <= toM(l.end) + 10);
      if (cur) return cur;
    }
    const subj = (opts.subject || '').toLowerCase().slice(0, 4);
    return (subj && list.find(l => l.subject.toLowerCase().startsWith(subj))) || list[0];
  };
  const load = async () => {
    box.replaceChildren(h('section.card', h('p.muted', 'Загружаем…')));
    const list = lessonsFor(opts.info, date);
    if (!lesson || !list.some(l => l.n === lesson.n)) lesson = pick(list) || { n: 0, subject: '' };
    let d; try { d = await api('GET', `${tok}/day?date=${date}&lesson=${lesson.n}`); } catch (e) { box.replaceChildren(h('section.card', h('p', e.message))); return; }
    const byId = Object.fromEntries(d.marks.map(m => [m.student_id, m]));
    const dateIn = h('input', { type: 'date', value: date, max: localISO(), onchange: e => { date = e.target.value || localISO(); load(); } });
    const stat = h('span.small.muted');
    const updStat = () => { const v = Object.values(byId); stat.textContent = `⭐ ${v.filter(m => m.mark === 'star').length} · 💬 ${v.filter(m => m.mark === 'note').length} · не готовы ${v.filter(m => m.ready === 0).length}`; };
    updStat();
    const rows = d.students.map(s => {
      const m = byId[s.id] || { mark: 'good', ready: 1, comment: '' };
      const saved = h('span.lsv');
      let timer = null;
      const save = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try { await api('PUT', `${tok}/mark`, { date, lesson: lesson.n, subject: lesson.subject, student_id: s.id, mark: m.mark, ready: !!m.ready, comment: m.comment }); byId[s.id] = { ...m, student_id: s.id }; updStat(); saved.textContent = '✓'; setTimeout(() => saved.textContent = '', 1500); }
          catch (e) { toast(e.message, true); }
        }, 400);
      };
      const comment = h('input.lcom', { value: m.comment, maxlength: 300, placeholder: 'Комментарий (необязательно)', oninput: e => { m.comment = e.target.value; save(); } });
      const chips = h('div.lchips');
      const drawChips = () => {
        const list = [...(PHRASES[m.mark] || []), ...(m.ready ? [] : PHRASES.ready)];
        chips.replaceChildren(...list.map(t => h('button.chip', { type: 'button', onpointerdown: e => e.preventDefault(), onclick: () => { m.comment = m.comment ? (m.comment.includes(t) ? m.comment : m.comment + '; ' + t) : t; comment.value = m.comment; save(); } }, t)));
        row.classList.toggle('nocom', !m.comment);
        row.classList.toggle('open', forceOpen || m.mark !== 'good' || !m.ready || !!m.comment);
      };
      const seg = h('div.lseg', Object.entries(MARK).map(([k, v]) => h('button.lbtn.' + k + (m.mark === k ? '.on' : ''), { type: 'button', onclick: e => {
        m.mark = k; seg.querySelectorAll('.lbtn').forEach(b => b.classList.toggle('on', b === e.currentTarget)); row.dataset.mark = k; drawChips(); save();
      } }, v.icon)));
      let forceOpen = false;
      const ready = h('button.lready' + (m.ready ? '' : '.off'), { type: 'button', title: 'Готовность к уроку', 'aria-label': 'Не готов(а) к уроку', onclick: () => { m.ready = m.ready ? 0 : 1; ready.classList.toggle('off', !m.ready); drawChips(); save(); } }, '🎒');
      const pen = h('button.lpen', { type: 'button', title: 'Комментарий', 'aria-label': 'Комментарий', onclick: () => { forceOpen = !forceOpen || !!m.comment; drawChips(); if (row.classList.contains('open')) comment.focus(); } }, '✎');
      const row = h('div.lrow', { 'data-mark': m.mark }, h('div.lmain', h('span.lname', s.name, saved), seg, ready, pen), h('div.lextra', comment, chips));
      drawChips();
      return row;
    });
    box.replaceChildren(
      h('section.card.ltop', h('div.row.between', h('h3', '📝 Сегодня на уроке'), dateIn),
        list.length ? h('div.lpick', list.map(l => h('button.lchip' + (l.n === lesson.n ? '.on' : '') + (d.done.includes(l.n) ? '.done' : ''), { type: 'button', onclick: () => { lesson = l; load(); } },
          h('b', l.n + ' урок'), l.subject ? h('span', l.subject) : null, l.start ? h('small', l.start) : null))) : h('p.small.muted', 'В этот день уроков по расписанию нет.'),
        h('div.llegend', h('span', '🙂 хорошо (у всех сразу)'), h('span', '⭐ умница'), h('span', '💬 замечание'), h('span', '🎒 не готов(а)'), h('span', '✎ комментарий')),
        h('div.row.between.small', h('span.muted', 'Сохраняется само'), stat)),
      h('section.card.lessons-list', rows));
  };
  load();
  return box;
}
// журнал: все отметки за период (для кабинета и классного руководителя)
function journalView(fetchUrl, students) {
  const box = h('div.stack');
  const names = Object.fromEntries((students || []).map(s => [s.id, s.name]));
  let range = 'week';
  const load = async () => {
    const t = new Date(), to = localISO(t);
    const from = range === 'day' ? to : range === 'week' ? localISO(new Date(t - ((t.getDay() + 6) % 7) * 864e5)) : localISO(new Date(t.getFullYear(), t.getMonth(), 1));
    const chips = h('div.row', { style: 'gap:6px;flex-wrap:wrap' }, [['day', 'Сегодня'], ['week', 'Эта неделя'], ['month', 'Этот месяц']].map(([k, l]) => h('button.chip' + (range === k ? '.on' : ''), { type: 'button', onclick: () => { range = k; load(); } }, l)));
    box.replaceChildren(h('section.card', h('h3', '📒 Журнал отметок'), chips, h('p.muted', 'Загружаем…')));
    let d; try { d = await api('GET', `${fetchUrl}?from=${from}&to=${to}`); } catch (e) { box.replaceChildren(h('section.card', h('p', e.message))); return; }
    const per = {};
    d.marks.forEach(m => { const x = per[m.student_id] ||= { star: 0, note: 0, notReady: 0, list: [] }; if (m.mark === 'star') x.star++; if (m.mark === 'note') x.note++; if (!m.ready) x.notReady++; x.list.push(m); });
    const ids = Object.keys(per).sort((a, b) => (names[a] || '').localeCompare(names[b] || ''));
    const fd = s => s.split('-').reverse().slice(0, 2).join('.');
    box.replaceChildren(h('section.card', h('h3', '📒 Журнал отметок'), chips,
      h('p.small.muted', 'Здесь только особые отметки. Все остальные дети на уроках - «Хорошо».'),
      ids.length ? h('div.jlist', ids.map(id => {
        const x = per[id];
        return h('details.jrow', h('summary', h('b', names[id] || 'Ученик'), h('span.jsum', x.star ? h('span.jpill.star', '⭐ ' + x.star) : null, x.note ? h('span.jpill.note', '💬 ' + x.note) : null, x.notReady ? h('span.jpill.ready', '🎒 ' + x.notReady) : null)),
          h('ul.plain.jitems', x.list.map(m => h('li', h('span.muted.small', fd(m.date) + (m.lesson ? ', ' + m.lesson + ' урок' : '') + ' · ' + (m.subject || m.tutor)), ' ', MARK[m.mark].icon + ' ' + MARK[m.mark].label, m.ready ? null : ' · 🎒 не готов(а)', m.comment ? h('div.small', m.comment) : null))));
      })) : h('p.muted', 'За этот период особых отметок нет.')));
  };
  load();
  return box;
}
