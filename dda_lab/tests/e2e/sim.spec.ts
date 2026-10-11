import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.SIM_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

/** Number of features in a map source, or 0 when the map or source is missing. */
async function sourceFeatureCount(page: Page, id: string): Promise<number> {
  return page.evaluate((sourceId) => {
    const m = (window as unknown as { __map?: { getSource: (id: string) => { _data?: { geojson?: GeoJSON.FeatureCollection } } } }).__map;
    const src = m?.getSource(sourceId);
    return src?._data?.geojson?.features?.length ?? 0;
  }, id);
}

/** Sum of the sim session's speed trace, read off the store via the map's session data. */
async function simSpeedSignature(page: Page): Promise<number> {
  return page.evaluate(() => {
    const lab = (window as unknown as { __lab?: { getState: () => { sessions: Array<{ isSim?: boolean; id: string; channels: Map<string, { data: ArrayLike<number> }> }> } } }).__lab;
    const s = lab?.getState().sessions.find((x) => x.id === 'sim');
    const d = s?.channels.get('brake')?.data ?? s?.channels.get('speed')?.data;
    if (!d) return -1;
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i] * (1 + (i % 7));
    return sum;
  });
}

test('the virtual rider produces a lap that the map and charts follow', async ({ page }) => {
  await page.goto('/?example=bike1000');
  await page.getByTestId('bp-tab-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();

  // enable the simulator: a lap time appears, with the corner/brake count
  await page.getByTestId('sim-enable').check();
  const lapTime = page.getByTestId('sim-laptime');
  await expect(lapTime).not.toHaveText('—');
  await expect(page.getByTestId('sim-corner-count')).toContainText('corners');
  const before = await lapTime.textContent();
  await shot(page, '01-enabled');

  // the simulated lap joins the workspace. Assert it by name, not by a lap
  // count: the example page may already start with more than one lap selected.
  await expect(page.getByTestId('bottom-panels')).toContainText('Virtual rider');

  // the solver-mode switch is there, with the rider mode selected; an optimal
  // mode whose solver is not reachable is greyed with an explanation
  await expect(page.getByTestId('sim-mode-rider')).toHaveAttribute('aria-checked', 'true');
  const ocp = page.getByTestId('sim-mode-ocp');
  if (await ocp.isDisabled()) await expect(ocp).toHaveAttribute('title', /bridge/i);

  const sigBefore = await simSpeedSignature(page);

  // dragging the Risk slider changes the lap time
  const riskSlider = page.getByTestId('sim-risk-slider');
  await riskSlider.fill('1');
  await riskSlider.dispatchEvent('change');
  await expect(lapTime).not.toHaveText(before!);
  await shot(page, '02-risk-max');

  // ... and the sim session (what the map trace and charts draw) changed too
  await expect.poll(() => simSpeedSignature(page)).not.toBe(sigBefore);

  // the advanced panel shows the derived values, and pinning one shows a lock
  await page.getByTestId('sim-advanced').locator('summary').click();
  const braking = page.getByTestId('sim-adv-brakingG');
  await braking.fill('0.6');
  await braking.dispatchEvent('change');
  await expect(page.getByTestId('sim-lock-brakingG')).toHaveClass(/pinned/);
  // the pinned value is the one the user set (an off-grid derived value used
  // to make the range input read back the old number)
  await expect(page.locator('.sim-adv-row.pinned .sim-slider-value')).toHaveText('0.60 g');
  // keyboard stepping keeps going while the store update is debounced
  await braking.focus();
  for (let k = 0; k < 10; k++) await braking.press('ArrowLeft');
  await expect(page.locator('.sim-adv-row.pinned .sim-slider-value')).toHaveText('0.50 g');
  // a Risk change no longer moves the pinned value
  await riskSlider.fill('0.3');
  await expect(page.locator('.sim-adv-row.pinned .sim-slider-value')).toHaveText('0.50 g');
  await expect(page.getByTestId('sim-panel').locator('.sim-top-sliders .sim-slider-value').nth(1)).toHaveText('0.30');
  await shot(page, '03-advanced-pinned');
  if (SHOTS) await page.getByTestId('sim-panel').screenshot({ path: `${SHOTS}/04-panel.png` });
  await page.getByTestId('sim-lock-brakingG').click();
  await expect(page.getByTestId('sim-lock-brakingG')).not.toHaveClass(/pinned/);

  // the ideal line is on the map and actually carries the generated line's
  // points — not just an empty source that was there from map init regardless
  // of whether anything ever drew into it.
  expect(await sourceFeatureCount(page, 'idealLine')).toBeGreaterThan(0);
});
