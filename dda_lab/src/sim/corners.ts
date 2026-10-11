// STUB (W6) — replaced by W1/W2/W3/W5 at merge
//
// Contract-only placeholder for W3's corner segmentation (plan "Shared
// interface contract"). Finds nothing, so index.ts falls through to the QSS
// envelope unchanged until the real file lands.
import type { Corner, Line, SimParams } from './types';

export interface CornerOpts {
  kFrac?: number;
  promMinMs?: number;
  promFrac?: number;
}

export function findCorners(
  _line: Line,
  _v: Float32Array,
  _params: SimParams,
  _opts?: CornerOpts,
): Corner[] {
  return [];
}
