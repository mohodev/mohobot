import type { MohoMessage } from '../core/types.js';
import type { SocialDecision } from './social-decision.js';

export interface TalkGovernorConfig {
  enabled: boolean;
  hourlyBudget: number;
  cooldownMs: number;
  consecutiveLimit: number;
  maxBackoffMs: number;
  backoffFactor: number;
  governRoomQuestions: boolean;
  governPeerBanter: boolean;
}

export interface TalkGovernorDecision {
  allowed: boolean;
  reason: 'disabled' | 'direct' | 'outside-scope' | 'hourly-budget' | 'cooldown' | 'allowed';
  channelId: string;
}

interface ChannelState { delivered: number[]; lastAt: number; consecutive: number; backoffUntil: number; }

/** In-memory voluntary-speech governor. It deliberately never governs direct summons. */
export class TalkGovernor {
  readonly #config: TalkGovernorConfig;
  readonly #states = new Map<string, ChannelState>();
  readonly #now: () => number;

  constructor(config: TalkGovernorConfig, now: () => number = Date.now) {
    this.#config = config;
    this.#now = now;
  }

  decide(message: MohoMessage, social: SocialDecision): TalkGovernorDecision {
    const channelId = message.channel.id;
    if (!this.#config.enabled) return { allowed: true, reason: 'disabled', channelId };
    if (message.channel.dm || message.mentionsBot || social.reason === 'direct') return { allowed: true, reason: 'direct', channelId };
    const governed = social.reason === 'natural group participation' ||
      (social.reason === 'group question' && this.#config.governRoomQuestions) ||
      (social.reason === 'peer rp character interjected' && this.#config.governPeerBanter);
    if (!governed) return { allowed: true, reason: 'outside-scope', channelId };
    const now = this.#now();
    const state = this.#state(channelId);
    state.delivered = state.delivered.filter((at) => now - at < 3_600_000);
    if (this.#config.hourlyBudget <= state.delivered.length) return { allowed: false, reason: 'hourly-budget', channelId };
    if (now < state.backoffUntil || (state.lastAt > 0 && now - state.lastAt < this.#config.cooldownMs)) {
      return { allowed: false, reason: 'cooldown', channelId };
    }
    return { allowed: true, reason: 'allowed', channelId };
  }

  /** Commit only after the outbound reply is confirmed delivered. */
  commit(channelId: string): void {
    const now = this.#now();
    const state = this.#state(channelId);
    state.delivered = state.delivered.filter((at) => now - at < 3_600_000);
    state.delivered.push(now);
    state.consecutive = state.lastAt > 0 && now - state.lastAt < this.#config.cooldownMs * 2 ? state.consecutive + 1 : 1;
    state.lastAt = now;
    if (state.consecutive > this.#config.consecutiveLimit) {
      const exponent = state.consecutive - this.#config.consecutiveLimit;
      state.backoffUntil = now + Math.min(this.#config.maxBackoffMs, this.#config.cooldownMs * this.#config.backoffFactor ** exponent);
    }
  }

  reset(channelId?: string): void { if (channelId) this.#states.delete(channelId); else this.#states.clear(); }

  #state(channelId: string): ChannelState {
    let state = this.#states.get(channelId);
    if (!state) { state = { delivered: [], lastAt: 0, consecutive: 0, backoffUntil: 0 }; this.#states.set(channelId, state); }
    return state;
  }
}
