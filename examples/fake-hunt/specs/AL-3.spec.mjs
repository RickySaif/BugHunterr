// AL-3 · R3: the end date must be on or after the start date; otherwise 400 and nothing saved.
import { test, expect, knownBug, named } from '../bh.mjs';

test('R3 an end date before the start date is refused and nothing is saved', async ({ api, db }) => {
  knownBug('AL-3', 'createRequest does not check that end >= start');
  const ben = await api('employee');
  const reason = named('al3-reversed');
  const res = await ben.post('/api/requests', { start: '2030-03-15', end: '2030-03-13', reason });
  expect(res.status, 'a reversed range must be refused').toBe(400);
  const rows = await db.read(`SELECT id FROM requests WHERE reason = '${reason}'`);
  expect(rows, 'nothing may be saved').toHaveLength(0);
});
