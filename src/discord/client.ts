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
  ActivityType,
  MessageFlags,
  type ClientEvents,
  type ApplicationCommandDataResolvable,
  type Interaction,
  type APIEmbed,
  type Message,
  type ThreadChannel,
  type MessageCreateOptions,
  type SendableChannels,
  type NonThreadGuildBasedChannel,
} from 'discord.js';

import type { ResolvedBotConfig } from '../config/schema.js';
import type { EventBus } from '../core/event.js';
import { registerSecret, type Logger } from '../core/logger.js';
import type { BotId, EmbedCard, MohoMessageDelete, MohoMessageLocation, MohoMessageUpdate, MohoThreadLifecycle, OutboundMessage } from '../core/types.js';
import { chunkContent, sanitizeOutbound, toMohoMessage } from './adapter.js';
import type { Gateway, GatewayStatus } from './types.js';
import { persistChat } from '../pipeline/persist.js';
import { WorldStore } from '../admin/world.js';
import { presenceFromWorld } from './presence.js';
import type { GuildInventory, GuildPlan } from './guild-admin.js';

export interface DiscordGatewayOptions {
  botId: BotId;
  config: ResolvedBotConfig;
  events: EventBus;
  logger: Logger;
  rootDir?: string;
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

export function discordMessageLocation(message: Pick<Message, 'channelId' | 'guildId' | 'channel'>): MohoMessageLocation {
  const channel = message.channel;
  if (channel.isThread()) {
    const parent = channel.parent;
    const forumPost = parent?.type === ChannelType.GuildForum || parent?.type === ChannelType.GuildMedia;
    return { channelId: message.channelId, parentChannelId: channel.parentId ?? undefined, guildId: message.guildId ?? undefined, kind: forumPost ? 'forum-post' : 'thread' };
  }
  if (channel.type === ChannelType.DM) return { channelId: message.channelId, kind: 'dm' };
  return { channelId: message.channelId, guildId: message.guildId ?? undefined, kind: message.guildId ? 'guild-text' : 'unknown' };
}

export function toMessageUpdateEvent(botId: BotId, message: Message | import('discord.js').PartialMessage, now = Date.now()): MohoMessageUpdate {
  return { botId, platform: 'discord', messageId: message.id, location: discordMessageLocation(message as Message), content: typeof message.content === 'string' ? message.content : undefined, authorId: message.author?.id, editedAt: message.editedTimestamp ?? now, partial: message.partial };
}

export function toMessageDeleteEvent(botId: BotId, message: Message | import('discord.js').PartialMessage, now = Date.now()): MohoMessageDelete {
  return { botId, platform: 'discord', messageId: message.id, location: discordMessageLocation(message as Message), authorId: message.author?.id, deletedAt: now, partial: message.partial };
}

export function toThreadLifecycleEvent(botId: BotId, action: MohoThreadLifecycle['action'], thread: ThreadChannel, now = Date.now()): MohoThreadLifecycle {
  const parent = thread.parent;
  return { botId, platform: 'discord', action, channelId: thread.id, parentChannelId: thread.parentId ?? undefined, guildId: thread.guildId, name: thread.name, forumPost: parent?.type === ChannelType.GuildForum || parent?.type === ChannelType.GuildMedia, archived: thread.archived ?? undefined, locked: thread.locked ?? undefined, partial: false, occurredAt: now };
}

export class DiscordSessionStartLimitError extends Error {
  readonly retryAt: number;

  constructor(message: string, retryAt: number) {
    super(message);
    this.name = 'DiscordSessionStartLimitError';
    this.retryAt = retryAt;
  }
}

function sessionStartRetryAt(error: unknown): number | undefined {
  const message = describeError(error);
  if (!/not enough sessions remaining to spawn/i.test(message)) return undefined;
  const match = /resets at\s+([^\s]+)/i.exec(message);
  const parsed = match?.[1] ? Date.parse(match[1]) : Number.NaN;
  return Number.isFinite(parsed) && parsed > Date.now() ? parsed : undefined;
}

export class DiscordGateway implements Gateway {
  readonly botId: BotId;
  readonly platform = 'discord' as const;
  readonly name: string;

  readonly #config: ResolvedBotConfig;
  readonly #events: EventBus;
  readonly #logger: Logger;
  readonly #rootDir?: string;

  #client: Client | null = null;
  #ready = false;
  #starting = false;
  #reconnects = 0;
  #lastError: string | undefined;
  #presenceTimer?: NodeJS.Timeout;

  constructor(opts: DiscordGatewayOptions) {
    this.botId = opts.botId;
    this.#config = opts.config;
    this.#events = opts.events;
    this.#rootDir = opts.rootDir;
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
    this.#startPresenceProjection();
  }

  async #registerInteractionBase(client: Client<true>): Promise<void> {
    if (!this.#config.discord.registerEmptySlash) return;
    try {
      const commands: ApplicationCommandDataResolvable[] = this.#config.admin.enabled
        ? [{ name: 'status', description: '查看当前 Bot 运行状态' }]
        : [];
      // Replace, rather than append: old commands must not survive a role
      // changing from admin to persona.
      await client.application.commands.set(commands);
      this.#logger.debug({ botId: this.botId, commands: commands.length }, 'registered interaction base');
    } catch (error) {
      this.#logger.warn({ err: error }, 'failed to register interaction base');
    }
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
        void this.#registerInteractionBase(readyClient);
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
        const retryAt = sessionStartRetryAt(error);
        if (retryAt) {
          reject(new DiscordSessionStartLimitError(`[${this.botId}] Discord login failed: ${this.#lastError}`, retryAt));
          return;
        }
        reject(new Error(`[${this.botId}] Discord login failed: ${this.#lastError}`));
      });
    });
  }

  async stop(): Promise<void> {
    if (this.#presenceTimer) clearInterval(this.#presenceTimer);
    this.#presenceTimer = undefined;
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

  #startPresenceProjection(): void {
    const config = this.#config.presence;
    if (!config.enabled) return;
    const update = async (): Promise<void> => {
      const user = this.#client?.user;
      if (!user) return;
      try {
        const rootDir = this.#rootDir ?? process.env.MOHO_ROOT ?? process.cwd();
        const presence = presenceFromWorld(await new WorldStore(rootDir, this.botId).get());
        user.setPresence({ status: presence.status, afk: presence.afk, activities: [{ name: presence.activity, type: ActivityType.Custom, state: presence.activity }] });
      } catch (error) {
        this.#logger.debug({ err: error }, 'presence projection failed');
      }
    };
    void update();
    this.#presenceTimer = setInterval(() => void update(), config.updateIntervalSeconds * 1000);
    this.#presenceTimer.unref?.();
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

  async guildInventory(guildId: string): Promise<GuildInventory> {
    const client = this.#client;
    if (!client?.isReady()) throw new Error('Discord gateway is not ready');
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const views = [...channels.values()].filter((channel): channel is NonThreadGuildBasedChannel => channel !== null).map((channel) => ({
      id: channel.id,
      name: channel.name,
      kind: channel.type === ChannelType.GuildCategory ? 'category' as const : channel.type === ChannelType.GuildText ? 'text' as const : channel.type === ChannelType.GuildVoice ? 'voice' as const : 'other' as const,
      ...(channel.parentId ? { parentId: channel.parentId } : {}),
      position: channel.position,
      ...(channel.type === ChannelType.GuildText && channel.topic ? { topic: channel.topic } : {}),
    }));
    const roles = [...(await guild.roles.fetch()).values()].map((role) => ({ id: role.id, name: role.name, position: role.position, managed: role.managed }));
    return { guildId: guild.id, name: guild.name, ownerId: guild.ownerId, communityEnabled: guild.features.includes('COMMUNITY'), channels: views, roles };
  }

  async applyGuildPlan(plan: GuildPlan): Promise<{ applied: number; skipped: number }> {
    const client = this.#client;
    if (!client?.isReady()) throw new Error('Discord gateway is not ready');
    if (!plan.guildId || plan.communityEnabled !== false || plan.actions.length > 100) throw new Error('guild plan is invalid');
    const guild = await client.guilds.fetch(plan.guildId);
    const allowed = new Set(['create-category', 'create-text', 'create-voice', 'move-channel', 'set-topic']);
    if (plan.actions.some((action) => !allowed.has(action.kind))) throw new Error('guild plan contains a forbidden action');
    let applied = 0; let skipped = 0;
    const categories = async () => new Map((await guild.channels.fetch()).filter((channel): channel is NonThreadGuildBasedChannel => channel !== null && channel.type === ChannelType.GuildCategory).map((channel) => [channel.name.toLowerCase(), channel]));
    for (const action of plan.actions) {
      if (action.kind === 'create-category') {
        const found = (await categories()).get(action.name.toLowerCase());
        if (found) { skipped += 1; continue; }
        await guild.channels.create({ name: action.name, type: ChannelType.GuildCategory }); applied += 1;
      } else if (action.kind === 'create-text' || action.kind === 'create-voice') {
        const parent = (await categories()).get(action.category.toLowerCase());
        if (!parent) throw new Error(`category missing: ${action.category}`);
        const current = (await guild.channels.fetch()).find((channel) => channel?.name.toLowerCase() === action.name.toLowerCase() && channel.parentId === parent.id);
        if (current) { skipped += 1; continue; }
        await guild.channels.create({ name: action.name, type: action.kind === 'create-text' ? ChannelType.GuildText : ChannelType.GuildVoice, parent: parent.id, ...(action.kind === 'create-text' ? { topic: action.topic } : {}) }); applied += 1;
      } else {
        const channel = await guild.channels.fetch(action.channelId);
        if (!channel) { skipped += 1; continue; }
        if (action.kind === 'move-channel') {
          const parent = (await categories()).get(action.category.toLowerCase());
          if (!parent || channel.parentId === parent.id) { skipped += 1; continue; }
          await guild.channels.edit(channel.id, { parent: parent.id, lockPermissions: false }); applied += 1;
        } else if (action.kind === 'set-topic' && channel.type === ChannelType.GuildText) {
          if (channel.topic === action.topic) { skipped += 1; continue; }
          await channel.setTopic(action.topic); applied += 1;
        }
      }
    }
    return { applied, skipped };
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

    this.#on(client, 'messageUpdate', (_oldMessage, newMessage) => {
      this.#onMessageUpdate(newMessage);
    });

    this.#on(client, 'messageDelete', (message) => {
      this.#onMessageDelete(message);
    });

    this.#on(client, 'threadCreate', (thread) => {
      this.#onThread('create', thread);
    });

    this.#on(client, 'threadUpdate', (_oldThread, newThread) => {
      this.#onThread('update', newThread);
    });

    this.#on(client, 'threadDelete', (thread) => {
      this.#onThread('delete', thread);
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

    const content = typeof message.content === 'string' ? message.content : '';

    // Cheapest filters first.
    if (message.author.id === self.id) return;
    if (cfg.ignoreBots && message.author.bot && !cfg.peerBots.includes(message.author.id)) return;
    if (cfg.blockedUsers.includes(message.author.id)) return;

    const guildId = message.guildId ?? undefined;
    if (guildId && cfg.allowedGuilds.length > 0 && !cfg.allowedGuilds.includes(guildId)) return;
    const location = discordMessageLocation(message);
    if (cfg.allowedChannels.length > 0
      && !cfg.allowedChannels.includes(message.channelId)
      && !(location.parentChannelId && cfg.allowedChannels.includes(location.parentChannelId))) return;

    const isDM = guildId === undefined || message.channel.type === ChannelType.DM;

    let mentionsBot = message.mentions.users.has(self.id);
    if (!mentionsBot) mentionsBot = await this.#isReplyToBot(message, self.id);

    if (isDM) {
      if (!cfg.respondToDM) return;
    } else if (cfg.respondToMentionsOnly && !mentionsBot) {
      return;
    }

    if (content.trim().length === 0 && message.attachments.size === 0) return;

    const isBotManager = await this.#isBotManager(guildId, message.author.id);
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
        isBotManager,
      },
      channelId: message.channelId,
      guildId,
      channelName,
      parentChannelId: location.parentChannelId,
      location,
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

    // Persist only messages that passed the bot's access and response filters.
    void persistChat(moho).catch(() => {});
    this.#events.emit('message:create', { message: moho });
  }

  #onMessageUpdate(message: Message | import('discord.js').PartialMessage): void {
    this.#events.emit('message:update', toMessageUpdateEvent(this.botId, message));
  }

  #onMessageDelete(message: Message | import('discord.js').PartialMessage): void {
    this.#events.emit('message:delete', toMessageDeleteEvent(this.botId, message));
  }

  #onThread(action: MohoThreadLifecycle['action'], thread: ThreadChannel): void {
    this.#events.emit('thread:lifecycle', toThreadLifecycleEvent(this.botId, action, thread));
  }

  async #isBotManager(guildId: string | undefined, userId: string): Promise<boolean> {
    // Explicit user allowlist is person-scoped, not guild-scoped: a listed ID
    // stays an admin in every guild and in DMs. guildIds only scopes where
    // role-based administration is honored.
    if (this.#config.admin.userIds.includes(userId)) return true;
    if (!guildId) return false;
    const names = new Set(this.#config.admin.roleNames.map((name) => name.trim().toLowerCase()).filter(Boolean));
    if (names.size === 0) return false;
    if (this.#config.admin.guildIds.length > 0 && !this.#config.admin.guildIds.includes(guildId)) return false;
    try {
      const guild = await this.#client?.guilds.fetch(guildId);
      const member = await guild?.members.fetch(userId);
      return Boolean(member?.roles.cache.some((role) => names.has(role.name.trim().toLowerCase())));
    } catch {
      return false;
    }
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

  async #onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'status') return;
    if (!this.#config.admin.enabled || !(await this.#isBotManager(interaction.guildId ?? undefined, interaction.user.id))) {
      void interaction.reply({ content: '这个入口只对授权管理员开放。', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    const options: Record<string, unknown> = {};
    for (const option of interaction.options.data) options[option.name] = option.value;

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
      isBotManager: await this.#isBotManager(interaction.guildId ?? undefined, interaction.user.id),
      options,
      reply,
    });
  }

  // ---------------------------------------------------------------- outbound

  async send(out: OutboundMessage): Promise<void> {
    const client = this.#client;
    if (!client) throw new Error(`[${this.botId}] gateway is not started`);

    const suppress = out.suppressMentions === true;
    const allowedMentions = out.mentionUserId
      ? { parse: [] as [], users: [out.mentionUserId], repliedUser: false }
      : suppress ? { parse: [] as [], repliedUser: false } : undefined;

    // Embed path: render a rich card when present and within Discord's hard limits.
    if (out.embed && this.#embedFits(out.embed)) {
      try {
        const channel = await this.#resolveSendable(out.channelId);
        const payload: MessageCreateOptions = { embeds: [this.#toApiEmbed(out.embed)] };
        if (out.replyToId) {
          payload.reply = { messageReference: out.replyToId, failIfNotExists: false };
        }
        if (allowedMentions) payload.allowedMentions = allowedMentions;
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
        if (allowedMentions) payload.allowedMentions = allowedMentions;
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
