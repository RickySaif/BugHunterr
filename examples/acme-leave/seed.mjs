#!/usr/bin/env node
// Seed for the Acme Leave test database: a fresh file with every role, and requests in every state, so a hunt
// starts with screens that have something on them. Fictional people only.
//   node seed.mjs            (ACME_DB picks the file, like the server; ACME_DEMO_PASSWORD the shared password)
// Dates are in 2026 and 2027, the "current" years; tests use 2030 and later, so they never collide with this data.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, hashPassword } from './src/db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.env.ACME_DB || join(here, 'data', 'acme-leave.db');
const password = process.env.ACME_DEMO_PASSWORD || 'acme-demo';
const db = openDb(file, { reset: true, demoPassword: password });

// More people than the three accounts the tests log in as, so lists and team views are not trivially short.
const extra = [
  ['dewi@acme.example', 'Dewi Manager', 'manager'],
  ['eko@acme.example', 'Eko Employee', 'employee'],
  ['fitri@acme.example', 'Fitri Employee', 'employee'],
];
const addUser = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)');
for (const [email, name, role] of extra) addUser.run(email, name, role, hashPassword(password));
const id = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

// [who, start, end, working days, reason, status, decided by]
const requests = [
  ['ben@acme.example', '2026-03-02', '2026-03-06', 5, 'family trip', 'approved', 'ana@acme.example'],
  ['ben@acme.example', '2026-07-13', '2026-07-14', 2, 'moving house', 'rejected', 'ana@acme.example'],
  ['ben@acme.example', '2026-12-21', '2026-12-24', 4, 'year-end break', 'pending', null],
  ['cleo@acme.example', '2026-05-18', '2026-05-22', 5, 'wedding', 'approved', 'dewi@acme.example'],
  ['cleo@acme.example', '2026-11-16', '2026-11-16', 1, 'doctor', 'cancelled', null],
  ['cleo@acme.example', '2027-01-04', '2027-01-08', 5, 'new year', 'pending', null],
  ['eko@acme.example', '2026-08-17', '2026-08-28', 10, 'long holiday', 'approved', 'ana@acme.example'],
  ['eko@acme.example', '2026-12-28', '2026-12-31', 4, 'holidays', 'pending', null],
  ['fitri@acme.example', '2026-02-09', '2026-02-10', 2, 'school event', 'approved', 'dewi@acme.example'],
  ['ana@acme.example', '2026-09-07', '2026-09-11', 5, 'conference', 'approved', 'dewi@acme.example'],
  ['dewi@acme.example', '2026-12-14', '2026-12-15', 2, 'personal', 'pending', null],
];
const addRequest = db.prepare(
  'INSERT INTO requests (user_id, start_date, end_date, days, reason, status, created_at, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
for (const [who, start, end, days, reason, status, decider] of requests) {
  const created = `${start.slice(0, 4)}-01-05T09:00:00Z`;
  const decided = status === 'pending' ? null : `${start.slice(0, 4)}-01-06T09:00:00Z`;
  addRequest.run(id(who), start, end, days, reason, status, created, decider ? id(decider) : null, decided);
}
db.close();
console.log(`Seeded ${file}: ${3 + extra.length} users, ${requests.length} requests (pending, approved, rejected, cancelled).`);
