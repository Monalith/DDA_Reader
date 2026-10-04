import { describe, expect, it } from 'vitest';
import { dragZoomFactor, panRange, zoomRange } from '../../src/ui/chartInteractions';

const ext: [number, number] = [0, 3000];

describe('chart x interactions', () => {
  it('zooms in around the anchor and keeps it fixed', () => {
    const r = zoomRange([0, 3000], ext, 2, 1000);
    expect(r[1] - r[0]).toBeCloseTo(1500);
    expect((1000 - r[0]) / (r[1] - r[0])).toBeCloseTo(1000 / 3000);
  });
  it('clamps zoom-out to the extent', () => {
    expect(zoomRange([1000, 2000], ext, 0.1, 1500)).toEqual([0, 3000]);
  });
  it('never zooms below the minimum span', () => {
    const r = zoomRange([1000, 1001], ext, 1000, 1000.5);
    expect(r[1] - r[0]).toBeCloseTo(6);
  });
  it('pans and clamps at both ends', () => {
    expect(panRange([1000, 2000], ext, 500)).toEqual([1500, 2500]);
    expect(panRange([1000, 2000], ext, 5000)).toEqual([2000, 3000]);
    expect(panRange([1000, 2000], ext, -5000)).toEqual([0, 1000]);
  });
  it('drag to the right zooms in, to the left zooms out', () => {
    expect(dragZoomFactor(120)).toBeGreaterThan(1);
    expect(dragZoomFactor(-120)).toBeLessThan(1);
    expect(dragZoomFactor(0)).toBe(1);
  });
});
