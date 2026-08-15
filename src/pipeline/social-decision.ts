import type { MohoMessage } from '../core/types.js';

export type SocialAction = 'ignore' | 'reply';
export interface SocialDecision { action: SocialAction; urgency: 'low' | 'normal' | 'high'; reason: string; }

/** Cheap deterministic gate. It runs before sessions/AI and costs zero RPM. */
export function decideSocially(message: MohoMessage, input: { recentReplies: number; energy: number; stress: number; deviceDelay?: boolean; proactiveRoll?: number } = { recentReplies: 0, energy: .65, stress: .2 }): SocialDecision {
  const text = message.content.trim();
  const urgent = /[?？]|怎么办|救命|急/.test(text);
  // A direct @, reply-to-bot, or DM is an explicit invitation: simulated device
  // delay may affect timing, never silently discard it.
  if (message.channel.dm || message.mentionsBot) return { action: 'reply', urgency: urgent ? 'high' : 'normal', reason: 'direct' };
  if (input.deviceDelay) return { action: 'ignore', urgency: 'low', reason: 'device unavailable' };
  if (input.stress >= .9 || input.energy <= .08) return { action: 'ignore', urgency: 'low', reason: 'character unavailable' };
  if (input.recentReplies >= 2 && text.length < 16 && !/[?？]/.test(text)) return { action: 'ignore', urgency: 'low', reason: 'recently spoke' };
  if (/^(哈哈|笑死|确实|好耶|草|lol|👍|😂)+$/iu.test(text)) return { action: 'ignore', urgency: 'low', reason: 'low-information social echo' };
  if (/[?？]|怎么|为什么|能不能|帮我|谁知道/.test(text)) return { action: 'reply', urgency: 'normal', reason: 'group question' };
  // Normal group conversation is observed into the shared session. Speak only
  // occasionally, with lower odds when tired/stressed, so the bot feels present
  // without treating every line as a prompt.
  const chance = Math.max(.05, Math.min(.28, .16 + (input.energy - .5) * .18 - input.stress * .12));
  if ((input.proactiveRoll ?? Math.random()) > chance) return { action: 'ignore', urgency: 'low', reason: 'observing group conversation' };
  return { action: 'reply', urgency: 'low', reason: 'natural group participation' };
}
