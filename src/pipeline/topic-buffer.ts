import type { MohoMessage } from '../core/types.js';

export interface TopicBufferOptions { quietMs: number; maxMessages: number; maxChars: number; }
export const DEFAULT_TOPIC_BUFFER: TopicBufferOptions = { quietMs: 900, maxMessages: 6, maxChars: 2000 };

/** Coalesces consecutive low-urgency messages without calling a model. */
export class TopicBuffer {
  readonly #options: TopicBufferOptions;
  readonly #pending = new Map<string, { messages: MohoMessage[]; timer: NodeJS.Timeout; resolves: Array<(message: MohoMessage) => void> }>();
  constructor(options: Partial<TopicBufferOptions> = {}) { this.#options = { ...DEFAULT_TOPIC_BUFFER, ...options }; }

  /** Immediate messages never wait. Other messages return the merged final turn. */
  push(key: string, message: MohoMessage): Promise<MohoMessage> {
    if (this.#immediate(message)) return Promise.resolve(message);
    const existing = this.#pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(message);
      const chars = existing.messages.reduce((sum, item) => sum + item.content.length, 0);
      if (existing.messages.length >= this.#options.maxMessages || chars >= this.#options.maxChars) return this.#flush(key);
      existing.timer = this.#timer(key);
      return new Promise((resolve) => { existing.resolves.push(resolve); });
    }
    return new Promise((resolve) => {
      const item = { messages: [message], timer: this.#timer(key), resolves: [resolve] };
      this.#pending.set(key, item);
    });
  }

  clear(): void {
    for (const item of this.#pending.values()) {
      clearTimeout(item.timer);
      // Resolve callers with their newest original message. Pipeline.stop()
      // then prevents new work, while no handle promise is left hanging.
      const last = item.messages.at(-1)!;
      for (const resolve of item.resolves) resolve(last);
    }
    this.#pending.clear();
  }
  #timer(key: string): NodeJS.Timeout { const timer = setTimeout(() => void this.#flush(key), this.#options.quietMs); timer.unref?.(); return timer; }
  #flush(key: string): Promise<MohoMessage> {
    const item = this.#pending.get(key);
    if (!item) return Promise.reject(new Error('topic buffer was already flushed'));
    this.#pending.delete(key);
    clearTimeout(item.timer);
    const last = item.messages.at(-1)!;
    const merged = item.messages.length === 1 ? last : { ...last, content: item.messages.map((entry) => entry.content.trim()).filter(Boolean).join('\n') };
    for (const resolve of item.resolves) resolve(merged);
    return Promise.resolve(merged);
  }
  #immediate(message: MohoMessage): boolean { return message.channel.dm || message.mentionsBot || message.attachments.length > 0 || message.content.trim().startsWith('?'); }
}
