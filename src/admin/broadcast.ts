/**
 * Two-step guild broadcast (preview -> confirm -> fan-out).
 *
 * Discord-native port of upstream's broadcast plugin. Upstream targets QQ
 * friends and groups with cross-bot dedupe; on Discord friend lists are not
 * enumerable and this runtime owns one bot, so broadcast covers the guilds
 * the bot can see, one message per guild into its first text channel. DMs
 * are intentionally out of scope: unsolicited bot DMs are spam, and Discord
 * does not let bots enumerate messageable users anyway.
 *
 * Safety is the two-step flow: `?广播 <内容>` only stages a pending item and
 * announces the preview on the ops surface; nothing is sent until
 * `?广播确认` within the timeout. `?广播取消` drops it.
 */

import type { Logger } from '../core/logger.js';

export interface BroadcastGuild {
  id: string;
  name: string;
}

export interface BroadcastChannel {
  id: string;
  name: string;
}

export interface BroadcastDeps {
  botName: string;
  listGuilds: () => Promise<BroadcastGuild[]>;
  /** First writable text channel, or null when the guild has nowhere to post. */
  resolveChannel: (guildId: string) => Promise<BroadcastChannel | null>;
  /** Sends to a channel; resolves false (never throws) when undeliverable. */
  send: (channelId: string, content: string) => Promise<boolean>;
  /** Ops surface (log channel). Never throws; best effort. */
  announce: (content: string) => Promise<void>;
  logger: Logger;
  now?: () => number;
  confirmTimeoutMs?: number;
}

interface PendingBroadcast {
  id: string;
  content: string;
  by: string;
  createdAt: number;
  expiresAt: number;
}

const CONFIRM_TIMEOUT_MS = 10 * 60_000;
const MAX_CONTENT_CHARS = 1900;
const SEND_GAP_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class BroadcastManager {
  readonly #deps: BroadcastDeps;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #confirmTimeoutMs: number;
  #pending: PendingBroadcast | null = null;
  #seq = 0;

  constructor(deps: BroadcastDeps) {
    this.#deps = deps;
    this.#logger = deps.logger.child({ component: 'broadcast' });
    this.#now = deps.now ?? Date.now;
    this.#confirmTimeoutMs = deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
  }

  /** Stage content and announce the preview. Nothing is sent to guilds. */
  async preview(content: string, authorId: string): Promise<string> {
    const text = content.trim();
    if (!text) throw new Error('广播内容为空。');
    if (text.length > MAX_CONTENT_CHARS) {
      throw new Error(`广播内容过长（${text.length}/${MAX_CONTENT_CHARS} 字），请缩短后重试。`);
    }
    this.#seq += 1;
    const now = this.#now();
    this.#pending = {
      id: `bc-${now.toString(36)}-${this.#seq}`,
      content: text,
      by: authorId,
      createdAt: now,
      expiresAt: now + this.#confirmTimeoutMs,
    };
    const guilds = await this.#deps.listGuilds().catch(() => []);
    await this.#deps.announce([
      `📢 广播预告（编号 ${this.#pending.id}，发起人 ${authorId}）`,
      text,
      `目标：${guilds.length} 个服务器。\`?广播确认\` 发送，\`?广播取消\` 撤销（10 分钟内有效）。`,
    ].join('\n')).catch(() => {});
    this.#logger.info({ id: this.#pending.id, by: authorId, guilds: guilds.length }, 'broadcast staged');
    return `预告已生成（${guilds.length} 个服务器），预览已发到管理频道。请 \`?广播确认\` 发送，或 \`?广播取消\` 撤销（10 分钟内有效）。`;
  }

  /** Sends the pending broadcast to every guild with a postable channel. */
  async confirm(): Promise<string> {
    const pending = this.#takePending();
    if (!pending) return '没有待确认的广播。用 `?广播 <内容>` 先预告。';
    const guilds = await this.#deps.listGuilds().catch(() => []);
    const delivered: string[] = [];
    const failed: string[] = [];
    for (const guild of guilds) {
      try {
        const channel = await this.#deps.resolveChannel(guild.id);
        if (!channel) {
          failed.push(`${guild.name}（无可发送频道）`);
          continue;
        }
        const ok = await this.#deps.send(channel.id, `📢 来自${this.#deps.botName}的广播\n\n${pending.content}`);
        (ok ? delivered : failed).push(ok ? guild.name : `${guild.name}（发送失败）`);
      } catch (error) {
        failed.push(`${guild.name}（${error instanceof Error ? error.message : '异常'}）`);
      }
      await sleep(SEND_GAP_MS);
    }
    const summary = [
      `广播完成：成功 ${delivered.length} / 失败 ${failed.length}（共 ${guilds.length} 个服务器）`,
      ...failed.map((reason) => `· ${reason}`),
    ].join('\n');
    await this.#deps.announce(`📢 广播结果（编号 ${pending.id}）\n${summary}`).catch(() => {});
    this.#logger.info({ id: pending.id, ok: delivered.length, failed: failed.length }, 'broadcast confirmed');
    return summary;
  }

  async cancel(): Promise<string> {
    const pending = this.#takePending();
    if (!pending) return '没有待确认的广播。';
    await this.#deps.announce(`📢 广播已取消（编号 ${pending.id}）。`).catch(() => {});
    this.#logger.info({ id: pending.id }, 'broadcast cancelled');
    return '已取消待确认的广播。';
  }

  #takePending(): PendingBroadcast | null {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return null;
    if (this.#now() >= pending.expiresAt) return null;
    return pending;
  }
}
