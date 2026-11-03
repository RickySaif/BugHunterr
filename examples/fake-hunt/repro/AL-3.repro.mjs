// AL-3: an end date before the start date is accepted (R3).
import { demo, caption, evidence, login } from '../bh.mjs';

demo('AL-3 end date before start date is accepted', async ({ page, db }) => {
  await caption('Rule R3: the end date must be on or after the start date, or the app refuses it.');
  await login(page, 'employee');
  await caption('Ben types the dates the wrong way round: from 15 March to 13 March 2030.');
  await page.getByTestId('start').fill('2030-03-15');
  await page.getByTestId('end').fill('2030-03-13');
  await page.getByTestId('reason').fill('typo in dates');
  await page.getByTestId('submit-request').click();
  const row = page.locator('[data-testid=my-requests] tbody tr').filter({ hasText: 'typo in dates' }).first();
  await row.waitFor();
  const id = Number(await row.getAttribute('data-request-id'));
  const [stored] = await db.read(`SELECT start_date, end_date, days, status FROM requests WHERE id = ${id}`);
  await caption('No error. The request is saved, with a negative number of days.');
  await evidence({
    title: 'Confirmed two ways',
    rows: {
      'expected (R3)': { value: 'HTTP 400 and nothing saved', good: true },
      'stored row': { value: `${stored.start_date} → ${stored.end_date}, ${stored.status}`, bad: true },
      'stored days': { value: String(stored.days), bad: true },
    },
  });
  await caption("If a manager approves it, Ben's balance goes UP by one day.", { hold: 3500 });
});
