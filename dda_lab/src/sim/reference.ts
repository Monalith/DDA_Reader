// A reference lap for the reference-fit rider (fitRider.ts): the BMW / R6
// Serres files in `_inbox/` (`meta`, `viraj_ozeti`, `telemetri_1m`).
//
// Reading rules (docs/superpowers/notes/2026-10-10-virtual-vs-real.md §0):
// `hiz_kmh` is the one measured channel (read off an onboard dash), `t_s` is
// the video clock, `boylamsal_g` is the speed's derivative, and lat/lon is a
// hand-placed line. The `s_m` axis is the files' common TEMPLATE axis — it is
// 3186 m for both laps although the speed integrated over the lap's own clock
// gives 3040 m (BMW) and 3113 m (R6): ∫ds/v over the template axis is 83.8 s
// for a 79.8 s lap. So the axis is a label, not a distance the bike covered.
// `sIntM` re-integrates the distance from speed and time, which is the axis
// the fit aligns to the simulated line (alignRef.ts).
//
// Pure: no DOM, no node APIs.

export interface RefCorner {
  /** "K1".."K16". */
  name: string;
  /** +1 left, -1 right (`yon`: Sol / Sağ). */
  dir: 1 | -1;
  /** Zone on the template axis, metres. */
  zoneM: [number, number];
  /**
   * `bolge_suresi_s`: time from the PREVIOUS zone's end (the start line for
   * the first) to this zone's end. The zones partition the lap up to the last
   * zone's end.
   */
  zoneTimeS: number;
  kmh: { entry: number; apex: number; exit: number };
  /** Geometric apex, template axis, metres. */
  apexM: number;
  /** Brake point, template axis, metres; null when the file has none. */
  brakeM: number | null;
  braked: boolean;
}

export interface Reference {
  name: string;
  lapTimeS: number;
  /** Template axis length, metres (`pist_uzunlugu_m`). */
  lengthM: number;
  corners: RefCorner[];
  /** Speed per template metre, km/h (index = s_m). */
  speedKmh: Float32Array;
  /** Longitudinal g per template metre (the file's `boylamsal_g`). */
  longG: Float32Array;
  /** Clock per template metre, s. */
  tS: Float64Array;
  /** Distance re-integrated from speed and clock per template metre, metres (see the header). */
  sIntM: Float64Array;
  /** sIntM at the end of the lap (closing the last row to the line), metres. */
  lengthIntM: number;
  /**
   * The file's hand-placed position per template metre (±15-20 m), degrees;
   * absent when the file has none. Only used as a PRIOR for which sim corner
   * a reference apex is (alignRef.ts), never as the distance axis.
   */
  lon?: Float64Array;
  lat?: Float64Array;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);

/** True when a parsed JSON object carries a corner summary and a 1 m trace. */
export function isReferenceJson(j: unknown): boolean {
  if (!j || typeof j !== 'object') return false;
  const o = j as Row;
  return Array.isArray(o.viraj_ozeti) && Array.isArray(o.telemetri_1m) && (o.telemetri_1m as unknown[]).length > 10;
}

function parseLapTime(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return Number.NaN;
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(v.trim());
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Parse a reference file. Throws on a file without `viraj_ozeti` /
 * `telemetri_1m`. The trace is resampled onto whole template metres
 * 0 … lengthM−1 (the files already are; this guards gaps).
 */
export function parseReference(j: unknown, fallbackName = 'Reference'): Reference {
  if (!isReferenceJson(j)) throw new Error('not a reference lap: needs viraj_ozeti[] and telemetri_1m[]');
  const o = j as { meta?: Row; viraj_ozeti: Row[]; telemetri_1m: Row[] };
  const meta = o.meta ?? {};
  const rows = o.telemetri_1m
    .map((r) => ({ s: num(r.s_m), t: num(r.t_s), v: num(r.hiz_kmh), g: num(r.boylamsal_g), lon: num(r.lon), lat: num(r.lat) }))
    .filter((r) => Number.isFinite(r.s) && Number.isFinite(r.t) && Number.isFinite(r.v))
    .sort((a, b) => a.s - b.s);
  if (rows.length < 10) throw new Error('reference trace has fewer than 10 usable rows');
  const lastS = rows[rows.length - 1].s;
  const lengthM = Math.max(Math.round(num(meta.pist_uzunlugu_m) || 0), Math.floor(lastS) + 1);
  const lapFromMeta = parseLapTime(meta.tur_suresi ?? meta.lap_time);
  const lapTimeS = Number.isFinite(lapFromMeta) ? lapFromMeta : rows[rows.length - 1].t - rows[0].t;

  const n = lengthM;
  const speedKmh = new Float32Array(n);
  const longG = new Float32Array(n);
  const tS = new Float64Array(n);
  const hasGeo = rows.every((r) => Number.isFinite(r.lon) && Number.isFinite(r.lat));
  const lon = hasGeo ? new Float64Array(n) : undefined;
  const lat = hasGeo ? new Float64Array(n) : undefined;
  let j0 = 0;
  for (let k = 0; k < n; k++) {
    while (j0 < rows.length - 2 && rows[j0 + 1].s < k) j0++;
    const a = rows[j0];
    const b = rows[Math.min(rows.length - 1, j0 + 1)];
    const f = b.s > a.s ? Math.min(1, Math.max(0, (k - a.s) / (b.s - a.s))) : 0;
    speedKmh[k] = a.v + f * (b.v - a.v);
    longG[k] = (Number.isFinite(a.g) ? a.g : 0) + f * ((Number.isFinite(b.g) ? b.g : 0) - (Number.isFinite(a.g) ? a.g : 0));
    tS[k] = a.t + f * (b.t - a.t);
    if (lon && lat) {
      lon[k] = a.lon + f * (b.lon - a.lon);
      lat[k] = a.lat + f * (b.lat - a.lat);
    }
  }
  // distance re-integrated from speed over the lap's own clock (trapezoid in t)
  const sIntM = new Float64Array(n);
  for (let k = 1; k < n; k++) {
    const dt = Math.max(0, tS[k] - tS[k - 1]);
    sIntM[k] = sIntM[k - 1] + ((speedKmh[k] + speedKmh[k - 1]) / 2 / 3.6) * dt;
  }
  // close the lap: the last row to the line takes the rest of the lap time
  const dtClose = Math.max(0, lapTimeS - (tS[n - 1] - tS[0]));
  const lengthIntM = sIntM[n - 1] + ((speedKmh[n - 1] + speedKmh[0]) / 2 / 3.6) * dtClose;

  const corners: RefCorner[] = [];
  for (const r of o.viraj_ozeti) {
    const zone = r.bolge_m as unknown;
    const apexM = num(r.apeks_m);
    if (!Array.isArray(zone) || zone.length !== 2 || !Number.isFinite(apexM)) continue;
    const kmh = (r.hiz_kmh ?? {}) as Row;
    const dirRaw = String(r.yon ?? '').toLowerCase();
    const brake = num(r.fren_basi_m);
    corners.push({
      name: String(r.viraj ?? `K${corners.length + 1}`),
      dir: dirRaw.startsWith('sol') || dirRaw.startsWith('l') ? 1 : -1,
      zoneM: [num(zone[0]), num(zone[1])],
      zoneTimeS: num(r.bolge_suresi_s),
      kmh: { entry: num(kmh.bolge_basi), apex: num(kmh.apeks), exit: num(kmh.cikis) },
      apexM,
      brakeM: Number.isFinite(brake) ? brake : null,
      braked: r.frenli === true,
    });
  }
  corners.sort((a, b) => a.apexM - b.apexM);

  const name = String(meta.kisa_ad ?? meta.ad ?? fallbackName);
  return { name, lapTimeS, lengthM, corners, speedKmh, longG, tS, sIntM, lengthIntM, lon, lat };
}

/** Linear interpolation of a per-template-metre array at template position s (clamped). */
export function atTemplate(a: ArrayLike<number>, s: number): number {
  const n = a.length;
  if (s <= 0) return a[0];
  if (s >= n - 1) return a[n - 1];
  const k = Math.floor(s);
  const f = s - k;
  return a[k] + f * (a[k + 1] - a[k]);
}
