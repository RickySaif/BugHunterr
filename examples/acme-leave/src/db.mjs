// Storage for Acme Leave: one SQLite file, created and seeded on first start.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager', 'employee')),
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at TEXT NOT NULL,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT
);`;

// Fictional demo people. They all share the public demo password.
const SEED_USERS = [
  ['ana@acme.example', 'Ana Manager', 'manager'],
  ['ben@acme.example', 'Ben Employee', 'employee'],
  ['cleo@acme.example', 'Cleo Employee', 'employee'],
];

export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(plain, salt, 32).toString('hex')}`;
}

export function checkPassword(plain, stored) {
  const [salt, hash] = stored.split(':');
  const got = scryptSync(plain, salt, 32);
  return timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

export function openDb(file, { reset = false, demoPassword }) {
  if (reset && existsSync(file)) rmSync(file);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)');
    for (const [email, name, role] of SEED_USERS) insert.run(email, name, role, hashPassword(demoPassword));
  }
  return db;
}
