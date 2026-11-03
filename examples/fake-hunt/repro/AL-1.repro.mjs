// AL-1: an employee approves their own leave request (R4).
import { demo, caption, evidence, login } from '../bh.mjs';

demo('AL-1 employee approves own request', async ({ page, db }) => {
  await caption('Rule R4: only a manager may approve, and nobody may decide their own request.');
  await login(page, 'employee');
  await caption('Ben is an employee. He asks for Monday 4 February 2030 off.');
  await page.getByTestId('start').fill('2030-02-04');
  await page.getByTestId('end').fill('2030-02-04');
  await page.getByTestId('reason').fill('dentist');
  await page.getByTestId('submit-request').click();
  const row = page.locator('[data-testid=my-requests] tbody tr').filter({ hasText: 'dentist' }).first();
  await row.getByText('pending').waitFor();
  const id = Number(await row.getAttribute('data-request-id'));
  await caption('The page shows no Approve button for an employee. So far, so good.');
  await caption('But the server accepts an approval from anyone. Ben sends one for his own request.');
  const res = await page.evaluate(async (rid) => {
    const r = await fetch(`/api/requests/${rid}/approve`, { method: 'POST' });
    return { status: r.status, body: await r.json() };
  }, id);
  await page.reload();
  await page.locator(`[data-request-id="${id}"]`).getByText('approved').waitFor();
  const [stored] = await db.read(`SELECT status, decided_by FROM requests WHERE id = ${id}`);
  await evidence({
    title: 'Confirmed two ways',
    rows: {
      'expected (R4)': { value: 'HTTP 403, still pending', good: true },
      'API response': { value: `HTTP ${res.status}, ${res.body.status}`, bad: true },
      'stored status': { value: stored.status, bad: true },
      'decided_by': { value: `user ${stored.decided_by} (Ben himself)`, bad: true },
    },
  });
  await caption('Ben approved his own leave. It now counts against his balance without a manager.', { hold: 3500 });
});
