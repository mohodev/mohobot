export type MemoryScope = 'private' | 'relationship' | 'shared';
export interface SocialDisclosure {
  requesterCharacterId: string;
  subjectUserId: string;
  targetCharacterId: string;
  scope: MemoryScope;
  requesterAffinity: number;
  targetAffinity: number;
  targetAllowsPeerConsultation: boolean;
  hasDirectMessageChannel: boolean;
}

/**
 * Gate for character-to-character consultation. It deliberately authorizes
 * only abstract, shared facts; private transcript, diary and relationship
 * notes never become eligible for automatic disclosure.
 */
export function mayConsultPeer(input: SocialDisclosure): boolean {
  if (input.requesterCharacterId === input.targetCharacterId) return false;
  if (input.scope !== 'shared') return false;
  if (!input.targetAllowsPeerConsultation || !input.hasDirectMessageChannel) return false;
  return input.requesterAffinity >= 70 && input.targetAffinity >= 70;
}
