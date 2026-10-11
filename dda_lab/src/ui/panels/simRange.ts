/**
 * The value a range input can actually hold: snapped to its step and clamped.
 *
 * Derived rider values (1.2411… g) and preset numbers (cgRearM 0.691 on a
 * 0.005 step) are not on the slider's grid. Bound raw, the browser snaps the
 * DOM value while React keeps tracking the raw one, and the two disagree on
 * every input event — the edit was read back as the old value and lost
 * (found in the W6 Playwright check: a Braking drag to 0.6 pinned 1.24).
 */
export function rangeValue(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  const snapped = min + Math.round((value - min) / step) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals));
}
