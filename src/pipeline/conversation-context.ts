import type { ResolvedBotConfig } from '../config/schema.js';
import type { ChatMessage, MohoMessage } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { SessionKeyInput, SessionManagerLike } from '../session/types.js';
import type { PluginManager } from '../plugins/manager.js';
import type { MediaRuntime } from '../media/runtime.js';
import type { AttachmentPreprocessResult } from '../media/attachments.js';
import type { JargonMemory } from '../memory/jargon-memory.js';
import { buildJargonBlock } from '../memory/jargon-memory.js';
import type { EmotionBridge, PersonaAbBridge, SongBridge } from './bridges.js';
import type { WorldStore } from '../admin/world.js';
import { markUntrusted, formatUntrustedData } from '../security/untrusted-data.js';
import { buildContextAnchor, buildHistorySummaryBlock } from './context-prompts.js';

export interface ConversationContextDeps {
  config: ResolvedBotConfig;
  sessions: Pick<SessionManagerLike, 'append' | 'buildContext' | 'getSummary'>;
  world: Pick<WorldStore, 'context'>;
  logger: Logger;
  media?: Pick<MediaRuntime, 'process'>;
  emotion?: Pick<EmotionBridge, 'buildContextBlock'>;
  songs?: Pick<SongBridge, 'match'>;
  personaAb?: Pick<PersonaAbBridge, 'preference' | 'snapshot'>;
  jargonMemory?: JargonMemory;
  plugins?: Pick<PluginManager, 'runBeforeAI'>;
}

export interface ConversationContextInput {
  message: MohoMessage;
  key: SessionKeyInput;
  prompt: string;
  rawContent: string;
  attachments: AttachmentPreprocessResult;
}

export interface ConversationContextResult {
  messages: ChatMessage[];
  personaText: string;
}

/**
 * Assemble model context without owning message policy or the AI call.
 *
 * Ordering is deliberate: persist the incoming user turn before reading the
 * session window; keep the persona as the first system message; wrap recalled
 * memory and user turns as untrusted data; let plugins mutate only after the
 * complete context is assembled.
 */
export async function buildConversationContext(
  input: ConversationContextInput,
  deps: ConversationContextDeps,
): Promise<ConversationContextResult> {
  const { message, key, prompt, rawContent, attachments } = input;
  const cfg = deps.config;
  const log = deps.logger;

  // Persist the user turn BEFORE building context, so the model sees its own
  // prior replies in the right order (no "echo bot" / repetition bugs).
  try {
    await deps.sessions.append(key, {
      role: 'user',
      content: prompt,
      name: message.author.username,
      sourceMessageId: message.id,
      sourcePlatform: message.platform,
      createdAt: message.createdAt,
    });
  } catch (error) {
    log.warn({ err: String(error) }, 'failed to persist user turn');
  }

  // Build the context window. Failure degrades to an empty context.
  let sessionMessages: ChatMessage[] = [];
  try {
    sessionMessages = await deps.sessions.buildContext(key, cfg.systemPrompt);
  } catch (error) {
    log.warn({ channelId: message.channel.id, error: String(error) }, 'session context build failed; using empty context');
  }

  // Attachment observation remains opt-in; metadata fallback stays in prompt.
  let mediaContext: string | undefined;
  if (cfg.media.enabled && deps.media && attachments.accepted.length > 0) {
    try {
      const observed = await deps.media.process(attachments.accepted, rawContent || undefined);
      if (observed.items.some((item) => item.status === 'observed' || item.status === 'degraded')) {
        mediaContext = observed.context;
      }
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'media observation failed; using attachment metadata');
    }
  }

  // Live time anchor and world state are separate system blocks.
  const [anchor, worldContext] = await Promise.all([
    Promise.resolve(buildContextAnchor()),
    deps.world.context().catch(() => ''),
  ]);

  let emotionBlock: string | undefined;
  if (deps.emotion) {
    try {
      emotionBlock = await deps.emotion.buildContextBlock(message.author.id);
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error), user: message.author.id }, 'emotion block build failed; continuing without it');
    }
  }

  // Song recognition is request-scoped and cannot prevent the reply.
  let songBlock: string | undefined;
  if (deps.songs) {
    try {
      songBlock = await deps.songs.match(prompt);
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'song match failed; continuing without it');
    }
  }

  // Older turns compacted out of the live window are optional context.
  let historySummary: string | undefined;
  try {
    historySummary = await deps.sessions.getSummary?.(key);
  } catch (error) {
    log.warn({ err: error instanceof Error ? error.message : String(error) }, 'history summary lookup failed; continuing without it');
  }

  // A/B switch binding applies only to human DM conversations.
  let personaText = cfg.systemPrompt;
  if (deps.personaAb && message.channel.dm && !message.author.bot) {
    try {
      if ((await deps.personaAb.preference(message.author.id)) === 'test') {
        personaText = (await deps.personaAb.snapshot('test', cfg.systemPrompt, cfg.name)).content;
      }
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error), user: message.author.id }, 'persona-ab preference lookup failed; using live persona');
      personaText = cfg.systemPrompt;
    }
  }

  // Semantic/expression recall is distinct from persona system instructions.
  const isRecalledMemory = (item: ChatMessage): boolean =>
    item.role === 'system' && item.content !== cfg.systemPrompt &&
    (item.content.startsWith('[Recalled ') || item.content.startsWith('[表达风格参考]'));
  const recalledMemories = sessionMessages.filter(isRecalledMemory).map((item) => ({
    ...item,
    content: formatUntrustedData(markUntrusted('memory', item.content)),
  }));

  // User-role turns are untrusted input. The stored history is never mutated.
  const contextTurns = sessionMessages.filter((item) => item.role !== 'system').map((item) => {
    if (item.role === 'user') {
      return { ...item, content: formatUntrustedData(markUntrusted('user', item.content)) };
    }
    return item;
  });

  const jargonBlock = deps.jargonMemory
    ? buildJargonBlock(await deps.jargonMemory.recall(message.channel.id, message.channel.guildId, cfg.jargonMemory.recallLimit))
    : undefined;

  let messages: ChatMessage[] = [
    { role: 'system', content: personaText },
    { role: 'system', content: anchor },
    { role: 'system', content: worldContext },
    ...(jargonBlock ? [{ ...jargonBlock, content: formatUntrustedData(markUntrusted('memory', jargonBlock.content)) }] : []),
    ...(historySummary ? [{ role: 'system' as const, content: buildHistorySummaryBlock(historySummary) }] : []),
    ...recalledMemories,
    ...(mediaContext ? [{ role: 'system' as const, content: mediaContext }] : []),
    ...(emotionBlock ? [{ role: 'system' as const, content: emotionBlock }] : []),
    ...(songBlock ? [{ role: 'system' as const, content: songBlock }] : []),
    ...contextTurns,
  ];

  if (deps.plugins) {
    await deps.plugins.runBeforeAI(message, messages, cfg.disabledPlugins);
  }

  return { messages, personaText };
}
