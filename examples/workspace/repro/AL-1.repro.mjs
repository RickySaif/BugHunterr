import { demo, caption, evidence, login } from '../bh.mjs';
demo('AL-1 employee approves own leave request', async ({ page, db }) => {
  await caption('Rule R4: only a manager may approve leave, and nobody may approve their own request.');
  await login(page, 'employee');
  await caption('Ben is an employee. He asks for one day off.');
  await page.fill('[data-testid=start]', '2045-06-05');
  await page.fill('[data-testid=end]', '2045-06-05');
  await page.fill('[data-testid=reason]', '20261103-105420-guided-repro-self');
  await page.click('[data-testid=submit-request]');
  await page.waitForTimeout(800);
  const rows = await db.read("SELECT id FROM requests WHERE reason = '20261103-105420-guided-repro-self' ORDER BY id DESC LIMIT 1");
  const id = rows[0].id;
  await caption('Ben has no Approve button, but he sends the approve call himself, with his own login.');
  const res = await page.request.post(`/api/requests/${id}/approve`);
  await caption(`The app answers ${res.status()}: it accepts it.`);
  await page.reload();
  await page.waitForTimeout(800);
  await caption('His request now shows as approved, decided by himself.');
  const [row] = await db.read(`SELECT status, decided_by FROM requests WHERE id = ${id}`);
  await evidence({ title: 'Confirmed two ways', rows: {
    expected: { value: '403, request stays pending', good: true },
    response: { value: `${res.status()} approved`, bad: true },
    stored: { value: `${row.status}, decided_by user ${row.decided_by} (Ben)`, bad: true } } });
});
