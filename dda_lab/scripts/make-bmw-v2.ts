// Build the corrected BMW reference (v2) from the original 1:19.81 file:
//
//   cd dda_lab && npx vite-node scripts/make-bmw-v2.ts [original.json]
//
// Corrections (docs/superpowers/notes/2026-10-11-bmw-k8-k12-reread.md §3, §6):
//
//   1. `ham_veri` frames 950-1005 (the K8 OCR gap): the per-frame dash re-read
//      replaces the interpolated trace and the two wrong hand points (967: 118
//      → 114, 987: 119 → 115). The smoothed speed `duzgun_hiz_kmh` is rebuilt
//      over frames 941-1012 the way the file's is (linear between readings,
//      Gaussian σ 2 frames: reproduces v1's smoothing in the gap to ≤ 0.2 km/h;
//      the span runs 6 frames past the gap so both edges join v1 within 0.4 km/h).
//   2. The distance axis is re-aligned. The file integrated the speed and
//      pinned it to the speed minima of K1, K5, K10, K11, K13, K15. v2 keeps
//      K1, K5, K10, K13, K15 (K5 and K10 are confirmed by the re-read), DROPS
//      the K11 minimum (mid-corner on a long right with no kerb) and adds the
//      inside-kerb times: K8 35.1 s → 1375 m, K11 turn-in kerb 51.3 s → its
//      v1 position, K12 55.5 s → 2085 m. Between two anchors the integral is
//      scaled linearly; frames before K5 and after K13 keep their v1 `s_m`
//      exactly (their anchors did not change).
//   3. `telemetri_1m` is resampled from the frames on the new axis in
//      1063-2516 m (outside it the rows are v1's, byte for byte). lat/lon stay
//      on their template metre (they are the map line, shared with the R6
//      file). `boylamsal_g` keeps v1's value at the same lap TIME, except in the
//      corrected speed window (33.9-36.6 s), where it is recomputed as the ±8 m
//      central difference of the new trace (the closest match to the file's
//      own g: 0.039 g rms over the lap), blended over 0.3 s at the edges.
//   4. `viraj_ozeti`: K8 apex 1393 → 1375 and K12 apex 2117 → 2085 (the
//      inside kerb; the file's apexes were exit points, note §4); K11 apex
//      follows its speed minimum onto the new axis; brake points in the
//      re-aligned span follow their lap time; zones stay (template geometry,
//      shared with the R6 file); every zone's entry / apex / exit speed and
//      zone time are recomputed from the new trace.
//
// Writes public/examples/serres_BMW_1-19-81_v2.json and
// _inbox/serres_BMW_1-19-81_v2.json; the original is not touched.
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/Users/macbookmini/projects/DDA_Reader';
const SRC = process.argv[2] ?? `${ROOT}/_inbox/serres_BMW_1-19-81.json`;
const OUT = [`${ROOT}/dda_lab/public/examples/serres_BMW_1-19-81_v2.json`, `${ROOT}/_inbox/serres_BMW_1-19-81_v2.json`];
const NOTE = 'docs/superpowers/notes/2026-10-11-bmw-k8-k12-reread.md';

interface Frame {
  kare: number;
  t_s: number;
  okunan_hiz_kmh: number | null;
  kaynak: string;
  duzgun_hiz_kmh: number;
  s_m: number;
  duzeltme?: string;
}
interface Row {
  s_m: number;
  t_s: number;
  hiz_kmh: number;
  gaz_pct: number | null;
  vites: number | null;
  boylamsal_g: number;
  lat: number;
  lon: number;
}
interface Corner {
  viraj: string;
  yon: string;
  bolge_m: [number, number];
  bolge_suresi_s: number;
  hiz_kmh: { bolge_basi: number; apeks: number; cikis: number };
  apeks_m: number;
  fren_basi_m: number | null;
  frenli: boolean;
}
interface RefFile {
  meta: Record<string, unknown>;
  viraj_ozeti: Corner[];
  telemetri_1m: Row[];
  ham_veri: { aciklama: string; ornekler: Frame[] };
}

/** Per-frame dash readings, frames 950-1005 (note §3, K8 table + the ×4 zoom of 964-969 / 986-987). */
const READ: Record<number, number> = {
  950: 121, // "12?" (≈121)
  953: 118,
  956: 117,
  957: 117, // v1 hand point, agrees
  958: 115,
  961: 114,
  964: 114,
  965: 114,
  966: 114,
  967: 114, // v1 hand point 118: the zoom shows 114
  968: 114,
  969: 114,
  970: 112,
  973: 112,
  976: 112,
  977: 112, // v1 hand point, agrees
  980: 112,
  983: 114,
  986: 115,
  987: 115, // v1 hand point 119: the zoom shows 115
  989: 117, // "11?" (≈117)
  991: 119,
  993: 120,
  996: 122,
  999: 125,
  1002: 127,
};
const UNCERTAIN = new Set([950, 989]);
const GAP: [number, number] = [950, 1005];
/** Frames whose smoothed speed is rebuilt (the gap plus the smoothing kernel's reach). */
const SMOOTH_SPAN: [number, number] = [941, 1012];
const SIGMA_FRAMES = 2;
/** Lap-time window whose longitudinal g is recomputed, s; blend width, s. */
const G_WIN: [number, number] = [33.9, 36.6];
const G_BLEND_S = 0.3;
const G_HALF_M = 8;

const r1 = (x: number): number => Math.round(x * 10) / 10;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

function interp(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const f = (x - xs[lo]) / Math.max(1e-12, xs[hi] - xs[lo]);
  return ys[lo] + f * (ys[hi] - ys[lo]);
}

const v1 = JSON.parse(readFileSync(SRC, 'utf8')) as RefFile;
const out = JSON.parse(JSON.stringify(v1)) as RefFile;
const fr = out.ham_veri.ornekler;
const fr1 = v1.ham_veri.ornekler;
const rows1 = v1.telemetri_1m;
const idxOf = new Map(fr.map((f, i) => [f.kare, i]));

// ---------------------------------------------------------------------------
// 1. readings + smoothing
for (let k = GAP[0]; k <= GAP[1]; k++) {
  const f = fr[idxOf.get(k)!];
  if (READ[k] !== undefined) {
    const was = f.okunan_hiz_kmh;
    f.okunan_hiz_kmh = READ[k];
    f.kaynak = 'manuel';
    f.duzeltme = UNCERTAIN.has(k) ? 'v2: elle okundu, belirsiz hane' : was === null ? 'v2: elle okundu' : was !== READ[k] ? `v2: elle okundu (v1 ${was})` : 'v2: v1 ile aynı';
  } else if (f.kaynak !== 'interp') {
    f.okunan_hiz_kmh = null;
    f.kaynak = 'interp';
  }
}
{
  // raw: linear between readings over a span wide enough for the kernel
  const a = idxOf.get(SMOOTH_SPAN[0] - 20)!;
  const b = idxOf.get(SMOOTH_SPAN[1] + 20)!;
  const kx: number[] = [];
  const ky: number[] = [];
  for (let i = a; i <= b; i++) if (fr[i].okunan_hiz_kmh !== null) {
    kx.push(i);
    ky.push(fr[i].okunan_hiz_kmh!);
  }
  const raw = new Map<number, number>();
  for (let i = a; i <= b; i++) raw.set(i, interp(kx, ky, i));
  const h = Math.ceil(3 * SIGMA_FRAMES);
  for (let k = SMOOTH_SPAN[0]; k <= SMOOTH_SPAN[1]; k++) {
    const i = idxOf.get(k)!;
    let s = 0;
    let w = 0;
    for (let d = -h; d <= h; d++) {
      const q = Math.exp((-d * d) / (2 * SIGMA_FRAMES * SIGMA_FRAMES));
      s += raw.get(i + d)! * q;
      w += q;
    }
    fr[i].duzgun_hiz_kmh = r1(s / w);
  }
}

// ---------------------------------------------------------------------------
// 2. distance re-alignment
const tAtS1 = (s: number): number => interp(rows1.map((r) => r.s_m), rows1.map((r) => r.t_s), s);
const sAtT1 = (t: number): number => interp(fr1.map((f) => f.t_s), fr1.map((f) => f.s_m), t);
const frameAtT = (t: number): number => {
  let best = 0;
  for (let i = 0; i < fr.length; i++) if (Math.abs(fr[i].t_s - t) < Math.abs(fr[best].t_s - t)) best = i;
  return best;
};
const apex1 = (name: string): number => v1.viraj_ozeti.find((c) => c.viraj === name)!.apeks_m;
// anchors kept from v1 (the speed-minimum time of the apex) — the span ends must sit exactly on v1 frames
const K5 = frameAtT(tAtS1(apex1('K5')));
const K13 = frameAtT(tAtS1(apex1('K13')));
interface Anchor {
  name: string;
  t: number;
  s: number;
  why: string;
}
const anchors: Anchor[] = [
  { name: 'K5', t: fr1[K5].t_s, s: fr1[K5].s_m, why: 'v1 çapası (en düşük hız; video doğruladı)' },
  { name: 'K8', t: 35.1, s: 1375, why: 'iç kerb (kareler 955-980), en düşük hız 112' },
  { name: 'K10', t: tAtS1(apex1('K10')), s: apex1('K10'), why: 'v1 çapası (en düşük hız; video doğruladı)' },
  { name: 'K11-kerb', t: 51.3, s: r1(sAtT1(51.3)), why: 'K11 dönüş kerbi (kare 1380), v1 konumunda' },
  { name: 'K12', t: 55.5, s: 2085, why: 'K12 iç kerbinin ortası (kareler 1478-1495)' },
  { name: 'K13', t: fr1[K13].t_s, s: fr1[K13].s_m, why: 'v1 çapası (en düşük hız)' },
];
// integral of the new smoothed speed over the frames (trapezoid)
const I = new Float64Array(fr.length);
for (let i = 1; i < fr.length; i++) I[i] = I[i - 1] + ((fr[i].duzgun_hiz_kmh + fr[i - 1].duzgun_hiz_kmh) / 2 / 3.6) * (fr[i].t_s - fr[i - 1].t_s);
const tF = Float64Array.from(fr, (f) => f.t_s);
const IAt = (t: number): number => interp(tF, I, t);
const scales: Array<{ from: string; to: string; scale: number }> = [];
for (let a = 0; a + 1 < anchors.length; a++) {
  const A = anchors[a];
  const B = anchors[a + 1];
  scales.push({ from: A.name, to: B.name, scale: (B.s - A.s) / (IAt(B.t) - IAt(A.t)) });
}
for (let i = K5; i <= K13; i++) {
  const t = fr[i].t_s;
  let a = 0;
  while (a + 2 < anchors.length && t > anchors[a + 1].t) a++;
  const A = anchors[a];
  fr[i].s_m = r1(A.s + (IAt(t) - IAt(A.t)) * scales[a].scale);
}

// ---------------------------------------------------------------------------
// 3. telemetri_1m
const sNew = Float64Array.from(fr, (f) => f.s_m);
const vNew = Float64Array.from(fr, (f) => f.duzgun_hiz_kmh);
const S0 = fr[K5].s_m;
const S1 = fr[K13].s_m;
const rows = out.telemetri_1m;
const tRows1 = Float64Array.from(rows1, (r) => r.t_s);
const gRows1 = Float64Array.from(rows1, (r) => r.boylamsal_g);
for (const r of rows) {
  if (r.s_m <= S0 || r.s_m >= S1) continue;
  r.t_s = r3(interp(sNew, tF, r.s_m));
  r.hiz_kmh = r1(interp(sNew, vNew, r.s_m));
}
for (let k = 0; k < rows.length; k++) {
  const r = rows[k];
  if (r.s_m <= S0 || r.s_m >= S1) continue;
  const gOld = interp(tRows1, gRows1, r.t_s);
  const a = rows[Math.max(0, k - G_HALF_M)];
  const b = rows[Math.min(rows.length - 1, k + G_HALF_M)];
  const gNew = (b.hiz_kmh - a.hiz_kmh) / 3.6 / Math.max(1e-6, b.t_s - a.t_s) / 9.81;
  const d = Math.max(G_WIN[0] - r.t_s, r.t_s - G_WIN[1]);
  const w = d <= 0 ? 1 : Math.max(0, 1 - d / G_BLEND_S);
  r.boylamsal_g = r3(w * gNew + (1 - w) * gOld);
}

// ---------------------------------------------------------------------------
// 4. viraj_ozeti
const sR = Float64Array.from(rows, (r) => r.s_m);
const tR = Float64Array.from(rows, (r) => r.t_s);
const vR = Float64Array.from(rows, (r) => r.hiz_kmh);
const tAt = (s: number): number => interp(sR, tR, s);
const vAt = (s: number): number => interp(sR, vR, s);
const sAtT = (t: number): number => interp(tF, sNew, t);
const moved: string[] = [];
const cs = out.viraj_ozeti;
for (const c of cs) {
  const old = { apex: c.apeks_m, brake: c.fren_basi_m };
  if (c.viraj === 'K8') c.apeks_m = 1375;
  else if (c.viraj === 'K12') c.apeks_m = 2085;
  else if (c.viraj === 'K11') c.apeks_m = Math.round(sAtT(tAtS1(old.apex)));
  if (c.fren_basi_m !== null && c.fren_basi_m > S0 && c.fren_basi_m < S1) c.fren_basi_m = Math.round(sAtT(tAtS1(c.fren_basi_m)));
  if (c.apeks_m !== old.apex) moved.push(`${c.viraj} apeks ${old.apex} → ${c.apeks_m}`);
  if (c.fren_basi_m !== old.brake) moved.push(`${c.viraj} fren başı ${old.brake} → ${c.fren_basi_m}`);
}
cs.forEach((c, k) => {
  const prevEnd = k === 0 ? null : cs[k - 1].bolge_m[1];
  c.hiz_kmh = { bolge_basi: r1(vAt(c.bolge_m[0])), apeks: r1(vAt(c.apeks_m)), cikis: r1(vAt(c.bolge_m[1])) };
  c.bolge_suresi_s = r3(tAt(c.bolge_m[1]) - (prevEnd === null ? 0 : tAt(prevEnd)));
});

// ---------------------------------------------------------------------------
// meta
const notlar = (out.meta.notlar as string[]).map((x) =>
  x.startsWith('Mesafe hız integralinden')
    ? 'Mesafe hız integralinden çıkarıldı; v2: K1, K5, K10, K13, K15 en düşük hız noktalarına ve K8 / K11 girişi / K12 iç kerb zamanlarına hizalandı (K11 en düşük hızı çapa değil).'
    : x,
);
out.meta = {
  ...out.meta,
  kisa_ad: 'BMW v2',
  versiyon: 2,
  notlar,
  duzeltme: {
    tarih: '2026-10-11',
    kaynak: NOTE,
    betik: 'dda_lab/scripts/make-bmw-v2.ts',
    ozet: [
      'K8 boşluğu (kareler 950-1005) videodan kare kare yeniden okundu: iç kerbde 112-114 km/h, en düşük 112 (34.9-35.3 s). Elle okunan 967 (118 → 114) ve 987 (119 → 115) düzeltildi; düzgün hız 941-1012 yeniden hesaplandı.',
      'K8 apeksi 1393 → 1375 m (iç kerb; v1 apeksi çıkıştaydı).',
      'K12 apeksi 2117 → 2085 m (iç kerbin ortası, 55.5 s; v1 apeksi 56.5 s, ~1 s geç, çıkış hızıydı).',
      'Mesafe çapaları: K11 en düşük hız (53.5 s) çıkarıldı; K8 35.1 s, K11 dönüş kerbi 51.3 s, K12 55.5 s eklendi. K5 öncesi ve K13 sonrası s_m v1 ile aynı.',
      'boylamsal_g yalnız 33.9-36.6 s aralığında yeni hızdan yeniden türetildi; başka yerde v1 değeri (aynı tur zamanında).',
    ],
    capalar: anchors.map((a) => ({ ad: a.name, t_s: r3(a.t), s_m: a.s, neden: a.why })),
    olcek: scales.map((x) => ({ aralik: `${x.from}→${x.to}`, s_m_bolu_integral: r3(x.scale) })),
    tasinan: moved,
  },
};
out.ham_veri.aciklama += ' v2: kareler 950-1005 yeniden okundu (alan `duzeltme`).';

const text = JSON.stringify(out);
for (const p of OUT) writeFileSync(p, text);

// report
const fmt = (c: Corner): string => `${c.viraj} apex ${c.apeks_m} m ${c.hiz_kmh.apeks} km/h zone t ${c.bolge_suresi_s}`;
console.log('anchors:', anchors.map((a) => `${a.name} ${a.t.toFixed(2)} s → ${a.s} m`).join(', '));
console.log('scales:', scales.map((x) => `${x.from}→${x.to} ${x.scale.toFixed(4)}`).join(', '));
console.log('moved:', moved.join('; '));
v1.viraj_ozeti.forEach((c, k) => {
  const d = cs[k];
  const ch = c.apeks_m !== d.apeks_m || c.hiz_kmh.apeks !== d.hiz_kmh.apeks || Math.abs(c.bolge_suresi_s - d.bolge_suresi_s) > 0.0005 || c.hiz_kmh.bolge_basi !== d.hiz_kmh.bolge_basi || c.hiz_kmh.cikis !== d.hiz_kmh.cikis;
  console.log(`${ch ? '*' : ' '} v1 ${fmt(c)} (entry ${c.hiz_kmh.bolge_basi} exit ${c.hiz_kmh.cikis}) | v2 ${fmt(d)} (entry ${d.hiz_kmh.bolge_basi} exit ${d.hiz_kmh.cikis})`);
});
let changedRows = 0;
for (let k = 0; k < rows.length; k++) if (JSON.stringify(rows[k]) !== JSON.stringify(rows1[k])) changedRows++;
const intLen = (rs: Row[]): number => {
  let s = 0;
  for (let k = 1; k < rs.length; k++) s += ((rs[k].hiz_kmh + rs[k - 1].hiz_kmh) / 2 / 3.6) * (rs[k].t_s - rs[k - 1].t_s);
  return s;
};
console.log(`telemetri rows changed ${changedRows}/${rows.length}; speed-integrated length v1 ${intLen(rows1).toFixed(1)} m, v2 ${intLen(rows).toFixed(1)} m`);
{ const e = [939, 940, 941, 942, 946, 947, 1005, 1006, 1007, 1011, 1012, 1013, 1014]; console.log('edges v1→v2:', e.map((k) => `${k}:${fr1[idxOf.get(k)!].duzgun_hiz_kmh}→${fr[idxOf.get(k)!].duzgun_hiz_kmh}`).join(' ')); }
console.log('K8 trace:', [1355, 1360, 1365, 1370, 1375, 1380, 1385, 1393].map((s) => `${s}:${vAt(s).toFixed(1)}@${tAt(s).toFixed(2)}`).join(' '));
console.log('K12 trace:', [2060, 2071, 2085, 2095, 2110, 2117].map((s) => `${s}:${vAt(s).toFixed(1)}@${tAt(s).toFixed(2)}`).join(' '));
console.log('wrote', OUT.join(', '));
