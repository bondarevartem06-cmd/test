require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
const loadTest = () => JSON.parse(fs.readFileSync(QFILE, 'utf8')); // читаем каждый раз: правки применяются без перезапуска
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
  typeof u === 'string' && typeof p === 'string' && /^[\w.\-@ ]{3,40}$/.test(u) && p.length >= 6 && p.length <= 100;

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
  const done = db.prepare('SELECT score, total FROM attempts WHERE user_id = ?').get(req.user.id);
  if (done) return res.json({ title: t.title, done: true });
  res.json({
    title: t.title,
    done: false,
    questions: t.questions.map(({ correct, ...q }) => q) // правильные ответы наружу не уходят
  });
});

app.post('/api/submit', auth, need('student'), (req, res) => {
  const t = loadTest();
  const given = req.body && req.body.answers;
  if (!given || typeof given !== 'object') return res.status(400).json({ error: 'Некорректные данные' });
  const answers = {};
  let score = 0;
  for (const q of t.questions) {
    const a = given[q.id];
    if (!Number.isInteger(a) || a < 0 || a >= q.options.length)
      return res.status(400).json({ error: 'Ответьте на все вопросы' });
    answers[q.id] = a;
    if (a === q.correct) score++;
  }
  try {
    db.prepare('INSERT INTO attempts (user_id, answers, score, total) VALUES (?, ?, ?, ?)')
      .run(req.user.id, JSON.stringify(answers), score, t.questions.length);
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'Вы уже проходили тест' }); }
});

// ---------- администратор ----------
function results() {
  const t = loadTest();
  const rows = db.prepare(`SELECT a.id, u.username, a.answers, a.score, a.total, a.created_at
    FROM attempts a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC`).all();
  return { t, rows: rows.map(r => {
    const ans = JSON.parse(r.answers);
    return { id: r.id, username: r.username, score: r.score, total: r.total, created_at: r.created_at,
      details: t.questions.map(q => ({ id: q.id, chosen: ans[q.id] ?? null, ok: ans[q.id] === q.correct })) };
  }) };
}

app.get('/api/admin/results', auth, need('admin'), (req, res) => {
  const { t, rows } = results();
  res.json({ title: t.title, questions: t.questions.map(q => ({ id: q.id, text: q.text })), results: rows });
});

// Удалить результат, чтобы студент мог пройти тест заново
app.delete('/api/admin/results/:id', auth, need('admin'), (req, res) => {
  db.prepare('DELETE FROM attempts WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Сервер запущен: http://localhost:' + PORT));
