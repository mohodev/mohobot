import { describe, expect, it } from 'vitest';
import { createProvenance, hasSecretLikeContent, safeProvenanceSummary, withProvenance } from './provenance.js';

describe('provenance', () => {
  it('attaches untrusted source metadata without changing the value', () => {
    const provenance = createProvenance('memory', { capturedAt: 10, reference: 'record-1' });
    expect(withProvenance('remembered text', provenance)).toEqual({ value: 'remembered text', provenance });
    expect(provenance.trust).toBe('untrusted');
  });

  it('detects secret-like data and keeps it out of summaries', () => {
    const secret = 'Bearer abcdefghijklmnop';
    expect(hasSecretLikeContent(secret)).toBe(true);
    expect(safeProvenanceSummary(createProvenance('tool', { reference: secret }))).not.toContain(secret);
  });
});
