import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 1x1 transparent PNG, inlined so the test needs no image tooling.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DDA = path.resolve(HERE, '../../public/sample/sample_run.dda');

const FAKE_SCHEMA = {
  track_outline: [
    [0.1, 0.1],
    [0.9, 0.1],
    [0.9, 0.9],
    [0.1, 0.9],
  ],
  racing_line: [
    [0.15, 0.2],
    [0.5, 0.25],
    [0.8, 0.5],
  ],
  apexes: [
    { turn: 1, x: 0.3, y: 0.3, label: 'T1' },
    { turn: 2, x: 0.6, y: 0.4, label: 'T2' },
  ],
  markers: [{ type: 'brake', x: 0.25, y: 0.28, text: 'hard' }],
  start_finish: { x: 0.12, y: 0.5 },
  turn_labels: [{ n: 1, x: 0.31, y: 0.32 }],
};

/** Mock the local bridge so the test never shells out to `claude`. */
async function mockBridge(page: Page) {
  await page.route('**/health', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, claude: true }) }),
  );
  await page.route('**/analyze-schema', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_SCHEMA) }),
  );
}

test.describe('schema import', () => {
  test.beforeEach(async ({ page }) => {
    await mockBridge(page);
    await page.goto('/');
  });

  test('analyzes a schema image through the mocked bridge', async ({ page }) => {
    // Load the sample session (the top bar hides the real input behind a button).
    await page.setInputFiles('input[type=file]', SAMPLE_DDA).catch(async () => {
      await page.getByTestId('open-files').click();
      await page.setInputFiles('input[type=file]', SAMPLE_DDA);
    });

    await page.getByTestId('schema-import').click();
    await expect(page.getByTestId('schema-modal')).toBeVisible();

    await page.getByTestId('schema-file').setInputFiles({
      name: 'schema.png',
      mimeType: 'image/png',
      buffer: PNG_1X1,
    });

    await expect(page.getByTestId('schema-bridge-state')).toContainText('Claude CLI ready');
    await page.getByTestId('schema-analyze').click();

    const counts = page.getByTestId('schema-counts');
    await expect(counts).toBeVisible();
    await expect(counts).toContainText('2 apexes');
    await expect(counts).toContainText('3 racing line points');
    await expect(counts).toContainText('1 markers');
  });

  test('falls back to manual apex marking', async ({ page }) => {
    await page.getByTestId('schema-import').click();
    await page.getByTestId('schema-file').setInputFiles({
      name: 'schema.png',
      mimeType: 'image/png',
      buffer: PNG_1X1,
    });
    await page.getByTestId('schema-manual').click();
    await page.getByTestId('schema-image').click({ position: { x: 0, y: 0 } });
    await expect(page.getByTestId('schema-counts')).toContainText('1 apexes marked manually');

    // Alignment step needs 3 pairs before Fit becomes available.
    await page.getByTestId('schema-align').click();
    await expect(page.getByTestId('schema-align-hint')).toBeVisible();
    await expect(page.getByTestId('schema-fit')).toBeDisabled();
  });

  test('map tools are present', async ({ page }) => {
    await expect(page.getByTestId('map-canvas')).toBeVisible();
    await page.getByTestId('map-layers').click();
    await expect(page.getByTestId('map-layer-trace')).toBeVisible();
    await page.getByTestId('map-measure').click();
    await expect(page.getByTestId('map-status')).toContainText('Measure');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('map-status')).toBeHidden();
  });
});
