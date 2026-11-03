const view = document.getElementById('view');
const topEl = document.getElementById('top');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Ошибка'), { status: r.status });
  return data;
}

// Матрица -> HTML (массив массивов); скаляры и текст выводятся как есть
function mat(a) {
  const n = a[0].length;
  return '<span class="mat" style="grid-template-columns:repeat(' + n + ',auto)">' +
    a.flat().map(v => '<span>' + esc(v) + '</span>').join('') + '</span>';
}
const val = v => Array.isArray(v) ? mat(v) : esc(v);

function header(me) {
  topEl.innerHTML = '<b>' + (me ? esc(me.username) + (me.role === 'admin' ? ' (администратор)' : '') : '') + '</b>' +
    (me ? '<button class="sec" id="lo">Выйти</button>' : '');
  if (me) document.getElementById('lo').onclick = async () => { await api('/api/logout', 'POST'); init(); };
}

function authView(allowReg) {
  header(null);
  view.innerHTML = '<div class="card"><h1>Вход</h1>' +
    '<label>Логин<input type="text" id="u" autocomplete="username"></label>' +
    '<label>Пароль<input type="password" id="p" autocomplete="current-password"></label>' +
    '<div class="row"><button id="in">Войти</button>' +
    (allowReg ? '<button class="sec" id="reg">Зарегистрироваться</button>' : '') + '</div>' +
    '<p id="err" class="bad"></p></div>';
  const go = path => async () => {
    try {
      await api(path, 'POST', { username: u.value.trim(), password: p.value });
      init();
    } catch (e) { document.getElementById('err').textContent = e.message; }
  };
  document.getElementById('in').onclick = go('/api/login');
  if (allowReg) document.getElementById('reg').onclick = go('/api/register');
  p.onkeydown = e => { if (e.key === 'Enter') document.getElementById('in').click(); };
}

async function testView() {
  const t = await api('/api/test');
  if (t.done) {
    view.innerHTML = '<div class="card"><h1>Спасибо!</h1><p>Ваши ответы отправлены.</p></div>';
    return;
  }
  let h = '<h1>' + esc(t.title) + '</h1>';
  t.questions.forEach((q, i) => {
    h += '<div class="card"><div class="mut">Вопрос ' + (i + 1) + ' из ' + t.questions.length + '</div>' +
      '<p><b>' + esc(q.text) + '</b></p>';
    if (q.matrices && q.matrices.length)
      h += '<div class="mats">' + q.matrices.map(m =>
        '<div class="mw"><b>' + esc(m.label) + ' =</b>' + mat(m.data) + '</div>').join('') + '</div>';
    h += '<div class="opts">' + q.options.map((o, j) =>
      '<label class="opt"><input type="radio" name="q' + i + '" value="' + j + '">' + val(o) + '</label>').join('') + '</div></div>';
  });
  h += '<button id="send">Отправить ответы</button><p id="err" class="bad"></p>';
  view.innerHTML = h;
  document.getElementById('send').onclick = async e => {
    const answers = {};
    for (let i = 0; i < t.questions.length; i++) {
      const r = document.querySelector('input[name=q' + i + ']:checked');
      if (!r) { document.getElementById('err').textContent = 'Ответьте на все вопросы.'; return; }
      answers[t.questions[i].id] = +r.value;
    }
    e.target.disabled = true;
    try { await api('/api/submit', 'POST', { answers }); testView(); }
    catch (er) { e.target.disabled = false; document.getElementById('err').textContent = er.message; }
  };
}

async function adminView() {
  const d = await api('/api/admin/results');
  const rows = d.results;
  const avg = rows.length ? (rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(1) : '—';
  let h = '<h1>Результаты: ' + esc(d.title) + '</h1><div class="card"><div class="row">' +
    '<span class="mut">Прошли: ' + rows.length + ' · Средний балл: ' + avg + '</span>' +
    '<a class="btn" href="/api/admin/results.csv">Скачать CSV</a>' +
    '<button class="sec" id="rf">Обновить</button></div></div>';
  if (!rows.length) h += '<p class="mut">Пока нет ответов.</p>';
  else {
    h += '<div class="card tw"><table><tr><th>Логин</th><th>Балл</th>' +
      d.questions.map((q, i) => '<th title="' + esc(q.text) + '">В' + (i + 1) + '</th>').join('') +
      '<th>Дата (UTC)</th><th></th></tr>' +
      rows.map(r => '<tr><td>' + esc(r.username) + '</td><td><b>' + r.score + '/' + r.total + '</b></td>' +
        r.details.map(x => '<td class="' + (x.ok ? 'ok' : 'bad') + '">' + (x.ok ? '✓' : '✗') + '</td>').join('') +
        '<td class="mut">' + esc(r.created_at) + '</td>' +
        '<td><button class="sec" data-del="' + r.id + '" title="Разрешить пройти заново">Сбросить</button></td></tr>').join('') +
      '</table></div>';
  }
  view.innerHTML = h;
  document.getElementById('rf').onclick = adminView;
  view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (confirm('Удалить результат? Студент сможет пройти тест заново.')) {
      await api('/api/admin/results/' + b.dataset.del, 'DELETE'); adminView();
    }
  });
}

async function init() {
  try {
    const me = await api('/api/me');
    header(me);
    me.role === 'admin' ? await adminView() : await testView();
  } catch (e) {
    if (e.status === 401) { const c = await api('/api/config'); authView(c.allowRegistration); }
    else view.innerHTML = '<p class="bad">' + esc(e.message) + '</p>';
  }
}
init();
