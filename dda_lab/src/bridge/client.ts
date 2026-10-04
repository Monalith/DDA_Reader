// Client for the local Python bridge (dda_lab_bridge.py) that runs `claude -p`
// on an imported track schema image. Everything stays on 127.0.0.1.
import { z } from 'zod';

export const BRIDGE_BASE = 'http://127.0.0.1:8777';

const HEALTH_TIMEOUT_MS = 2000;

const Pair = z.tuple([z.number(), z.number()]);

/** Mirror of the bridge's pydantic `SchemaResult` (normalized 0..1 coords). */
export const SchemaResultZ = z.object({
  track_outline: z.array(Pair).default([]),
  racing_line: z.array(Pair).default([]),
  apexes: z
    .array(
      z.object({
        turn: z.number().nullish(),
        x: z.number(),
        y: z.number(),
        label: z.string().nullish(),
      }),
    )
    .default([]),
  markers: z
    .array(
      z.object({
        type: z.enum(['brake', 'throttle', 'note']),
        x: z.number(),
        y: z.number(),
        text: z.string().nullish(),
      }),
    )
    .default([]),
  start_finish: z.object({ x: z.number(), y: z.number() }).nullish(),
  turn_labels: z.array(z.object({ n: z.number(), x: z.number(), y: z.number() })).default([]),
});

export type SchemaResult = z.infer<typeof SchemaResultZ>;

export interface BridgeHealth {
  ok: boolean;
  claude: boolean;
}

export type BridgeErrorCode = 'claude_unavailable' | 'invalid_model_output' | 'network';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export function bridgeErrorText(e: unknown): string {
  const code = e instanceof BridgeError ? e.code : 'network';
  if (code === 'claude_unavailable') return 'Claude CLI is not available on the bridge — use manual mode.';
  if (code === 'invalid_model_output') return 'Claude returned output that did not match the schema. Try again or use manual mode.';
  return 'Could not reach the local bridge at 127.0.0.1:8777 — start dda_lab_bridge.py or use manual mode.';
}

/**
 * Bridge liveness. Never throws: a missing/slow bridge reports
 * `{ ok: false, claude: false }` after at most 2 s.
 */
export async function health(): Promise<BridgeHealth> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BRIDGE_BASE}/health`, { signal: ac.signal });
    if (!res.ok) return { ok: false, claude: false };
    const body: unknown = await res.json();
    const parsed = z.object({ ok: z.boolean().default(false), claude: z.boolean().default(false) }).safeParse(body);
    if (!parsed.success) return { ok: false, claude: false };
    return { ok: parsed.data.ok, claude: parsed.data.claude };
  } catch {
    return { ok: false, claude: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST the schema image (png/jpg/pdf) to the bridge and validate the model
 * output. Throws {@link BridgeError} with code 'claude_unavailable' (503),
 * 'invalid_model_output' (422 or zod failure) or 'network'.
 */
export async function analyzeSchema(file: File): Promise<SchemaResult> {
  const form = new FormData();
  form.append('file', file, file.name);

  let res: Response;
  try {
    res = await fetch(`${BRIDGE_BASE}/analyze-schema`, { method: 'POST', body: form });
  } catch (e) {
    throw new BridgeError('network', (e as Error)?.message);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const err = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    if (err === 'claude_unavailable' || res.status === 503) throw new BridgeError('claude_unavailable');
    if (err === 'invalid_model_output' || res.status === 422) throw new BridgeError('invalid_model_output');
    throw new BridgeError('network', `bridge HTTP ${res.status}`);
  }

  const parsed = SchemaResultZ.safeParse(body);
  if (!parsed.success) throw new BridgeError('invalid_model_output', parsed.error.message);
  return parsed.data;
}
