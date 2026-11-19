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
    { id: 'инфо', label: 'Информация' },
    { id: 'класс', label: 'Список класса' },
    { id: 'расходы', label: 'Расходы и чеки' },
    ...(S.books?.length ? [{ id: 'учебники', label: 'Учебники' }] : []),
  ], show);
}

function show(id) {
  const m = $('#main');
  if (id === 'сборы') m.replaceChildren(collectionsView());
  if (id === 'расходы') m.replaceChildren(expensesView());
  if (id === 'класс') m.replaceChildren(rosterView());
  if (id === 'инфо') m.replaceChildren(renderInfo(S.info));
  if (id === 'учебники') m.replaceChildren(h('section.card', h('h3', '📚 Учебники'), h('p.small.muted', 'Нажмите на учебник, чтобы читать. Листайте вниз, кнопки «+» и «−» увеличивают страницу.'), booksGrid(S.books)));
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
  const kids = S.students.filter(s => inColl(c, s) || S.payments.some(p => p.student_id === s.id && p.collection_id === c.id)).map(s => ({ s, st: statusOf(S, c, s.id) }));
  const paid = kids.filter(k => k.st.s === 'paid').length;
  const dl = c.due_date ? daysLeft(c.due_date) : null;
  const due = c.due_date ? h('span.pill' + (c.closed ? '' : dl < 0 ? '.bad' : dl <= 3 ? '.warn' : '.blue'),
    c.closed ? 'закрыт' : dl < 0 ? 'срок прошёл' : dl === 0 ? 'до сегодня' : 'до ' + fdate(c.due_date)) : c.closed ? h('span.pill.ok', '✓ закрыт') : null;
  return h('section.card.coll' + (c.closed ? '.closed' : ''),
    h('div.row.between', h('div.title.grow', c.title, c.separate ? h('span.pill.blue', { style: 'margin-left:6px' }, 'досбор') : null), due),
    /₽|руб/i.test(c.description || '') ? null : h('div.meta', c.amount ? `${c.flex ? 'от ' : ''}${rub(c.amount)} с ребёнка` : 'Сумма свободная'),
    c.description ? h('p.pre', { style: 'margin-top:8px' }, c.description) : null,
    c.expected ? progress(c) : null,
    h('div.row.between.small', h('span', `Сдали ${paid} из ${kids.length}`, (n => n ? h('span.muted', ` · частично ${n}`) : null)(kids.filter(k => k.st.s === 'partial').length)), h('span.muted', `${rub(c.collected)}${c.expected ? ' из ' + rub(c.expected) : ''}`)),
    !c.closed ? h('div.row', { style: 'margin-top:12px' }, h('button.btn.primary.grow', { onclick: () => payDialog(c) }, 'Оплатить')) : null,
    h('details.more', h('summary', 'Кто сдал'),
      h('ul.kids', kids.map(({ s, st }) => h('li.' + st.s,
        h('span.ic', st.s === 'paid' || st.s === 'partial' ? '✓' : st.s === 'pending' ? '…' : '✕'),
        h('span.name', s.name),
        h('span.paid-sum', st.s === 'paid' ? rub(st.amount) : st.s === 'partial' ? rub(st.amount) : st.s === 'pending' ? 'проверка' : '0 ₽'),
        st.s === 'partial' ? h('span.debt', 'долг ' + rub(st.debt)) : null))),
      h('p.hint', { style: 'margin-top:8px' }, 'Рядом с именем - сколько оплачено. Зелёный - оплачено, оранжевым - сколько осталось доплатить, красный - не оплачено, жёлтый - ждёт подтверждения.')));
}

function payDialog(c) {
  const sel = h('select', { required: true }, h('option', { value: '' }, 'Выберите ребёнка'),
    S.students.filter(s => inColl(c, s)).map(s => {
      const x = statusOf(S, c, s.id), st = x.s;
      return h('option', { value: s.id, disabled: st === 'paid', 'data-debt': x.debt || '' }, s.name + (st === 'paid' ? ' - оплачено' : st === 'partial' ? ' - доплатить ' + rub(x.debt) : st === 'pending' ? ' - ждёт подтверждения' : ''));
    }));
  const amount = h('input', { type: 'number', inputmode: 'numeric', min: 1, value: c.amount || '', required: true });
  sel.addEventListener('change', () => { const d = sel.selectedOptions[0]?.dataset.debt; amount.value = d || c.amount || ''; });
  const file = h('input', { type: 'file', accept: 'image/*' });
  const btn = h('button.btn.primary.block', { type: 'submit' }, 'Отправить');
  const form = h('form.form', {
    onsubmit: async e => {
      e.preventDefault();
      btn.disabled = true; btn.textContent = 'Отправляем…';
      try {
        const image = file.files[0] ? await compressImage(file.files[0]) : null;
        await api('POST', '/api/report-payment', { collection_id: c.id, student_id: sel.value, amount: amount.value, image });
        close(); toast('Спасибо! Казначей подтвердит оплату.'); if (SLUG) $('#adminlink').href = '/c/' + SLUG + '/admin';
load();
      } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Отправить'; }
    },
  },
    h('label.field', 'За кого', sel),
    h('label.field', 'Сумма, ₽', amount),
    h('label.field', 'Скриншот перевода (необязательно)', file),
    btn);

  const steps = h('div.steps',
    h('div.step', h('div',
      h('b', 'Переведите деньги'),
      c.pay_link
        ? [h('p.small.muted', (payLinks(c).length > 1 ? 'Выберите банк, откроется страница сбора' : 'Откроется страница сбора в банке') + (c.amount ? ` · ${rub(c.amount)}` : '') + '.'),
           h('div.banks', payLinks(c).map(bankButton))]
        : c.qr ? null
        : h('p.small.muted', 'Ссылка на оплату пока не добавлена.'),
      c.qr ? h('details.qrpay', { open: !c.pay_link },
        h('summary', '📷 Оплатить по QR-коду из любого банка'),
        h('img.qrimg', { src: '/uploads/' + c.qr, alt: 'QR-код для оплаты' }),
        h('p.small.muted', 'С другого устройства: отсканируйте камерой в приложении своего банка. С этого телефона: сохраните картинку, затем в приложении банка «Оплата по QR» → «Из галереи».'),
        h('a.btn.small', { href: '/uploads/' + c.qr, download: 'qr-' + c.id + '.png' }, 'Сохранить QR')) : null,
      S.class.payHint ? h('p.small.pre', { style: 'margin-top:8px' }, S.class.payHint) : null)),
    h('div.step', h('div', h('b', 'Отметьте, что оплатили'), h('p.small.muted', 'Ваша отметка появится в списке и будет ожидать подтверждения.'), form)));
  const close = modal(c.title, steps);
}

function expensesView() {
  if (!S.expenses.length) return h('p.empty', 'Расходов пока нет.');
  const byColl = id => S.collections.find(c => c.id === id && c.separate)?.title;
  const total = S.expenses.reduce((a, e) => a + e.amount, 0);
  return h('section.card', h('div.row.between', h('h3', '🧾 Расходы'), h('span.muted.small', `${S.expenses.length} шт. · ${rub(total)}`)),
    h('div.explist', S.expenses.map(e => expRow(e, byColl(e.collection_id)))));
}

if (SLUG) $('#adminlink').href = '/c/' + SLUG + '/admin';
load();

let ROSTER = null;
function rosterView() {
  const box = h('section.card');
  const draw = () => {
    if (ROSTER) {
      box.replaceChildren(h('div.row.between', h('h3', 'Список класса'), h('span.muted.small', ROSTER.length + ' детей')),
        h('div.kidlist', ROSTER.map((s, i) => h('div.kid', h('div.kid-n', i + 1),
          h('div.kid-main', h('div.kid-name', s.full_name || s.name), s.birth ? h('div.kid-meta', '🎂 ' + s.birth) : null),
          h('div.kid-parent', parentRows(s))))));
      return;
    }
    if (!S.class.hasList) { box.replaceChildren(h('h3', 'Список класса'), h('p.small.muted', 'Загружаем…')); api('POST', '/api/roster', {}).then(r => { ROSTER = r.students; draw(); }).catch(e => toast(e.message, true)); return; }
    const inp = h('input', { inputmode: 'numeric', placeholder: 'Код класса', autocomplete: 'off', style: 'max-width:180px' });
    const go = async code => {
      try { ROSTER = (await api('POST', '/api/roster', { code })).students; try { localStorage.setItem('roster-' + SLUG, code); } catch { } draw(); }
      catch (e) { if (inp.isConnected) toast(e.message, true); try { localStorage.removeItem('roster-' + SLUG); } catch { } }
    };
    box.replaceChildren(h('h3', 'Список класса'), h('p.small.muted', 'Здесь ФИО детей, даты рождения и телефоны родителей. Введите код класса - его знает казначей и присылает в чат класса.'),
      h('form.row', { onsubmit: e => { e.preventDefault(); go(inp.value.trim()); } }, inp, h('button.btn.primary', { type: 'submit' }, 'Открыть')));
    let saved = null; try { saved = localStorage.getItem('roster-' + SLUG); } catch { }
    if (saved) go(saved);
  };
  draw();
  return box;
}
