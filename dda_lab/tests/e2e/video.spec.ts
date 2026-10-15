import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/sample/sample_run.dda');
const VIDEO = path.join(os.tmpdir(), 'dda-lab-e2e-testsrc.webm');

/** A 12 s, 30 fps test pattern with a seconds counter (VP8 webm plays in any Chromium build). */
function makeVideo(): boolean {
  if (fs.existsSync(VIDEO) && fs.statSync(VIDEO).size > 1000) return true;
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=12', '-c:v', 'libvpx', '-b:v', '400k', '-g', '30', VIDEO]);
    return fs.existsSync(VIDEO);
  } catch {
    return false;
  }
}

const vt = (page: import('@playwright/test').Page) => page.evaluate(() => (document.querySelector('[data-testid=video-element]') as HTMLVideoElement).currentTime);

test('onboard video: open, pre-process, sync, follow the chart, play drives the cursor, saved in the session', async ({ page }) => {
  test.skip(!makeVideo(), 'ffmpeg (with libvpx) is not available to make the test video');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('dda-lab-video-sync'));
  await page.getByTestId('open-files').setInputFiles(SAMPLE);
  await expect(page.locator('.status')).toContainText(/laps/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Time', exact: true }).click();

  // Map ⇄ Video
  await page.getByTestId('map-video-toggle-video').click();
  await expect(page.getByTestId('video-panel')).toBeVisible();
  await expect(page.getByTestId('video-open')).toBeVisible();
  await page.getByTestId('video-open-input').setInputFiles(VIDEO);
  await expect(page.getByTestId('video-name')).toContainText('dda-lab-e2e-testsrc.webm');
  await expect(page.getByTestId('video-name')).toContainText('00:12.00');

  // pre-processing runs by itself and finishes
  const prog = page.getByTestId('video-cache-progress');
  await expect(prog).toHaveAttribute('data-phase', 'done', { timeout: 60_000 });
  const total = Number(await prog.getAttribute('data-total'));
  expect(total).toBeGreaterThan(50);
  expect(Number(await prog.getAttribute('data-done'))).toBe(total);

  // sync: video frame 0 = the clicked sample
  await page.getByTestId('video-follow').selectOption('off');
  const box = (await page.locator('.uplot .u-over').first().boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.5);
  await page.getByTestId('video-sync-here').click();
  await expect(page.locator('.status')).toContainText('Synced');
  await expect(page.getByTestId('video-offset')).not.toHaveValue('0');
  const off = Number(await page.getByTestId('video-offset').inputValue());
  expect(off).toBeGreaterThan(0);

  // hovering the chart moves the video
  await page.getByTestId('video-follow').selectOption('hover');
  for (let i = 0; i < 25; i++) await page.mouse.move(box.x + box.width * (0.105 + i * 0.002), box.y + box.height * 0.5);
  await expect(page.getByTestId('video-timecode')).not.toHaveText('00:00.00');
  await expect.poll(() => vt(page), { timeout: 5000 }).toBeGreaterThan(0.5);
  const scrub = await page.evaluate(() => (window as unknown as { __video: { scrubMs: number[] } }).__video.scrubMs.length);
  expect(scrub).toBeGreaterThan(0);

  // nudge the offset
  await page.getByTestId('video-nudge-p01').click();
  await expect(page.getByTestId('video-offset')).toHaveValue(String(Math.round((off + 0.1) * 10000) / 10000));

  // frame step
  await page.getByTestId('video-follow').selectOption('off');
  await page.waitForTimeout(500); // let the nudge settle
  const t0 = await vt(page);
  await page.getByTestId('video-step-next').click();
  await expect.poll(() => vt(page)).toBeGreaterThan(t0);
  expect((await vt(page)) - t0).toBeLessThan(0.1);

  // play: the video drives the store cursor (the map cursor marker appears)
  const idxBefore = await page.evaluate(() => (window as unknown as { __video: { lastIdx: number | null } }).__video.lastIdx);
  await page.getByTestId('video-speed').selectOption('2');
  await page.getByTestId('video-play').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __video: { lastIdx: number | null } }).__video.lastIdx), { timeout: 5000 }).not.toBe(idxBefore);
  await page.getByTestId('video-play').click();
  await expect.poll(() => page.evaluate(() => (document.querySelector('[data-testid=video-element]') as HTMLVideoElement).paused)).toBe(true);

  // HUD toggle
  await expect(page.getByTestId('video-overlay')).toBeVisible();
  await page.getByTestId('video-overlay-toggle').click();
  await expect(page.getByTestId('video-overlay')).toHaveCount(0);

  // the lab session carries the sync (not the file)
  const dl = page.waitForEvent('download');
  await page.getByTestId('save-session').click();
  const file = await (await dl).path();
  const saved = JSON.parse(fs.readFileSync(file!, 'utf8'));
  expect(saved.video.fileName).toBe('dda-lab-e2e-testsrc.webm');
  expect(saved.video.offsetS).toBeCloseTo(off + 0.1, 3);

  // back to the map; the video panel keeps its file
  await page.getByTestId('map-video-toggle-map').click();
  await expect(page.getByTestId('video-panel')).toBeHidden();
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
