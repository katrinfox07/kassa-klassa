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

function statusOf(st, collection, studentId) {
  const ps = st.payments.filter(p => p.collection_id === collection.id && p.student_id === studentId);
  const conf = ps.filter(p => p.status === 'confirmed');
  if (conf.length) return { s: 'paid', amount: conf.reduce((a, p) => a + p.amount, 0), list: ps };
  if (ps.some(p => p.status === 'pending')) return { s: 'pending', list: ps };
  return { s: 'none', list: ps };
}

function progress(c) {
  const pct = c.expected ? Math.min(100, Math.round(c.collected / c.expected * 100)) : 0;
  return h('div.progress', { title: pct + '%' }, h('div', { style: `width:${pct}%` }));
}

// Информационный раздел: одинаковый вид для родителей и предпросмотра у казначея
function renderInfo(info) {
  const wrap = h('div.stack');
  if (info.announcements?.length) wrap.append(h('section.card', h('h3', 'Объявления'),
    info.announcements.map(a => h('div.announce', a.date ? h('div.muted.small', fdate(a.date)) : null, h('p.pre', a.text)))));
  if (info.bells?.length) {
    const now = new Date(); const mins = now.getHours() * 60 + now.getMinutes();
    const toM = t => { const [a, b] = (t || '').split(':').map(Number); return a * 60 + b; };
    wrap.append(h('section.card', h('h3', 'Расписание звонков'),
      h('table.bells', h('tbody', info.bells.map(b => h('tr', { class: mins >= toM(b.from) && mins < toM(b.to) && now.getDay() % 6 ? 'now' : '' },
        h('td.muted', b.n + ' урок'), h('td', `${b.from} – ${b.to}`)))))));
  }
  if (info.timetable?.length) {
    const wd = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'][new Date().getDay()];
    wrap.append(h('section.card', h('h3', 'Расписание уроков'), h('div.timetable', info.timetable.map(d =>
      h('div.tt-day', { class: d.day.trim().toLowerCase() === wd ? 'today' : '' }, h('b', d.day), h('ol', d.lessons.split('\n').map(x => x.trim()).filter(Boolean).map(x => h('li', x))))))));
  }
  if (info.holidays?.length) wrap.append(h('section.card', h('h3', 'Каникулы и выходные'),
    h('ul.plain', info.holidays.map(x => h('li', h('b', x.title), h('span.muted', ' ' + (x.from ? fdate(x.from) : '') + (x.to && x.to !== x.from ? ' – ' + fdate(x.to) : '')))))));
  if (info.teachers?.length) wrap.append(h('section.card', h('h3', 'Учителя'),
    h('ul.plain.teachers', info.teachers.map(t => h('li', h('div.muted.small', t.role), h('div', t.name), t.contact ? h('div.small', linkify(t.contact)) : null)))));
  if (info.links?.length) wrap.append(h('section.card', h('h3', 'Полезные ссылки'),
    h('ul.plain', info.links.map(l => h('li', h('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.title))))));
  if (!wrap.children.length) wrap.append(h('p.empty', 'Информация пока не добавлена.'));
  return wrap;
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
