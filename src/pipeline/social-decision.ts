import type { MohoMessage } from '../core/types.js';

export type SocialAction = 'ignore' | 'reply';
export type SocialUrgency = 'low' | 'normal' | 'high';
export interface SocialDecision { action: SocialAction; urgency: SocialUrgency; reason: string; }

export interface SocialInput {
  recentReplies: number;
  energy: number;
  stress: number;
  deviceDelay?: boolean;
  /**
   * Explicit opt-in for joining conversations nobody addressed the bot in.
   * Off (the default) the bot is a good listener: it only speaks when spoken
   * to, when a peer RP character interjects, or when the room asks a question.
   */
  proactiveParticipation?: boolean;
  /** Odds for that opt-in path; deterministic when omitted. */
  proactiveRoll?: number;
  proactiveChance?: number;
}

/** A question aimed at the room, not at a specific person. */
const ROOM_QUESTION =
  /[?？]|怎么办|怎么|为什么|能不能|可不可以|有没有人|谁知道|求助|请问|有人吗|在吗/;
/** Pure social filler: laughing, agreement, emoji storms. */
const ECHO = /^(哈哈+|笑死|确实|好耶|草|lol|草|确实|可以|牛逼|卧槽|👍|😂|🤣|😅)+$/iu;
/** Already answered a lot recently: back off. */
const RECENTLY_SPOKE = 3;
/** Questions stay worth answering past the usual cooldown, but not forever. */
const QUESTION_COOLDOWN = 6;

/** Cheap deterministic gate. It runs before sessions/AI and costs zero RPM. */
export function decideSocially(message: MohoMessage, input: SocialInput = { recentReplies: 0, energy: .65, stress: .2 }): SocialDecision {
  const text = message.content.trim();
  const urgent = /[?？]|救命|救|急/.test(text);
  // A whitelisted fellow RP character cutting into the conversation is worth
  // engaging (quote-reply back), but never with "direct" privilege and never
  // endlessly: recentReplies >= 3 acts as the anti-loop cooldown.
  if (message.author.bot) {
    if (input.recentReplies >= RECENTLY_SPOKE) return { action: 'ignore', urgency: 'low', reason: 'peer bot cooldown' };
    return { action: 'reply', urgency: urgent ? 'normal' : 'low', reason: 'peer rp character interjected' };
  }
  // A direct @, reply-to-bot, or DM is an explicit invitation: simulated device
  // delay may affect timing, never silently discard it.
  if (message.channel.dm || message.mentionsBot) return { action: 'reply', urgency: urgent ? 'high' : 'normal', reason: 'direct' };
  if (input.deviceDelay) return { action: 'ignore', urgency: 'low', reason: 'device unavailable' };
  if (input.stress >= .9 || input.energy <= .08) return { action: 'ignore', urgency: 'low', reason: 'character unavailable' };
  // Back off from a room it just talked in, unless someone is asking something.
  if (input.recentReplies >= RECENTLY_SPOKE && !ROOM_QUESTION.test(text)) return { action: 'ignore', urgency: 'low', reason: 'recently spoke' };
  if (input.recentReplies >= QUESTION_COOLDOWN) return { action: 'ignore', urgency: 'low', reason: 'answered the room enough' };
  if (ECHO.test(text)) return { action: 'ignore', urgency: 'low', reason: 'low-information social echo' };
  // A question nobody was addressed at directly is a reasonable invitation:
  // answer the room instead of every line it contains.
  if (ROOM_QUESTION.test(text)) return { action: 'reply', urgency: 'normal', reason: 'group question' };

  // Observed chatter: only spoken to when the operator opted in, and then with
  // lower odds when tired or stressed, so the bot feels present without
  // treating every line as a prompt. Deterministic (no roll) by default.
  if (!input.proactiveParticipation) return { action: 'ignore', urgency: 'low', reason: 'observing group conversation' };
  const chance = Math.max(0, Math.min(1, input.proactiveChance ?? Math.max(.05, Math.min(.28, .16 + (input.energy - .5) * .18 - input.stress * .12))));
  if ((input.proactiveRoll ?? Math.random()) > chance) return { action: 'ignore', urgency: 'low', reason: 'observing group conversation' };
  return { action: 'reply', urgency: 'low', reason: 'natural group participation' };
}
