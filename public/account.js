'use strict';
// Вход, регистрация и список своих классов
let ME = null;
const next = new URLSearchParams(location.search).get('next');
const safeNext = next && /^\/c\/[a-z0-9-]+(\/admin)?$/.test(next) ? next : null;

async function start() {
  ME = await api('GET', '/api/me').catch(() => ({ user: null }));
  if (!ME.user) return authView(location.hash === '#register' && ME.signup ? 'up' : 'in');
  if (safeNext) { location.href = safeNext; return; }
  $('#sub').textContent = ME.user.email;
  $('#head-actions').replaceChildren(...[
    ME.user.owner ? h('a.btn.small', { href: '/owner' }, 'Владелец') : null,
    h('button.btn.small', { onclick: passwordDialog }, 'Пароль'),
    h('button.btn.small', { onclick: async () => { await api('POST', '/api/auth/logout'); location.href = '/'; } }, 'Выйти')].filter(Boolean));
  classesView();
}

function authView(mode) {
  const name = h('input', { autocomplete: 'name', maxlength: 100, placeholder: 'Как к вам обращаться' });
  const email = h('input', { type: 'email', autocomplete: 'email', required: true });
  const pass = h('input', { type: 'password', autocomplete: mode === 'up' ? 'new-password' : 'current-password', required: true, minlength: mode === 'up' ? 8 : null });
  const consent = h('input', { type: 'checkbox' });
  const btn = h('button.btn.primary', { type: 'submit' }, mode === 'up' ? 'Зарегистрироваться' : 'Войти');
  const form = h('form.card.form.login', {
    onsubmit: async e => {
      e.preventDefault(); btn.disabled = true;
      try {
        if (mode === 'up') await api('POST', '/api/auth/register', { name: name.value, email: email.value, password: pass.value, consent: consent.checked });
        else await api('POST', '/api/auth/login', { email: email.value, password: pass.value });
        location.href = safeNext || '/account';
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    },
  },
    h('h2', mode === 'up' ? 'Регистрация казначея' : 'Вход для казначея'),
    mode === 'up' ? h('p.hint', `Первые ${ME?.trialDays || 30} дней бесплатно, дальше ${rub(ME?.price || 399)} в год за класс. Родителям регистрироваться не нужно.`) : null,
    mode === 'up' ? h('label.field', 'Имя', name) : null,
    h('label.field', 'Почта', email),
    h('label.field', 'Пароль' + (mode === 'up' ? ' (не короче 8 символов)' : ''), pass),
    mode === 'up' ? h('label.check.small', consent, h('span', 'Согласна(ен) на ', h('a', { href: '/privacy', target: '_blank' }, 'обработку персональных данных'), ' и принимаю ', h('a', { href: '/oferta', target: '_blank' }, 'условия сервиса'))) : null,
    btn,
    !ME.signup ? null : h('button.btn.small', { type: 'button', onclick: () => { history.replaceState(null, '', location.pathname + location.search + (mode === 'up' ? '' : '#register')); authView(mode === 'up' ? 'in' : 'up'); } },
      mode === 'up' ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Регистрация'));
  $('#main').replaceChildren(form);
}

function subPill(c) {
  const left = daysLeft(c.paid_until);
  if (left < 0) return h('span.pill.bad', 'подписка закончилась');
  if (left <= 14) return h('span.pill.warn', 'до ' + fdate(c.paid_until));
  return h('span.pill' + (c.paid ? '.ok' : '.blue'), (c.paid ? 'оплачено до ' : 'бесплатно до ') + fdate(c.paid_until));
}

function classesView() {
  const wrap = h('div.stack');
  if (!ME.classes.length) wrap.append(h('section.card', h('h2', 'Создайте свой класс'), h('p.muted', 'Это займёт минуту: название, адрес страницы и список детей. Потом добавите сборы и отправите ссылку родителям.')));
  ME.classes.forEach(c => {
    const url = classUrl(c.slug);
    wrap.append(h('section.card', { id: 'pay-' + c.slug },
      h('b', c.title), h('div.small', { style: 'overflow-wrap:anywhere;margin:2px 0 6px' }, h('a', { href: url, target: '_blank' }, url.replace(/^https?:\/\//, ''))), subPill(c),
      h('div.row', { style: 'margin-top:10px' },
        h('a.btn.primary.small', { href: '/c/' + c.slug + '/admin' }, 'Открыть кабинет'),
        h('button.btn.small', { onclick: async () => { try { await navigator.clipboard.writeText(url); toast('Ссылка для родителей скопирована'); } catch { toast(url); } } }, 'Ссылка для родителей'),
        h('button.btn.small', { onclick: () => payDialog(c) }, `Продлить - ${rub(ME.price)}/год`))));
  });
  wrap.append(createForm());
  $('#main').replaceChildren(wrap);
  if (location.hash.startsWith('#pay-')) { const c = ME.classes.find(x => 'pay-' + x.slug === location.hash.slice(1)); if (c) payDialog(c); }
}

function payDialog(c) {
  modal('Продление подписки', h('div.form',
    h('p', h('b', c.title)),
    h('p', `${rub(ME.price)} за год. Подписка продлится на 365 дней от ${daysLeft(c.paid_until) >= 0 ? 'текущей даты окончания' : 'сегодняшнего дня'}.`),
    h('p.hint', 'Оплата картой прямо здесь появится совсем скоро. Пока подписка продлевается вручную: напишите владельцу сервиса.')));
}

function createForm() {
  const title = h('input', { required: true, maxlength: 100, placeholder: 'Например: Школа 12, 4 «А»' });
  const slug = h('input', { maxlength: 40, placeholder: 'например: shkola12-4a', pattern: '[a-z0-9-]{3,40}' });
  const kids = h('textarea', { rows: 6, placeholder: 'ФИО ребёнка, дата рождения, ФИО родителя - по одному на строку.\nМожно вставить прямо из таблицы.' });
  const btn = h('button.btn.primary', { type: 'submit' }, 'Создать класс');
  const translit = s => { const T = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
    return s.toLowerCase().split('').map(c => T[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); };
  let touched = false;
  title.addEventListener('input', () => { if (!touched) slug.value = translit(title.value); });
  slug.addEventListener('input', () => { touched = true; slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); });
  return h('form.card.form', {
    onsubmit: async e => {
      e.preventDefault(); btn.disabled = true;
      try {
        const r = await api('POST', '/api/classes', { title: title.value, slug: slug.value, students: kids.value });
        location.href = '/c/' + r.slug + '/admin';
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    },
  }, h('h3', ME.classes.length ? 'Ещё один класс' : 'Новый класс'),
    h('label.field', 'Название', title),
    h('label.field', 'Адрес страницы (латиницей)', slug),
    h('span.hint', 'Страница для родителей будет по адресу ' + location.host + '/c/…'),
    h('label.field', 'Список класса', kids, h('span.hint', 'Можно вставить из таблицы: ФИО ребёнка, дата рождения, ФИО родителя. Всё сохранится в вашем кабинете, а родителям будут видны только фамилия и имя.')),
    btn);
}

function passwordDialog() {
  const old = h('input', { type: 'password', autocomplete: 'current-password' });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  const close = modal('Сменить пароль', h('form.form', { onsubmit: async e => { e.preventDefault(); try { await api('POST', '/api/auth/password', { old: old.value, password: nw.value }); close(); toast('Пароль изменён'); } catch (err) { toast(err.message, true); } } },
    h('label.field', 'Текущий пароль', old), h('label.field', 'Новый пароль', nw), h('button.btn.primary', { type: 'submit' }, 'Сохранить')));
}

api('GET', '/api/config').then(c => { ME = { ...c, ...(ME || {}) }; }).catch(() => {}).finally(start);
