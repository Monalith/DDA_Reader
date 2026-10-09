// Workspace (de)serialization: zod schema mirroring `Workspace` from types.ts,
// with every field defaulting to DEFAULT_WORKSPACE so older/partial
// workspace.json files keep loading.

import { z } from 'zod';
import { DEFAULT_TURN_LABELS, DEFAULT_WORKSPACE, type Workspace } from './types';

const clone = <T>(v: T): T => structuredClone(v);

const PanelChannelSchema = z.object({
  name: z.string(),
  axis: z.enum(['L', 'R']).default('L'),
  width: z.number().min(0.25).max(10).optional(),
  fill: z.literal('zero').optional(),
});

const AxisRangeSchema = z.object({
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
});

const PanelSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  xAxis: z.enum(['time', 'distance']).optional(),
  channels: z.array(PanelChannelSchema).default([]),
  yL: AxisRangeSchema.optional(),
  yR: AxisRangeSchema.optional(),
  x: z.object({ linked: z.boolean().default(true), min: z.number().nullable().optional(), max: z.number().nullable().optional() }).optional(),
  lineWidth: z.number().min(0.25).max(10).optional(),
});

const MathChannelSchema = z.object({
  name: z.string(),
  unit: z.string().default(''),
  expr: z.string(),
  color: z.string().default('#ffffff'),
  perSession: z.record(z.string(), z.string()).optional(),
  perLap: z.record(z.string(), z.string()).optional(),
});

const WorkspaceObject = z.object({
  version: z.literal(1).default(1),
  xAxis: z.enum(['time', 'distance']).default(DEFAULT_WORKSPACE.xAxis),
  unitMph: z.boolean().default(DEFAULT_WORKSPACE.unitMph),
  splitPct: z.number().min(5).max(95).default(DEFAULT_WORKSPACE.splitPct),
  panels: z.array(PanelSchema).default(clone(DEFAULT_WORKSPACE.panels)),
  mathChannels: z.array(MathChannelSchema).default(clone(DEFAULT_WORKSPACE.mathChannels)),
  mapLayers: z.record(z.string(), z.boolean()).default(clone(DEFAULT_WORKSPACE.mapLayers)),
  turnLabels: z
    .object({
      show: z.boolean().default(DEFAULT_TURN_LABELS.show),
      onMap: z.boolean().default(true),
      speed: z.boolean().default(true),
      size: z.number().min(8).max(28).default(DEFAULT_TURN_LABELS.size),
      gain: z.string().default(DEFAULT_TURN_LABELS.gain),
      loss: z.string().default(DEFAULT_TURN_LABELS.loss),
      best: z.string().default(DEFAULT_TURN_LABELS.best),
      turnSize: z.number().min(8).max(32).optional(),
      turnColor: z.string().optional(),
      pointSize: z.number().min(8).max(28).optional(),
    })
    .default(clone(DEFAULT_TURN_LABELS)),
});

export const WorkspaceSchema = WorkspaceObject as unknown as z.ZodType<Workspace>;

export function serializeWorkspace(w: Workspace): string {
  return JSON.stringify(w, null, 2);
}

/** Parse workspace JSON, filling missing fields from DEFAULT_WORKSPACE. */
export function parseWorkspace(json: string): Workspace {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`parseWorkspace: invalid JSON (${(e as Error).message})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('parseWorkspace: expected a JSON object');
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== undefined && version !== 1) {
    throw new Error(`parseWorkspace: unsupported workspace version ${String(version)}`);
  }
  const parsed = WorkspaceObject.parse(raw);
  return clone(parsed) as Workspace;
}
