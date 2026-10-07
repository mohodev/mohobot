import type { ChatMessage, Platform } from '../core/types.js';
import type { PersistedSession, SessionSummary } from '../storage/types.js';

/** Highest session recordVersion this build can read and write. */
export const SESSION_RECORD_VERSION = 2;
const MAX_SUMMARY_CHARS = 20_000;

export type SessionDecodeResult =
  | { ok: true; value: PersistedSession; legacy: boolean; droppedMessages: number }
  | { ok: false; reason: 'invalid_shape'|'future_version' };

const ROLES = new Set(['system', 'user', 'assistant']);
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

/** A malformed summary is dropped on its own; the conversation itself survives. */
export function decodeSessionSummary(value: unknown): SessionSummary | undefined {
  if (!object(value) || typeof value.text !== 'string') return undefined;
  const text = value.text.trim();
  if (!text || text.length > MAX_SUMMARY_CHARS || !finite(value.updatedAt)) return undefined;
  const covered = finite(value.coveredMessages) && value.coveredMessages >= 0 ? Math.floor(value.coveredMessages) : 0;
  return { text, updatedAt: value.updatedAt, coveredMessages: covered };
}

export function decodePersistedSession(value: unknown, expectedKey: string): SessionDecodeResult {
  if (!object(value)) return { ok: false, reason: 'invalid_shape' };
  if (value.recordVersion !== undefined && (!Number.isSafeInteger(value.recordVersion) || Number(value.recordVersion) > SESSION_RECORD_VERSION)) {
    return { ok: false, reason: 'future_version' };
  }
  if (value.kind !== undefined && value.kind !== 'session') return { ok: false, reason: 'invalid_shape' };
  if (typeof value.key !== 'string' || value.key !== expectedKey || typeof value.botId !== 'string'
    || typeof value.channelId !== 'string' || !optionalString(value.userId)
    || !Array.isArray(value.messages) || !finite(value.updatedAt)) return { ok: false, reason: 'invalid_shape' };
  const messages: ChatMessage[] = [];
  for (const raw of value.messages) { const message = decodeChatMessage(raw); if (message) messages.push(message); }
  const summary = value.summary === undefined ? undefined : decodeSessionSummary(value.summary);
  return { ok: true, legacy: value.kind === undefined && value.recordVersion === undefined,
    droppedMessages: value.messages.length - messages.length,
    value: { kind: 'session', recordVersion: summary ? 2 : 1, key: value.key, botId: value.botId,
      channelId: value.channelId, ...(value.userId !== undefined ? { userId: value.userId } : {}), messages,
      ...(summary ? { summary } : {}), updatedAt: value.updatedAt } };
}
