/**
 * Deterministic offline provider.
 *
 * Purpose: `npm start` must work with zero credentials so the runtime, the
 * gateway wiring and the plugin pipeline can be exercised without a real key.
 */

import type { ChatMessage } from '../core/types.js';
import { AIError, type AIProvider, type AIResponse, type ChatOptions } from './types.js';

export interface MockProviderOptions {
  /** Artificial think-time, applied once per call. */
  latencyMs?: number;
  /** 0..1 - probability of throwing a retryable 'server' AIError. */
  failRate?: number;
  /** Canned replies, cycled in order. Overrides the echo behaviour. */
  replies?: string[];
  /** Reported model name. */
  model?: string;
}

const ECHO_LIMIT = 200;
const CHUNK_SIZE = 12;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cheap deterministic token estimate - good enough for logs and tests. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class MockProvider implements AIProvider {
  readonly name = 'mock';
  readonly model: string;

  readonly #latencyMs: number;
  readonly #failRate: number;
  readonly #replies: string[];
  #calls = 0;

  constructor(options: MockProviderOptions = {}) {
    this.model = options.model ?? 'mock';
    this.#latencyMs = Math.max(0, options.latencyMs ?? 0);
    this.#failRate = Math.min(1, Math.max(0, options.failRate ?? 0));
    this.#replies = options.replies ?? [];
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<AIResponse> {
    const started = Date.now();

    if (options.signal?.aborted) {
      throw new AIError('request aborted by caller', { kind: 'aborted', retryable: false });
    }
    if (this.#latencyMs > 0) await sleep(this.#latencyMs);
    if (this.#failRate > 0 && Math.random() < this.#failRate) {
      throw new AIError('mock provider synthetic failure', {
        kind: 'server',
        status: 500,
        attempts: 1,
        retryable: true,
      });
    }

    const index = this.#calls;
    this.#calls += 1;

    const content = this.#reply(messages, index);

    if (options.onDelta) {
      for (let i = 0; i < content.length; i += CHUNK_SIZE) {
        options.onDelta(content.slice(i, i + CHUNK_SIZE));
      }
    }

    const promptTokens = estimateTokens(messages.map((m) => m.content).join(' '));
    const completionTokens = estimateTokens(content);

    return {
      content,
      model: this.model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: 'stop',
      ms: Date.now() - started,
    };
  }

  #reply(messages: ChatMessage[], index: number): string {
    if (this.#replies.length > 0) {
      return this.#replies[index % this.#replies.length] ?? '';
    }
    let lastUser = '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === 'user') {
        lastUser = m.content;
        break;
      }
    }
    const trimmed = lastUser.length > ECHO_LIMIT ? `${lastUser.slice(0, ECHO_LIMIT)}...` : lastUser;
    return `[mock] you said: ${trimmed}`;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'mock provider - no network calls' };
  }
}
