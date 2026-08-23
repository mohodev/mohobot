export type ReplyAction = 'ignore' | 'reply';
export type ReplyStyle = 'short' | 'chat' | 'structured' | 'comfort' | 'technical';

export interface ReplyPlan {
  action: ReplyAction;
  style: ReplyStyle;
  /** Whether the first outbound message should quote the triggering message. */
  quote: boolean;
  segments: Array<{ text: string; pauseAfterMs?: number }>;
}

export interface DeliverySegment { text: string; pauseAfterMs: number; typingMs: number; }

const MAX_SEGMENTS = 6;
const MAX_DELAY_MS = 4_000;
const MAX_TYPING_MS = 8_000;

/**
 * Decode optional fenced `reply-plan` JSON. Plain model output stays valid so
 * existing prompts/providers keep working. Malformed control data is never
 * exposed; it safely degrades to a normal one-segment reply.
 */
export function decodeReplyPlan(input: string): ReplyPlan {
  const trimmed = input.trim();
  const match = trimmed.match(/^```(?:reply-plan|json)?\s*\n([\s\S]*?)\n```$/i);
  if (!match) return { action: 'reply', style: 'chat', quote: true, segments: [{ text: trimmed }] };
  try {
    const raw = JSON.parse(match[1]!) as { action?: unknown; style?: unknown; quote?: unknown; segments?: unknown };
    if (raw.action === 'ignore') return { action: 'ignore', style: 'chat', quote: false, segments: [] };
    if (!Array.isArray(raw.segments)) throw new Error('segments missing');
    const segments = raw.segments.slice(0, MAX_SEGMENTS).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as { text?: unknown; pauseAfterMs?: unknown };
      const text = typeof value.text === 'string' ? value.text.trim() : '';
      if (!text) return [];
      return [{ text, pauseAfterMs: typeof value.pauseAfterMs === 'number' ? Math.max(0, Math.min(MAX_DELAY_MS, Math.floor(value.pauseAfterMs))) : undefined }];
    });
    if (segments.length === 0) throw new Error('empty segments');
    const style: ReplyStyle = ['short', 'chat', 'structured', 'comfort', 'technical'].includes(String(raw.style)) ? raw.style as ReplyStyle : 'chat';
    return { action: 'reply', style, quote: raw.quote !== false, segments };
  } catch {
    return { action: 'reply', style: 'chat', quote: true, segments: [{ text: trimmed }] };
  }
}

/** Local delivery policy: no model call and no fake "thinking" for tiny replies. */
export function deliverySegments(plan: ReplyPlan, isDM: boolean): DeliverySegment[] {
  const charsPerSecond = plan.style === 'technical' ? 12 : plan.style === 'short' ? 20 : 9;
  const baseDelay = isDM ? 220 : 120;
  return plan.segments.map((segment) => ({
    text: segment.text,
    pauseAfterMs: segment.pauseAfterMs ?? (isDM && plan.segments.length > 1 ? 280 : 0),
    typingMs: Math.min(MAX_TYPING_MS, Math.max(0, Math.round(baseDelay + (segment.text.length / charsPerSecond) * 1000))),
  }));
}

export function planText(plan: ReplyPlan): string { return plan.segments.map((segment) => segment.text).join('\n'); }
