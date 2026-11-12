import { describe, expect, it } from 'vitest';
import { ALERT_KINDS } from '../../src/alerts/kinds.js';

describe('ALERT_KINDS', () => {
  it('has a label for all 13 kinds', () => {
    expect(Object.keys(ALERT_KINDS)).toHaveLength(13);
    expect(ALERT_KINDS['new-origin'].label).toBe('Nuova origine');
    expect(ALERT_KINDS['hash-changed'].label).toBe('Script modificato');
  });
  it('describes payload items from their fields', () => {
    const i = { kind: 'nel-rate' as const, origin: '', directive: '', page: '', sourceFile: '', sample: '', firstSeen: 0, originId: 0, payload: { host: 'h', n: 3 } };
    expect(ALERT_KINDS['nel-rate'].describe(i)).toBe('host: h, n: 3');
  });
});
