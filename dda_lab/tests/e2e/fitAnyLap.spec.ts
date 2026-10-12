import { expect, test, type Page } from '@playwright/test';

// "Fit to reference" from ANY loaded lap: a Ducati DDA lap (its own GPS line),
// fit, pick a corner on the map, move its C ↔ V slider in the left pane.
const DUCATI = '/Users/macbookmini/projects/DDA_Reader/_inbox/Run036-219926-00.00.json';
const SHOTS = process.env.SIM_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

test('fit to a recorded lap → pick a corner on the map → tune its line', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto('/');
  await page.getByTestId('open-files').setInputFiles(DUCATI);
  await page.getByTestId('bp-tab-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();
  await page.getByTestId('sim-mode-fit').click();

  // the lap picker lists the recorded laps
  const picker = page.getByTestId('sim-fit-ref');
  await expect(picker.locator('option')).not.toHaveCount(1);
  await page.getByTestId('sim-fit-run').click();
  await expect(page.getByTestId('sim-fit-table')).toBeVisible({ timeout: 60_000 });
  const rows = await page.getByTestId('sim-fit-table').locator('tbody tr').count();
  expect(rows).toBeGreaterThanOrEqual(5);
  await expect(page.getByTestId('sim-fit-hint')).toBeVisible();

  // numeric checks on the store: the fitted lap reproduces the reference lap
  // (a corner-seam bug once left it −4.5 s off on the session-built 10-turn
  // track model), extra corners the model misses are added, and the
  // refinement lowers the error
  const fit = await page.evaluate(() => {
    type St = {
      fitBusy: boolean;
      fitModel?: { corners: Array<{ name: string }> };
      simFit?: { lapTimeS: number; refLapTimeS: number; stats: { errorBefore: number; errorAfter: number } };
    };
    const st = (window as unknown as { __lab: { getState: () => St } }).__lab.getState();
    return {
      busy: st.fitBusy,
      corners: st.fitModel?.corners.map((c) => c.name) ?? [],
      lapTimeS: st.simFit?.lapTimeS ?? Number.NaN,
      refLapTimeS: st.simFit?.refLapTimeS ?? Number.NaN,
      errorBefore: st.simFit?.stats.errorBefore ?? Number.NaN,
      errorAfter: st.simFit?.stats.errorAfter ?? Number.NaN,
    };
  });
  console.log(`fit: ${fit.lapTimeS.toFixed(2)} s vs ref ${fit.refLapTimeS.toFixed(2)} s · error ${fit.errorBefore.toFixed(1)} → ${fit.errorAfter.toFixed(1)} · corners ${fit.corners.join(' ')}`);
  expect(fit.busy).toBe(false);
  expect(Math.abs(fit.lapTimeS - fit.refLapTimeS), `fitted ${fit.lapTimeS} vs ref ${fit.refLapTimeS}`).toBeLessThan(1.0);
  expect(fit.corners.length).toBeGreaterThanOrEqual(16);
  expect(rows).toBe(fit.corners.length);
  expect(fit.errorAfter).toBeLessThan(fit.errorBefore);
  await shot(page, 'any-01-fitted');

  // pick a corner on the map: click a rendered fit-apex marker
  const map = page.locator('.maplibregl-canvas');
  const pt = await page.evaluate(() => {
    const m = (window as unknown as { __map?: { getLayer(id: string): unknown; queryRenderedFeatures(o?: unknown): Array<{ properties: { k: number }; geometry: { coordinates: [number, number] } }>; project(c: [number, number]): { x: number; y: number } } }).__map;
    if (!m || !m.getLayer('fit-apex')) return null;
    const f = m.queryRenderedFeatures({ layers: ['fit-apex'] }).find((x) => x.properties.k === 2);
    return f ? { k: f.properties.k, ...m.project(f.geometry.coordinates) } : null;
  });
  if (pt) {
    await map.click({ position: { x: pt.x, y: pt.y } });
  } else {
    await page.getByTestId('sim-fit-chip-2').click();
  }
  await expect(page.getByTestId('sim-fit-editor')).toBeVisible();
  const name = (await page.getByTestId('sim-fit-chip-2').textContent()) ?? '';
  await expect(page.getByTestId('sim-fit-corner-name')).toContainText(name);

  // the sliders sit in the left pane, the map on the right
  const editor = await page.getByTestId('sim-fit-editor').boundingBox();
  const mapBox = await map.boundingBox();
  expect(editor!.x + editor!.width).toBeLessThanOrEqual(mapBox!.x + 1);

  const before = (await page.getByTestId('sim-fit-status').textContent()) ?? '';
  const kappa = page.getByTestId('sim-fit-kappa');
  await kappa.focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('sim-fit-reset-corner')).toBeEnabled();
  await expect(page.getByTestId('sim-fit-status')).not.toHaveText(before);
  await shot(page, 'any-02-corner-tuned');
  await page.getByTestId('sim-fit-reset-corner').click();
  await expect(page.getByTestId('sim-fit-reset-corner')).toBeDisabled();
  console.log(`${rows} corners · map pick: ${pt ? 'map' : 'chip fallback'} · ${before}`);
});
