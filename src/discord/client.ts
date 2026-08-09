/**
 * Discord gateway.
 *
 * ARCHITECTURAL IRON RULE: src/discord/ is the only place allowed to import
 * discord.js. Nothing leaves this file except Moho types; the raw discord.js
 * Message is only ever reachable through MohoMessage.raw.
 */

import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type ClientEvents,
  type Interaction,
  type APIEmbed,
  type Message,
  type MessageCreateOptions,
  type SendableChannels,
} from 'discord.js';

import type { ResolvedBotConfig } from '../config/schema.js';
import type { EventBus } from '../core/event.js';
import { registerSecret, type Logger } from '../core/logger.js';
import type { BotId, EmbedCard, OutboundMessage } from '../core/types.js';
import { chunkContent, sanitizeOutbound, toMohoMessage } from './adapter.js';
import type { Gateway, GatewayStatus } from './types.js';
import { persistChat } from '../pipeline/persist.js';

export interface DiscordGatewayOptions {
  botId: BotId;
  config: ResolvedBotConfig;
  events: EventBus;
  logger: Logger;
}

const LOGIN_TIMEOUT_MS = 30_000;
const CHUNK_DELAY_MS = 250;

// Discord Embed hard limits (see discord.js EmbedBuilder source).
const EMBED_TITLE_LIMIT = 256;
const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_FOOTER_LIMIT = 2048;
const EMBED_FIELD_NAME_LIMIT = 256;
const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_FIELD_COUNT = 25;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export class DiscordGateway implements Gateway {
  readonly botId: BotId;
  readonly platform = 'discord' as const;
  readonly name: string;

  readonly #config: ResolvedBotConfig;
  readonly #events: EventBus;
  readonly #logger: Logger;

  #client: Client | null = null;
  #ready = false;
  #starting = false;
  #reconnects = 0;
  #lastError: string | undefined;

  constructor(opts: DiscordGatewayOptions) {
    this.botId = opts.botId;
    this.#config = opts.config;
    this.#events = opts.events;
    this.#logger = opts.logger.child({ gateway: 'discord', botId: opts.botId });
    this.name = `gateway:discord:${opts.botId}`;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.#client || this.#starting) return;

    const token = (this.#config.discord.token ?? '').trim();
    if (token.length === 0) {
      throw new Error(
        `[${this.botId}] Discord token is empty - set DISCORD_TOKEN or MOHO_BOT_${this.botId.toUpperCase()}_DISCORD_TOKEN`,
      );
    }
    registerSecret(token);

    this.#starting = true;
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      // Partials are required or DMs from uncached channels are dropped.
      partials: [Partials.Channel, Partials.Message],
    });
    this.#client = client;
    this.#attach(client);

    try {
      await this.#login(client, token);
    } catch (error) {
      this.#starting = false;
      await this.stop();
      throw error instanceof Error ? error : new Error(describeError(error));
    }
    this.#starting = false;
  }

  #login(client: Client, token: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`[${this.botId}] Discord login timed out after ${LOGIN_TIMEOUT_MS}ms`));
      }, LOGIN_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();

      // v14.16+ renamed 'ready' to 'clientReady'; listen for both, fire once.
      const onReady = (readyClient: Client<true>): void => {
        if (this.#ready) return;
        this.#ready = true;
        const username = readyClient.user?.username ?? 'unknown';
        this.#logger.info(
          { username, guilds: readyClient.guilds.cache.size },
          'discord gateway ready',
        );
        this.#events.emit('gateway:ready', { botId: this.botId, username });
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      client.once('clientReady', onReady);
      client.once('ready', onReady);

      client.login(token).catch((error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#lastError = describeError(error);
        reject(new Error(`[${this.botId}] Discord login failed: ${this.#lastError}`));
      });
    });
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#ready = false;
    this.#starting = false;
    if (!client) return;

    try {
      client.removeAllListeners();
    } catch {
      /* stop() must never throw */
    }
    try {
      await client.destroy();
    } catch (error) {
      this.#logger.warn({ err: error }, 'discord client destroy failed');
    }
  }

  status(): GatewayStatus {
    const client = this.#client;
    const rawPing = client ? client.ws.ping : Number.NaN;
    return {
      connected: client?.isReady() === true,
      ping: Number.isFinite(rawPing) ? Math.round(rawPing) : -1,
      username: client?.user?.username,
      guilds: client ? client.guilds.cache.size : 0,
      reconnects: this.#reconnects,
      lastError: this.#lastError,
    };
  }

  // ---------------------------------------------------------------- listeners

  /** Attach a listener that can never throw into discord.js' emitter. */
  #on<K extends keyof ClientEvents>(
    client: Client,
    event: K,
    handler: (...args: ClientEvents[K]) => void | Promise<void>,
  ): void {
    const safe = (...args: ClientEvents[K]): void => {
      try {
        const result = handler(...args);
        if (result instanceof Promise) {
          result.catch((error: unknown) => this.#noteError(error, String(event)));
        }
      } catch (error) {
        this.#noteError(error, String(event));
      }
    };
    client.on(event, safe);
  }

  #noteError(error: unknown, where: string): void {
    this.#lastError = describeError(error);
    this.#logger.error({ err: error, where }, 'discord listener error');
    this.#events.emit('gateway:error', { botId: this.botId, error: this.#lastError });
  }

  #attach(client: Client): void {
    this.#on(client, 'messageCreate', async (message) => {
      await this.#onMessage(message);
    });

    this.#on(client, 'interactionCreate', (interaction) => {
      this.#onInteraction(interaction);
    });

    this.#on(client, 'error', (error) => {
      this.#lastError = describeError(error);
      this.#logger.error({ err: error }, 'discord client error');
      this.#events.emit('gateway:error', { botId: this.botId, error: this.#lastError });
    });

    this.#on(client, 'shardError', (error, shardId) => {
      this.#lastError = describeError(error);
      this.#logger.error({ err: error, shardId }, 'discord shard error');
      this.#events.emit('gateway:error', { botId: this.botId, error: this.#lastError });
    });

    this.#on(client, 'shardDisconnect', (event, shardId) => {
      const reason = `shard ${shardId} disconnected (code ${event.code})`;
      this.#ready = false;
      this.#logger.warn({ shardId, code: event.code }, 'discord shard disconnected');
      this.#events.emit('gateway:disconnect', { botId: this.botId, reason });
    });

    this.#on(client, 'shardReconnecting', (shardId) => {
      this.#reconnects += 1;
      this.#logger.warn({ shardId, reconnects: this.#reconnects }, 'discord shard reconnecting');
      this.#events.emit('gateway:disconnect', {
        botId: this.botId,
        reason: `shard ${shardId} reconnecting`,
      });
    });

    this.#on(client, 'shardResume', (shardId, replayedEvents) => {
      this.#reconnects += 1;
      this.#ready = true;
      this.#logger.info({ shardId, replayedEvents }, 'discord shard resumed');
    });
  }

  // ----------------------------------------------------------------- inbound

  async #onMessage(message: Message): Promise<void> {
    const client = this.#client;
    const self = client?.user;
    if (!client || !self) return;

    const cfg = this.#config.discord;

    // Physical chat log: record every inbound message before any filtering,
    // so the transcript is complete (including messages the bot does not reply to).
    const content = typeof message.content === 'string' ? message.content : '';
    void persistChat({
      id: message.id,
      platform: 'discord',
      botId: this.botId,
      channel: { id: message.channelId, dm: message.channel.type === ChannelType.DM },
      author: {
        id: message.author.id,
        username: message.author.username,
        bot: message.author.bot,
      },
      content,
      mentionsBot: message.mentions.users.has(self.id),
      attachments: [],
      createdAt: message.createdTimestamp ?? Date.now(),
    }).catch(() => {});

    // Cheapest filters first.
    if (message.author.id === self.id) return;
    if (cfg.ignoreBots && message.author.bot) return;
    if (cfg.blockedUsers.includes(message.author.id)) return;

    const guildId = message.guildId ?? undefined;
    if (guildId && cfg.allowedGuilds.length > 0 && !cfg.allowedGuilds.includes(guildId)) return;
    if (cfg.allowedChannels.length > 0 && !cfg.allowedChannels.includes(message.channelId)) return;

    const isDM = guildId === undefined || message.channel.type === ChannelType.DM;

    let mentionsBot = message.mentions.users.has(self.id);
    if (!mentionsBot) mentionsBot = await this.#isReplyToBot(message, self.id);

    if (isDM) {
      if (!cfg.respondToDM) return;
    } else if (cfg.respondToMentionsOnly && !mentionsBot && !content.startsWith('?')) {
      return;
    }

    if (content.trim().length === 0 && message.attachments.size === 0) return;

    const channel = message.channel;
    const channelName =
      'name' in channel && typeof channel.name === 'string' ? channel.name : undefined;

    const moho = toMohoMessage({
      id: message.id,
      content,
      author: {
        id: message.author.id,
        username: message.author.username,
        globalName: message.author.globalName,
        bot: message.author.bot,
      },
      channelId: message.channelId,
      guildId,
      channelName,
      isDM,
      mentionsBot: isDM ? true : mentionsBot,
      replyToId: message.reference?.messageId ?? undefined,
      attachments: [...message.attachments.values()].map((a) => ({
        id: a.id,
        url: a.url,
        name: a.name,
        contentType: a.contentType,
        size: a.size,
      })),
      createdTimestamp: message.createdTimestamp,
      botId: this.botId,
      platform: 'discord',
      raw: message,
    });

    this.#events.emit('message:create', { message: moho });
  }

  async #isReplyToBot(message: Message, selfId: string): Promise<boolean> {
    const referencedId = message.reference?.messageId;
    if (!referencedId) return false;

    if (message.mentions.repliedUser?.id === selfId) return true;

    const cached = message.channel.messages.cache.get(referencedId);
    if (cached) return cached.author.id === selfId;

    try {
      const fetched = await message.fetchReference();
      return fetched.author.id === selfId;
    } catch {
      return false;
    }
  }

  #onInteraction(interaction: Interaction): void {
    if (!interaction.isChatInputCommand()) return;

    const options: Record<string, unknown> = {};
    for (const option of interaction.options.data) {
      options[option.name] = option.value;
    }

    const reply = async (content: string): Promise<void> => {
      try {
        const text = sanitizeOutbound(content, { suppressMentions: true });
        const chunks = chunkContent(text, this.#config.discord.maxReplyLength);
        const first = chunks[0] ?? ' ';
        const rest = chunks.slice(1);
        const allowedMentions = { parse: [] as [], repliedUser: false };

        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: first, allowedMentions });
        } else {
          await interaction.reply({ content: first, allowedMentions });
        }
        for (const chunk of rest) {
          await interaction.followUp({ content: chunk, allowedMentions });
        }
      } catch (error) {
        // The interaction reply must never escalate into the runtime.
        this.#logger.warn(
          { err: error, command: interaction.commandName },
          'interaction reply failed',
        );
      }
    };

    this.#events.emit('interaction:create', {
      botId: this.botId,
      name: interaction.commandName,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      options,
      reply,
    });
  }

  // ---------------------------------------------------------------- outbound

  async send(out: OutboundMessage): Promise<void> {
    const client = this.#client;
    if (!client) throw new Error(`[${this.botId}] gateway is not started`);

    const suppress = out.suppressMentions === true;

    // Embed path: render a rich card when present and within Discord's hard limits.
    if (out.embed && this.#embedFits(out.embed)) {
      try {
        const channel = await this.#resolveSendable(out.channelId);
        const payload: MessageCreateOptions = { embeds: [this.#toApiEmbed(out.embed)] };
        if (out.replyToId) {
          payload.reply = { messageReference: out.replyToId, failIfNotExists: false };
        }
        if (suppress) {
          payload.allowedMentions = { parse: [], repliedUser: false };
        }
        await channel.send(payload);
        return;
      } catch (error) {
        const reason = describeError(error);
        this.#lastError = reason;
        this.#logger.error({ err: error, channelId: out.channelId }, 'discord embed send failed');
        throw new Error(`[${this.botId}] failed to send embed to channel ${out.channelId}: ${reason}`);
      }
    }

    // Plain text path - also the fallback when an embed would overflow the limits.
    const text = sanitizeOutbound(out.content, { suppressMentions: suppress });
    const chunks = chunkContent(text, this.#config.discord.maxReplyLength);
    if (chunks.length === 0) return;

    try {
      const channel = await this.#resolveSendable(out.channelId);

      for (const [index, chunk] of chunks.entries()) {
        const payload: MessageCreateOptions = { content: chunk };
        if (index === 0 && out.replyToId) {
          payload.reply = { messageReference: out.replyToId, failIfNotExists: false };
        }
        if (suppress) {
          payload.allowedMentions = { parse: [], repliedUser: false };
        }
        await channel.send(payload);
        if (index < chunks.length - 1) await sleep(CHUNK_DELAY_MS);
      }
    } catch (error) {
      const reason = describeError(error);
      this.#lastError = reason;
      this.#logger.error({ err: error, channelId: out.channelId }, 'discord send failed');
      throw new Error(`[${this.botId}] failed to send to channel ${out.channelId}: ${reason}`);
    }
  }

  /** Translate a platform-agnostic EmbedCard into a Discord REST embed. */
  #toApiEmbed(card: EmbedCard): APIEmbed {
    const self = this.#client?.user;
    const embed: APIEmbed = {};
    if (card.title !== undefined) embed.title = card.title;
    if (card.description !== undefined) embed.description = card.description;
    if (card.color !== undefined) embed.color = card.color;
    if (card.footer !== undefined) embed.footer = { text: card.footer };
    // Auto-stamp author (bot identity) + timestamp so every card has a consistent header.
    embed.author = {
      name: self?.username ?? this.botId,
      icon_url: self?.displayAvatarURL({ size: 64 }),
    };
    embed.timestamp = new Date().toISOString();
    if (card.fields && card.fields.length > 0) {
      embed.fields = card.fields.map((f) => ({
        name: f.name,
        value: f.value,
        inline: f.inline === true,
      }));
    }
    return embed;
  }

  /** True when every part of the card fits Discord's hard embed limits. */
  #embedFits(card: EmbedCard): boolean {
    if (card.title !== undefined && card.title.length > EMBED_TITLE_LIMIT) return false;
    if (card.description !== undefined && card.description.length > EMBED_DESCRIPTION_LIMIT) return false;
    if (card.footer !== undefined && card.footer.length > EMBED_FOOTER_LIMIT) return false;
    const fields = card.fields ?? [];
    if (fields.length > EMBED_FIELD_COUNT) return false;
    for (const f of fields) {
      if (f.name.length > EMBED_FIELD_NAME_LIMIT) return false;
      if (f.value.length > EMBED_FIELD_VALUE_LIMIT) return false;
    }
    return true;
  }

  /** Best effort typing indicator. Never throws. */
  async typing(channelId: string): Promise<void> {
    try {
      const channel = await this.#resolveSendable(channelId);
      await channel.sendTyping();
    } catch (error) {
      this.#logger.debug({ err: error, channelId }, 'typing indicator failed');
    }
  }

  async #resolveSendable(channelId: string): Promise<SendableChannels> {
    const client = this.#client;
    if (!client) throw new Error('gateway is not started');

    const channel = client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId));
    if (!channel) throw new Error(`channel ${channelId} not found`);
    if (!channel.isTextBased()) throw new Error(`channel ${channelId} is not text based`);
    if (!channel.isSendable()) throw new Error(`channel ${channelId} is not sendable by this bot`);
    return channel;
  }
}
