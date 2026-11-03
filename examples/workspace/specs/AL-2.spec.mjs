import { test, expect, knownBug, named } from '../bh.mjs';

test('R2 a Friday-to-Monday request counts 2 working days', async ({ api, db }) => {
  knownBug('AL-2', 'countDays counts calendar days, including Saturday and Sunday');
  const ben = await api('employee');
  const req = await ben.okPost('/api/requests', { start: '2030-03-08', end: '2030-03-11', reason: named('weekend') });
  expect(req.days).toBe(2);
  const [row] = await db.read(`SELECT days FROM requests WHERE id = ${req.id}`);
  expect(row.days).toBe(2);
});
