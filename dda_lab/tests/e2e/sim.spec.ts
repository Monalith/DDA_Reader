import { expect, test } from '@playwright/test';

test('the virtual rider produces a lap that the map and charts follow', async ({ page }) => {
  await page.goto('/?example=bike1000');
  await page.getByTestId('bp-tab-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();

  await page.getByTestId('sim-enable').check();
  const lapTime = page.getByTestId('sim-laptime');
  await expect(lapTime).not.toHaveText('—', { timeout: 20000 });
  const before = await lapTime.textContent();

  await expect(page.getByTestId('bottom-panels')).toContainText('Virtual rider');

  const braking = page.getByTestId('sim-braking');
  await braking.fill('1.5');
  await braking.dispatchEvent('change');
  await expect(lapTime).not.toHaveText(before!);

  const hasLine = await page.evaluate(() => {
    const m = (window as unknown as { __map?: { getSource: (id: string) => unknown } }).__map;
    return Boolean(m?.getSource('idealLine'));
  });
  expect(hasLine).toBe(true);
});
