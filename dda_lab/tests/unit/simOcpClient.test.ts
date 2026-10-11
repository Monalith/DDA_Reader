import { describe, expect, it } from 'vitest';
import {
  buildOcpRequest,
  envelopeFromSpeed,
  ocpBase,
  ocpResultToLine,
  pollOcp,
  submitOcp,
  waitForOcp,
  type OcpJobRequest,
} from '../../src/sim/ocpClient';
import { corridorKey } from '../../src/sim/corridorCache';
import { lineFromOffsets, offsetBounds } from '../../src/sim/line';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { Corridor } from '../../src/sim/types';
import type { LngLat, TrackModel } from '../../src/core/types';

const G = 9.81;

function circleTrack(radiusM: number, halfWidthM: number): { track: TrackModel; corridor: Corridor } {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const n = Math.max(64, Math.round((2 * Math.PI * radiusM) / 2));
  const centerline: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    centerline.push([lng0 + (radiusM * Math.cos(a)) / mPerDegLng, lat0 + (radiusM * Math.sin(a)) / mPerDegLat]);
  }
  const cum = new Float64Array(n);
  const step = (2 * Math.PI * radiusM) / n;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + step;
  const track: TrackModel = {
    id: 'c', name: 'Serres Circle', center: [lng0, lat0], centerline, cumDistM: cum, lengthM: step * n,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
  const corridor: Corridor = {
    stepM: step,
    leftM: new Float32Array(n).fill(halfWidthM),
    rightM: new Float32Array(n).fill(halfWidthM),
    known: new Array(n).fill(true),
  };
  return { track, corridor };
}

interface Call { url: string; init: RequestInit | undefined }

/** A fake `fetch` that records calls and replies from a queue. */
function fakeFetch(replies: Array<{ status: number; body: unknown }>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = replies.shift() ?? { status: 500, body: {} };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('ocpClient base URL', () => {
  it('is the local bridge outside a browser (same rule as corridorService)', () => {
    expect(ocpBase()).toBe('http://127.0.0.1:8777');
  });
});

describe('buildOcpRequest', () => {
  it('sends the centerline, the line box widths, the corridor key, machine and tyre', () => {
    const { track, corridor } = circleTrack(60, 6);
    const params = DEFAULT_SIM_PARAMS;
    const req = buildOcpRequest(track, corridor, params);
    const { loM, hiM } = offsetBounds(track, corridor, params);
    expect(req.key).toBe(corridorKey(track));
    expect(req.key).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(req.centerline).toHaveLength(track.centerline.length);
    expect(req.centerline[3]).toEqual(track.centerline[3]);
    expect(req.leftM).toHaveLength(track.centerline.length);
    expect(req.rightM).toHaveLength(track.centerline.length);
    // the SAME box the browser's line generators use (half bike width + kerb margin)
    expect(req.leftM[5]).toBeCloseTo(hiM[5], 5);
    expect(req.rightM[5]).toBeCloseTo(-loM[5], 5);
    expect(req.machine).toEqual(params.machine);
    expect(req.tyre).toEqual(params.tyre);
    // plain JSON: no typed arrays
    expect(Array.isArray(req.leftM)).toBe(true);
    expect(JSON.parse(JSON.stringify(req)).leftM[5]).toBeCloseTo(hiM[5], 5);
  });
});

describe('submitOcp', () => {
  const req: OcpJobRequest = {
    key: 'circle-1', centerline: [[0, 0], [1, 1]], leftM: [1, 1], rightM: [1, 1],
    machine: DEFAULT_SIM_PARAMS.machine, tyre: DEFAULT_SIM_PARAMS.tyre,
  };

  it('POSTs JSON to /ocp/jobs with the token and returns the id', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 202, body: { id: 'abc123' } }]);
    const out = await submitOcp(req, fetchImpl, { token: 's3cret' });
    expect(out).toEqual({ id: 'abc123' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:8777/ocp/jobs');
    expect(calls[0].init?.method).toBe('POST');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Corridor-Token']).toBe('s3cret');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(req);
  });

  it('throws a readable error on 401 / 429 / 503', async () => {
    for (const [status, word] of [[401, 'token'], [429, 'busy'], [503, 'read-only']] as const) {
      const { fetchImpl } = fakeFetch([{ status, body: {} }]);
      await expect(submitOcp(req, fetchImpl, { token: 'x' })).rejects.toThrow(word);
    }
  });

  it('names a host without the OCP service', async () => {
    const { fetchImpl } = fakeFetch([{ status: 503, body: { error: 'ocp_unavailable' } }]);
    await expect(submitOcp(req, fetchImpl, { token: 'x' })).rejects.toThrow('not installed');
  });

  it('throws when the reply has no id', async () => {
    const { fetchImpl } = fakeFetch([{ status: 202, body: {} }]);
    await expect(submitOcp(req, fetchImpl)).rejects.toThrow();
  });
});

describe('pollOcp', () => {
  it('GETs the job and maps queued / running / done / error', async () => {
    const result = { offsetsM: [0, 1], vMs: [10, 11], lapTimeS: 42 };
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: { id: 'j', status: 'queued' } },
      { status: 200, body: { id: 'j', status: 'running', progress: 0.4 } },
      { status: 200, body: { id: 'j', status: 'done', progress: 1, result } },
      { status: 200, body: { id: 'j', status: 'error', message: 'timeout after 900 s' } },
    ]);
    expect(await pollOcp('j', fetchImpl)).toEqual({ status: 'queued' });
    expect(await pollOcp('j', fetchImpl)).toEqual({ status: 'running', progress: 0.4 });
    expect(await pollOcp('j', fetchImpl)).toEqual({ status: 'done', progress: 1, result });
    expect(await pollOcp('j', fetchImpl)).toEqual({ status: 'error', message: 'timeout after 900 s' });
    expect(calls[0].url).toBe('http://127.0.0.1:8777/ocp/jobs/j');
    expect(calls[0].init?.method ?? 'GET').toBe('GET');
  });

  it('maps 404, an unknown status and a malformed result to error', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 404, body: { error: 'not_found' } },
      { status: 200, body: { status: 'exploded' } },
      { status: 200, body: { status: 'done', result: { offsetsM: [0, NaN], vMs: [1], lapTimeS: 3 } } },
    ]);
    expect((await pollOcp('j', fetchImpl)).status).toBe('error');
    expect((await pollOcp('j', fetchImpl)).status).toBe('error');
    expect((await pollOcp('j', fetchImpl)).status).toBe('error');
  });

  it('maps a network failure to error instead of throwing', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const out = await pollOcp('j', fetchImpl);
    expect(out.status).toBe('error');
  });
});

describe('waitForOcp', () => {
  it('polls until done, reporting progress, without real timers', async () => {
    const result = { offsetsM: [0, 1], vMs: [10, 11], lapTimeS: 42 };
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { status: 'queued' } },
      { status: 200, body: { status: 'running', progress: 0.5 } },
      { status: 200, body: { status: 'done', result } },
    ]);
    const seen: number[] = [];
    const out = await waitForOcp('j', {
      fetchImpl,
      sleep: async () => undefined,
      onProgress: (p) => seen.push(p),
    });
    expect(out).toEqual(result);
    expect(seen).toContain(0.5);
  });

  it('rejects on error and stops when cancelled', async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: { status: 'error', message: 'boom' } }]);
    await expect(waitForOcp('j', { fetchImpl, sleep: async () => undefined })).rejects.toThrow('boom');
    const { fetchImpl: f2, calls } = fakeFetch([{ status: 200, body: { status: 'running' } }]);
    await expect(
      waitForOcp('j', { fetchImpl: f2, sleep: async () => undefined, shouldCancel: () => true }),
    ).rejects.toThrow(/cancel/i);
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});

describe('envelopeFromSpeed', () => {
  it('reproduces latG = v²κ/g, lean opposite to latG, zero longG and a monotone tS on a circle', () => {
    const r = 80;
    const { track } = circleTrack(r, 5);
    const line = lineFromOffsets(track, new Float32Array(track.centerline.length));
    const v = new Float32Array(line.points.length).fill(25);
    const env = envelopeFromSpeed(line, v);
    const n = v.length;
    for (let i = 0; i < n; i += 17) {
      expect(env.latG[i]).toBeCloseTo((25 * 25 * line.curvature[i]) / G, 6);
      expect(env.latG[i]).toBeCloseTo((25 * 25) / r / G, 1);
      // app convention: left = negative lean, tan(lean) = −latG
      expect(Math.tan((env.leanDeg[i] * Math.PI) / 180)).toBeCloseTo(-env.latG[i], 4);
      expect(Math.abs(env.longG[i])).toBeLessThan(1e-6);
    }
    for (let i = 1; i < n; i++) expect(env.tS[i]).toBeGreaterThan(env.tS[i - 1]);
    expect(env.tS[0]).toBe(0);
    expect(env.lapTimeS).toBeCloseTo(line.lengthM / 25, 3);
    expect(env.v).not.toBe(v); // a copy
    expect(env.gripUse.length).toBe(n);
  });

  it('longG is v·dv/ds / g and gripUse is the combined g over μ', () => {
    const { track } = circleTrack(500, 5);
    const line = lineFromOffsets(track, new Float32Array(track.centerline.length));
    const n = line.points.length;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = 20 + 10 * Math.sin((2 * Math.PI * i) / n);
    const env = envelopeFromSpeed(line, v, 1.25);
    const i = Math.round(n / 3);
    const ds = line.cumDistM[i + 1] - line.cumDistM[i];
    const dvds = (v[i + 1] - v[i - 1]) / (2 * ds);
    expect(env.longG[i]).toBeCloseTo((v[i] * dvds) / G, 3);
    expect(env.gripUse[i]).toBeCloseTo(Math.hypot(env.longG[i], env.latG[i]) / 1.25, 5);
    expect(env.lapTimeS).toBeGreaterThan(0);
    expect(Number.isFinite(env.lapTimeS)).toBe(true);
  });
});

describe('ocpResultToLine', () => {
  it('builds the Line from the offsets and the Envelope from the speeds', () => {
    const { track } = circleTrack(60, 6);
    const n = track.centerline.length;
    const result = { offsetsM: new Array(n).fill(1.5), vMs: new Array(n).fill(22), lapTimeS: 17 };
    const { line, envelope } = ocpResultToLine(track, result, DEFAULT_SIM_PARAMS);
    expect(line.offsetM[10]).toBeCloseTo(1.5, 5);
    expect(envelope.v[10]).toBeCloseTo(22, 5);
    expect(envelope.v.length).toBe(n);
  });

  it('rejects a result whose length does not match the centerline', () => {
    const { track } = circleTrack(60, 6);
    expect(() =>
      ocpResultToLine(track, { offsetsM: [0, 1], vMs: [1, 2], lapTimeS: 1 }, DEFAULT_SIM_PARAMS),
    ).toThrow();
  });
});
