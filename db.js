require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // встроен в Node.js 22.13+, ничего компилировать не нужно

const dir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, 'quiz.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  answers TEXT NOT NULL,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
module.exports = db;
