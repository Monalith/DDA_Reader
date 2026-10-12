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
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 1300 });
  await page.goto('/');
  await page.getByTestId('open-files').setInputFiles(BMW);
  await page.getByTestId('bp-tab-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();

  await page.getByTestId('sim-mode-fit').click();
  await expect(page.getByTestId('sim-mode-fit')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('sim-fit-status')).toContainText('BMW');
  await page.getByTestId('sim-fit-run').click();

  // the fit runs in a Worker (~7 s, ≤ 30 s) behind a progress bar
  await expect(page.getByTestId('sim-fit-run')).toHaveText('Fit', { timeout: 60_000 });
  await expect
    .poll(() => page.evaluate(() => {
      type St = { fitBusy: boolean; simFit?: unknown };
      const st = (window as unknown as { __lab: { getState: () => St } }).__lab.getState();
      return !st.fitBusy && !!st.simFit;
    }), { timeout: 60_000 })
    .toBe(true);
  const table = page.getByTestId('sim-fit-table');
  await expect(table).toBeVisible({ timeout: 60_000 });
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
  // what the fit controls: speed per station (fitModel minimises speed +
  // longitudinal-g error per corner). The note's "reference speed ridden on
  // this line" is integrated over the line actually ridden (the tuned C↔V
  // line, ~30 m longer than the base line on the BMW), so the fitted lap
  // must sit within 0.3 s of it (measured 80.09 vs 80.10 s).
  const note = (await page.locator('.sim-fit-note').textContent()) ?? '';
  const onLine = lapSeconds(note.replace(/^.*this line: /, ''));
  console.log(`note: ${note}`);
  expect(Math.abs(fitLap - onLine), `fitted lap ${fitLap} vs ref on line ${onLine}`).toBeLessThan(0.3);
  const st = await page.evaluate(() => {
    type St = { fitModel?: { corners: unknown[] }; simFit?: { lapTimeS: number; refLapTimeS: number; stats: { errorBefore: number; errorAfter: number } } };
    const s = (window as unknown as { __lab: { getState: () => St } }).__lab.getState();
    return { K: s.fitModel?.corners.length ?? 0, lap: s.simFit?.lapTimeS ?? NaN, ref: s.simFit?.refLapTimeS ?? NaN, before: s.simFit?.stats.errorBefore ?? NaN, after: s.simFit?.stats.errorAfter ?? NaN };
  });
  // the BMW file carries its own 16-corner summary: no corners are added
  expect(st.K).toBe(16);
  expect(Math.abs(st.lap - st.ref), `fitted ${st.lap} vs ref ${st.ref}`).toBeLessThan(1.0);
  expect(st.after).toBeLessThan(st.before);
});
