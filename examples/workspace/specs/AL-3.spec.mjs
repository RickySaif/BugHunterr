import { test, expect, knownBug, named } from '../bh.mjs';

test('R3 a request whose end is before its start is refused and not saved', async ({ api, db }) => {
  knownBug('AL-3', 'createRequest never checks end >= start');
  const ben = await api('employee');
  const reason = named('reversed');
  const res = await ben.post('/api/requests', { start: '2032-03-11', end: '2032-03-08', reason });
  expect(res.status).toBe(400);
  const rows = await db.read(`SELECT id FROM requests WHERE reason = '${reason.replace(/'/g, "''")}'`);
  expect(rows.length).toBe(0);
});
