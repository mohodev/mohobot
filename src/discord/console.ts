/**
 * Console gateway.
 *
 * Reads stdin line by line and turns every line into a MohoMessage so the
 * whole runtime can be smoke-tested end to end without a Discord token.
 */

import { createInterface, type Interface } from 'node:readline';

import type { EventBus } from '../core/event.js';
import type { Logger } from '../core/logger.js';
import type { BotId, OutboundMessage } from '../core/types.js';
import type { ResolvedBotConfig } from '../config/schema.js';
import { sanitizeOutbound, toMohoMessage } from './adapter.js';
import type { Gateway, GatewayStatus } from './types.js';
import { persistChat } from '../pipeline/persist.js';

export const CONSOLE_CHANNEL_ID = 'console';
export const CONSOLE_USER_ID = 'local-user';

export interface ConsoleGatewayOptions {
  botId: BotId;
  config: ResolvedBotConfig;
  events: EventBus;
  logger: Logger;
}

export class ConsoleGateway implements Gateway {
  readonly botId: BotId;
  readonly platform = 'console' as const;
  readonly name: string;

  readonly #config: ResolvedBotConfig;
  readonly #events: EventBus;
  readonly #logger: Logger;

  #rl: Interface | null = null;
  #seq = 0;
  #lastError: string | undefined;

  constructor(opts: ConsoleGatewayOptions) {
    this.botId = opts.botId;
    this.#config = opts.config;
    this.#events = opts.events;
    this.#logger = opts.logger.child({ gateway: 'console', botId: opts.botId });
    this.name = `gateway:console:${opts.botId}`;
  }

  get #botName(): string {
    return this.#config.name.length > 0 ? this.#config.name : this.botId;
  }

  async start(): Promise<void> {
    if (this.#rl) return;

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    this.#rl = rl;

    rl.on('line', (line: string) => {
      try {
        this.#onLine(line);
      } catch (error) {
        this.#lastError = error instanceof Error ? error.message : String(error);
        this.#logger.error({ err: error }, 'console line handler failed');
      }
    });

    rl.on('error', (error: unknown) => {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#events.emit('gateway:error', { botId: this.botId, error: this.#lastError });
    });

    rl.on('close', () => {
      this.#events.emit('gateway:disconnect', { botId: this.botId, reason: 'stdin closed' });
    });

    this.#logger.info({ bot: this.#botName }, 'console gateway ready (type a line and press enter)');
    this.#events.emit('gateway:ready', { botId: this.botId, username: this.#botName });
  }

  #onLine(line: string): void {
    const content = line.trim();
    if (content.length === 0) return;

    this.#seq += 1;
    const message = toMohoMessage({
      id: `console-${this.#seq}`,
      content,
      author: {
        id: CONSOLE_USER_ID,
        username: CONSOLE_USER_ID,
        globalName: CONSOLE_USER_ID,
        bot: false,
      },
      channelId: CONSOLE_CHANNEL_ID,
      channelName: CONSOLE_CHANNEL_ID,
      isDM: true,
      mentionsBot: true,
      attachments: [],
      createdTimestamp: Date.now(),
      botId: this.botId,
      platform: 'console',
      raw: { line },
    });

    void persistChat(message).catch(() => {});
    this.#events.emit('message:create', { message });
  }

  async send(out: OutboundMessage): Promise<void> {
    const content = sanitizeOutbound(out.content, {
      suppressMentions: out.suppressMentions === true,
    });
    process.stdout.write(`[${this.#botName}] ${content}\n`);
  }

  async typing(_channelId: string): Promise<void> {
    // Nothing sensible to draw on a pipe.
  }

  async stop(): Promise<void> {
    const rl = this.#rl;
    this.#rl = null;
    if (!rl) return;

    try {
      rl.removeAllListeners();
      rl.close();
    } catch {
      /* stop() must never throw */
    }

    // Release stdin so the readline interface cannot keep the event loop alive.
    try {
      process.stdin.pause();
      if (typeof process.stdin.unref === 'function') process.stdin.unref();
    } catch {
      /* stop() must never throw */
    }
  }

  status(): GatewayStatus {
    return {
      connected: this.#rl !== null,
      ping: 0,
      username: this.#botName,
      guilds: 0,
      reconnects: 0,
      lastError: this.#lastError,
    };
  }
}
