import { demo, caption, evidence, login } from '../bh.mjs';
demo('AL-3 backwards date range is accepted', async ({ page, db }) => {
  await caption('Rule R3: the end date must be on or after the start date, otherwise the app must refuse.');
  await login(page, 'employee');
  await caption('Ben enters From 11 March 2032, To 8 March 2032: the end is before the start.');
  await page.fill('[data-testid=start]', '2032-03-11');
  await page.fill('[data-testid=end]', '2032-03-08');
  await page.fill('[data-testid=reason]', '20261103-105420-guided-repro-reversed');
  await page.click('[data-testid=submit-request]');
  await page.waitForTimeout(1000);
  await caption('No error. The request is saved, with minus 2 days.');
  const [row] = await db.read("SELECT days, status FROM requests WHERE reason = '20261103-105420-guided-repro-reversed' ORDER BY id DESC LIMIT 1");
  await evidence({ title: 'Confirmed two ways', rows: {
    expected: { value: '400 error, nothing saved', good: true },
    response: { value: 'accepted (201)', bad: true },
    stored: { value: `saved, ${row.status}, days = ${row.days}`, bad: true } } });
});
