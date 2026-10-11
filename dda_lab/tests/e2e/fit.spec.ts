import { expect, test, type Page } from '@playwright/test';

// "Fit to reference": import the BMW Serres lap (a lap JSON with a corner
// summary), run the fit, read the per-corner table.
const BMW = '/Users/macbookmini/projects/DDA_Reader/_inbox/serres_BMW_1-19-81.json';
const SHOTS = process.env.SIM_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

/** "1:19.20" → 79.2 */
function lapSeconds(text: string): number {
  const m = /(\d+):(\d+\.\d+)/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
}

test('fit to reference: BMW lap → 16-corner table and a fitted lap', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1300 });
  await page.goto('/');
  await page.getByTestId('open-files').setInputFiles(BMW);
  await page.getByTestId('bp-tab-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();

  await page.getByTestId('sim-mode-fit').click();
  await expect(page.getByTestId('sim-mode-fit')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('sim-fit-status')).toContainText('BMW');
  await page.getByTestId('sim-fit-run').click();

  const table = page.getByTestId('sim-fit-table');
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(16);
  // the fitted session joins the workspace
  await expect(page.getByTestId('bottom-panels')).toContainText('Fit: BMW');
  await shot(page, '01-fit-table');
  // the whole table: scroll the sim panel so it starts at the table
  await page.getByTestId('sim-fit').evaluate((el) => {
    let p: HTMLElement | null = el.parentElement;
    while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement;
    if (p) p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top - 4;
  });
  await shot(page, '02-fit-table-scrolled');
  // ... and to its last row
  await table.locator('tbody tr').last().scrollIntoViewIfNeeded();
  await shot(page, '03-fit-table-end');

  const status = (await page.getByTestId('sim-fit-status').textContent()) ?? '';
  const fitLap = lapSeconds(status.replace(/^.*?Fit: \S+ /, ''));
  console.log(`fit status: ${status} → fitted lap ${fitLap.toFixed(2)} s`);
  // the spec's acceptance: within 0.3 s of the reference lap
  expect.soft(Math.abs(fitLap - 79.81), `fitted lap ${fitLap} vs 79.81`).toBeLessThan(0.3);
  // what the fit controls: within 0.3 s of the reference SPEED ridden over this line (shown in the note)
  const note = (await page.locator('.sim-fit-note').textContent()) ?? '';
  const onLine = lapSeconds(note.replace(/^.*this line: /, ''));
  console.log(`note: ${note}`);
  expect(Math.abs(fitLap - onLine)).toBeLessThan(0.3);
});
