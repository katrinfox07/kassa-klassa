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
    { id: 'календарь', label: 'Календарь' },
    { id: 'класс', label: 'Список класса' },
    { id: 'инфо', label: 'Информация' },
    { id: 'настройки', label: 'Настройки' },
  ], show);
}

const VIEWS = {};
function show(id) { const bb = ['проверить', 'сборы', 'календарь'].includes(id) && bdayBanner(calEvents(S, true)); $('#main').replaceChildren(...[bb, VIEWS[id]()].filter(Boolean)); }
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
  wrap.append(pushCard());
  wrap.append(h('div.row', { style: 'gap:8px' },
    h('button.btn.grow', { onclick: reconcileDialog }, '🏦 Сверить с банком'),
    list.length > 1 ? h('button.btn.ok.grow', { onclick: () => confirmAll(list) }, `✓ Подтвердить все (${list.length})`) : null));
  if (!list.length) wrap.append(h('p.empty', 'Новых отметок нет 👍'));
  list.forEach(p => wrap.append(h('section.card.pending-item.pend-row',
    p.has_shot ? h('img.pend-shot', { src: apiUrl('/api/admin/shot/' + p.id), alt: 'Скриншот', loading: 'lazy', onclick: () => viewImage(apiUrl('/api/admin/shot/' + p.id)) }) : h('div.pend-shot.none', '🧾'),
    h('div.grow',
      h('div.row.between', h('b', sName(p.student_id)), h('b', rub(p.amount))),
      h('div.muted.small', cTitle(p.collection_id), ' · ', fdatetime(p.created_at), p.payer ? ' · ' + p.payer : '', p.note ? ' · ' + p.note : ''),
      h('div.row.nowrap', { style: 'margin-top:6px' },
        h('button.btn.ok.small', { onclick: act(() => api('PUT', '/api/admin/payments/' + p.id, { status: 'confirmed' }), 'Подтверждено') }, '✓ Подтвердить'),
        h('button.btn.small', { onclick: act(() => api('PUT', '/api/admin/payments/' + p.id, { status: 'rejected' }), 'Отклонено') }, 'Нет перевода'))))));
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
  return h('section.card.coll' + (c.closed ? '.closed' : ''),
    h('div.row.between', h('div.title.grow', c.title, c.separate ? h('span.pill.blue', { style: 'margin-left:6px' }, 'досбор') : null), c.closed ? h('span.pill.ok', '✓ закрыт') : c.due_date ? h('span.pill.blue', 'до ' + fdate(c.due_date)) : null),
    h('div.meta', (c.amount ? rub(c.amount) + ' с ребёнка' : 'Сумма свободная') + (c.pay_link ? '' : ' · ⚠ нет ссылки на оплату'), c.pay_link ? h('span.bankchips', { style: 'margin-left:8px' }, payLinks(c).map(b => h('a', { href: b.url, target: '_blank', rel: 'noopener', title: b.name }, bankIcon(b)))) : null),
    progress(c),
    h('div.row.between.small', h('span', `Сдали ${paid} из ${active.length}`,
      (n => n ? h('span.pill.bad.debtpill', { style: 'margin-left:6px' }, n + ' с долгом') : null)(active.filter(s => statusOf(S, c, s.id).s === 'partial').length), c.pending ? h('span.pill.warn', { style: 'margin-left:6px' }, c.pending + ' на проверке') : null),
      h('span.muted', `${rub(c.collected)}${c.expected ? ' из ' + rub(c.expected) : ''}${c.spent ? ' · потрачено ' + rub(c.spent) : ''}`)),
    h('div.row', { style: 'margin-top:10px' },
      h('button.btn.small', { onclick: () => collectionDialog(c) }, 'Изменить'),
      h('button.btn.small', { onclick: () => remind(c) }, 'Текст для чата'),
      h('button.btn.small', { onclick: act(() => api('PUT', '/api/admin/collections/' + c.id, { ...c, closed: !c.closed }), c.closed ? 'Сбор снова открыт' : 'Сбор закрыт') }, c.closed ? '↺ Открыть снова' : '✓ Закрыть сбор'),
      null),
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
    } else if (st.s === 'partial') {
      status = h('span.pill.bad', `оплачено ${rub(st.amount)} · долг ${rub(st.debt)}`);
      actions = [pend && shotBtn(pend), pend && h('button.btn.ok.small', { onclick: act(() => api('PUT', '/api/admin/payments/' + pend.id, { status: 'confirmed' })) }, '✓ доплату'),
        !pend && h('button.btn.small', { onclick: () => markPaid(c, s, st.debt) }, 'Отметить доплату'),
        h('button.btn.small', { onclick: act(() => Promise.all(conf.map(p => p.source === 'treasurer' ? api('DELETE', '/api/admin/payments/' + p.id) : api('PUT', '/api/admin/payments/' + p.id, { status: 'pending' })))) }, 'Отменить')].filter(Boolean);
    } else if (st.s === 'pending') {
      status = h('span.pill.warn', 'на проверке ' + rub(pend.amount));
      actions = [shotBtn(pend), h('button.btn.ok.small', { onclick: act(() => api('PUT', '/api/admin/payments/' + pend.id, { status: 'confirmed' })) }, '✓'),
        h('button.btn.small.danger', { onclick: act(() => api('PUT', '/api/admin/payments/' + pend.id, { status: 'rejected' })) }, '✕')];
    } else {
      status = h('span.pill', 'не оплачено');
      actions = [h('button.btn.small', { onclick: () => markPaid(c, s) }, 'Отметить оплату')];
    }
    return h('tr', { class: (s.active ? '' : 'out') + (st.s === 'partial' ? ' debt' : '') }, h('td', s.name), h('td', status), h('td', h('div.actions', actions)));
  });
  return h('div.tbl-scroll', { style: 'margin-top:8px' }, h('table.tbl', h('tbody', rows)));
}

function markPaid(c, s, def) {
  const amount = h('input', { type: 'number', inputmode: 'numeric', min: 1, value: def || c.amount || '', required: true });
  const note = h('input', { placeholder: 'Например: наличными', maxlength: 300 });
  const file = h('input', { type: 'file', accept: 'image/*' });
  const close = modal('Отметить оплату', h('form.form', {
    onsubmit: async e => { e.preventDefault(); e.submitter && (e.submitter.disabled = true);
      const image = file.files[0] ? await compressImage(file.files[0]) : null;
      await act(() => api('POST', '/api/admin/payments', { collection_id: c.id, student_id: s.id, amount: amount.value, note: note.value, image }), 'Отмечено')(); close(); },
  }, h('p', h('b', s.name), h('br'), h('span.muted', c.title)), h('label.field', 'Сумма, ₽', amount), h('label.field', 'Комментарий', note),
     h('label.field', 'Чек или скриншот перевода (необязательно)', file),
     h('button.btn.primary', { type: 'submit' }, 'Сохранить')));
}

function collectionDialog(c) {
  const isNew = !c; c = c || { title: '', description: '', amount: '', due_date: '', pay_link: '', closed: 0, separate: 1 };
  const f = {
    title: h('input', { value: c.title, required: true, maxlength: 150, placeholder: 'Например: Подарки к Новому году' }),
    amount: h('input', { type: 'number', inputmode: 'numeric', min: 0, value: c.amount, placeholder: '0 — если сумма свободная' }),
    due_date: h('input', { type: 'date', value: c.due_date || '' }),
    description: h('textarea', { placeholder: 'На что собираем, подробности' }, c.description),
    closed: h('input', { type: 'checkbox', checked: !!c.closed }),
    separate: h('select', h('option', { value: '1', selected: !!c.separate }, 'Досбор — на конкретное дело (кино, фото, подарок)'), h('option', { value: '', selected: !c.separate }, 'Взнос в кассу класса')),
  };
  const links = h('div');
  const addLink = v => {
    const chip = h('span');
    const inp = h('input', { type: 'url', value: v || '', placeholder: 'https://… ссылка на сбор' });
    const upd = () => chip.replaceChildren(inp.value.trim() ? bankIcon(bankOf(inp.value.trim())) : h('span.bankic', { style: 'background:var(--line)' }, '?'));
    inp.addEventListener('input', upd); upd();
    const row = h('div.linkrow', chip, inp, h('button.icon-btn', { type: 'button', 'aria-label': 'Убрать', onclick: () => row.remove() }, '✕'));
    links.append(row);
  };
  const cur = String(c.pay_link || '').split(/\s+/).filter(Boolean);
  let qrRemove = false;
  const qrFile = h('input', { type: 'file', accept: 'image/*' });
  const qrBox = h('div', c.qr ? h('div.row', h('img', { src: '/uploads/' + c.qr, alt: 'QR', style: 'width:72px;height:72px;object-fit:contain;border-radius:8px;border:1px solid var(--line)' }),
    h('button.linklike', { type: 'button', onclick: e => { qrRemove = true; e.target.closest('.row').remove(); } }, 'убрать QR')) : null, qrFile);
  (cur.length ? cur : ['']).forEach(addLink);
  const close = modal(isNew ? 'Новый сбор' : 'Изменить сбор', h('form.form', {
    onsubmit: async e => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
      body.pay_link = [...links.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean).join('\n');
      if (qrFile.files[0]) body.qr = await compressImage(qrFile.files[0], 1000); else if (qrRemove) body.qr_remove = true;
      try { await api(isNew ? 'POST' : 'PUT', '/api/admin/collections' + (isNew ? '' : '/' + c.id), body); close(); toast('Сохранено'); load(); }
      catch (err) { toast(err.message, true); }
    },
  },
    h('label.field', 'Тип сбора', f.separate),
    h('label.field', 'Название', f.title),
    h('div.two', h('label.field', 'С каждого ребёнка, ₽', f.amount), h('label.field', 'Сдать до', f.due_date)),
    h('div.field', h('span', 'Ссылки на сбор в банках'), links,
      h('button.linklike', { type: 'button', onclick: () => addLink('') }, '+ ещё банк'),
      h('span.hint', 'Создайте сбор в приложении банка и вставьте ссылку. Можно в нескольких банках: у родителей появится выбор со значками банков.')),
    h('div.field', h('span', 'QR-код для оплаты (необязательно)'), qrBox,
      h('span.hint', 'Скриншот QR-кода сбора из приложения банка. Его можно оплатить из приложения любого банка.')),
    h('label.field', 'Описание', f.description),
    !isNew ? h('label.check', f.closed, 'Сбор закрыт (кнопка оплаты у родителей скроется)') : null,
    h('div.row.between',
      h('button.btn.primary', { type: 'submit' }, 'Сохранить'),
      !isNew ? h('button.linklike.danger-text', { type: 'button', onclick: async () => {
        if (!confirmInline(close, `Удалить сбор «${c.title}» вместе со всеми отметками об оплате?`, async () => { await api('DELETE', '/api/admin/collections/' + c.id); toast('Удалено'); load(); })) return;
      } }, 'удалить сбор') : null)));
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
  const debts = S.students.filter(s => s.active).map(s => [s, statusOf(S, c, s.id)]).filter(([, x]) => x.s === 'partial').map(([s, x]) => `${s.name} (${rub(x.debt)})`);
  const url = classUrl();
  const ownPrices = /₽|руб/i.test(c.description || '');
  const text = `Уважаемые родители! Идёт сбор «${c.title}»` + (c.amount && !ownPrices ? ` — ${rub(c.amount)} с ребёнка` : '') + (c.due_date ? `, до ${fdate(c.due_date)}` : '') + '.\n' +
    (c.description ? c.description.trim() + '\n' : '') +
    payLinks(c).map(b => `Оплатить (${b.name}${b.note ? ', ' + b.note : ''}): ${b.url}\n`).join('') + `После оплаты отметьтесь, пожалуйста, на странице класса: ${url}\n` +
    (notPaid.length && notPaid.length < S.students.length ? `\nПока не сдали: ${notPaid.join(', ')}.` : '') +
    (debts.length ? `\nНужно доплатить: ${debts.join(', ')}.` : '');
  const ta = h('textarea', { rows: 9 }, text);
  modal('Текст для чата класса', h('div.form', ta, h('button.btn.primary', {
    onclick: async () => { try { await navigator.clipboard.writeText(ta.value); toast('Скопировано'); } catch { ta.select(); toast('Выделите и скопируйте текст'); } },
  }, 'Скопировать')));
}

// ---------- Расходы ----------
VIEWS['расходы'] = () => {
  const wrap = h('div.stack', h('div.row', h('button.btn.primary', { onclick: expenseDialog }, '+ Добавить расход с чеком')));
  if (!S.expenses.length) wrap.append(h('p.empty', 'Расходов пока нет.'));
  if (S.expenses.length) wrap.append(h('section.card', h('div.explist', S.expenses.map(e => expRow(e, S.collections.find(c => c.id === e.collection_id && c.separate)?.title || '',
    h('button.icon-btn', { 'aria-label': 'Ещё', title: 'Ещё', onclick: () => {
      const close = modal(e.title, h('div.form', h('p.muted', fdate(e.date) + ' · ' + rub(e.amount)),
        h('button.linklike.danger-text', { onclick: () => confirmInline(close, `Удалить расход «${e.title}» вместе с чеками? Вернуть будет нельзя.`, async () => { await api('DELETE', '/api/admin/expenses/' + e.id); toast('Удалено'); load(); }) }, 'Удалить этот расход')));
    } }, '⋯'))))));
  return wrap;
};

function expenseDialog() {
  const f = {
    title: h('input', { required: true, maxlength: 200, placeholder: 'Например: Сладкие подарки, 29 шт.' }),
    amount: h('input', { type: 'number', inputmode: 'decimal', min: 1, required: true }),
    date: h('input', { type: 'date', value: today() }),
    collection_id: h('select', h('option', { value: '' }, 'Касса класса'), S.collections.filter(c => c.separate).map(c => h('option', { value: c.id }, 'Досбор: ' + c.title))),
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
  const ta = h('textarea', { rows: 3, placeholder: 'ФИО ребёнка, дата рождения, ФИО родителя — по одному на строку (можно вставить из таблицы)' });
  const save = (s, patch) => api('PUT', '/api/admin/students/' + s.id, { full_name: s.full_name || s.name, birth: s.birth, parent: s.parent, phone: s.phone, active: s.active, ...patch });
  return h('div.stack',
    h('section.card', h('p.hint', 'Полные данные видите только вы. Родителям показываются только фамилия и имя. Чтобы поправить данные, нажмите на ребёнка.'),
      h('div.kidlist', S.students.map((s, i) => {
        return h('div.kid' + (s.active ? '' : '.out'), { onclick: () => editKid(s, save), role: 'button', tabindex: 0 },
          h('div.kid-n', i + 1),
          h('div.kid-main', h('div.kid-name', s.full_name || s.name, s.active ? null : h('span.pill', { style: 'margin-left:6px' }, 'выбыл')),
            h('div.kid-meta', s.birth ? '🎂 ' + s.birth : 'дата рождения не указана')),
          h('div.kid-parent', parentRows(s)),
          h('div.kid-edit', '✎'));
      }))),
    h('section.card.form', h('h3', 'Добавить детей или дополнить данные'), h('p.hint', 'Вставьте список из таблицы. Если ребёнок уже есть в списке, его дата рождения и родитель просто допишутся, дубля не будет.'), ta,
      h('button.btn', { onclick: act(async () => { await api('POST', '/api/admin/students', { names: ta.value }); }, 'Сохранено') }, 'Сохранить')));
};

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
function editKid(s, save) {
  const f = {
    full: h('input', { value: s.full_name || s.name, maxlength: 160 }),
    birth: h('input', { value: s.birth || '', maxlength: 20, placeholder: 'дд.мм.гггг' }),
    parent: h('textarea', { rows: 2, maxlength: 200 }, s.parent || ''),
    phone: h('input', { value: s.phone || '', maxlength: 200, type: 'tel', placeholder: '8-900-000-00-00, через запятую' }),
  };
  const close = modal('Данные ребёнка', h('form.form', {
    onsubmit: async e => { e.preventDefault(); await act(() => save(s, { full_name: f.full.value, birth: f.birth.value, parent: f.parent.value, phone: f.phone.value }), 'Сохранено')(); close(); },
  }, h('label.field', 'ФИО ребёнка', f.full), h('label.field', 'Дата рождения', f.birth), h('label.field', 'Родители', f.parent), h('label.field', 'Телефоны', f.phone),
    h('button.btn.primary', { type: 'submit' }, 'Сохранить'),
    h('button.linklike', { type: 'button', onclick: async () => { await act(() => save(s, { active: !s.active }))(); close(); } }, s.active ? 'Отметить, что ребёнок выбыл из класса' : 'Вернуть в класс')));
}

// Расписание: одна таблица — уроки по строкам, дни по столбцам, время звонков в первой колонке
function scheduleEditor(info) {
  const DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const SH = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const grid = DAYS.map(d => {
    const t = (info.timetable || []).find(x => (x.day || '').trim().toLowerCase() === d.toLowerCase());
    return t ? t.lessons.split('\n').map(x => x.trim()).map(x => /^[—-]+$/.test(x) ? '' : x) : [];
  });
  const times = (info.bells || []).map(b => b.from && b.to ? `${b.from}–${b.to}` : '');
  let rows = Math.max(6, times.length, ...grid.map(g => g.length));
  const sync = () => {
    info.bells = Array.from({ length: rows }, (_, i) => { const m = /(\d{1,2}[:.]\d{2})\D+(\d{1,2}[:.]\d{2})/.exec(times[i] || ''); const f = x => x.replace('.', ':').padStart(5, '0'); return m ? { from: f(m[1]), to: f(m[2]) } : { from: '', to: '' }; });
    while (info.bells.length && !info.bells[info.bells.length - 1].from) info.bells.pop();
    info.timetable = DAYS.map((d, j) => { const l = Array.from({ length: rows }, (_, i) => grid[j][i] || ''); while (l.length && !l[l.length - 1]) l.pop(); return { day: d, lessons: l.map(x => x || '—').join('\n') }; }).filter(d => d.lessons);
  };
  const body = h('tbody');
  const draw = () => body.replaceChildren(...Array.from({ length: rows }, (_, i) => h('tr',
    h('td.sn', i + 1),
    h('td', h('input.cell.time', { value: times[i] || '', placeholder: '08:00–08:40', oninput: e => { times[i] = e.target.value; sync(); } })),
    ...DAYS.map((_, j) => h('td', h('input.cell', { value: grid[j][i] || '', oninput: e => { grid[j][i] = e.target.value; sync(); } }))))));
  draw(); sync();
  return h('section.card', h('h3', '📅 Расписание уроков и звонков'),
    h('div.tbl-scroll', h('table.sched-edit', h('thead', h('tr', h('th', '№'), h('th', 'Время'), SH.map(x => h('th', x)))), body)),
    h('div.row', { style: 'margin-top:6px' },
      h('button.btn.small', { type: 'button', onclick: () => { rows++; draw(); } }, '+ урок'),
      h('button.btn.small', { type: 'button', onclick: () => { if (rows > 1) { rows--; grid.forEach(g => g.length = Math.min(g.length, rows)); times.length = Math.min(times.length, rows); sync(); draw(); } } }, '− урок'),
      h('span.hint', 'Пустая клетка — нет урока.')));
}

// ---------- Информация ----------
VIEWS['инфо'] = () => {
  const info = structuredClone(S.info); info.timetable ||= [];
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
    scheduleEditor(info),
    listEditor('Каникулы и выходные', 'holidays', [['title', 'Название'], ['from', 'С', 'date'], ['to', 'По', 'date']], { title: '', from: '', to: '' }, '.three'),
    listEditor('Учителя', 'teachers', [['role', 'Предмет или роль'], ['name', 'ФИО'], ['contact', 'Телефон / почта (необяз.)'], ['birth', 'ДР, дд.мм']], { role: '', name: '', contact: '', birth: '' }, '.four'),
    listEditor('Полезные ссылки', 'links', [['title', 'Название'], ['url', 'https://…', 'url']], { title: '', url: '' }),
    h('div.savebar', h('button.btn.primary.block', { onclick: save }, 'Сохранить')));
  return body;
};

// ---------- Календарь ----------
VIEWS['календарь'] = () => h('div.stack',
  h('label.check.card', { style: 'padding:10px 14px' }, h('input', { type: 'checkbox', checked: !!S.class.showBirthdays,
    onchange: act(e => api('PUT', '/api/admin/class', { title: S.class.title, treasurer: S.class.treasurer || '', payHint: S.class.payHint || '', showBirthdays: e.target.checked }), 'Сохранено') }),
    'Показывать родителям дни рождения детей (без года)'),
  calendarCard(S, true),
  h('p.hint', 'Дни рождения детей берутся из «Списка класса», учителей — из «Информации».'));

// ---------- Настройки ----------
VIEWS['настройки'] = () => {
  const f = {
    title: h('input', { value: S.class.title, maxlength: 100, placeholder: 'Например: 5 «Б» класс' }),
    treasurer: h('input', { value: S.class.treasurer, maxlength: 100, placeholder: 'Как к вам обращаться' }),
    payHint: h('textarea', { placeholder: 'Например: если не получается по ссылке — напишите мне в чат' }, S.class.payHint),
    opening: h('input', { type: 'number', inputmode: 'numeric', min: 0, value: S.opening?.amount || 0 }),
    openingNote: h('input', { value: S.opening?.note || '', maxlength: 200, placeholder: 'Например: остаток прошлых сборов' }),
    showBirthdays: h('input', { type: 'checkbox', checked: !!S.class.showBirthdays }),
  };
  return h('div.stack',
    h('section.card.form', h('h3', 'Класс'),
      h('label.field', 'Название (заголовок страницы)', f.title),
      h('label.field', 'Казначей', f.treasurer),
      h('label.field', 'Подсказка родителям при оплате', f.payHint),
      h('div.two', h('label.field', 'Остаток на начало, ₽ (входит в «Собрано»)', f.opening), h('label.field', 'Откуда остаток', f.openingNote)),
      h('label.check', f.showBirthdays, 'Показывать родителям дни рождения детей в календаре (только день и месяц)'),
      h('button.btn.primary', { onclick: act(() => api('PUT', '/api/admin/class', Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]))), 'Сохранено') }, 'Сохранить')),
    h('section.card', h('h3', 'Резервная копия'), h('p.hint', 'Скачайте все данные (сборы, оплаты, расходы) одним файлом.'),
      h('a.btn', { href: apiUrl('/api/admin/export') }, 'Скачать копию')),
    h('section.card.form', h('h3', 'Ссылка для родителей'),
      h('p.hint', 'Отправьте её в чат класса. Родителям не нужно регистрироваться.'),
      h('div.row', h('input.grow', { value: classUrl(), readonly: true, onclick: e => e.target.select() }),
        h('button.btn', { onclick: async () => { try { await navigator.clipboard.writeText(classUrl()); toast('Скопировано'); } catch { toast('Выделите и скопируйте'); } } }, 'Копировать'))));
};

start();


function confirmAll(list) {
  const close = modal('Подтвердить все?', h('div.form',
    h('p', `Отметить как оплаченные ${list.length} шт. на ${rub(list.reduce((a, p) => a + p.amount, 0))}? Проверьте, что все переводы пришли.`),
    h('div.row', h('button.btn.ok', { onclick: async () => { close(); await act(() => Promise.all(list.map(p => api('PUT', '/api/admin/payments/' + p.id, { status: 'confirmed' }))), 'Подтверждено')(); } }, '✓ Да, подтвердить'),
      h('button.btn', { onclick: () => close() }, 'Отмена'))));
}

// ---------- Уведомления на телефон ----------
function pushCard() {
  const box = h('section.card.push-card');
  const urlB64 = k => { const b = atob(k.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((k.length + 3) % 4)); return Uint8Array.from(b, ch => ch.charCodeAt(0)); };
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const render = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      box.replaceChildren(h('b', '🔔 Уведомления об оплатах'), h('p.small.muted', isIOS
        ? 'На iPhone сначала добавьте сайт на экран «Домой» (Поделиться → На экран «Домой»), откройте его оттуда и включите уведомления здесь.'
        : 'Этот браузер не умеет присылать уведомления. Откройте кабинет в Chrome, Edge или Safari.'));
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') {
      box.replaceChildren(h('div.row.between', h('span', '🔔 Уведомления об оплатах ', h('b', 'включены'), h('span.muted.small', ' на этом устройстве')),
        h('button.linklike', { onclick: async () => { await api('POST', '/api/admin/push/off', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); render(); } }, 'выключить')));
      return;
    }
    box.replaceChildren(h('div.row.between', h('div.grow', h('b', '🔔 Сразу узнавать об оплатах'), h('div.small.muted', 'На телефон: «Иванов Петя — 5 000 ₽, 01:32»')),
      h('button.btn.primary.small', { onclick: async e => {
        e.target.disabled = true;
        try {
          if (await Notification.requestPermission() !== 'granted') throw new Error('Уведомления запрещены в настройках браузера');
          const { key } = await api('GET', '/api/admin/push');
          const s2 = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
          await api('POST', '/api/admin/push', { ...s2.toJSON(), test: true });
          toast('Готово! Пришлём пробное уведомление');
        } catch (err) { toast(err.message, true); }
        render();
      } }, 'Включить')));
  };
  render().catch(() => {});
  return box;
}

// ---------- Сверка с банком ----------
const nrm = t => String(t || '').toLowerCase().replace(/ё/g, 'е');
const escRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function kidPatterns(s) {
  const pats = [];
  String(s.parent || '').split(/[,;\n]/).map(x => nrm(x).trim().split(/\s+/)).filter(x => x.length >= 2).forEach(([fam, im, ot]) => {
    if (ot) pats.push([new RegExp(`${escRe(im)}\\s+${escRe(ot)}\\s+${escRe(fam[0])}\\.?(?![а-я])`), 3]);
    pats.push([new RegExp(`${escRe(fam)}\\s+${escRe(im)}`), 3], [new RegExp(`${escRe(im)}\\s+${escRe(fam)}`), 3]);
    pats.push([new RegExp(`(^|[^а-я])${escRe(im)}\\s+${escRe(fam[0])}\\.`), 2]);
  });
  const [kf, ki] = nrm(s.name).split(/\s+/);
  if (ki) pats.push([new RegExp(`${escRe(kf)}\\s+${escRe(ki)}|${escRe(ki)}\\s+${escRe(kf)}`), 3]);
  if (kf && kf.length > 3) pats.push([new RegExp(`(^|[^а-я])${escRe(kf.slice(0, -1))}`), 1]);
  return pats;
}
function parseBank(text) {
  const lines = String(text).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const AMT = /([+]?\s?\d{1,3}(?:[\s  ]\d{3})+|[+]?\d{3,7})(?:[.,](\d{2}))?\s*(?:₽|руб|р\.|rub)/i;
  const out = []; let start = 0;
  lines.forEach((ln, i) => {
    const m = ln.match(AMT); if (!m) return;
    if (/^-|−|списан|оплата товаров/i.test(ln.trim()) && !/^\+/.test(m[1].trim())) { start = i + 1; return; }
    out.push({ amount: Math.round(Number(m[1].replace(/[^\d]/g, '')) + (m[2] ? Number(m[2]) / 100 : 0)), text: lines.slice(start, i + 1).join(' · '), extra: lines[i + 1] || '' });
    start = i + 1;
  });
  return out;
}
function matchKid(rec, kids) {
  const tryText = t => {
    const scored = kids.map(s => ({ s, sc: Math.max(0, ...s._p.filter(([re]) => re.test(nrm(t))).map(([, w]) => w)) })).filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc);
    if (!scored.length) return null;
    if (scored.length > 1 && scored[0].sc === scored[1].sc) return null;
    return scored[0].s;
  };
  return tryText(rec.text) || tryText(rec.extra);
}
function reconcileDialog() {
  const open = S.collections.filter(c => !c.closed);
  if (!open.length) { toast('Нет открытых сборов', true); return; }
  const sel = h('select', open.map(c => h('option', { value: c.id }, c.title + (c.amount ? ` · ${rub(c.amount)}` : ''))));
  const ta = h('textarea', { rows: 8, placeholder: 'Скопируйте сюда список участников сбора или историю поступлений из приложения банка.\nНапример:\nАнна Сергеевна И.  +5 000 ₽\nОльга Петровна С.  +5 000 ₽' });
  const res = h('div');
  const run = () => {
    const c = open.find(x => x.id === Number(sel.value));
    const kids = S.students.filter(s => s.active).map(s => Object.assign(s, { _p: kidPatterns(s) }));
    const recs = parseBank(ta.value);
    if (!recs.length) { res.replaceChildren(h('p.small.muted', 'Не нашла сумм. Скопируйте строки, где есть имя и сумма в ₽.')); return; }
    const rows = recs.map(r => {
      const kid = matchKid(r, kids);
      const pick = h('select.small', h('option', { value: '' }, '— не учитывать —'), kids.map(s => h('option', { value: s.id, selected: kid?.id === s.id }, s.name)));
      const info = h('span.small');
      const upd = () => {
        const s = kids.find(k => k.id === Number(pick.value));
        if (!s) { info.textContent = kid ? '' : 'не узнала — выберите ребёнка'; info.className = 'small muted'; return; }
        const st = statusOf(S, c, s.id);
        info.className = 'small ' + (st.s === 'paid' ? 'muted' : 'ok-text');
        info.textContent = st.s === 'paid' ? 'уже отмечено' : st.s === 'pending' ? 'есть отметка родителя → подтвердить' : st.s === 'partial' ? 'доплата' : 'отметить оплату';
      };
      pick.addEventListener('change', upd); upd();
      return { r, pick, el: h('div.recon-row', h('div.recon-head', h('span.small.recon-text', r.text), h('b', rub(r.amount))), h('div.row', pick, info)) };
    });
    const go = h('button.btn.ok.block', { onclick: async () => {
      const todo = rows.map(x => ({ x, s: Number(x.pick.value) })).filter(y => y.s && statusOf(S, c, y.s).s !== 'paid');
      if (!todo.length) { toast('Нечего отмечать'); return; }
      go.disabled = true;
      try {
        for (const { x, s } of todo) {
          const pend = S.payments.find(p => p.collection_id === c.id && p.student_id === s && p.status === 'pending');
          if (pend) await api('PUT', '/api/admin/payments/' + pend.id, { status: 'confirmed', amount: x.r.amount });
          else await api('POST', '/api/admin/payments', { collection_id: c.id, student_id: s, amount: x.r.amount, note: 'сверка с банком: ' + x.r.text.slice(0, 200) });
        }
        close(); toast(`Отмечено: ${todo.length}`); load();
      } catch (e) { toast(e.message, true); go.disabled = false; }
    } }, 'Отметить оплаты');
    const found = rows.filter(x => x.pick.value).length;
    res.replaceChildren(h('p.small', `Нашла переводов: ${recs.length}, узнала детей: ${found}. Проверьте и поправьте, где нужно.`), ...rows.map(x => x.el), go);
  };
  const close = modal('Сверка с банком', h('div.form',
    h('label.field', 'Сбор', sel),
    h('label.field', 'Переводы из банка', ta),
    h('span.hint', 'Узнаю детей по ФИО родителей из «Списка класса» (например «Анна Сергеевна И.») или по фамилии ребёнка в комментарии к переводу.'),
    h('button.btn.primary', { onclick: run }, 'Найти, кто заплатил'), res), { wide: true });
}
