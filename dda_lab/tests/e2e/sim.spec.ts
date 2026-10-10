import { expect, test } from '@playwright/test';

test('the virtual rider produces a lap that the map and charts follow', async ({ page }) => {
  await page.goto('/?example=bike1000');
  await page.getByTestId('bp-tab-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();

  // enable the simulator: a lap time appears
  await page.getByTestId('sim-enable').check();
  const lapTime = page.getByTestId('sim-laptime');
  await expect(lapTime).not.toHaveText('—');
  const before = await lapTime.textContent();

  // the simulated lap joins the workspace. Assert it by name, not by a lap
  // count: the example page may already start with more than one lap selected.
  await expect(page.getByTestId('bottom-panels')).toContainText('Virtual rider');

  // dragging the braking slider changes the lap time
  const braking = page.getByTestId('sim-braking');
  await braking.fill('1.5');
  await braking.dispatchEvent('change');
  await expect(lapTime).not.toHaveText(before!);

  // the ideal line is on the map and actually carries the generated line's
  // points — not just an empty source that was there from map init regardless
  // of whether anything ever drew into it.
  const lineFeatureCount = await page.evaluate(() => {
    const m = (window as unknown as { __map?: { getSource: (id: string) => { _data?: { geojson?: GeoJSON.FeatureCollection } } } }).__map;
    const src = m?.getSource('idealLine');
    return src?._data?.geojson?.features?.length ?? 0;
  });
  expect(lineFeatureCount).toBeGreaterThan(0);
});
