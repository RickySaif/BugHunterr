// AL-2 · R2: only working days count. By hand: Fri 8 + Mon 11 March 2030 = 2 working days.
import { test, expect, knownBug, named } from '../bh.mjs';

test('R2 a Friday-to-Monday request counts 2 working days', async ({ api, db }) => {
  knownBug('AL-2', 'countDays counts calendar days, so the weekend is charged');
  const cleo = await api('employee2');
  const req = await cleo.okPost('/api/requests', { start: '2030-03-08', end: '2030-03-11', reason: named('al2-weekend') });
  expect(req.days, 'Fri 8 + Mon 11 March = 2 working days').toBe(2);
  const [row] = await db.read(`SELECT days FROM requests WHERE id = ${Number(req.id)}`);
  expect(row.days).toBe(2);
});

test('R2 a Monday-to-Friday week counts 5 working days', async ({ api }) => {
  const cleo = await api('employee2');
  const req = await cleo.okPost('/api/requests', { start: '2030-04-01', end: '2030-04-05', reason: named('week') });
  expect(req.days).toBe(5);
});
