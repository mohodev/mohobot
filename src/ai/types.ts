/**
 * AI provider contract. Any OpenAI-compatible endpoint plugs in here.
 *
 * Hard rule: no provider error may ever escape as an unhandled rejection or
 * terminate the process. Callers get either an AIResponse or a thrown AIError.
 */

import type { ChatMessage } from '../core/types.js';

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** External cancellation (shutdown, user cancel). */
  signal?: AbortSignal;
  /** When set, the provider streams and invokes this per delta chunk. */
  onDelta?: (delta: string) => void;
  stream?: boolean;
}

export interface AIUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AIResponse {
  content: string;
  model: string;
  usage?: AIUsage;
  finishReason?: string;
  /** Wall-clock duration of the successful attempt. */
  ms: number;
}

export type AIErrorKind =
  | 'timeout'
  | 'rate_limit'
  | 'auth'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'aborted'
  | 'unknown';

export class AIError extends Error {
  readonly kind: AIErrorKind;
  readonly status?: number;
  readonly attempts: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    init: { kind: AIErrorKind; status?: number; attempts?: number; retryable?: boolean; cause?: unknown },
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'AIError';
    this.kind = init.kind;
    this.status = init.status;
    this.attempts = init.attempts ?? 1;
    this.retryable = init.retryable ?? false;
  }
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<AIResponse>;
  /** Cheap liveness probe; must not throw. */
  health(): Promise<{ ok: boolean; detail?: string }>;
}
