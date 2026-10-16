import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/sample/sample_run.dda');
const VIDEO = path.join(os.tmpdir(), 'dda-lab-e2e-testsrc.webm'); // same fixture as video.spec.ts

function makeVideo(): boolean {
  if (fs.existsSync(VIDEO) && fs.statSync(VIDEO).size > 1000) return true;
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=12', '-c:v', 'libvpx', '-b:v', '400k', '-g', '30', VIDEO]);
    return fs.existsSync(VIDEO);
  } catch {
    return false;
  }
}

test('onboard video: 🏁 Start line marks the current frame, badge + flag, go-to, clear', async ({ page }) => {
  test.skip(!makeVideo(), 'ffmpeg (with libvpx) is not available to make the test video');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('dda-lab-video-sync'));
  await page.getByTestId('open-files').setInputFiles(SAMPLE);
  await expect(page.locator('.status')).toContainText(/laps/, { timeout: 30_000 });
  await page.getByTestId('map-video-toggle-video').click();
  await page.getByTestId('video-open-input').setInputFiles(VIDEO);
  await expect(page.getByTestId('video-name')).toContainText('00:12.00');
  await page.getByTestId('video-follow').selectOption('off');

  // move to ~2 s, mark the start line there
  await page.getByTestId('video-jump-p1').click();
  await page.getByTestId('video-jump-p1').click();
  await expect(page.getByTestId('video-start-line-tc')).toHaveCount(0);
  await page.getByTestId('video-start-line').click();
  await expect(page.locator('.status')).toContainText('Start line = video 00:02');
  await expect(page.getByTestId('video-start-line-tc')).toBeVisible();
  await expect(page.getByTestId('video-start-line-tc')).toContainText('00:02');
  await expect(page.getByTestId('video-start-badge')).toBeVisible();
  await expect(page.getByTestId('video-start-badge')).toContainText('START');
  await expect(page.getByTestId('video-seek-start-flag')).toBeVisible();

  // away from it: no badge; before it: the dim hint
  await page.getByTestId('video-jump-m1').click();
  await expect(page.getByTestId('video-start-badge')).toHaveCount(0);
  await expect(page.getByTestId('video-before-start')).toBeVisible();

  // go back to the start-line frame
  await page.getByTestId('video-start-line-go').click();
  await expect(page.getByTestId('video-start-badge')).toBeVisible();

  // clear
  await page.getByTestId('video-start-line-clear').click();
  await expect(page.getByTestId('video-start-line-tc')).toHaveCount(0);
  await expect(page.getByTestId('video-start-badge')).toHaveCount(0);
  await expect(page.getByTestId('video-seek-start-flag')).toHaveCount(0);

  // S key in the panel sets it again
  await page.getByTestId('video-panel').focus();
  await page.keyboard.press('s');
  await expect(page.getByTestId('video-start-line-tc')).toBeVisible();
  await expect(page.getByTestId('video-start-badge')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
