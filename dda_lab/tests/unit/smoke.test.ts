import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE, RAW_CHANNEL_NAMES } from '../../src/core/types';

describe('types', () => {
  it('default workspace has six panels', () => {
    expect(DEFAULT_WORKSPACE.panels.length).toBe(6);
  });
  it('raw channel set matches the DDA+ GPS table', () => {
    expect(RAW_CHANNEL_NAMES.length).toBe(14);
  });
});
