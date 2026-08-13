import { describe, expect, it } from 'vitest';
import { mayConsultPeer } from './disclosure.js';

const base = { requesterCharacterId: 'a', targetCharacterId: 'b', subjectUserId: 'u', scope: 'shared' as const, requesterAffinity: 70, targetAffinity: 70, targetAllowsPeerConsultation: true, hasDirectMessageChannel: true };
describe('peer consultation privacy gate', () => {
  it('requires both strong relations, DM and explicit shared scope', () => {
    expect(mayConsultPeer(base)).toBe(true);
    expect(mayConsultPeer({ ...base, scope: 'private' })).toBe(false);
    expect(mayConsultPeer({ ...base, targetAffinity: 69 })).toBe(false);
    expect(mayConsultPeer({ ...base, hasDirectMessageChannel: false })).toBe(false);
  });
});
