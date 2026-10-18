export interface TalkGovernorChannelState {
  delivered: number[];
  lastAt: number;
  consecutive: number;
  backoffUntil: number;
  focusUntil: number;
  pending: Map<string, number>;
}

/** Replaceable state boundary; production persistence can implement this without changing policy. */
export interface TalkGovernorStateStore {
  get(channelId: string): TalkGovernorChannelState | undefined;
  set(channelId: string, state: TalkGovernorChannelState): void;
  delete(channelId?: string): void;
}

export class MemoryTalkGovernorStateStore implements TalkGovernorStateStore {
  readonly #states = new Map<string, TalkGovernorChannelState>();
  get(channelId: string): TalkGovernorChannelState | undefined { return this.#states.get(channelId); }
  set(channelId: string, state: TalkGovernorChannelState): void { this.#states.set(channelId, state); }
  delete(channelId?: string): void { if (channelId) this.#states.delete(channelId); else this.#states.clear(); }
}
