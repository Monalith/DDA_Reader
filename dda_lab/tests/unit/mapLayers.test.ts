import { describe, expect, it } from 'vitest';
import { applyAffine, type Affine } from '../../src/core/affine';
import {
  IMAGE_CORNERS,
  centerlineGeoJson,
  gatesGeoJson,
  rampColor,
  schemaGeoJson,
  traceGeoJson,
} from '../../src/ui/MapLayers';
import {
  DEFAULT_PROC,
  type Channel,
  type Gate,
  type Lap,
  type Session,
  type TrackModel,
} from '../../src/core/types';

function ch(name: string, values: number[], unit = ''): Channel {
  return { name, unit, kind: 'raw', data: Float32Array.from(values), proc: { ...DEFAULT_PROC } };
}

/** 3 GPS samples near Sonoma, with speed / tps / lean / long_g. */
function session(): Session {
  const channels = new Map<string, Channel>();
  channels.set('gps_lon', ch('gps_lon', [-122.4, -122.3999, -122.3998], 'deg'));
  channels.set('gps_lat', ch('gps_lat', [38.16, 38.1601, 38.1602], 'deg'));
  channels.set('speed', ch('speed', [100, 150, 200], 'km/h'));
  channels.set('tps', ch('tps', [0, 50, 100], '%'));
  channels.set('lean', ch('lean', [0, -30, 50], 'deg'));
  channels.set('long_g', ch('long_g', [-0.05, -0.6, 0.3], 'g'));
  return {
    id: 's1',
    name: 'run',
    source: 'dda',
    color: '#ff6a00',
    t: Float64Array.from([0, 0.1, 0.2]),
    channels,
    laps: [],
    meta: { track: '', rider: '', note: '' },
  };
}

const lap: Lap = { n: 1, startIdx: 0, endIdx: 2, timeS: 0.2, sectorsS: [], isBest: true, kind: 'flying' };

function gate(id: string, type: 'sf' | 'split', at: [number, number]): Gate {
  return { id, name: id, type, at, bearingDeg: 0, halfWidthM: 15 };
}

function track(schema?: TrackModel['schema']): TrackModel {
  const centerline: Array<[number, number]> = [
    [-122.4, 38.16],
    [-122.3999, 38.1601],
    [-122.3998, 38.1602],
  ];
  return {
    id: 't1',
    name: 'Test',
    center: [-122.3999, 38.1601],
    centerline,
    cumDistM: Float64Array.from([0, 14, 28]),
    lengthM: 28,
    startFinish: gate('sf', 'sf', [-122.4, 38.16]),
    sectors: [gate('s1', 'split', [-122.3998, 38.1602])],
    turns: [],
    schema,
  };
}

describe('rampColor', () => {
  it('returns the ramp end points and the mid stops', () => {
    expect(rampColor(0, 0, 100)).toBe('#2060ff'); // blue
    expect(rampColor(100, 0, 100)).toBe('#ff2828'); // red
    expect(rampColor(100 / 3, 0, 100)).toBe('#00c878'); // green
    expect(rampColor(200 / 3, 0, 100)).toBe('#ffd200'); // yellow
  });

  it('clamps outside the range and tolerates NaN / zero span', () => {
    expect(rampColor(-10, 0, 100)).toBe(rampColor(0, 0, 100));
    expect(rampColor(1e6, 0, 100)).toBe(rampColor(100, 0, 100));
    expect(rampColor(NaN, 0, 100)).toBe(rampColor(0, 0, 100));
    expect(rampColor(5, 7, 7)).toBe(rampColor(0, 0, 1));
  });
});

describe('traceGeoJson', () => {
  it('builds one LineString per consecutive GPS pair', () => {
    const fc = traceGeoJson(session(), lap, 'solid');
    expect(fc.features).toHaveLength(2);
    const [p0, p1] = fc.features[0].geometry.coordinates;
    // Float32 channel storage, so compare with GPS-grade tolerance.
    expect(p0[0]).toBeCloseTo(-122.4, 4);
    expect(p0[1]).toBeCloseTo(38.16, 4);
    expect(p1[0]).toBeCloseTo(-122.3999, 4);
    expect(p1[1]).toBeCloseTo(38.1601, 4);
    expect(fc.features.map((f) => f.properties.color)).toEqual(['#ff6a00', '#ff6a00']);
    expect(fc.features.map((f) => f.properties.idx)).toEqual([0, 1]);
  });

  it('colours by speed over the lap range', () => {
    const fc = traceGeoJson(session(), lap, 'speed');
    expect(fc.features).toHaveLength(2);
    // speed 100..200 over the lap -> first segment is the low (blue) end
    expect(fc.features[0].properties.color).toBe(rampColor(100, 100, 200));
    expect(fc.features[1].properties.color).toBe(rampColor(150, 100, 200));
    expect(fc.features[0].properties.color).not.toBe(fc.features[1].properties.color);
  });

  it('colours by braking intensity only below -0.15 g', () => {
    const fc = traceGeoJson(session(), lap, 'brake');
    expect(fc.features[0].properties.color).toBe('#5a6676'); // -0.05 g -> neutral
    expect(fc.features[1].properties.color).toMatch(/^#ff/); // -0.6 g -> red-ish
  });

  it('is empty without GPS channels', () => {
    const s = session();
    s.channels.delete('gps_lon');
    expect(traceGeoJson(s, lap, 'speed').features).toHaveLength(0);
  });
});

describe('centerlineGeoJson / gatesGeoJson', () => {
  it('emits the centerline as one LineString', () => {
    const f = centerlineGeoJson(track());
    expect(f.geometry.type).toBe('LineString');
    expect(f.geometry.coordinates).toHaveLength(3);
  });

  it('emits a short crossing line per gate', () => {
    const fc = gatesGeoJson(track());
    expect(fc.features).toHaveLength(2);
    expect(fc.features.map((f) => f.properties.type)).toEqual(['sf', 'split']);
    const [a, b] = fc.features[0].geometry.coordinates;
    // bearing 0 -> the line runs north/south, ~30 m long
    expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-9);
    expect((b[1] - a[1]) * 111195).toBeCloseTo(30, 0);
  });
});

describe('schemaGeoJson', () => {
  const A: Affine = [0.002, 0, -122.4, 0, -0.001, 38.162]; // x -> lng, y flipped -> lat

  const schema: TrackModel['schema'] = {
    imageDataUrl: 'data:image/png;base64,AAAA',
    affine: A,
    apexes: [{ x: 0.25, y: 0.5, turn: 3, label: 'T3' }],
    racingLine: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ],
    trackOutline: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ],
    markers: [{ x: 0.1, y: 0.2, type: 'brake', text: 'hard' }],
    startFinish: { x: 0.5, y: 0.9 },
    turnLabels: [{ n: 3, x: 0.26, y: 0.52 }],
  };

  it('is empty without a schema or without a fitted affine', () => {
    expect(schemaGeoJson(track()).features).toHaveLength(0);
    expect(schemaGeoJson(track({ ...schema, affine: null })).features).toHaveLength(0);
  });

  it('applies the affine to every schema element', () => {
    const fc = schemaGeoJson(track(schema));
    const kinds = fc.features.map((f) => f.properties.kind);
    expect(kinds).toEqual(['outline', 'racingLine', 'schemaApex', 'schemaMarker', 'schemaSF', 'schemaTurn']);

    const apex = fc.features.find((f) => f.properties.kind === 'schemaApex')!;
    expect(apex.geometry.type).toBe('Point');
    expect((apex.geometry as GeoJSON.Point).coordinates).toEqual(applyAffine(A, [0.25, 0.5]));
    expect(apex.properties.label).toBe('T3');

    const line = fc.features.find((f) => f.properties.kind === 'racingLine')!;
    expect((line.geometry as GeoJSON.LineString).coordinates[2]).toEqual(applyAffine(A, [1, 1]));

    const marker = fc.features.find((f) => f.properties.kind === 'schemaMarker')!;
    expect(marker.properties.mtype).toBe('brake');
  });

  it('exposes the image corners in TL,TR,BR,BL order', () => {
    expect(IMAGE_CORNERS).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    expect(applyAffine(A, IMAGE_CORNERS[0])[1]).toBeGreaterThan(applyAffine(A, IMAGE_CORNERS[3])[1]);
  });
});
