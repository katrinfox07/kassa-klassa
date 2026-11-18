'use strict';
// Кабинет казначея
let S = null;
const openColl = new Set(); // какие таблицы сборов развёрнуты

async function start() {
  const me = await api('GET', '/api/me').catch(() => ({ user: null }));
  if (!me.user) { location.href = '/account?next=' + encodeURIComponent(location.pathname); return; }
  $('#head-actions').replaceChildren(
    h('a.btn.small', { href: classUrl(), target: '_blank' }, 'Страница родителей'),
    h('a.btn.small', { href: '/account' }, 'Мои классы'),
    installButton() || '');
  await load();
}

function subscriptionBanner() {
  const sub = S.subscription; if (!sub) return null;
  const left = daysLeft(sub.paid_until);
  if (sub.active && left > 14) return null;
  return h('section.card.pending-item', { style: 'margin-bottom:12px' },
    h('b', sub.active ? `Подписка действует до ${fdate(sub.paid_until)}` : 'Подписка закончилась'),
    h('p.small.muted', sub.active ? `Продлите заранее: ${rub(sub.price)} в год.` : `Данные сохранены, родители видят страницу, но изменения недоступны. Продление: ${rub(sub.price)} в год.`),
    h('a.btn.primary.small', { href: '/account#pay-' + S.class.slug }, 'Продлить'));
}

async function load() {
  try { S = await api('GET', '/api/admin/state'); }
  catch (e) { if (e.status === 401) { location.href = '/account?next=' + encodeURIComponent(location.pathname); return; } if (e.status === 403) { $('#main').replaceChildren(h('p.empty', 'Это не ваш класс. ', h('a', { href: '/account' }, 'Мои классы'))); return; } toast(e.message, true); return; }
  $('#sub').textContent = S.class.title;
  $('#banner').replaceChildren(subscriptionBanner() || '');
  $('#totals').replaceChildren(
    h('div.total', h('div.label', 'Собрано'), h('div.value', rub(S.totals.collected))),
    h('div.total', h('div.label', 'Потрачено'), h('div.value', rub(S.totals.spent))),
    h('div.total.main', h('div.label', 'В кассе'), h('div.value', rub(S.totals.balance))));
  const pending = S.payments.filter(p => p.status === 'pending').length;
  tabs($('#tabs'), [
    { id: 'проверить', label: 'Проверить', badge: pending || null },
    { id: 'сборы', label: 'Сборы' },
    { id: 'расходы', label: 'Расходы' },
    { id: 'класс', label: 'Список класса' },
    { id: 'инфо', label: 'Информация' },
    { id: 'настройки', label: 'Настройки' },
  ], show);
}

const VIEWS = {};
function show(id) { $('#main').replaceChildren(VIEWS[id]()); }
const act = (fn, okMsg) => async (...a) => { try { await fn(...a); if (okMsg) toast(okMsg); await load(); } catch (e) { toast(e.message, true); } };
const sName = id => S.students.find(s => s.id === id)?.name || '—';
const cTitle = id => S.collections.find(c => c.id === id)?.title || '—';

function shotBtn(p) {
  return p.has_shot ? h('button.btn.small', { onclick: () => viewImage(apiUrl('/api/admin/shot/' + p.id)) }, 'Скриншот') : null;
}

// ---------- Проверить ----------
VIEWS['проверить'] = () => {
  const list = S.payments.filter(p => p.status === 'pending');
  const wrap = h('div.stack');
  wrap.append(h('p.hint', 'Здесь отметки родителей «Я оплатил». Сверьте с уведомлением из банка или списком участников сбора и подтвердите.'));
  if (!list.length) wrap.append(h('p.empty', 'Новых отметок нет 👍'));
  list.forEach(p => wrap.append(h('section.card.pending-item',
    h('div.row.between', h('div.grow', h('b', sName(p.student_id)), h('div.muted.small', cTitle(p.collection_id))), h('b', rub(p.amount))),
    h('div.small.muted', { style: 'margin:4px 0 10px' }, fdatetime(p.created_at), p.payer ? ' · платил(а): ' + p.payer : '', p.note ? ' · ' + p.note : ''),
    h('div.row',
      h('button.btn.ok.small', { onclick: act(() => api('PUT', '/api/admin/payments/' + p.id, { status: 'confirmed' }), 'Подтверждено') }, '✓ Подтвердить'),
      h('button.btn.small.danger', { onclick: act(() => api('PUT', '/api/admin/payments/' + p.id, { status: 'rejected' }), 'Отклонено') }, 'Не нашла перевод'),
      shotBtn(p)))));
  const recent = S.payments.filter(p => p.status !== 'pending').slice(0, 15);
  if (recent.length) wrap.append(h('section.card', h('h3', 'Последние решения'),
    h('div.tbl-scroll', h('table.tbl', h('tbody', recent.map(p => h('tr',
      h('td', sName(p.student_id), h('div.muted.small', cTitle(p.collection_id))),
      h('td.num', rub(p.amount)),
      h('td', p.status === 'confirmed' ? h('span.pill.ok', p.source === 'treasurer' ? 'отмечено вами' : 'подтверждено') : h('span.pill.bad', 'отклонено')),
      h('td', h('div.actions', p.status === 'rejected'
        ? h('button.btn.small', { onclick: act(() => api('PUT', '/api/admin/payments/' + p.id, { status: 'confirmed' })) }, 'Всё-таки подтвердить')
        : h('button.btn.small', { onclick: act(() => api('PUT', '/api/admin/payments/' + p.id, { status: 'pending' })) }, 'Вернуть на проверку'))))))))));
  return wrap;
};

// ---------- Сборы ----------
VIEWS['сборы'] = () => {
  const wrap = h('div.stack', h('div.row', h('button.btn.primary', { onclick: () => collectionDialog() }, '+ Новый сбор')));
  if (!S.collections.length) wrap.append(h('p.empty', 'Создайте первый сбор: например «Новогодние подарки, 800 ₽».'));
  S.collections.forEach(c => wrap.append(collectionAdminCard(c)));
  return wrap;
};

function collectionAdminCard(c) {
  const active = S.students.filter(s => s.active);
  const paid = active.filter(s => statusOf(S, c, s.id).s === 'paid').length;
  const det = h('details.more', { open: openColl.has(c.id), ontoggle: e => e.target.open ? openColl.add(c.id) : openColl.delete(c.id) },
    h('summary', 'Таблица оплат'), collectionTable(c));
  return h('section.card.coll',
    h('div.row.between', h('div.title.grow', c.title), c.closed ? h('span.pill', 'завершён') : c.due_date ? h('span.pill.blue', 'до ' + fdate(c.due_date)) : null),
    h('div.meta', (c.amount ? rub(c.amount) + ' с ребёнка' : 'Сумма свободная') + (c.pay_link ? '' : ' · ⚠ нет ссылки на оплату')),
    progress(c),
    h('div.row.between.small', h('span', `Сдали ${paid} из ${active.length}`, c.pending ? h('span.pill.warn', { style: 'margin-left:6px' }, c.pending + ' на проверке') : null),
      h('span.muted', `${rub(c.collected)}${c.expected ? ' из ' + rub(c.expected) : ''}${c.spent ? ' · потрачено ' + rub(c.spent) : ''}`)),
    h('div.row', { style: 'margin-top:10px' },
      h('button.btn.small', { onclick: () => collectionDialog(c) }, 'Изменить'),
      h('button.btn.small', { onclick: () => remind(c) }, 'Текст для чата'),
      c.pay_link ? h('a.btn.small', { href: c.pay_link, target: '_blank', rel: 'noopener' }, 'Ссылка сбора ↗') : null),
    det);
}

function collectionTable(c) {
  const rows = S.students.filter(s => s.active || S.payments.some(p => p.student_id === s.id && p.collection_id === c.id)).map(s => {
    const st = statusOf(S, c, s.id);
    const pend = st.list.find(p => p.status === 'pending');
    const conf = st.list.filter(p => p.status === 'confirmed');
    let status, actions;
    if (st.s === 'paid') {
      status = h('span.pill.ok', 'оплачено ' + rub(st.amount));
      actions = [conf[0] && shotBtn(conf[0]), h('button.btn.small', { onclick: act(() => Promise.all(conf.map(p => p.source === 'treasurer' ? api('DELETE', '/api/admin/payments/' + p.id) : api('PUT', '/api/admin/payments/' + p.id, { status: 'pending' })))) }, 'Отменить')];
    } else if (st.s === 'pending') {
      status = h('span.pill.warn', 'на проверке ' + rub(pend.amount));
      actions = [shotBtn(pend), h('button.btn.ok.small', { onclick: act(() => api('PUT', '/api/admin/payments/' + pend.id, { status: 'confirmed' })) }, '✓'),
        h('button.btn.small.danger', { onclick: act(() => api('PUT', '/api/admin/payments/' + pend.id, { status: 'rejected' })) }, '✕')];
    } else {
      status = h('span.pill', 'не оплачено');
      actions = [h('button.btn.small', { onclick: () => markPaid(c, s) }, 'Отметить оплату')];
    }
    return h('tr', { class: s.active ? '' : 'out' }, h('td', s.name), h('td', status), h('td', h('div.actions', actions)));
  });
  return h('div.tbl-scroll', { style: 'margin-top:8px' }, h('table.tbl', h('tbody', rows)));
}

function markPaid(c, s) {
  const amount = h('input', { type: 'number', inputmode: 'numeric', min: 1, value: c.amount || '', required: true });
  const note = h('input', { placeholder: 'Например: наличными', maxlength: 300 });
  const close = modal('Отметить оплату', h('form.form', {
    onsubmit: async e => { e.preventDefault(); await act(() => api('POST', '/api/admin/payments', { collection_id: c.id, student_id: s.id, amount: amount.value, note: note.value }), 'Отмечено')(); close(); },
  }, h('p', h('b', s.name), h('br'), h('span.muted', c.title)), h('label.field', 'Сумма, ₽', amount), h('label.field', 'Комментарий', note),
     h('button.btn.primary', { type: 'submit' }, 'Сохранить')));
}

function collectionDialog(c) {
  const isNew = !c; c = c || { title: '', description: '', amount: '', due_date: '', pay_link: '', closed: 0 };
  const f = {
    title: h('input', { value: c.title, required: true, maxlength: 150, placeholder: 'Например: Подарки к Новому году' }),
    amount: h('input', { type: 'number', inputmode: 'numeric', min: 0, value: c.amount, placeholder: '0 — если сумма свободная' }),
    due_date: h('input', { type: 'date', value: c.due_date || '' }),
    pay_link: h('input', { type: 'url', value: c.pay_link, placeholder: 'https://…' }),
    description: h('textarea', { placeholder: 'На что собираем, подробности' }, c.description),
    closed: h('input', { type: 'checkbox', checked: !!c.closed }),
  };
  const close = modal(isNew ? 'Новый сбор' : 'Изменить сбор', h('form.form', {
    onsubmit: async e => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
      try { await api(isNew ? 'POST' : 'PUT', '/api/admin/collections' + (isNew ? '' : '/' + c.id), body); close(); toast('Сохранено'); load(); }
      catch (err) { toast(err.message, true); }
    },
  },
    h('label.field', 'Название', f.title),
    h('div.two', h('label.field', 'С каждого ребёнка, ₽', f.amount), h('label.field', 'Сдать до', f.due_date)),
    h('label.field', 'Ссылка на банковский сбор', f.pay_link,
      h('span.hint', 'Создайте сбор в приложении своего банка и вставьте сюда ссылку на него. По ней родители оплатят с карты любого банка или по СБП.')),
    h('label.field', 'Описание', f.description),
    !isNew ? h('label.check', f.closed, 'Сбор завершён (кнопка оплаты скроется)') : null,
    h('div.row.between',
      h('button.btn.primary', { type: 'submit' }, 'Сохранить'),
      !isNew ? h('button.btn.danger', { type: 'button', onclick: async () => {
        if (!confirmInline(close, `Удалить сбор «${c.title}» вместе со всеми отметками об оплате?`, async () => { await api('DELETE', '/api/admin/collections/' + c.id); toast('Удалено'); load(); })) return;
      } }, 'Удалить') : null)));
}

// Подтверждение без системных диалогов
function confirmInline(closePrev, text, onYes) {
  closePrev();
  const close = modal('Точно?', h('div.form', h('p', text), h('div.row',
    h('button.btn.danger', { onclick: async () => { close(); try { await onYes(); } catch (e) { toast(e.message, true); } } }, 'Да, удалить'),
    h('button.btn', { onclick: () => close() }, 'Отмена'))));
  return false;
}

function remind(c) {
  const notPaid = S.students.filter(s => s.active && statusOf(S, c, s.id).s === 'none').map(s => s.name);
  const url = classUrl();
  const text = `Уважаемые родители! Идёт сбор «${c.title}»` + (c.amount ? ` — ${rub(c.amount)} с ребёнка` : '') + (c.due_date ? `, до ${fdate(c.due_date)}` : '') + '.\n' +
    (c.pay_link ? `Оплатить: ${c.pay_link}\n` : '') + `После оплаты отметьтесь, пожалуйста, на странице класса: ${url}\n` +
    (notPaid.length && notPaid.length < S.students.length ? `\nПока не сдали: ${notPaid.join(', ')}.` : '');
  const ta = h('textarea', { rows: 9 }, text);
  modal('Текст для чата класса', h('div.form', ta, h('button.btn.primary', {
    onclick: async () => { try { await navigator.clipboard.writeText(ta.value); toast('Скопировано'); } catch { ta.select(); toast('Выделите и скопируйте текст'); } },
  }, 'Скопировать')));
}

// ---------- Расходы ----------
VIEWS['расходы'] = () => {
  const wrap = h('div.stack', h('div.row', h('button.btn.primary', { onclick: expenseDialog }, '+ Добавить расход с чеком')));
  if (!S.expenses.length) wrap.append(h('p.empty', 'Расходов пока нет.'));
  S.expenses.forEach(e => wrap.append(h('section.card',
    h('div.exp', h('div.grow', h('b', e.title), h('div.muted.small', fdate(e.date), e.collection_id ? ' · ' + cTitle(e.collection_id) : ''), e.note ? h('p.small.pre', e.note) : null),
      h('div.sum', rub(e.amount))),
    h('div.row.between', { style: 'margin-top:6px' },
      e.receipts.length ? h('div.thumbs', e.receipts.map(src => h('button', { onclick: () => viewImage(src) }, h('img', { src, alt: 'Чек', loading: 'lazy' })))) : h('span.pill.warn', 'нет чека'),
      h('button.btn.small.danger', { onclick: () => confirmInline(() => {}, `Удалить расход «${e.title}»?`, async () => { await api('DELETE', '/api/admin/expenses/' + e.id); toast('Удалено'); load(); }) }, 'Удалить')))));
  return wrap;
};

function expenseDialog() {
  const f = {
    title: h('input', { required: true, maxlength: 200, placeholder: 'Например: Сладкие подарки, 29 шт.' }),
    amount: h('input', { type: 'number', inputmode: 'decimal', min: 1, required: true }),
    date: h('input', { type: 'date', value: today() }),
    collection_id: h('select', h('option', { value: '' }, '— общая касса —'), S.collections.map(c => h('option', { value: c.id }, c.title))),
    note: h('textarea', { placeholder: 'Где купили, комментарий (необязательно)' }),
  };
  const files = h('input', { type: 'file', accept: 'image/*', multiple: true });
  const btn = h('button.btn.primary', { type: 'submit' }, 'Сохранить');
  const close = modal('Новый расход', h('form.form', {
    onsubmit: async e => {
      e.preventDefault(); btn.disabled = true; btn.textContent = 'Загружаем…';
      try {
        const images = [];
        for (const file of [...files.files].slice(0, 6)) images.push(await compressImage(file, 2000));
        await api('POST', '/api/admin/expenses', { ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])), images });
        close(); toast('Расход добавлен'); load();
      } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Сохранить'; }
    },
  },
    h('label.field', 'На что потрачено', f.title),
    h('div.two', h('label.field', 'Сумма, ₽', f.amount), h('label.field', 'Дата', f.date)),
    h('label.field', 'Из какого сбора', f.collection_id),
    h('label.field', 'Фото чеков (можно несколько)', files, h('span.hint', 'На телефоне можно сразу сфотографировать чек.')),
    h('label.field', 'Комментарий', f.note),
    btn));
}

// ---------- Список класса ----------
VIEWS['класс'] = () => {
  const ta = h('textarea', { rows: 3, placeholder: 'Фамилия Имя — по одному на строку' });
  return h('div.stack',
    h('section.card', h('p.hint', 'На странице для родителей видны только эти имена. Выбывших лучше отмечать, а не удалять: так сохранится история оплат.'),
      h('div.tbl-scroll', h('table.tbl', h('tbody', S.students.map((s, i) => {
        const name = h('input', { value: s.name, maxlength: 120, onchange: act(() => api('PUT', '/api/admin/students/' + s.id, { name: name.value, active: s.active }), 'Сохранено') });
        return h('tr', { class: s.active ? '' : 'out' }, h('td.muted.small', i + 1), h('td', name),
          h('td', h('div.actions',
            h('button.btn.small', { onclick: act(() => api('PUT', '/api/admin/students/' + s.id, { name: s.name, active: !s.active })) }, s.active ? 'Выбыл' : 'Вернуть'),
            h('button.icon-btn', { 'aria-label': 'Удалить', onclick: () => confirmInline(() => {}, `Удалить «${s.name}» из списка?`, async () => { await api('DELETE', '/api/admin/students/' + s.id); load(); }) }, '🗑'))));
      }))))),
    h('section.card.form', h('h3', 'Добавить детей'), ta,
      h('button.btn', { onclick: act(async () => { await api('POST', '/api/admin/students', { names: ta.value }); }, 'Добавлено') }, 'Добавить')));
};

// ---------- Информация ----------
VIEWS['инфо'] = () => {
  const info = structuredClone(S.info);
  const save = act(() => api('PUT', '/api/admin/info', info), 'Сохранено');
  const listEditor = (title, key, fields, empty, cls = '') => {
    const rows = h('div');
    const draw = () => rows.replaceChildren(...info[key].map((item, i) => h('div.edit-row' + cls,
      fields.map(([k, ph, type]) => h(type === 'textarea' ? 'textarea' : 'input', { type: type || 'text', placeholder: ph, value: item[k] || '', oninput: e => { item[k] = e.target.value; } }, type === 'textarea' ? item[k] : null)),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Убрать', onclick: () => { info[key].splice(i, 1); draw(); } }, '✕'))));
    draw();
    return h('section.card', h('h3', title), rows,
      h('button.btn.small', { type: 'button', onclick: () => { info[key].push({ ...empty }); draw(); } }, '+ Добавить'));
  };
  const ann = h('section.card', h('h3', 'Объявления'));
  const annRows = h('div.stack');
  const drawAnn = () => annRows.replaceChildren(...info.announcements.map((a, i) => h('div.form',
    h('div.row', h('input', { type: 'date', value: a.date, style: 'max-width:180px', oninput: e => { a.date = e.target.value; } }),
      h('button.icon-btn', { type: 'button', onclick: () => { info.announcements.splice(i, 1); drawAnn(); } }, '✕')),
    h('textarea', { oninput: e => { a.text = e.target.value; }, placeholder: 'Текст объявления' }, a.text))));
  drawAnn();
  ann.append(annRows, h('button.btn.small', { type: 'button', onclick: () => { info.announcements.unshift({ date: today(), text: '' }); drawAnn(); } }, '+ Объявление'));
  const body = h('div.stack',
    h('p.hint', 'Всё, что здесь заполнено, видно на странице для родителей во вкладке «Информация». После правок нажмите «Сохранить» внизу.'),
    ann,
    listEditor('Расписание звонков', 'bells', [['from', 'Начало, 08:00', 'time'], ['to', 'Конец, 08:40', 'time']], { from: '', to: '' }),
    listEditor('Каникулы и выходные', 'holidays', [['title', 'Название'], ['from', 'С', 'date'], ['to', 'По', 'date']], { title: '', from: '', to: '' }, '.three'),
    listEditor('Учителя', 'teachers', [['role', 'Предмет или роль'], ['name', 'ФИО'], ['contact', 'Телефон / почта (необяз.)']], { role: '', name: '', contact: '' }, '.three'),
    listEditor('Полезные ссылки', 'links', [['title', 'Название'], ['url', 'https://…', 'url']], { title: '', url: '' }),
    h('div.savebar', h('button.btn.primary.block', { onclick: save }, 'Сохранить')));
  return body;
};

// ---------- Настройки ----------
VIEWS['настройки'] = () => {
  const f = {
    title: h('input', { value: S.class.title, maxlength: 100, placeholder: 'Например: 5 «Б» класс' }),
    treasurer: h('input', { value: S.class.treasurer, maxlength: 100, placeholder: 'Как к вам обращаться' }),
    payHint: h('textarea', { placeholder: 'Например: если не получается по ссылке — напишите мне в чат' }, S.class.payHint),
  };
  return h('div.stack',
    h('section.card.form', h('h3', 'Класс'),
      h('label.field', 'Название (заголовок страницы)', f.title),
      h('label.field', 'Казначей', f.treasurer),
      h('label.field', 'Подсказка родителям при оплате', f.payHint),
      h('button.btn.primary', { onclick: act(() => api('PUT', '/api/admin/class', Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]))), 'Сохранено') }, 'Сохранить')),
    h('section.card', h('h3', 'Резервная копия'), h('p.hint', 'Скачайте все данные (сборы, оплаты, расходы) одним файлом.'),
      h('a.btn', { href: apiUrl('/api/admin/export') }, 'Скачать копию')),
    h('section.card.form', h('h3', 'Ссылка для родителей'),
      h('p.hint', 'Отправьте её в чат класса. Родителям не нужно регистрироваться.'),
      h('div.row', h('input.grow', { value: classUrl(), readonly: true, onclick: e => e.target.select() }),
        h('button.btn', { onclick: async () => { try { await navigator.clipboard.writeText(classUrl()); toast('Скопировано'); } catch { toast('Выделите и скопируйте'); } } }, 'Копировать'))),
    h('section.card.form', h('h3', 'Удалить класс'),
      h('p.hint', 'Удалятся все сборы, оплаты, чеки и список класса. Отменить нельзя. Сначала скачайте копию.'),
      h('button.btn.danger', { onclick: () => {
        const inp = h('input', { placeholder: S.class.slug });
        modal('Удалить класс?', h('div.form', h('p', 'Чтобы подтвердить, введите адрес класса: ', h('b', S.class.slug)), inp,
          h('button.btn.danger', { onclick: async () => { try { await api('DELETE', '/api/admin/class', { confirm: inp.value }); location.href = '/account'; } catch (e) { toast(e.message, true); } } }, 'Удалить навсегда')));
      } }, 'Удалить класс')));
};

start();
