import { useState } from 'react';
import { rangeValue } from './simRange';

export interface RangeProps {
  value: number;
  min: number;
  max: number;
  step: number;
  testId: string;
  unit?: string;
  decimals?: number;
  /** Readout text instead of `value.toFixed(decimals) unit`. */
  format?: (v: number) => string;
  onChange: (v: number) => void;
}

/**
 * A range input that follows the user immediately. The store update behind it
 * is debounced, and React restores a controlled input to its prop after every
 * change event — so bound straight to the store, each arrow-key press started
 * again from the stale value and twenty presses moved it one step. The local
 * value carries the edit (thumb AND readout) until the store catches up, then
 * the prop wins again.
 */
export function RangeInput({ value, min, max, step, testId, unit, decimals = 2, format, onChange }: RangeProps) {
  const [local, setLocal] = useState<number | null>(null);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    // the store moved (debounce flushed, or a slider elsewhere re-derived it)
    setSeen(value);
    setLocal(null);
  }
  const shown = local ?? value;
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={rangeValue(shown, min, max, step)}
        data-testid={testId}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          onChange(v);
        }}
      />
      <span className="sim-slider-value num">
        {format ? format(shown) : `${shown.toFixed(decimals)}${unit ? ` ${unit}` : ''}`}
      </span>
    </>
  );
}

