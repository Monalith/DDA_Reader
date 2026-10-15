import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/sample/sample_run.dda');

type LabWindow = { __lab: { getState(): { workspace: { panels: { id: string; lineWidth?: number }[] }; xRange: [number, number] | null; setXRange(r: [number, number] | null): void } } };

const domOrder = (page: Page) =>
  page.locator('.chart-stack > .chart-panel').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.panelId));
const storeOrder = (page: Page) =>
  page.evaluate(() => (window as unknown as LabWindow).__lab.getState().workspace.panels.map((p) => p.id));
const savedOrder = (page: Page) =>
  page.evaluate(() => {
    const raw = localStorage.getItem('dda-lab-workspace');
    return raw ? (JSON.parse(raw).panels as { id: string }[]).map((p) => p.id) : null;
  });

test('chart panels can be reordered with ▲/▼, grip drag and Alt+arrows', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('open-files').setInputFiles(SAMPLE);
  await expect(page.locator('.status')).toContainText(/laps/, { timeout: 30_000 });
  await expect(page.locator('.uplot canvas').first()).toBeVisible();

  const start = await storeOrder(page);
  expect(start.slice(0, 3)).toEqual(['p1', 'p2', 'p3']);
  expect(await domOrder(page)).toEqual(start);

  // ends are disabled
  await expect(page.getByTestId('panel-up-p1')).toBeDisabled();
  await expect(page.getByTestId(`panel-down-${start[start.length - 1]}`)).toBeDisabled();

  // zoom + a per-panel setting, and tag p2's uPlot root to prove it is not remounted
  await page.evaluate(() => (window as unknown as LabWindow).__lab.getState().setXRange([200, 800]));
  await page.getByTestId('panel-gear-p2').click();
  await page.getByTestId('ps-p2-width').fill('3');
  await page.keyboard.press('Escape');
  await page.locator('[data-panel-id="p2"] .uplot').evaluate((el) => ((el as HTMLElement & { __tag?: string }).__tag = 'keep'));

  // 1. button: panel 2 to the top
  await page.getByTestId('panel-up-p2').click();
  const afterUp = ['p2', 'p1', ...start.slice(2)];
  await expect.poll(() => storeOrder(page)).toEqual(afterUp);
  expect(await domOrder(page)).toEqual(afterUp);
  await expect(page.getByTestId('panel-up-p2')).toBeDisabled();
  await expect(page.getByTestId('panel-up-p1')).toBeEnabled();
  expect(await page.locator('[data-panel-id="p2"] .uplot').evaluate((el) => (el as HTMLElement & { __tag?: string }).__tag)).toBe('keep');
  const st = await page.evaluate(() => {
    const s = (window as unknown as LabWindow).__lab.getState();
    return { xRange: s.xRange, width: s.workspace.panels.find((p) => p.id === 'p2')?.lineWidth };
  });
  expect(st).toEqual({ xRange: [200, 800], width: 3 });

  // 2. drag: the panel now first (p2) below the third one (p3) via the grip
  const grip = page.getByTestId('panel-grip-p2');
  const gb = (await grip.boundingBox())!;
  const third = (await page.locator('[data-panel-id="p3"]').boundingBox())!;
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2, third.y + third.height * 0.8, { steps: 8 });
  await expect(page.locator('.chart-panel.drop-before, .chart-panel.drop-after')).toHaveCount(1);
  await page.mouse.up();
  const afterDrag = ['p1', 'p3', 'p2', ...start.slice(3)];
  await expect.poll(() => storeOrder(page)).toEqual(afterDrag);
  expect(await domOrder(page)).toEqual(afterDrag);
  await expect(page.locator('.chart-panel.drop-before, .chart-panel.drop-after, .chart-panel.dragging')).toHaveCount(0);
  expect(await page.locator('[data-panel-id="p2"] .uplot').evaluate((el) => (el as HTMLElement & { __tag?: string }).__tag)).toBe('keep');
  expect(await page.evaluate(() => (window as unknown as LabWindow).__lab.getState().xRange)).toEqual([200, 800]);

  // 3. keyboard: Alt+ArrowUp on the focused grip
  await page.getByTestId('panel-grip-p2').focus();
  await page.keyboard.press('Alt+ArrowUp');
  const afterKey = ['p1', 'p2', 'p3', ...start.slice(3)];
  await expect.poll(() => storeOrder(page)).toEqual(afterKey);
  await expect(page.getByTestId('panel-grip-p2')).toBeFocused();

  // persisted workspace (debounced autosave) keeps the order
  await expect.poll(() => savedOrder(page)).toEqual(afterKey);

  // settings popover still opens after the moves
  await page.getByTestId('panel-gear-p2').click();
  await expect(page.getByTestId('panel-settings-p2')).toBeVisible();
  await expect(page.getByTestId('ps-p2-width')).toHaveValue('3');
  expect(errors, errors.join('\n')).toEqual([]);
});
