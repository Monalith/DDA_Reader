// Least-squares 2D affine fit, used to align an imported track schema (image
// pixels, normalized 0..1) with map coordinates (lng/lat or local metres).
//
//   x' = a x + b y + c
//   y' = d x + e y + f

export type Affine = [number, number, number, number, number, number];

/** Solve a 3x3 linear system with partial pivoting. Throws when singular. */
function solve3(m: number[][], rhs: number[]): [number, number, number] {
  const a = m.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    }
    if (Math.abs(a[piv][col]) < 1e-12) {
      throw new Error('fitAffine: degenerate point configuration (singular system)');
    }
    if (piv !== col) {
      const tmp = a[piv];
      a[piv] = a[col];
      a[col] = tmp;
    }
    const d = a[col][col];
    for (let c = col; c < 4; c++) a[col][c] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let c = col; c < 4; c++) a[r][c] -= factor * a[col][c];
    }
  }
  return [a[0][3], a[1][3], a[2][3]];
}

/**
 * Least-squares affine fit from >= 3 point pairs. Solves the 3x3 normal
 * equations once for (a, b, c) and once for (d, e, f).
 */
export function fitAffine(src: [number, number][], dst: [number, number][]): Affine {
  if (src.length !== dst.length) {
    throw new Error('fitAffine: src and dst must have the same length');
  }
  if (src.length < 3) throw new Error('fitAffine: at least 3 point pairs are required');

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sx = 0;
  let sy = 0;
  let sxu = 0;
  let syu = 0;
  let su = 0;
  let sxv = 0;
  let syv = 0;
  let sv = 0;
  const n = src.length;

  for (let i = 0; i < n; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    if (![x, y, u, v].every(Number.isFinite)) {
      throw new Error(`fitAffine: non-finite point pair at index ${i}`);
    }
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    sxu += x * u;
    syu += y * u;
    su += u;
    sxv += x * v;
    syv += y * v;
    sv += v;
  }

  const normal = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const [a, b, c] = solve3(normal, [sxu, syu, su]);
  const [d, e, f] = solve3(normal, [sxv, syv, sv]);
  return [a, b, c, d, e, f];
}

export function applyAffine(A: Affine, p: [number, number]): [number, number] {
  const [a, b, c, d, e, f] = A;
  return [a * p[0] + b * p[1] + c, d * p[0] + e * p[1] + f];
}

/** Inverse transform. Throws when the linear part is singular. */
export function invertAffine(A: Affine): Affine {
  const [a, b, c, d, e, f] = A;
  const det = a * e - b * d;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) {
    throw new Error('invertAffine: singular transform');
  }
  return [
    e / det,
    -b / det,
    (b * f - e * c) / det,
    -d / det,
    a / det,
    (c * d - a * f) / det,
  ];
}
