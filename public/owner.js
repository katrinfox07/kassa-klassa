'use strict';
// Кабинет владельца сервиса: все классы и продление подписок
async function start() {
  let d;
  try { d = await api('GET', '/api/owner/classes'); }
  catch (e) { $('#main').replaceChildren(h('p.empty', e.status === 401 ? 'Войдите' : 'Нет доступа', ' · ', h('a', { href: '/account?next=' }, 'Мои классы'))); return; }
  $('#sub').textContent = 'Кабинет владельца';
  $('#head-actions').replaceChildren(h('a.btn.small', { href: '/account' }, 'Мои классы'));
  const active = d.classes.filter(c => c.paid_until >= d.today).length;
  const paying = d.classes.filter(c => c.paid_total > 0).length;
  const list = h('div.stack');
  const filter = h('input', { placeholder: 'Поиск по названию, адресу или почте', oninput: () => draw() });
  const draw = () => {
    const f = filter.value.toLowerCase();
    list.replaceChildren(...d.classes.filter(c => !f || (c.title + c.slug + c.email).toLowerCase().includes(f)).map(c => {
      const left = daysLeft(c.paid_until);
      return h('section.card',
        h('div.row.between', h('div.grow', h('b', c.title), h('div.small.muted', c.email, c.name ? ' · ' + c.name : '')),
          h('span.pill' + (left < 0 ? '.bad' : c.paid_total ? '.ok' : '.blue'), left < 0 ? 'истекла ' + fdate(c.paid_until) : (c.paid_total ? 'оплачено до ' : 'пробный до ') + fdate(c.paid_until))),
        h('div.small.muted', { style: 'margin:6px 0 10px' }, `${c.kids} детей · ${c.colls} сборов · создан ${fdate(c.created_at)} · получено ${rub(c.paid_total)}`),
        h('div.row',
          h('a.btn.small', { href: '/c/' + c.slug + '/admin' }, 'Кабинет'),
          h('a.btn.small', { href: '/c/' + c.slug, target: '_blank' }, 'Страница'),
          h('button.btn.small.primary', { onclick: () => extend(c, d.price) }, '+ год')));
    }));
  };
  draw();
  $('#main').replaceChildren(h('div.stack',
    h('div.totals', h('div.total', h('div.label', 'Классов'), h('div.value', d.classes.length)),
      h('div.total', h('div.label', 'Активных'), h('div.value', active)),
      h('div.total.main', h('div.label', 'Получено'), h('div.value', rub(d.income)))),
    h('p.hint', `Аккаунтов: ${d.users}. Платящих классов: ${paying}.`), filter, list));
}
function extend(c, price) {
  const amount = h('input', { type: 'number', value: price, min: 0 });
  const close = modal('Продлить на год', h('form.form', { onsubmit: async e => { e.preventDefault(); try { await api('POST', `/api/owner/classes/${c.id}/extend`, { days: 365, amount: amount.value }); close(); toast('Продлено'); start(); } catch (err) { toast(err.message, true); } } },
    h('p', h('b', c.title), h('br'), h('span.muted', 'Используйте, если оплата пришла вручную (перевод, наличные).')), h('label.field', 'Получено, ₽', amount), h('button.btn.primary', { type: 'submit' }, 'Продлить')));
}
start();
