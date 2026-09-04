import { describe, expect, it } from 'vitest';

import { buildEnvironmentBlock, environmentAt, periodOf, tzOffset } from './perception.js';

describe('periodOf', () => {
  it('maps hours to coarse periods', () => {
    expect(periodOf(3)).toBe('深夜');
    expect(periodOf(8)).toBe('早晨');
    expect(periodOf(11)).toBe('上午');
    expect(periodOf(13)).toBe('中午');
    expect(periodOf(16)).toBe('下午');
    expect(periodOf(19)).toBe('傍晚');
    expect(periodOf(21)).toBe('晚上');
    expect(periodOf(23)).toBe('深夜');
  });
});

describe('environmentAt', () => {
  it('computes a full snapshot for a fixed UTC instant', () => {
    // 2026-09-04 is a Friday.
    const env = environmentAt(new Date('2026-09-04T00:00:00Z'), 'UTC');
    expect(env.date).toBe('2026-09-04');
    expect(env.weekday).toBe('周五');
    expect(env.workday).toBe(true);
    expect(env.hour).toBe(0);
    expect(env.period).toBe('深夜');
    expect(env.tzOffset).toBe('+00:00');
  });

  it('shifts date/hour for a positive offset timezone', () => {
    const env = environmentAt(new Date('2026-09-04T18:00:00Z'), 'Asia/Shanghai');
    expect(env.date).toBe('2026-09-05');
    expect(env.hour).toBe(2);
    expect(env.tzOffset).toBe('+08:00');
  });

  it('detects holidays', () => {
    const env = environmentAt(new Date('2026-12-25T12:00:00Z'), 'UTC');
    expect(env.holiday).toContain('圣诞节');
  });
});

describe('tzOffset', () => {
  it('returns a signed offset', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(tzOffset(now, 'Asia/Shanghai')).toBe('+08:00');
    expect(tzOffset(now, 'America/New_York')).toBe('-05:00');
  });
});

describe('buildEnvironmentBlock', () => {
  it('renders a system context block', () => {
    const env = environmentAt(new Date('2026-09-04T12:00:00Z'), 'UTC');
    const block = buildEnvironmentBlock(env, { dm: false, name: '测试频道' });
    expect(block).toContain('[环境感知');
    expect(block).toContain('2026-09-04');
    expect(block).toContain('工作日');
    expect(block).toContain('测试频道');
  });
});
