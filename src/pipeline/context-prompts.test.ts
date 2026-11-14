import { describe, expect, it } from 'vitest';
import { buildContextAnchor, buildHistorySummaryBlock } from './context-prompts.js';

describe('pipeline context prompt helpers', () => {
  it('adds a bounded Beijing time anchor with explicit trust wording', () => {
    const block = buildContextAnchor();
    expect(block).toContain('[上下文锚点 - 系统注入，非用户发言]');
    expect(block).toContain('北京时间 UTC+8');
    expect(block).toContain('不要臆测日期或时刻');
  });

  it('wraps rolling summaries as historical memory rather than a new user turn', () => {
    const block = buildHistorySummaryBlock('  用户喜欢蓝色。  ');
    expect(block).toContain('[历史对话摘要 - 系统注入，非用户发言]');
    expect(block).toContain('用户喜欢蓝色。');
    expect(block).not.toContain('  用户喜欢蓝色。  ');
  });
});
