import type { MohoMessage } from '../core/types.js';
import type { SocialDecision } from './social-decision.js';
import type { TalkGovernorChannelState, TalkGovernorStateStore } from './talk-governor-state.js';
import { MemoryTalkGovernorStateStore } from './talk-governor-state.js';

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

/** Voluntary-speech governor. It deliberately never governs direct summons. */
export class TalkGovernor {
  readonly #config: TalkGovernorConfig;
  readonly #store: TalkGovernorStateStore;
  readonly #now: () => number;

  constructor(config: TalkGovernorConfig, opts?: { now?: () => number; store?: TalkGovernorStateStore }) {
    this.#config = config;
    this.#now = opts?.now ?? Date.now;
    this.#store = opts?.store ?? new MemoryTalkGovernorStateStore();
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
    this.#store.set(channelId, state);
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
    this.#store.set(channelId, state);
  }

  reset(channelId?: string): void { this.#store.delete(channelId); }

  #state(channelId: string): TalkGovernorChannelState {
    return this.#store.get(channelId) ?? { delivered: [], lastAt: 0, consecutive: 0, backoffUntil: 0, focusUntil: 0, pending: new Map() };
  }
}
