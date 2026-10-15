import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { corridorFromPist, parsePistPackage, trackFromPist } from '../../src/core/pistPackage';
import { pistGeoJson } from '../../src/ui/SimLayers';
import { useLab } from '../../src/state/store';

const TEXT = readFileSync(new URL('../../public/tracks/serres.pist.json', import.meta.url), 'utf8');

describe('pist package → track model + corridor', () => {
  const p = parsePistPackage(TEXT);

  it('parses the bundled Serres package', () => {
    expect(p.name).toMatch(/Serres/);
    expect(p.centerline.length).toBeGreaterThan(3000);
    expect(p.corners.length).toBeGreaterThanOrEqual(14);
    expect(p.startFinish).not.toBeNull();
  });

  it('rejects anything that is not a version-2 package', () => {
    expect(() => parsePistPackage('{}')).toThrow(/version/);
    expect(() => parsePistPackage('nope')).toThrow(/JSON/);
    expect(() => parsePistPackage(JSON.stringify({ version: 2, center: [1, 2], centerline: [[1, 2]], cumDistM: [0] }))).toThrow(/centerline/);
  });

  it('builds a 2 m track whose length matches the package and whose turns follow the corners', () => {
    const t = trackFromPist(p);
    expect(Math.abs(t.lengthM - p.lengthM)).toBeLessThan(p.lengthM * 0.01);
    expect(t.centerline.length).toBeGreaterThan(1400);
    expect(t.centerline.length).toBeLessThan(1700);
    expect(t.turns.length).toBe(p.corners.length);
    expect(t.startFinish.type).toBe('sf');
    expect(t.sectors.length).toBeGreaterThan(0);
    for (let i = 1; i < t.cumDistM.length; i++) expect(t.cumDistM[i]).toBeGreaterThan(t.cumDistM[i - 1]);
  });

  it('uses the package sector gates when it has them, else splits evenly', () => {
    const obj = JSON.parse(TEXT);
    const i1 = Math.floor(obj.centerline.length * 0.4), i2 = Math.floor(obj.centerline.length * 0.7);
    obj.sectors = [
      { at: obj.centerline[i1], bearingDeg: 12.5, halfWidthM: 9 },
      { at: obj.centerline[i2], bearingDeg: 200, halfWidthM: 9 },
      { at: [1, 'x'], bearingDeg: 1, halfWidthM: 9 }, // malformed: dropped
    ];
    const withS = parsePistPackage(JSON.stringify(obj));
    expect(withS.sectors.length).toBe(2);
    const t = trackFromPist(withS);
    expect(t.sectors.map((g) => [g.id, g.name, g.type])).toEqual([['split1', 'S1', 'split'], ['split2', 'S2', 'split']]);
    expect(t.sectors[0]!.at).toEqual(obj.centerline[i1]);
    expect(t.sectors[0]!.bearingDeg).toBe(12.5);
    expect(t.sectors[1]!.halfWidthM).toBe(9);
    // no sectors field (older package) → the even default, as before
    delete obj.sectors;
    const noS = parsePistPackage(JSON.stringify(obj));
    expect(noS.sectors).toEqual([]);
    expect(trackFromPist(noS).sectors.length).toBe(2);
  });

  it('turns the package edges into a corridor on its own track', () => {
    const t = trackFromPist(p);
    const c = corridorFromPist(p, t)!;
    expect(c).not.toBeNull();
    const known = c.known.filter(Boolean).length / c.known.length;
    expect(known).toBeGreaterThan(0.95);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < c.known.length; i++) if (c.known[i]) { sum += c.leftM[i] + c.rightM[i]; n++; }
    const width = sum / n;
    expect(width).toBeGreaterThan(10); // Serres is ~12-14 m
    expect(width).toBeLessThan(18);
  });

  it('draws edges, centreline and corner apices', () => {
    const g = pistGeoJson(p);
    const kinds = g.features.map((f) => f.properties.kind);
    expect(kinds.filter((k) => k === 'edge').length).toBeGreaterThanOrEqual(2);
    expect(kinds.filter((k) => k === 'centerline').length).toBe(1);
    expect(kinds.filter((k) => k === 'corner').length).toBe(p.corners.length);
    expect(pistGeoJson(undefined).features.length).toBe(0);
  });

  it('applyTrackPackage makes it the active track with the corridor and keeps the sim following', () => {
    useLab.getState().applyTrackPackage(p);
    const st = useLab.getState();
    expect(st.activeTrackId).toMatch(/^pist-/);
    expect(st.trackPackage?.name).toBe(p.name);
    expect(st.corridor).toBeDefined();
    expect(st.statusMessage).toMatch(/Track model/);
    // the rider can run on a package alone (benchmark mode: no session needed)
    st.setSimEnabled(true);
    const sim = useLab.getState().sessions.find((s) => s.id === 'sim');
    expect(sim).toBeDefined();
    expect(useLab.getState().simLapTimeS).toBeGreaterThan(60);
    expect(useLab.getState().simLapTimeS).toBeLessThan(100);
  });
});
