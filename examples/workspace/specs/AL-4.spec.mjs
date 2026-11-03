import { test, expect, knownBug, named } from '../bh.mjs';

// three full Mon–Fri weeks (15 working days) starting at the first Monday of the given month
function threeWeeks(y, month) {
  const d = new Date(Date.UTC(y, month, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  const start = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 18); // Friday of the third week
  return { start, end: d.toISOString().slice(0, 10) };
}

test('R1/R7 approving cannot push an employee past 20 days in a year', async ({ api, db }) => {
  knownBug('AL-4', 'approveRequest does not re-check the remaining balance');
  const cleo = await api('employee2');
  const ana = await api('manager');
  const y = 2040 + Math.floor(Math.random() * 50);
  const a = await cleo.okPost('/api/requests', { ...threeWeeks(y, 2), reason: named('over-a') });
  const b = await cleo.okPost('/api/requests', { ...threeWeeks(y, 5), reason: named('over-b') });
  const first = await ana.post(`/api/requests/${a.id}/approve`);
  expect(first.status).toBe(200);
  const second = await ana.post(`/api/requests/${b.id}/approve`);
  expect(second.status).not.toBe(200);
  const [row] = await db.read(`SELECT status FROM requests WHERE id = ${b.id}`);
  expect(row.status).toBe('pending');
  const bal = await cleo.get(`/api/balance?year=${y}`);
  expect(bal.body.remaining).toBeGreaterThanOrEqual(0);
});
