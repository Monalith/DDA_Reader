import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/sample/sample_run.dda');

test('loads a .dda session, shows laps, charts and map', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.brand-main')).toHaveText('DDA');

  await page.getByTestId('open-files').setInputFiles(SAMPLE);
  // status line reports laps
  await expect(page.locator('.status')).toContainText(/laps/, { timeout: 30_000 });
  // lap table has rows
  await expect(page.locator('table.lap-table tbody tr').first()).toBeVisible();
  // at least one chart canvas rendered
  await expect(page.locator('.uplot canvas').first()).toBeVisible();
  // map canvas present
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('chart hover moves the cursor and updates the cursor panel', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-files').setInputFiles(SAMPLE);
  await expect(page.locator('.status')).toContainText(/laps/, { timeout: 30_000 });
  const chart = page.locator('.uplot').first();
  const box = await chart.boundingBox();
  if (!box) throw new Error('no chart');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.getByRole('tab', { name: /cursor/i }).click();
  await expect(page.locator('[data-testid="cursor-panel"]')).toContainText(/speed/i);
});

test('per-panel settings: fixed Y range, unlinked X and line width', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-files').setInputFiles(SAMPLE);
  await expect(page.locator('.status')).toContainText(/laps/, { timeout: 30_000 });
  await page.getByTestId('panel-gear-p1').click();
  const dlg = page.getByTestId('panel-settings-p1');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('ps-p1-yl-min').fill('0');
  await dlg.getByTestId('ps-p1-yl-max').fill('300');
  await dlg.getByTestId('ps-p1-xlinked').uncheck();
  await dlg.getByTestId('ps-p1-x-min').fill('100');
  await dlg.getByTestId('ps-p1-x-max').fill('900');
  await dlg.getByTestId('ps-p1-width').fill('3');
  // uPlot draws axes on canvas, so assert the persisted settings and the badge
  const firstPanel = page.locator('.chart-panel').first();
  await expect(firstPanel.locator('.chan-pill.dim')).toHaveText('custom');
  await expect(dlg.getByTestId('ps-p1-yl-max')).toHaveValue('300');
  await expect(dlg.getByTestId('ps-p1-x-max')).toHaveValue('900');
  await expect(dlg.getByTestId('ps-p1-width')).toHaveValue('3');
  await expect(firstPanel.locator('.uplot canvas')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
});
