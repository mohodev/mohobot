import type { MohoMessage } from '../core/types.js';

export type SocialAction = 'ignore' | 'reply';
export interface SocialDecision { action: SocialAction; urgency: 'low' | 'normal' | 'high'; reason: string; }

/** Cheap deterministic gate. It runs before sessions/AI and costs zero RPM. */
export function decideSocially(message: MohoMessage, input: { recentReplies: number; energy: number; stress: number; deviceDelay?: boolean } = { recentReplies: 0, energy: .65, stress: .2 }): SocialDecision {
  const text = message.content.trim();
  const urgent = /[?？]|怎么办|救命|急/.test(text);
  if ((message.channel.dm || message.mentionsBot) && (!input.deviceDelay || urgent)) return { action: 'reply', urgency: urgent ? 'high' : 'normal', reason: 'direct' };
  if (input.deviceDelay) return { action: 'ignore', urgency: 'low', reason: 'device unavailable' };
  if (input.stress >= .9 || input.energy <= .08) return { action: 'ignore', urgency: 'low', reason: 'character unavailable' };
  if (input.recentReplies >= 2 && text.length < 16 && !/[?？]/.test(text)) return { action: 'ignore', urgency: 'low', reason: 'recently spoke' };
  if (/^(哈哈|笑死|确实|好耶|草|lol|👍|😂)+$/iu.test(text)) return { action: 'ignore', urgency: 'low', reason: 'low-information social echo' };
  return { action: 'reply', urgency: /[?？]/.test(text) ? 'normal' : 'low', reason: 'topic may benefit from response' };
}
