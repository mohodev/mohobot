import type { MohoMessage } from '../core/types.js';
import { chatLogInsert } from '../storage/chatlog.js';

/**
 * Fire-and-forget physical chat log. Writes one row per inbound message into
 * the chat_log table of data/mohobot.db - the same SQLite database the kv
 * storage driver uses. Never awaited by the callers; the returned promise
 * rejects instead of throwing so existing .catch(() => {}) sites keep working.
 */
export function persistChat(message: MohoMessage): Promise<void> {
  try {
    chatLogInsert({
      channelId: message.channel.id,
      messageId: message.id,
      authorId: message.author.id,
      username: message.author.username,
      content: message.content,
      mentionsBot: message.mentionsBot,
      botId: message.botId,
      ts: new Date().toISOString(),
      createdAt: Date.now(),
    });
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
