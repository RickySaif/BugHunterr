// AL-1 · R4: only a manager decides, and never their own request.
import { test, expect, knownBug, named } from '../bh.mjs';

// A random far-future Monday, so repeated runs never run out of balance.
const day = () => {
  const d = new Date(Date.UTC(2040 + Math.floor(Math.random() * 50), 1, 4));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

test('R4 an employee cannot approve their own request', async ({ api, db }) => {
  knownBug('AL-1', 'approveRequest does not check the role or the requester');
  const ben = await api('employee');
  const d = day();
  const req = await ben.okPost('/api/requests', { start: d, end: d, reason: named('al1-self') });
  const res = await ben.post(`/api/requests/${req.id}/approve`);
  expect(res.status, 'approving your own request must be refused').toBe(403);
  const [row] = await db.read(`SELECT status FROM requests WHERE id = ${Number(req.id)}`);
  expect(row.status, 'the request must still be pending').toBe('pending');
});

test('R4 a manager can approve an employee request', async ({ api }) => {
  const ana = await api('manager');
  const cleo = await api('employee2');
  const d = day();
  const req = await cleo.okPost('/api/requests', { start: d, end: d, reason: named('al1-ok') });
  const res = await ana.post(`/api/requests/${req.id}/approve`);
  expect(res.status).toBe(200);
  expect(res.body.decided_by).toBe(ana.me.id);
});
