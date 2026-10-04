import { describe, expect, it } from 'vitest';
import {
  FOCUS_PAD_M,
  backgroundColorByZoom,
  fmtMetres,
  focusRangeLabel,
  inRangeSegments,
  rasterOpacityByZoom,
  stepTurnIndex,
  turnFocusRange,
  turnOptionLabel,
  zoomRadius,
  zoomWidth,
} from '../../src/ui/focus';

const turn = (n: number, name: string, sRange: [number, number]) => ({ n, name, sRange });

describe('turnFocusRange', () => {
  it('pads the turn by 60 m on both sides', () => {
    expect(turnFocusRange(turn(3, 'Hairpin', [1300, 1460]))).toEqual([1240, 1520]);
    expect(FOCUS_PAD_M).toBe(60);
  });

  it('clamps the low end to zero', () => {
    expect(turnFocusRange(turn(1, 'T1', [20, 180]))).toEqual([0, 240]);
  });

  it('honours a custom pad', () => {
    expect(turnFocusRange(turn(2, 'T2', [500, 600]), 10)).toEqual([490, 610]);
  });

  it('degrades to a window at the entry for a turn wrapping the start line', () => {
    expect(turnFocusRange(turn(9, 'Last', [2400, 40]))).toEqual([2340, 2460]);
  });
});

describe('turnOptionLabel', () => {
  it('includes a distinct name', () => {
    expect(turnOptionLabel(turn(3, 'Hairpin', [0, 1]))).toBe('T3 Hairpin');
  });
  it('collapses a redundant or empty name', () => {
    expect(turnOptionLabel(turn(3, 'T3', [0, 1]))).toBe('T3');
    expect(turnOptionLabel(turn(4, '  ', [0, 1]))).toBe('T4');
  });
});

describe('stepTurnIndex', () => {
  it('enters from whole lap at either end', () => {
    expect(stepTurnIndex(null, 5, 1)).toBe(0);
    expect(stepTurnIndex(null, 5, -1)).toBe(4);
  });
  it('steps and clamps', () => {
    expect(stepTurnIndex(2, 5, 1)).toBe(3);
    expect(stepTurnIndex(4, 5, 1)).toBe(4);
    expect(stepTurnIndex(0, 5, -1)).toBe(0);
  });
  it('is null without turns', () => {
    expect(stepTurnIndex(null, 0, 1)).toBeNull();
    expect(stepTurnIndex(1, 0, -1)).toBeNull();
  });
});

describe('focusRangeLabel', () => {
  it('formats metres with thousands separators', () => {
    expect(focusRangeLabel([1240, 1520], 'distance')).toBe('Focus: 1,240–1,520 m');
    expect(fmtMetres(1234567)).toBe('1,234,567');
    expect(fmtMetres(840.4)).toBe('840');
  });
  it('formats seconds on the time axis', () => {
    expect(focusRangeLabel([12.4, 15.2], 'time')).toBe('Focus: 12.40–15.20 s');
  });
  it('says whole lap when nothing is focused', () => {
    expect(focusRangeLabel(null, 'distance')).toBe('Focus: whole lap');
  });
});

describe('inRangeSegments', () => {
  it('returns the contiguous in-range runs', () => {
    const xs = [0, 100, 200, 300, 400, 500];
    expect(inRangeSegments(xs, [150, 350])).toEqual([[2, 3]]);
  });
  it('splits on non-finite values', () => {
    const xs = [100, 110, NaN, 130, 140];
    expect(inRangeSegments(xs, [0, 1000])).toEqual([
      [0, 1],
      [3, 4],
    ]);
  });
  it('closes a run that reaches the end', () => {
    expect(inRangeSegments([0, 10, 20], [5, 100])).toEqual([[1, 2]]);
  });
  it('is empty when nothing is inside', () => {
    expect(inRangeSegments([0, 10], [50, 60])).toEqual([]);
  });
});

describe('style expressions', () => {
  it('fades the imagery past the deepest real tile level', () => {
    expect(rasterOpacityByZoom()).toEqual(['interpolate', ['linear'], ['zoom'], 18.5, 1, 19.5, 0.6, 21, 0.25, 22, 0.25]);
  });
  it('interpolates line widths between z15 and z21', () => {
    expect(zoomWidth(3, 6)).toEqual(['interpolate', ['linear'], ['zoom'], 15, 3, 21, 6]);
    expect(zoomRadius(5, 9)).toEqual(['interpolate', ['linear'], ['zoom'], 15, 5, 21, 9]);
  });
  it('lightens the plain background at high zoom', () => {
    const expr = backgroundColorByZoom() as unknown[];
    expect(expr[0]).toBe('interpolate');
    expect(expr.at(-1)).toBe('#2b3340');
  });
});
