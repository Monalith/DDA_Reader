// Bounded quadratic programme behind the racing line (src/sim/line.ts):
//
//   minimise  ½ dᵀ Q d + cᵀ d   subject to   lo ≤ d ≤ hi
//
// where Q is a symmetric PERIODIC PENTADIAGONAL matrix (the normal matrix of
// a periodic second-difference curvature operator) on a closed lap of n
// stations. Solved to optimality by a projected Newton method (Bertsekas
// 1982): hold the stations a bound is stopping, take a Newton step on the
// rest with one banded direct solve, project, backtrack. Each iteration is
// O(n).
//
// This replaced a projected Gauss-Seidel / cascadic-multigrid smoother whose
// fine-grid sweeps never converged the fourth-order problem — the line sat
// metres short of the corridor edge through corners it should have used all
// of (docs/superpowers/notes/2026-10-11-bmw-fit-pist-line.md §6).

/** Q stored by diagonal: q[o][i] = Q[i][(i + o) mod n], o = 0, 1, 2 (symmetric). */
export interface PentaPeriodic {
  n: number;
  d0: Float64Array;
  d1: Float64Array;
  d2: Float64Array;
}

/** Q[i][j] for |i - j| (mod n) ≤ 2, else 0. */
function qAt(Q: PentaPeriodic, i: number, j: number): number {
  const n = Q.n;
  const o = (j - i + n) % n;
  if (o === 0) return Q.d0[i];
  if (o === 1) return Q.d1[i];
  if (o === 2) return Q.d2[i];
  if (o === n - 1) return Q.d1[j];
  if (o === n - 2) return Q.d2[j];
  return 0;
}

/** y = Q x. */
export function pentaMul(Q: PentaPeriodic, x: Float64Array, y: Float64Array): void {
  const { n, d0, d1, d2 } = Q;
  for (let i = 0; i < n; i++) {
    const im1 = (i - 1 + n) % n;
    const im2 = (i - 2 + n) % n;
    y[i] =
      d0[i] * x[i] +
      d1[i] * x[(i + 1) % n] +
      d2[i] * x[(i + 2) % n] +
      d1[im1] * x[im1] +
      d2[im2] * x[im2];
  }
}

/**
 * Factor the NON-periodic band part B (bandwidth 2) by LDLᵀ, in place on
 * copies. Returns null if a pivot is not positive.
 */
function factorBand(Q: PentaPeriodic): { L1: Float64Array; L2: Float64Array; D: Float64Array } | null {
  const { n, d0, d1, d2 } = Q;
  const D = new Float64Array(n);
  const L1 = new Float64Array(n); // L[i+1][i]
  const L2 = new Float64Array(n); // L[i+2][i]
  for (let i = 0; i < n; i++) {
    // B[i][i] - L[i][i-1]² D[i-1] - L[i][i-2]² D[i-2]
    let di = d0[i];
    if (i >= 1) di -= L1[i - 1] * L1[i - 1] * D[i - 1];
    if (i >= 2) di -= L2[i - 2] * L2[i - 2] * D[i - 2];
    if (!(di > 0)) return null;
    D[i] = di;
    if (i + 1 < n) {
      // B[i+1][i] - L[i+1][i-1] L[i][i-1] D[i-1]
      let v = d1[i];
      if (i >= 1) v -= L2[i - 1] * L1[i - 1] * D[i - 1];
      L1[i] = v / di;
    }
    if (i + 2 < n) L2[i] = d2[i] / di;
  }
  return { L1, L2, D };
}

function solveBand(f: { L1: Float64Array; L2: Float64Array; D: Float64Array }, r: Float64Array, out: Float64Array): void {
  const { L1, L2, D } = f;
  const n = D.length;
  for (let i = 0; i < n; i++) {
    let v = r[i];
    if (i >= 1) v -= L1[i - 1] * out[i - 1];
    if (i >= 2) v -= L2[i - 2] * out[i - 2];
    out[i] = v;
  }
  for (let i = 0; i < n; i++) out[i] /= D[i];
  for (let i = n - 1; i >= 0; i--) {
    let v = out[i];
    if (i + 1 < n) v -= L1[i] * out[i + 1];
    if (i + 2 < n) v -= L2[i] * out[i + 2];
    out[i] = v;
  }
}

/** Solve a 4×4 (row-major) system in place by Gaussian elimination with partial pivoting. */
function solve4(M: number[], b: number[]): number[] {
  const a = M.slice();
  const x = b.slice();
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r * 4 + c]) > Math.abs(a[p * 4 + c])) p = r;
    if (p !== c) {
      for (let k = 0; k < 4; k++) [a[c * 4 + k], a[p * 4 + k]] = [a[p * 4 + k], a[c * 4 + k]];
      [x[c], x[p]] = [x[p], x[c]];
    }
    const piv = a[c * 4 + c] || 1e-300;
    for (let r = c + 1; r < 4; r++) {
      const m = a[r * 4 + c] / piv;
      if (m === 0) continue;
      for (let k = c; k < 4; k++) a[r * 4 + k] -= m * a[c * 4 + k];
      x[r] -= m * x[c];
    }
  }
  for (let c = 3; c >= 0; c--) {
    let v = x[c];
    for (let k = c + 1; k < 4; k++) v -= a[c * 4 + k] * x[k];
    x[c] = v / (a[c * 4 + c] || 1e-300);
  }
  return x;
}

/**
 * A reusable solver for Q x = r with Q periodic pentadiagonal SPD: banded
 * LDLᵀ of the non-periodic part plus a rank-4 Sherman-Morrison-Woodbury
 * correction for the four wrap-around entries. Returns null when the band
 * part is not positive definite (the caller then falls back).
 */
export function periodicPentaSolver(Q: PentaPeriodic): ((r: Float64Array, out: Float64Array) => void) | null {
  const n = Q.n;
  if (n < 6) return null;
  const f = factorBand(Q);
  if (!f) return null;
  const idx = [0, 1, n - 2, n - 1];
  // C = Q - B = U Vᵀ, U = [e_idx], Vᵀ[a][j] = C[idx[a]][j] (only wrap entries)
  const wrap = (i: number, j: number): number => (Math.abs(i - j) > 2 ? qAt(Q, i, j) : 0);
  // Z = B⁻¹ U
  const Z: Float64Array[] = idx.map((k) => {
    const e = new Float64Array(n);
    e[k] = 1;
    const z = new Float64Array(n);
    solveBand(f, e, z);
    return z;
  });
  // Vᵀ Z: (Vᵀ Z)[a][b] = Σ_j C[idx[a]][j] Z[b][j]; C row idx[a] is non-zero only at idx columns
  const S = new Array<number>(16).fill(0);
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      let s = a === b ? 1 : 0;
      for (const j of idx) s += wrap(idx[a], j) * Z[b][j];
      S[a * 4 + b] = s;
    }
  }
  const y = new Float64Array(n);
  return (r, out) => {
    solveBand(f, r, y);
    const vy = [0, 0, 0, 0];
    for (let a = 0; a < 4; a++) {
      let s = 0;
      for (const j of idx) s += wrap(idx[a], j) * y[j];
      vy[a] = s;
    }
    const t = solve4(S, vy);
    for (let i = 0; i < n; i++) out[i] = y[i] - (Z[0][i] * t[0] + Z[1][i] * t[1] + Z[2][i] * t[2] + Z[3][i] * t[3]);
  };
}

export interface BoxQpResult {
  x: Float64Array;
  /** Newton iterations (one banded solve each). */
  iterations: number;
  /** True when the projected-gradient optimality measure fell below tolerance. */
  converged: boolean;
}

/** ½xᵀQx + cᵀx, using `tmp` as scratch. */
function objective(Q: PentaPeriodic, c: Float64Array, x: Float64Array, tmp: Float64Array): number {
  pentaMul(Q, x, tmp);
  let f = 0;
  for (let i = 0; i < x.length; i++) f += x[i] * (0.5 * tmp[i] + c[i]);
  return f;
}

/**
 * min ½xᵀQx + cᵀx  s.t.  lo ≤ x ≤ hi, with Q periodic pentadiagonal SPD.
 *
 * Bertsekas' projected Newton method (1982) with an ε-active set: stations on
 * a bound whose gradient pushes them further out are held there; a Newton step
 * is taken on the rest (one banded direct solve with the held rows/columns
 * replaced by identity, which keeps the periodic pentadiagonal structure);
 * the step is projected back into the box with Armijo backtracking. It is
 * monotone, so unlike a primal-dual active-set method it cannot cycle, and it
 * identifies the active set in finitely many steps — ~10-30 on a race track.
 *
 * Converged when the scaled projected gradient |x - P(x - g/diag Q)| is below
 * `tolM` (metres) everywhere.
 */
export function solveBoxQp(
  Q: PentaPeriodic,
  c: Float64Array,
  lo: Float64Array,
  hi: Float64Array,
  x0?: Float64Array,
  maxIter = 200,
  tolM = 1e-5,
): BoxQpResult {
  const n = Q.n;
  const x = new Float64Array(n);
  if (x0) for (let i = 0; i < n; i++) x[i] = Math.min(hi[i], Math.max(lo[i], x0[i]));
  const g = new Float64Array(n);
  const tmp = new Float64Array(n);
  const held = new Uint8Array(n);
  const M: PentaPeriodic = { n, d0: new Float64Array(n), d1: new Float64Array(n), d2: new Float64Array(n) };
  const rhs = new Float64Array(n);
  const p = new Float64Array(n);
  const xt = new Float64Array(n);
  let f = objective(Q, c, x, tmp);
  let converged = false;
  let it = 0;
  for (; it < maxIter; it++) {
    pentaMul(Q, x, g);
    let opt = 0;
    for (let i = 0; i < n; i++) {
      g[i] += c[i];
      const step = x[i] - Math.min(hi[i], Math.max(lo[i], x[i] - g[i] / Q.d0[i]));
      opt = Math.max(opt, Math.abs(step));
    }
    if (opt < tolM) {
      converged = true;
      break;
    }
    // ε-active set (Bertsekas): near a bound AND pushed outward
    const eps = Math.min(0.05, opt);
    for (let i = 0; i < n; i++) {
      held[i] = (x[i] <= lo[i] + eps && g[i] > 0) || (x[i] >= hi[i] - eps && g[i] < 0) ? 1 : 0;
    }
    for (let i = 0; i < n; i++) {
      const free = held[i] === 0;
      M.d0[i] = free ? Q.d0[i] : 1;
      M.d1[i] = free && held[(i + 1) % n] === 0 ? Q.d1[i] : 0;
      M.d2[i] = free && held[(i + 2) % n] === 0 ? Q.d2[i] : 0;
      // held stations take a scaled gradient step (projected away below)
      rhs[i] = free ? -g[i] : -g[i] / Q.d0[i];
    }
    const solve = periodicPentaSolver(M);
    if (solve) {
      solve(rhs, p);
    } else {
      for (let i = 0; i < n; i++) p[i] = -g[i] / Q.d0[i];
    }
    // projected Armijo backtracking
    let alpha = 1;
    let accepted = false;
    for (let ls = 0; ls < 30; ls++) {
      let dec = 0;
      for (let i = 0; i < n; i++) {
        xt[i] = Math.min(hi[i], Math.max(lo[i], x[i] + alpha * p[i]));
        dec += g[i] * (xt[i] - x[i]);
      }
      const ft = objective(Q, c, xt, tmp);
      if (ft <= f + 1e-4 * dec) {
        x.set(xt);
        f = ft;
        accepted = true;
        break;
      }
      alpha *= 0.5;
    }
    if (!accepted) break;
  }
  return { x, iterations: it, converged };
}

/**
 * QᵀQ-style normal matrix of a periodic TRIDIAGONAL operator A (row i has
 * A[i][i-1] = a[i], A[i][i] = b[i], A[i][i+1] = e[i]), times `w`, plus `reg`
 * on the diagonal: Q = w·AᵀA + reg·I, and the vector w·Aᵀr.
 */
export function normalPenta(
  a: Float64Array,
  b: Float64Array,
  e: Float64Array,
  w: number,
  reg: number,
): PentaPeriodic {
  const n = b.length;
  const Q: PentaPeriodic = { n, d0: new Float64Array(n), d1: new Float64Array(n), d2: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const im = (i - 1 + n) % n;
    const ip = (i + 1) % n;
    // row i contributes A[i][p] A[i][q] to Q[p][q], p,q ∈ {im, i, ip}
    Q.d0[im] += w * a[i] * a[i];
    Q.d0[i] += w * b[i] * b[i];
    Q.d0[ip] += w * e[i] * e[i];
    Q.d1[im] += w * a[i] * b[i]; // (im, i)
    Q.d1[i] += w * b[i] * e[i]; // (i, ip)
    Q.d2[im] += w * a[i] * e[i]; // (im, ip)
  }
  for (let i = 0; i < n; i++) Q.d0[i] += reg;
  return Q;
}

/** out = Aᵀ r for the periodic tridiagonal A of `normalPenta`. */
export function applyAt(a: Float64Array, b: Float64Array, e: Float64Array, r: Float64Array, out: Float64Array): void {
  const n = b.length;
  out.fill(0);
  for (let i = 0; i < n; i++) {
    out[(i - 1 + n) % n] += a[i] * r[i];
    out[i] += b[i] * r[i];
    out[(i + 1) % n] += e[i] * r[i];
  }
}
