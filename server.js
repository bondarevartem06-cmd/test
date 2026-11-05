require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomInt } = require('crypto');
const db = require('./db');

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET === 'change-me') {
  console.error('Задайте JWT_SECRET в .env (см. .env.example)');
  process.exit(1);
}
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const ALLOW_REG = process.env.ALLOW_REGISTRATION !== 'false';
const QFILE = path.join(__dirname, 'questions.json');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));
app.use('/api/register', rateLimit({ windowMs: 60 * 60 * 1000, max: 30 }));

// ---------- helpers ----------
// Читаем файл каждый раз: правки вопросов применяются без перезапуска.
// Поддерживаются два формата: {"variants":[{"id":"A","questions":[...]}, ...]} или старый {"questions":[...]}
function loadTest() {
  const t = JSON.parse(fs.readFileSync(QFILE, 'utf8'));
  const variants = t.variants && t.variants.length ? t.variants : [{ id: 'A', questions: t.questions }];
  return { title: t.title, variants };
}
// Вариант студента: выбирается случайно при первом открытии теста и дальше не меняется
function variantFor(userId, t) {
  const row = db.prepare('SELECT variant FROM assignments WHERE user_id = ?').get(userId);
  let v = row && t.variants.find(x => String(x.id) === row.variant);
  if (!v) {
    // Выбираем случайно среди наименее выданных вариантов: раздача выходит ровной (A, B, C, ...), порядок случайный
    const cnt = Object.fromEntries(db.prepare('SELECT variant, COUNT(*) AS n FROM assignments GROUP BY variant').all().map(r => [r.variant, r.n]));
    const min = Math.min(...t.variants.map(x => cnt[String(x.id)] || 0));
    const pool = t.variants.filter(x => (cnt[String(x.id)] || 0) === min);
    v = pool[randomInt(pool.length)];
    db.prepare('INSERT OR REPLACE INTO assignments (user_id, variant) VALUES (?, ?)').run(userId, String(v.id));
  }
  return v;
}
function setSession(res, user) {
  const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, maxAge: 7 * 864e5 });
}
function auth(req, res, next) {
  try {
    const { id } = jwt.verify(req.cookies.token, SECRET);
    const u = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
    if (!u) throw 0;
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Требуется вход' }); }
}
const need = role => (req, res, next) =>
  req.user.role === role ? next() : res.status(403).json({ error: 'Нет доступа' });
const validCreds = (u, p) =>
  typeof u === 'string' && typeof p === 'string' && /^[\p{L}\p{N}_.\-@ ]{3,40}$/u.test(u) && p.length >= 6 && p.length <= 100;

// ---------- auth ----------
app.post('/api/register', (req, res) => {
  if (!ALLOW_REG) return res.status(403).json({ error: 'Регистрация отключена' });
  const { username, password } = req.body || {};
  if (!validCreds(username, password))
    return res.status(400).json({ error: 'Логин 3-40 символов, пароль не короче 6' });
  try {
    const r = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'student')")
      .run(username.trim(), bcrypt.hashSync(password, 10));
    setSession(res, { id: r.lastInsertRowid });
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'Такой логин уже занят' }); }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = typeof username === 'string' && db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!u || typeof password !== 'string' || !bcrypt.compareSync(password, u.password_hash))
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  setSession(res, u);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.get('/api/me', auth, (req, res) => res.json({ ...req.user, allowRegistration: ALLOW_REG }));
app.get('/api/config', (req, res) => res.json({ allowRegistration: ALLOW_REG }));

// ---------- студент ----------
app.get('/api/test', auth, need('student'), (req, res) => {
  const t = loadTest();
  const done = db.prepare('SELECT 1 FROM attempts WHERE user_id = ?').get(req.user.id);
  if (done) return res.json({ title: t.title, done: true });
  const v = variantFor(req.user.id, t);
  res.json({
    title: t.title,
    done: false,
    questions: v.questions.map(({ correct, ...q }) => q) // правильные ответы наружу не уходят
  });
});

app.post('/api/submit', auth, need('student'), (req, res) => {
  const t = loadTest();
  const given = req.body && req.body.answers;
  if (!given || typeof given !== 'object') return res.status(400).json({ error: 'Некорректные данные' });
  const v = variantFor(req.user.id, t);
  const answers = {};
  let score = 0;
  for (const q of v.questions) {
    const a = given[q.id];
    if (!Number.isInteger(a) || a < 0 || a >= q.options.length)
      return res.status(400).json({ error: 'Ответьте на все вопросы' });
    answers[q.id] = a;
    if (a === q.correct) score++;
  }
  try {
    db.prepare('INSERT INTO attempts (user_id, answers, score, total, variant) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, JSON.stringify(answers), score, v.questions.length, String(v.id));
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'Вы уже проходили тест' }); }
});

// ---------- администратор ----------
app.get('/api/admin/results', auth, need('admin'), (req, res) => {
  const t = loadTest();
  const rows = db.prepare(`SELECT a.id, u.username, a.answers, a.score, a.total, a.variant, a.created_at
    FROM attempts a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC`).all();
  const results = rows.map(r => {
    const ans = JSON.parse(r.answers);
    const v = t.variants.find(x => String(x.id) === r.variant) || t.variants[0];
    return { id: r.id, username: r.username, variant: r.variant || String(v.id), score: r.score, total: r.total,
      created_at: r.created_at,
      details: v.questions.map(q => ({ id: q.id, ok: ans[q.id] === q.correct })) };
  });
  res.json({ title: t.title, results });
});

// Удалить результат (и закреплённый вариант), чтобы студент мог пройти тест заново с новым случайным вариантом
app.delete('/api/admin/results/:id', auth, need('admin'), (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT user_id FROM attempts WHERE id = ?').get(id);
  if (a) {
    db.prepare('DELETE FROM attempts WHERE id = ?').run(id);
    db.prepare('DELETE FROM assignments WHERE user_id = ?').run(a.user_id);
  }
  res.json({ ok: true });
});

// Создание/обновление администратора из переменных окружения (для хостингов без консоли).
// Задайте ADMIN_USERNAME и ADMIN_PASSWORD (не короче 8 символов), после первого запуска переменные лучше удалить.
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
  const u = process.env.ADMIN_USERNAME.trim(), p = process.env.ADMIN_PASSWORD;
  if (p.length < 8) console.error('ADMIN_PASSWORD короче 8 символов: администратор не создан');
  else {
    const hash = bcrypt.hashSync(p, 12);
    const ex = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
    if (ex) db.prepare("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?").run(hash, ex.id);
    else db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(u, hash);
    console.log('Администратор из переменных окружения готов: ' + u);
  }
}
// ---- Жёстко заданные администраторы (создаются/обновляются при каждом запуске сервера) ----
const ADMINS = [
  { username: 'admin1', password: 'пароль1' },
  { username: 'admin2', password: 'пароль2' },
  { username: '125fwe',  password: 'sgert135' },
   { username: 'Salima',  password: 'Salima0password' },
];
for (const a of ADMINS) {
  const hash = bcrypt.hashSync(a.password, 10);
  const ex = db.prepare('SELECT id FROM users WHERE username = ?').get(a.username);
  if (ex) db.prepare("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?").run(hash, ex.id);
  else db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(a.username, hash);
}
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Сервер запущен: http://localhost:' + PORT));
