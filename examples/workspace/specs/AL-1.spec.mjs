import { test, expect, knownBug, named } from '../bh.mjs';

// a Monday in a random far-future year, so the balance never runs out between runs
function futureMonday() {
  const y = 2040 + Math.floor(Math.random() * 50);
  const d = new Date(Date.UTC(y, 5, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test('R4 an employee cannot approve their own request', async ({ api, db }) => {
  knownBug('AL-1', 'approveRequest has no role or owner check');
  const ben = await api('employee');
  const day = futureMonday();
  const req = await ben.okPost('/api/requests', { start: day, end: day, reason: named('self-approve') });
  const res = await ben.post(`/api/requests/${req.id}/approve`);
  expect(res.status).toBe(403);
  const [row] = await db.read(`SELECT status FROM requests WHERE id = ${req.id}`);
  expect(row.status).toBe('pending');
});

test('R4 an employee cannot approve a colleague request', async ({ api, db }) => {
  knownBug('AL-1', 'approveRequest has no role check');
  const ben = await api('employee');
  const cleo = await api('employee2');
  const day = futureMonday();
  const req = await ben.okPost('/api/requests', { start: day, end: day, reason: named('peer-approve') });
  const res = await cleo.post(`/api/requests/${req.id}/approve`);
  expect(res.status).toBe(403);
  const [row] = await db.read(`SELECT status FROM requests WHERE id = ${req.id}`);
  expect(row.status).toBe('pending');
});
