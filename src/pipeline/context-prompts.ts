/**
 * System-injected time and rolling-summary blocks used by the model context.
 * Kept outside MessagePipeline so prompt formatting can be reviewed/tested
 * without constructing a Runtime.
 */

export function buildContextAnchor(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const date = `${get('year')}年${get('month')}${get('day')}日`;
  const weekday = get('weekday');
  const time = `${get('hour')}:${get('minute')}`;
  return [
    '[上下文锚点 - 系统注入，非用户发言]',
    `当前时间：${date} ${weekday} ${time}（北京时间 UTC+8）`,
    '你不知道确切时间，除非用户明确告知或本锚点提供。涉及时间请以上述为准，不要臆测日期或时刻。',
    '对话历史已按时间顺序提供，请基于上下文连贯回应，记得用户刚才说过的内容。',
  ].join('\n');
}

/** Wrap a rolling summary so the model reads it as memory, not as a speaker. */
export function buildHistorySummaryBlock(summary: string): string {
  return [
    '[历史对话摘要 - 系统注入，非用户发言]',
    '以下是更早之前对话的压缩记忆，其后的消息才是最近的原始对话。请把它当作已知背景自然地衔接，不要逐字复述，也不要把它当成用户刚说的话。',
    summary.trim(),
  ].join('\n');
}
