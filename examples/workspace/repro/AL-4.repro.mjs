import { demo, caption, evidence, login } from '../bh.mjs';
demo('AL-4 approvals push balance below zero', async ({ page, api, db }) => {
  await caption('Rules R1 and R7: 20 days a year, and nobody may take more leave than they have left.');
  const cleo = await api('employee2');
  const y = 2040 + Math.floor(Math.random() * 50);
  await caption(`Cleo files two requests in ${y}, about 15 days each. Each alone fits in her 20 days.`);
  const a = await cleo.okPost('/api/requests', { start: `${y}-03-01`, end: `${y}-03-15`, reason: '20261103-105420-guided-repro-over-a' });
  const b = await cleo.okPost('/api/requests', { start: `${y}-05-01`, end: `${y}-05-15`, reason: '20261103-105420-guided-repro-over-b' });
  await login(page, 'manager');
  await page.click('[data-testid=nav-team]');
  await page.waitForTimeout(800);
  await caption('Ana, the manager, approves both. The app lets her.');
  const ana = await api('manager');
  const r1 = await ana.post(`/api/requests/${a.id}/approve`);
  const r2 = await ana.post(`/api/requests/${b.id}/approve`);
  await page.reload();
  await page.waitForTimeout(800);
  const bal = await cleo.get(`/api/balance?year=${y}`);
  await caption(`Cleo's balance for ${y} is now ${bal.body.remaining} days.`);
  const [row] = await db.read(`SELECT SUM(days) AS used FROM requests WHERE user_id = 3 AND status = 'approved' AND start_date LIKE '${y}%'`);
  await evidence({ title: 'Confirmed two ways', rows: {
    expected: { value: 'second approval refused, balance never below 0', good: true },
    response: { value: `approve #1 ${r1.status}, approve #2 ${r2.status}`, bad: true },
    stored: { value: `${row.used} days approved, remaining ${bal.body.remaining}`, bad: true } } });
});
