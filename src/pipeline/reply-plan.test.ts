import { describe, expect, it } from 'vitest';
import { decodeReplyPlan, deliverySegments, planText } from './reply-plan.js';

describe('ReplyPlan decoder', () => {
  it('keeps ordinary model text backward compatible', () => {
    expect(decodeReplyPlan('hello')).toEqual({ action: 'reply', style: 'chat', quote: false, segments: [{ text: 'hello' }] });
  });
  it('decodes bounded segments and suppresses an explicit ignore', () => {
    const plan = decodeReplyPlan('```reply-plan\n{"action":"reply","style":"comfort","segments":[{"text":"我在。","pauseAfterMs":99999},{"text":"慢慢说。"}]}\n```');
    expect(plan.style).toBe('comfort');
    expect(plan.quote).toBe(false);
    expect(plan.segments[0]?.pauseAfterMs).toBe(4000);
    expect(planText(plan)).toBe('我在。\n慢慢说。');
    expect(decodeReplyPlan('```json\n{"action":"ignore","segments":[]}\n```').action).toBe('ignore');
  });
  it('calculates local typing and DM split pacing without an API call', () => {
    const plan = decodeReplyPlan('```reply-plan\n{"style":"chat","quote":true,"segments":[{"text":"第一句"},{"text":"第二句"}]}\n```');
    const delivery = deliverySegments(plan, true);
    expect(delivery[0]?.typingMs).toBeGreaterThan(0);
    expect(delivery[0]?.pauseAfterMs).toBe(280);
    expect(delivery[1]?.pauseAfterMs).toBe(280);
    expect(plan.quote).toBe(true);
  });
  it('fails closed to plain text on malformed structured output', () => {
    expect(decodeReplyPlan('```json\nnot JSON\n```').segments[0]?.text).toContain('not JSON');
  });
});
