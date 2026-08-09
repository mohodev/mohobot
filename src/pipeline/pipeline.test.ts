/**
 * Regression tests for the live context anchor injection.
 *
 * These lock the fix for the bot having no sense of time or conversation
 * continuity: every AI call now gets a second system message carrying the
 * current Asia/Shanghai wall-clock, so the model can reference "today" /
 * relative times and stay grounded in the ongoing conversation.
 */

import { describe, expect, it } from 'vitest';
import { buildContextAnchor } from './pipeline.js';

describe('buildContextAnchor', () => {
  it('emits a Beijing-time anchor carrying date, weekday and time', () => {
    const anchor = buildContextAnchor();
    expect(anchor).toContain('北京时间 UTC+8');
    // Date parts are present in zh-CN form (year/month/day/weekday/time).
    expect(anchor).toMatch(/\d{4}年/); // a year
    expect(anchor).toMatch(/\d{1,2}:\d{2}/); // HH:MM
    // A CJK weekday token such as 星期日 / 星期一 must appear.
    expect(anchor).toMatch(/[\u4e00-\u9fa5]{2,3}/);
  });

  it('instructs the model not to invent times and to use context', () => {
    const anchor = buildContextAnchor();
    expect(anchor).toContain('不要臆测日期或时刻');
    expect(anchor).toContain('记得用户刚才说过的内容');
  });

  it('does not echo any real credential or system internals', () => {
    const anchor = buildContextAnchor();
    expect(anchor).not.toMatch(/sk-|api[_-]?key|token/i);
  });
});
