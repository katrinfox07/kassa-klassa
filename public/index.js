'use strict';
// Общая страница для родителей
let S = null;

async function load() {
  try { S = await api('GET', '/api/public'); }
  catch (e) { $('#main').replaceChildren(h('p.empty', 'Не удалось загрузить данные. Обновите страницу.')); return; }
  document.title = S.class.title;
  $('#title').textContent = S.class.title;
  $('#sub').textContent = '';
  $('#install').replaceChildren(installButton() || '');
  $('#totals').replaceChildren(
    h('div.total', h('div.label', 'Собрано'), h('div.value', rub(S.totals.collected))),
    h('div.total', h('div.label', 'Потрачено'), h('div.value', rub(S.totals.spent))),
    h('div.total.main', h('div.label', 'В кассе'), h('div.value', rub(S.totals.balance))));
  tabs($('#tabs'), [
    { id: 'сборы', label: 'Сборы' },
    { id: 'расходы', label: 'Расходы и чеки' },
    { id: 'инфо', label: 'Информация' },
  ], show);
}

function show(id) {
  const m = $('#main');
  if (id === 'сборы') m.replaceChildren(collectionsView());
  if (id === 'расходы') m.replaceChildren(expensesView());
  if (id === 'инфо') m.replaceChildren(renderInfo(S.info));
}

function collectionsView() {
  const wrap = h('div.stack');
  if (!S.collections.length) return h('p.empty', 'Сборов пока нет.');
  const open = S.collections.filter(c => !c.closed), done = S.collections.filter(c => c.closed);
  open.forEach(c => wrap.append(collectionCard(c)));
  if (done.length) wrap.append(h('h3', { style: 'margin:12px 0 0' }, 'Завершённые сборы'), ...done.map(c => collectionCard(c)));
  return wrap;
}

function collectionCard(c) {
  const kids = S.students.map(s => ({ s, st: statusOf(S, c, s.id) }));
  const paid = kids.filter(k => k.st.s === 'paid').length;
  const dl = c.due_date ? daysLeft(c.due_date) : null;
  const due = c.due_date ? h('span.pill' + (c.closed ? '' : dl < 0 ? '.bad' : dl <= 3 ? '.warn' : '.blue'),
    c.closed ? 'закрыт' : dl < 0 ? 'срок прошёл' : dl === 0 ? 'до сегодня' : 'до ' + fdate(c.due_date)) : c.closed ? h('span.pill.ok', '✓ закрыт') : null;
  return h('section.card.coll',
    h('div.row.between', h('div.title.grow', c.title, c.separate ? h('span.pill.blue', { style: 'margin-left:6px' }, 'досбор') : null), due),
    h('div.meta', c.amount ? `${rub(c.amount)} с ребёнка` : 'Сумма свободная'),
    c.description ? h('p.pre', { style: 'margin-top:8px' }, c.description) : null,
    progress(c),
    h('div.row.between.small', h('span', `Сдали полностью ${paid} из ${S.students.length}`, (n => n ? h('span.muted', ` · частично ${n}`) : null)(kids.filter(k => k.st.s === 'partial').length)), h('span.muted', `${rub(c.collected)}${c.expected ? ' из ' + rub(c.expected) : ''}`)),
    !c.closed ? h('div.row', { style: 'margin-top:12px' }, h('button.btn.primary.grow', { onclick: () => payDialog(c) }, 'Оплатить')) : null,
    h('details.more', h('summary', 'Кто сдал'),
      h('ul.kids', kids.map(({ s, st }) => h('li.' + st.s,
        h('span.ic', st.s === 'paid' ? '✓' : st.s === 'pending' ? '…' : st.s === 'partial' ? '!' : '✕'),
        h('span.name', s.name),
        h('span.paid-sum', st.s === 'paid' ? rub(st.amount) : st.s === 'partial' ? rub(st.amount) : st.s === 'pending' ? 'проверка' : '0 ₽'),
        st.s === 'partial' ? h('span.debt', 'долг ' + rub(st.debt)) : null))),
      h('p.hint', { style: 'margin-top:8px' }, 'Рядом с именем — сколько оплачено. Зелёный — оплачено полностью, красный — не оплачено или есть долг, жёлтый — ждёт подтверждения.')));
}

function payDialog(c) {
  const sel = h('select', { required: true }, h('option', { value: '' }, 'Выберите ребёнка'),
    S.students.map(s => {
      const x = statusOf(S, c, s.id), st = x.s;
      return h('option', { value: s.id, disabled: st === 'paid', 'data-debt': x.debt || '' }, s.name + (st === 'paid' ? ' — оплачено' : st === 'partial' ? ' — доплатить ' + rub(x.debt) : st === 'pending' ? ' — ждёт подтверждения' : ''));
    }));
  const amount = h('input', { type: 'number', inputmode: 'numeric', min: 1, value: c.amount || '', required: true });
  sel.addEventListener('change', () => { const d = sel.selectedOptions[0]?.dataset.debt; amount.value = d || c.amount || ''; });
  const payer = h('input', { placeholder: 'Например: мама, Анна', maxlength: 120 });
  const file = h('input', { type: 'file', accept: 'image/*' });
  const btn = h('button.btn.primary.block', { type: 'submit' }, 'Отправить');
  const form = h('form.form', {
    onsubmit: async e => {
      e.preventDefault();
      btn.disabled = true; btn.textContent = 'Отправляем…';
      try {
        const image = file.files[0] ? await compressImage(file.files[0]) : null;
        await api('POST', '/api/report-payment', { collection_id: c.id, student_id: sel.value, amount: amount.value, payer: payer.value, image });
        close(); toast('Спасибо! Казначей подтвердит оплату.'); if (SLUG) $('#adminlink').href = '/c/' + SLUG + '/admin';
load();
      } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Отправить'; }
    },
  },
    h('label.field', 'За кого', sel),
    h('label.field', 'Сумма, ₽', amount),
    h('label.field', 'Кто платил (необязательно)', payer),
    h('label.field', 'Скриншот перевода (необязательно)', file),
    btn);

  const steps = h('div.steps',
    h('div.step', h('div',
      h('b', 'Переведите деньги'),
      c.pay_link
        ? [h('p.small.muted', 'Откроется страница сбора в банке. Оплатить можно с карты любого банка или по СБП.'),
           h('a.btn.primary.block', { href: c.pay_link, target: '_blank', rel: 'noopener' }, `Перейти к оплате${c.amount ? ' ' + rub(c.amount) : ''}`)]
        : h('p.small.muted', 'Ссылка на оплату пока не добавлена.'),
      S.class.payHint ? h('p.small.pre', { style: 'margin-top:8px' }, S.class.payHint) : null)),
    h('div.step', h('div', h('b', 'Отметьте, что оплатили'), h('p.small.muted', 'Так казначей быстрее найдёт ваш перевод.'), form)));
  const close = modal(c.title, steps);
}

function expensesView() {
  if (!S.expenses.length) return h('p.empty', 'Расходов пока нет.');
  const byColl = id => S.collections.find(c => c.id === id)?.title;
  return h('div.stack', S.expenses.map(e => h('section.card',
    h('div.exp', h('div.grow',
      h('div', h('b', e.title)),
      h('div.muted.small', fdate(e.date), byColl(e.collection_id) ? ' · ' + byColl(e.collection_id) : ''),
      e.note ? h('p.small.pre', { style: 'margin-top:6px' }, e.note) : null),
      h('div.sum', rub(e.amount))),
    e.receipts.length ? h('div.thumbs', e.receipts.map(src => h('button', { onclick: () => viewImage(src), 'aria-label': 'Открыть чек' }, h('img', { src, alt: 'Чек', loading: 'lazy' })))) :
      h('div.hint', { style: 'margin-top:6px' }, 'Чек не приложен'))));
}

if (SLUG) $('#adminlink').href = '/c/' + SLUG + '/admin';
load();
