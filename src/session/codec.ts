import type { ChatMessage, Platform } from '../core/types.js';
import type { PersistedSession } from '../storage/types.js';

export type SessionDecodeResult =
  | { ok: true; value: PersistedSession; legacy: boolean; droppedMessages: number }
  | { ok: false; reason: 'invalid_shape'|'future_version' };

const ROLES = new Set(['system', 'user', 'assistant', 'summary']);
const PLATFORMS = new Set<Platform>(['discord', 'console']);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function optionalString(value: unknown): value is string|undefined { return value === undefined || typeof value === 'string'; }

export function decodeChatMessage(value: unknown): ChatMessage | undefined {
  if (!object(value) || typeof value.role !== 'string' || !ROLES.has(value.role)
    || typeof value.content !== 'string' || value.content.length > 1_000_000
    || !optionalString(value.name) || !optionalString(value.sourceMessageId)
    || (value.sourcePlatform !== undefined && !PLATFORMS.has(value.sourcePlatform as Platform))
    || (value.createdAt !== undefined && !finite(value.createdAt))
    || (value.deleted !== undefined && typeof value.deleted !== 'boolean')) return undefined;
  return {
    role: value.role as ChatMessage['role'], content: value.content,
    ...(value.name !== undefined ? { name: value.name } : {}),
    ...(value.sourceMessageId !== undefined ? { sourceMessageId: value.sourceMessageId } : {}),
    ...(value.sourcePlatform !== undefined ? { sourcePlatform: value.sourcePlatform as Platform } : {}),
    ...(value.createdAt !== undefined ? { createdAt: value.createdAt } : {}),
    ...(value.deleted !== undefined ? { deleted: value.deleted } : {}),
  };
}

export function decodePersistedSession(value: unknown, expectedKey: string): SessionDecodeResult {
  if (!object(value)) return { ok: false, reason: 'invalid_shape' };
  if (value.recordVersion !== undefined && (!Number.isSafeInteger(value.recordVersion) || Number(value.recordVersion) > 1)) {
    return { ok: false, reason: 'future_version' };
  }
  if (value.kind !== undefined && value.kind !== 'session') return { ok: false, reason: 'invalid_shape' };
  if (typeof value.key !== 'string' || value.key !== expectedKey || typeof value.botId !== 'string'
    || typeof value.channelId !== 'string' || !optionalString(value.userId)
    || !Array.isArray(value.messages) || !finite(value.updatedAt)) return { ok: false, reason: 'invalid_shape' };
  const messages: ChatMessage[] = [];
  for (const raw of value.messages) { const message = decodeChatMessage(raw); if (message) messages.push(message); }
  return { ok: true, legacy: value.kind === undefined && value.recordVersion === undefined,
    droppedMessages: value.messages.length - messages.length,
    value: { kind: 'session', recordVersion: 1, key: value.key, botId: value.botId,
      channelId: value.channelId, ...(value.userId !== undefined ? { userId: value.userId } : {}), messages, updatedAt: value.updatedAt } };
}
