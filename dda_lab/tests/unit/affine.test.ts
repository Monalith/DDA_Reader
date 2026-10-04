import { describe, expect, it } from 'vitest';
import { applyAffine, fitAffine, invertAffine, type Affine } from '../../src/core/affine';

// rotation 30deg + scale 2 + translation (5, -3)
const deg = (Math.PI / 180) * 30;
const s = 2;
const KNOWN: Affine = [
  s * Math.cos(deg),
  -s * Math.sin(deg),
  5,
  s * Math.sin(deg),
  s * Math.cos(deg),
  -3,
];

describe('fitAffine', () => {
  it('recovers rotation + scale + translation within 1e-6', () => {
    const src: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
    ];
    const dst = src.map((p) => applyAffine(KNOWN, p));
    const A = fitAffine(src, dst);
    for (let i = 0; i < 6; i++) expect(A[i]).toBeCloseTo(KNOWN[i], 6);
  });

  it('maps a 4th point correctly', () => {
    const src: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [2, 3],
    ];
    const dst = src.map((p) => applyAffine(KNOWN, p));
    const A = fitAffine(src.slice(0, 3), dst.slice(0, 3));
    const got = applyAffine(A, src[3]);
    expect(got[0]).toBeCloseTo(dst[3][0], 6);
    expect(got[1]).toBeCloseTo(dst[3][1], 6);
  });

  it('least-squares fits over-determined noisy input', () => {
    const src: [number, number][] = [
      [0, 0],
      [10, 0],
      [0, 10],
      [10, 10],
      [5, 5],
    ];
    const dst = src.map((p) => applyAffine(KNOWN, p));
    const A = fitAffine(src, dst);
    for (let i = 0; i < 6; i++) expect(A[i]).toBeCloseTo(KNOWN[i], 6);
  });

  it('throws with fewer than three pairs or mismatched lengths', () => {
    expect(() => fitAffine([[0, 0]], [[0, 0]])).toThrow();
    expect(() =>
      fitAffine(
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        [
          [0, 0],
          [1, 0],
        ],
      ),
    ).toThrow();
  });

  it('throws on degenerate (collinear) source points', () => {
    const src: [number, number][] = [
      [0, 0],
      [1, 1],
      [2, 2],
    ];
    const dst = src.map((p) => applyAffine(KNOWN, p));
    expect(() => fitAffine(src, dst)).toThrow();
  });
});

describe('invertAffine', () => {
  it('round-trips a point', () => {
    const inv = invertAffine(KNOWN);
    const p: [number, number] = [7.5, -2.25];
    const back = applyAffine(inv, applyAffine(KNOWN, p));
    expect(back[0]).toBeCloseTo(p[0], 9);
    expect(back[1]).toBeCloseTo(p[1], 9);
  });

  it('throws on a singular transform', () => {
    expect(() => invertAffine([1, 2, 0, 2, 4, 0])).toThrow();
  });
});
