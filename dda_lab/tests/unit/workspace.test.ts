import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE, type Workspace } from '../../src/core/types';
import { parseWorkspace, serializeWorkspace, WorkspaceSchema } from '../../src/core/workspace';

describe('workspace', () => {
  it('round-trips the default workspace', () => {
    const json = serializeWorkspace(DEFAULT_WORKSPACE);
    const back = parseWorkspace(json);
    expect(back).toEqual(DEFAULT_WORKSPACE);
    expect(back).not.toBe(DEFAULT_WORKSPACE);
  });

  it('round-trips a customised workspace', () => {
    const w: Workspace = {
      ...DEFAULT_WORKSPACE,
      xAxis: 'time',
      unitMph: true,
      splitPct: 50,
      panels: [{ id: 'x', channels: [{ name: 'speed', axis: 'R' }] }],
      mathChannels: [{ name: 'gearRatio', unit: '', expr: 'rpm / speed', color: '#ff0' }],
      mapLayers: { satellite: false },
    };
    expect(parseWorkspace(serializeWorkspace(w))).toEqual(w);
  });

  it('fills missing fields from DEFAULT_WORKSPACE', () => {
    const w = parseWorkspace('{"version":1,"unitMph":true}');
    expect(w.unitMph).toBe(true);
    expect(w.xAxis).toBe(DEFAULT_WORKSPACE.xAxis);
    expect(w.splitPct).toBe(DEFAULT_WORKSPACE.splitPct);
    expect(w.panels).toEqual(DEFAULT_WORKSPACE.panels);
    expect(w.mathChannels).toEqual([]);
    expect(w.mapLayers).toEqual(DEFAULT_WORKSPACE.mapLayers);
  });

  it('fills an omitted version', () => {
    expect(parseWorkspace('{}')).toEqual(DEFAULT_WORKSPACE);
  });

  it('throws on a wrong version', () => {
    expect(() => parseWorkspace('{"version":2}')).toThrow(/version/i);
  });

  it('throws on invalid json and invalid field types', () => {
    expect(() => parseWorkspace('not json')).toThrow();
    expect(() => parseWorkspace('{"version":1,"xAxis":"banana"}')).toThrow();
    expect(() => parseWorkspace('{"version":1,"splitPct":"wide"}')).toThrow();
  });

  it('exposes a zod schema that validates a workspace', () => {
    expect(WorkspaceSchema.parse(DEFAULT_WORKSPACE)).toEqual(DEFAULT_WORKSPACE);
  });

  it('serializes to pretty, re-parsable JSON', () => {
    const json = serializeWorkspace(DEFAULT_WORKSPACE);
    expect(json).toContain('\n');
    expect(JSON.parse(json).version).toBe(1);
  });
});
