/**
 * Platform -> Moho translation helpers.
 *
 * Everything in this file is a PURE function over plain, structurally-typed
 * objects. There is deliberately no runtime discord.js import here so the
 * adapter can be unit-tested without a gateway, a token or a network.
 */

import type {
  BotId,
  MohoAttachment,
  MohoChannel,
  MohoMessage,
  MohoUser,
  Platform,
} from '../core/types.js';

/** Discord's hard per-message limit. */
export const DISCORD_MAX_MESSAGE_LENGTH = 2000;

const FENCE = '```';
/** Zero-width joiner used to defuse @everyone / @here without hiding it. */
const ZWJ = String.fromCharCode(0x200d);

export interface AdapterAuthorInput {
  id: string;
  username: string;
  /** Discord "global name"; becomes MohoUser.displayName. */
  globalName?: string | null;
  bot: boolean;
}

export interface AdapterAttachmentInput {
  id: string;
  url: string;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
}

/**
 * Structural shape of an inbound platform message.
 *
 * `botId` / `platform` are part of the shape because MohoMessage carries them
 * and toMohoMessage takes a single argument.
 */
export interface AdapterMessageInput {
  id: string;
  content: string;
  author: AdapterAuthorInput;
  channelId: string;
  guildId?: string | null;
  channelName?: string | null;
  parentChannelId?: string | null;
  location?: import('../core/types.js').MohoMessageLocation;
  isDM: boolean;
  mentionsBot: boolean;
  replyToId?: string | null;
  attachments?: readonly AdapterAttachmentInput[];
  createdTimestamp: number;
  /** Owning bot id. */
  botId: BotId;
  /** Defaults to 'discord'. */
  platform?: Platform;
  /** Original platform object. Defaults to the input object itself. */
  raw?: unknown;
}

function optionalString(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function mapAuthor(author: AdapterAuthorInput): MohoUser {
  return {
    id: author.id,
    username: author.username,
    displayName: optionalString(author.globalName) ?? author.username,
    bot: author.bot === true,
  };
}

function mapAttachment(attachment: AdapterAttachmentInput): MohoAttachment {
  return {
    id: attachment.id,
    url: attachment.url,
    name: optionalString(attachment.name),
    contentType: optionalString(attachment.contentType),
    size: typeof attachment.size === 'number' ? attachment.size : undefined,
  };
}

/** Translate a platform message into the platform-agnostic domain model. */
export function toMohoMessage(input: AdapterMessageInput): MohoMessage {
  const guildId = optionalString(input.guildId);
  const dm = input.isDM === true || guildId === undefined;

  const channel: MohoChannel = {
    id: input.channelId,
    guildId: dm ? undefined : guildId,
    name: optionalString(input.channelName),
    dm,
    parentChannelId: optionalString(input.parentChannelId),
    location: input.location,
  };

  return {
    id: input.id,
    platform: input.platform ?? 'discord',
    botId: input.botId,
    channel,
    author: mapAuthor(input.author),
    content: typeof input.content === 'string' ? input.content : '',
    mentionsBot: input.mentionsBot === true,
    replyToId: optionalString(input.replyToId),
    attachments: (input.attachments ?? []).map(mapAttachment),
    createdAt: Number.isFinite(input.createdTimestamp) ? input.createdTimestamp : Date.now(),
    raw: input.raw !== undefined ? input.raw : input,
  };
}

interface FenceState {
  open: boolean;
  lang: string;
}

/** Walk the text and report whether a ``` fence is still open at the end. */
function fenceState(text: string): FenceState {
  let open = false;
  let lang = '';
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(FENCE)) continue;
    if (open) {
      open = false;
      lang = '';
    } else {
      open = true;
      lang = trimmed.slice(FENCE.length).trim();
    }
  }
  return { open, lang };
}

/**
 * Pick where to cut `text` so the slice is at most `budget` chars.
 * Prefer the last newline, then the last space, else a hard cut.
 */
function splitPoint(text: string, budget: number): { end: number; next: number } {
  if (text.length <= budget) return { end: text.length, next: text.length };
  const newline = text.lastIndexOf('\n', budget);
  if (newline > 0) return { end: newline, next: newline + 1 };
  const space = text.lastIndexOf(' ', budget);
  if (space > 0) return { end: space, next: space + 1 };
  return { end: budget, next: budget };
}

/**
 * Split a reply so every chunk fits Discord's message limit.
 *
 * Never splits inside a fenced code block: an open fence is closed on the
 * current chunk and reopened (same language tag) on the next one.
 * Empty chunks are dropped.
 */
export function chunkContent(text: string, max: number): string[] {
  const limit =
    Number.isFinite(max) && max > 0
      ? Math.min(Math.floor(max), DISCORD_MAX_MESSAGE_LENGTH)
      : DISCORD_MAX_MESSAGE_LENGTH;

  if (text.length === 0) return [];
  if (text.length <= limit) return [text];

  const out: string[] = [];
  const closing = `\n${FENCE}`;
  let rest = text;
  let carry = '';
  let guard = 0;

  while (rest.length > 0 && guard < 10_000) {
    guard += 1;
    const prefix = carry.length > 0 ? `${carry}\n` : '';

    if (prefix.length + rest.length <= limit) {
      const tail = prefix + rest;
      if (tail.trim().length > 0) out.push(tail);
      break;
    }

    let budget = limit - prefix.length - closing.length;
    if (budget < 1) budget = Math.max(1, limit - prefix.length);

    const { end, next } = splitPoint(rest, budget);
    let piece = rest.slice(0, end);

    const state = fenceState(prefix + piece);
    if (state.open) {
      piece = `${piece.replace(/\s+$/, '')}${closing}`;
      carry = FENCE + state.lang;
    } else {
      carry = '';
    }

    const chunk = prefix + piece;
    if (chunk.trim().length > 0) out.push(chunk);

    if (next <= 0) break;
    rest = rest.slice(next);
  }

  return out;
}

export interface SanitizeOptions {
  /** Neutralise @everyone / @here so a reply can never mass-ping. */
  suppressMentions?: boolean;
}

/** Make an outbound body safe and non-empty for the platform. */
export function sanitizeOutbound(text: string, opts: SanitizeOptions = {}): string {
  let out = typeof text === 'string' ? text : '';
  out = out.replace(/\r\n/g, '\n');

  if (opts.suppressMentions === true) {
    out = out.replace(/@(everyone|here)/g, `@${ZWJ}$1`);
  }

  // Collapse runs of blank lines down to a single blank line.
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out.trim();

  // Discord rejects an empty body; a single space always succeeds.
  return out.length > 0 ? out : ' ';
}
