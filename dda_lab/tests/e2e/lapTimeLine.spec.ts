import { expect, test, type Page } from '@playwright/test';

// "Optimise line" (lineMode 'lap-time', pist-line note §8-9) on the bundled
// pist Serres: the free-trajectory worker descends the rider's own QSS lap from
// the fastest κ-line and — with the owner's Ducati lap (Run036, gitignored
// _inbox) loaded — from his GPS path too, with the BMW v2 reference pricing
// lateral g over the ceiling; the rider mode then rides the stored line, and
// "Fit to reference" runs on it. The map shows the owner's path next to the
// optimised line; SIM_SHOTS_DIR saves the views.
const BMW_V2 = new URL('../../public/examples/serres_BMW_1-19-81_v2.json', import.meta.url).pathname;
const OWNER = '/Users/macbookmini/projects/DDA_Reader/_inbox/Run036-219926-00.00.dda';
const SHOTS = process.env.SIM_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

type Bounds = [[number, number], [number, number]];
// lon/lat boxes of the optimised line's K2 → K4 and K12 → exit (scratch bounds.ts on the stored line)
const K2_K4: Bounds = [[23.51667, 41.06955], [23.52143, 41.07077]];
const K12_EXIT: Bounds = [[23.51275, 41.07099], [23.51513, 41.07163]];
// K11 → K12 kerb → exit, tighter (the corner the lateral-g penalty reshapes, note §9)
const K12: Bounds = [[23.51355, 41.07082], [23.51535, 41.07170]];

async function fitMap(page: Page, b: Bounds): Promise<void> {
  await page.evaluate((bb) => {
    const m = (window as unknown as { __map: { fitBounds: (b: unknown, o: unknown) => void } }).__map;
    m.fitBounds(bb, { padding: 60, duration: 0 });
  }, b);
  await page.waitForTimeout(2500); // satellite tiles
}

test('optimise line: worker run, progress, the rider rides it, the fit runs on it', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto('/');
  await page.getByTestId('open-files').setInputFiles(BMW_V2);
  const fs = await import('node:fs');
  if (fs.existsSync(OWNER)) await page.getByTestId('open-files').setInputFiles(OWNER);
  // the pist track model (track + corridor) becomes the active track
  const ok = await page.evaluate(async () => {
    const text = await (await fetch('/tracks/serres.pist.json')).text();
    const lab = (window as unknown as { __lab: { getState: () => { importCorridorJson: (t: string) => boolean } } }).__lab;
    return lab.getState().importCorridorJson(text);
  });
  expect(ok).toBe(true);

  await page.getByTestId('bp-tab-sim').click();
  await page.getByTestId('sim-enable').check();
  await expect(page.getByTestId('sim-laptime')).not.toHaveText('—');
  // κ 0, kerb 1.0 (the note's setup)
  await page.evaluate(() => {
    const lab = (window as unknown as { __lab: { getState: () => { setSimParams: (p: unknown) => void } } }).__lab;
    lab.getState().setSimParams({ rider: { kappa: 0 }, tyre: { kerbM: 1 } });
  });
  const before = (await page.getByTestId('sim-laptime').textContent()) ?? '';

  const t0 = Date.now();
  await page.getByTestId('sim-optimise-line').click();
  await expect(page.getByTestId('sim-line-opt-progress')).toBeVisible();
  await expect(page.getByTestId('sim-line-opt-status')).toContainText('start 1/', { timeout: 10_000 });
  await shot(page, 'lt-01-progress');
  const owner = fs.existsSync(OWNER);
  if (owner) {
    await expect(page.getByTestId('sim-line-opt-status')).toContainText('start 2/2', { timeout: 60_000 });
    console.log(`second start at ${((Date.now() - t0) / 1000).toFixed(1)} s: ${await page.getByTestId('sim-line-opt-status').textContent()}`);
    await shot(page, 'lt-01b-progress-start2');
  }
  await expect(page.getByTestId('sim-line-opt-status')).toContainText('optimised', { timeout: 180_000 });
  const runMs = Date.now() - t0;
  console.log(`info: ${await page.getByTestId('sim-line-opt-info').textContent()}`);
  await expect(page.getByTestId('sim-line-opt-info')).toContainText(owner ? 'of 2 starts' : 'of 1 start');
  await expect(page.getByTestId('sim-line-opt-info')).toContainText('lateral-g penalty');
  expect(runMs).toBeLessThan(40_000); // worker budget 28 s + the warm-start/alignment prep + UI
  await expect(page.getByTestId('sim-line-mode')).toHaveValue('lap-time');
  const after = (await page.getByTestId('sim-laptime').textContent()) ?? '';
  console.log(`optimise line: ${(runMs / 1000).toFixed(1)} s in the browser; lap ${before} → ${after}`);

  // a re-simulation on the stored line is cheap (no optimiser in setSimParams)
  const simMs = await page.evaluate(() => {
    const lab = (window as unknown as { __lab: { getState: () => { setSimParams: (p: unknown) => void } } }).__lab;
    const t = performance.now();
    lab.getState().setSimParams({ rider: { lineMode: 'lap-time' } });
    return performance.now() - t;
  });
  console.log(`setSimParams on the stored lap-time line: ${simMs.toFixed(0)} ms`);
  await shot(page, 'lt-02-done');

  // the fit-to-reference mode runs on that line
  await page.getByTestId('sim-mode-fit').click();
  await page.getByTestId('sim-fit-run').click();
  await expect(page.getByTestId('sim-fit-table').locator('tbody tr')).toHaveCount(16);
  console.log(`fit: ${await page.getByTestId('sim-fit-status').textContent()}`);
  const fitRows = await page.evaluate(() => {
    type St = { simFit?: { rows: Array<{ name: string; aLatG: number; aLatPeakG: number }> }; simLineOptInfo?: unknown };
    const st = (window as unknown as { __lab: { getState: () => St } }).__lab.getState();
    return { info: st.simLineOptInfo, rows: (st.simFit?.rows ?? []).filter((r) => ['K2', 'K4', 'K6', 'K12'].includes(r.name)) };
  });
  console.log(`run: ${JSON.stringify(fitRows.info)}`);
  console.log(`fit g: ${fitRows.rows.map((r) => `${r.name} ${r.aLatG.toFixed(2)}${r.name === 'K12' ? ` (zone ${r.aLatPeakG.toFixed(2)})` : ''}`).join(', ')}`);
  await shot(page, 'lt-03-fit');

  // map views: the owner's lap (Ducati best, lap 6) + the optimised line (the
  // sim session's trace and the ideal-line layer); labels and other laps off
  await page.evaluate(() => {
    type S = { sessions: Array<{ id: string; name: string }>; selectedLaps: Array<{ sessionId: string; lap: number }> };
    const lab = (window as unknown as { __lab: { getState: () => S; setState: (p: Partial<S>) => void } }).__lab;
    const st = lab.getState();
    const duc = st.sessions.find((x) => x.name.startsWith('Run036'));
    lab.setState({ selectedLaps: st.selectedLaps.filter((l) => l.sessionId === 'sim' || l.sessionId === duc?.id) });
    // one solid colour per lap: owner = his session's blue, the optimised line = the virtual rider's purple
    (lab.getState() as unknown as { setMapColorBy: (c: string) => void }).setMapColorBy('solid');
  });
  await page.evaluate(() => {
    const m = (window as unknown as { __map: { getStyle: () => { layers: Array<{ id: string; type: string }> }; setLayoutProperty: (id: string, k: string, v: string) => void } }).__map;
    for (const l of m.getStyle().layers) if (l.type === 'symbol' || /corner-events|markers-/.test(l.id)) m.setLayoutProperty(l.id, 'visibility', 'none');
  });
  await page.setViewportSize({ width: 2600, height: 1300 });
  await page.waitForTimeout(800);
  await page.evaluate(() => (window as unknown as { __map: { resize: () => void } }).__map.resize());
  await fitMap(page, K2_K4);
  if (SHOTS) await page.getByTestId('map-wrap').screenshot({ path: `${SHOTS}/lt-map-K2-K4.png` });
  await fitMap(page, K12_EXIT);
  if (SHOTS) await page.getByTestId('map-wrap').screenshot({ path: `${SHOTS}/lt-map-K12-exit.png` });
  await fitMap(page, K12);
  if (SHOTS) await page.getByTestId('map-wrap').screenshot({ path: `${SHOTS}/lt-map-K12.png` });
});
