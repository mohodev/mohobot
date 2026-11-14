import type { ResolvedBotConfig } from '../config/schema.js';
import type { EmbedCard, MohoMessage, OutboundMessage } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import { chatLogInsert } from '../storage/chatlog.js';
import type { ChatTraceStore } from './chat-trace.js';
import { stripReplyArtifacts } from './reply-filter.js';
import { deliverySegments, type ReplyPlan } from './reply-plan.js';

export interface ReplyDeliveryDeps {
  config: ResolvedBotConfig;
  logger: Logger;
  send: (out: OutboundMessage) => Promise<void | { status: 'delivered' | 'rejected' | 'unknown'; messageId?: string; error?: string }>;
  typing?: (channelId: string) => Promise<void>;
  chatLog: (
    direction: 'in' | 'out',
    message: MohoMessage,
    content: string,
    outcome: 'received' | 'delivered' | 'delivery_failed' | 'unknown',
    traceId?: string,
  ) => void;
  trace: (
    traceId: string,
    stage: Parameters<ChatTraceStore['addById']>[1],
    detail?: Parameters<ChatTraceStore['addById']>[2],
  ) => void;
}

/** Send a single reply and reconcile its delivery result, chat log and trace. */
export async function deliverReply(
  message: MohoMessage,
  content: string | EmbedCard,
  deps: ReplyDeliveryDeps,
  quote = true,
  mentionAuthor = false,
  traceId?: string,
): Promise<boolean> {
  const embed = typeof content === 'object' ? content : undefined;
  const text = typeof content === 'object' ? '' : content;
  const safeContent = embed && text.length === 0 ? (embed.description ?? '') : text;
  try {
    const delivery = await deps.send({
      channelId: message.channel.id,
      content: safeContent,
      embed,
      replyToId: !quote || message.channel.dm ? undefined : message.id,
      suppressMentions: true,
      mentionUserId: mentionAuthor ? message.author.id : undefined,
    });
    try {
      chatLogInsert({
        channelId: message.channel.id,
        messageId: `outbound:${message.id}:${Date.now()}`,
        authorId: deps.config.id,
        username: deps.config.name,
        content: safeContent,
        mentionsBot: false,
        botId: deps.config.id,
      });
    } catch (error) {
      deps.logger.warn({ err: error instanceof Error ? error.message : String(error), channel: message.channel.id }, 'outbound chat log write failed');
    }
    const status = delivery && typeof delivery === 'object' ? delivery.status : 'delivered';
    deps.chatLog('out', message, safeContent, status === 'delivered' ? 'delivered' : status === 'unknown' ? 'unknown' : 'delivery_failed', traceId);
    if (traceId) {
      deps.trace(
        traceId,
        status === 'delivered' ? 'delivered' : status === 'unknown' ? 'delivery_unknown' : 'delivery_failed',
        delivery && typeof delivery === 'object' && delivery.messageId ? { messageId: delivery.messageId } : undefined,
      );
    }
    return status === 'delivered';
  } catch (error) {
    deps.chatLog('out', message, safeContent, 'delivery_failed', traceId);
    deps.logger.error(
      { err: error instanceof Error ? error.message : String(error), channel: message.channel.id },
      'send failed',
    );
    return false;
  }
}

/** Deliver a decoded ReplyPlan with the original filter, typing and pause policy. */
export async function deliverReplyPlan(
  message: MohoMessage,
  plan: ReplyPlan,
  sendSegment: (message: MohoMessage, content: string, quote: boolean, mentionAuthor: boolean, traceId?: string) => Promise<boolean>,
  deps: Pick<ReplyDeliveryDeps, 'config' | 'typing'>,
  traceId?: string,
): Promise<boolean> {
  let delivered = 0;
  let segments = deliverySegments(plan, message.channel.dm);
  if (deps.config.ai.replyFilter) {
    segments = segments
      .map((segment) => ({ ...segment, text: stripReplyArtifacts(segment.text).display }))
      .filter((segment) => segment.text.trim().length > 0);
    if (segments.length === 0) return false;
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (deps.config.discord.typingIndicator && deps.typing && segment.typingMs > 0) {
      void deps.typing(message.channel.id).catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, segment.typingMs));
    }
    if (await sendSegment(message, segment.text, plan.quote && index === 0, false, traceId)) delivered += 1;
    else break;
    if (segment.pauseAfterMs > 0 && index < segments.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, segment.pauseAfterMs));
    }
  }
  return delivered === segments.length;
}
