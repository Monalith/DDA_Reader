import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';

// "Fit to lap" (spec 2026-10-14): the virtual rider's OWN parameters fitted to
// the owner's Ducati lap 6 (Run036, gitignored _inbox) on the serres-v6 track
// model, then a corner's sliders moved and reset.
const DUCATI = '/Users/macbookmini/projects/DDA_Reader/_inbox/Run036-219926-00.00.json';
const REF_LAP_S = 95.8;
const SHOTS = process.env.SIM_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

/** Evaluate `fn(state)` against the store (`window.__lab`). */
function lab<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(`(${fn})(window.__lab.getState())`) as Promise<T>;
}

const CORNER_KEYS = ['kappa', 'sBrake', 'trailBrakeDepth', 'trailBrakeProfile', 'brakeRiseGps', 'sLat', 'leanUsage', 'throttleDelayS', 'rollOnS', 'sDrive', 'rollRateFrac', 'slideOut'];

test('fit to lap: Run036 L6 → fitted rider, corner editor, live lap time, reset corner', async ({ page }) => {
  test.skip(!fs.existsSync(DUCATI), `${DUCATI} not present`);
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto('/');
  await page.getByTestId('open-files').setInputFiles(DUCATI);
  await expect.poll(() => lab<number>(page, '(st) => st.sessions.length')).toBeGreaterThan(0);

  // the serres-v6 track model becomes the active track (its turns = the corners)
  await page.getByTestId('map-track-model').selectOption('serres-v6');
  await expect
    .poll(() => lab<number>(page, `(st) => (st.trackPackage && st.tracks.find((t) => t.id === st.activeTrackId)?.turns.length) || 0`), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(16);

  await page.getByTestId('bp-tab-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();
  await page.getByTestId('sim-enable').check();
  await expect(page.getByTestId('sim-laptime')).not.toHaveText('—');

  // pick lap 6 of the Ducati run
  const sid = await lab<string>(page, `(st) => st.sessions.find((s) => !s.isSim && s.name.startsWith('Run036')).id`);
  await page.getByTestId('sim-fit-ref').selectOption(`${sid}|6`);
  await expect(page.getByTestId('sim-fit-status')).toContainText('L6');

  const t0 = Date.now();
  await page.getByTestId('sim-fit-run').click();
  await expect
    .poll(() => lab<boolean>(page, '(st) => !st.riderFit.busy && !!st.riderFit.ref'), { timeout: 40_000 })
    .toBe(true);
  const fitMs = Date.now() - t0;
  const fit = await lab<{ lap: number; ref: number; refOnLine: number | null; error: string | null; stats: unknown; agg: number; risk: number }>(
    page,
    `(st) => ({ lap: st.riderFit.lapTimeS, ref: st.riderFit.ref.refLapTimeS, refOnLine: st.riderFit.refOnLineS, error: st.riderFit.error,
      stats: st.riderFit.stats, agg: st.riderFit.fittedRider.aggressiveness, risk: st.riderFit.fittedRider.risk })`,
  );
  console.log(`fit in ${(fitMs / 1000).toFixed(1)} s: virtual ${fit.lap.toFixed(2)} s vs you ${fit.ref.toFixed(2)} s (on line ${fit.refOnLine?.toFixed(2)}) · stats ${JSON.stringify(fit.stats)}`);
  expect(fit.error).toBeNull();
  expect(Math.abs(fit.lap - REF_LAP_S), `virtual ${fit.lap} vs ${REF_LAP_S}`).toBeLessThanOrEqual(1.0);
  await expect(page.getByTestId('sim-fit-status')).toContainText('Virtual you');

  // the table: one row per track-model corner
  const rows = await page.getByTestId('sim-fit-table').locator('tbody tr').count();
  expect(rows).toBeGreaterThanOrEqual(16);

  // the lap-wide A/R sliders show the fitted values
  for (const [id, v] of [['sim-aggressiveness', fit.agg], ['sim-risk-slider', fit.risk]] as const) {
    const dom = Number(await page.getByTestId(id).inputValue());
    expect(Math.abs(dom - v), `${id}: slider ${dom} vs fitted ${v}`).toBeLessThanOrEqual(0.005 + 1e-6);
  }
  await shot(page, 'rf-01-fitted');

  // a braked-into corner: the slowest reference apex
  const n = await lab<number>(page, `(st) => st.riderFit.rows.reduce((b, r) => (r.apexRefKmh < b.apexRefKmh ? r : b)).n`);
  await page.getByTestId(`sim-corner-chip-${n}`).click();
  await expect(page.getByTestId('sim-corner-editor')).toBeVisible();

  // the editor's sliders read the effective values: the corner's own ?? lap-wide
  const eff = await lab<Record<string, number>>(
    page,
    `(st) => { const r = st.simParams.rider; const c = (r.corners && r.corners[${n}]) || {}; const o = {};
      for (const k of ${JSON.stringify(CORNER_KEYS)}) o[k] = c[k] ?? (k === 'slideOut' ? (r.slideOut ?? 0) : r[k]); return o; }`,
  );
  for (const key of CORNER_KEYS) {
    const input = page.getByTestId(`sim-corner-${key}`);
    const dom = Number(await input.inputValue());
    const step = Number(await input.getAttribute('step'));
    const lo = Number(await input.getAttribute('min'));
    const hi = Number(await input.getAttribute('max'));
    const want = Math.min(hi, Math.max(lo, eff[key]));
    expect(Math.abs(dom - want), `${key}: slider ${dom} vs effective ${eff[key]}`).toBeLessThanOrEqual(step / 2 + 1e-6);
  }

  // moving the corner's brake slip re-rides the lap: the lap time moves
  const lapFitted = await lab<number>(page, '(st) => st.riderFit.lapTimeS');
  const sBrake = page.getByTestId('sim-corner-sBrake');
  await sBrake.focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft');
  await expect.poll(() => lab<number>(page, '(st) => Math.abs(st.riderFit.lapTimeS - ' + lapFitted + ')'), { timeout: 5_000 }).toBeGreaterThan(0.005);
  const moved = await lab<number>(page, '(st) => st.riderFit.lapTimeS');
  console.log(`corner ${n} sBrake −0.30: lap ${lapFitted.toFixed(3)} → ${moved.toFixed(3)} s`);
  await shot(page, 'rf-02-corner-moved');

  // Reset corner → the fitted values and the fitted lap time
  await page.getByTestId('sim-corner-reset').click();
  await expect.poll(() => lab<number>(page, '(st) => st.riderFit.lapTimeS')).toBeCloseTo(lapFitted, 6);
  await expect(page.getByTestId('sim-corner-reset')).toBeDisabled();
});
