import { demo, caption, evidence, login } from '../bh.mjs';
demo('AL-2 weekend days are charged as leave', async ({ page, db }) => {
  await caption('Rule R2: only Monday to Friday count. Friday 8 to Monday 11 March 2030 is 2 working days.');
  await login(page, 'employee');
  await caption('Ben asks for Friday 8 March to Monday 11 March 2030.');
  await page.fill('[data-testid=start]', '2030-03-08');
  await page.fill('[data-testid=end]', '2030-03-11');
  await page.fill('[data-testid=reason]', '20261103-105420-guided-repro-weekend');
  await page.click('[data-testid=submit-request]');
  await page.waitForTimeout(1000);
  await caption('Look at the Days column: it says 4, not 2. The weekend is charged.');
  const [row] = await db.read("SELECT days FROM requests WHERE reason = '20261103-105420-guided-repro-weekend' ORDER BY id DESC LIMIT 1");
  await evidence({ title: 'Confirmed two ways', rows: {
    expected: { value: '2 working days', good: true },
    response: { value: '4 days shown', bad: true },
    stored: { value: `days = ${row.days}`, bad: true } } });
});
