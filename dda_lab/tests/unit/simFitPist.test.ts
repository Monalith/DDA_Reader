// The reference fit on a pist track model (docs/superpowers/notes/2026-10-11-bmw-fit-pist-line.md):
// the BMW Serres lap fitted on the `.pist.json` centreline and on the rider's racing line inside
// its corridor. The fit must run, match all 16 reference corners, and reproduce the apex speeds;
// the lateral g it needs is reported, not asserted (that is the note's finding).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePistPackage } from '../../src/core/pistPackage';
import { fitRider } from '../../src/sim/fitRider';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { parseReference } from '../../src/sim/reference';
import { fitLine, loadPistModel } from '../../scripts/lib/fitLines';

const BUNDLED = new URL('../../public/tracks/serres.pist.json', import.meta.url).pathname;
/** The package exported by pist's scripts/export-serres.ts (gitignored inbox; checked when present). */
const EXPORTED = new URL('../../../_inbox/serres.pist.json', import.meta.url).pathname;
const BMW = new URL('../../public/examples/serres_BMW_1-19-81.json', import.meta.url).pathname;

const P = clampParams(DEFAULT_SIM_PARAMS);
const raw = JSON.parse(readFileSync(BMW, 'utf8')) as { telemetri_1m: Array<{ lat: number; lon: number; s_m: number; t_s: number; hiz_kmh: number; boylamsal_g: number; gaz_pct: number | null; vites: number | null }> };
const ref = parseReference(raw);

describe('reference fit on a pist track model', () => {
  const model = loadPistModel(BUNDLED);

  it('the track model is rolled to the BMW finish line and carries a resolved corridor', () => {
    const [lon, lat] = model.track.centerline[0];
    const r0 = raw.telemetri_1m[0];
    const dM = Math.hypot((lon - r0.lon) * 111320 * Math.cos((lat * Math.PI) / 180), (lat - r0.lat) * 111320);
    expect(dM).toBeLessThan(15);
    expect(model.corridor).not.toBeNull();
    const known = model.corridor!.known.filter(Boolean).length / model.corridor!.known.length;
    expect(known).toBeGreaterThan(0.95);
  });

  for (const kind of ['centre', 'race'] as const) {
    it(`fits the BMW on the pist ${kind} line: 16 corners matched, apexes reproduced`, () => {
      const line = fitLine(kind, P, raw.telemetri_1m as never, model);
      const fit = fitRider(line, P, ref);
      expect(ref.corners.length).toBe(16);
      expect(fit.corners.length).toBe(16);
      expect(fit.alignment.apexIdx.length).toBe(16);
      // apexes strictly in lap order on the line (no corner matched twice or out of order)
      const sApex = fit.alignment.apexIdx.map((i) => line.cumDistM[i]);
      for (let k = 1; k < sApex.length; k++) expect(sApex[k]).toBeGreaterThan(sApex[k - 1]);
      expect(fit.alignment.notes.some((n) => /out of order/.test(n))).toBe(false);
      // the fit reproduces the reference speed on this line (lap within 0.6 s of the
      // reference speed integrated over the same line, the median apex within 1 km/h).
      // 0.5 s before the exact minimum-curvature line (pist-line note §6); the race
      // line at the preset's κ now reads -0.53 s, mostly K1 (-0.34 s).
      expect(Math.abs(fit.lapTimeS - fit.alignedRefLapS)).toBeLessThan(0.6);
      const dv = fit.residuals.apexKmh.map(Math.abs).sort((a, b) => a - b);
      expect(dv[8]).toBeLessThan(1);
      expect(Number.isFinite(fit.ceiling.aLatG)).toBe(true);
    });
  }

  it.skipIf(!existsSync(EXPORTED))('the lab parses the exported serres.pist.json (version 2, dual trace)', () => {
    const text = readFileSync(EXPORTED, 'utf8');
    const j = JSON.parse(text) as { version: number; provenance?: { tracedInner?: unknown[] } };
    expect(j.version).toBe(2);
    expect(j.provenance?.tracedInner?.length).toBeGreaterThan(10);
    const p = parsePistPackage(text);
    expect(p.corners.length).toBe(16);
    expect(p.startFinish).not.toBeNull();
    const m = loadPistModel(EXPORTED);
    const fit = fitRider(fitLine('race', P, raw.telemetri_1m as never, m), P, ref);
    expect(fit.corners.length).toBe(16);
  });
});
