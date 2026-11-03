// Использование: node scripts/create-admin.js <логин> [пароль]
// Если пароль не указан, он будет запрошен в консоли.
const readline = require('readline');
const bcrypt = require('bcryptjs');
const db = require('../db');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a); }));
}
function fail(m) { console.error(m); process.exit(1); }

(async () => {
  const username = process.argv[2] || (await ask('Логин администратора: '));
  const password = process.argv[3] || (await ask('Пароль (не менее 8 символов): '));
  if (!/^[\w.\-@]{3,40}$/.test(username)) return fail('Логин: 3-40 символов (буквы, цифры, _ . - @)');
  if (password.length < 8) return fail('Пароль слишком короткий');
  const hash = bcrypt.hashSync(password, 12);
  const ex = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (ex) {
    db.prepare("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?").run(hash, ex.id);
    console.log('Пользователь обновлён: теперь администратор.');
  } else {
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(username, hash);
    console.log('Администратор создан.');
  }
})();
