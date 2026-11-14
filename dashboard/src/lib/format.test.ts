import { describe, expect, it } from 'vitest';
import {
  formatDateTime, formatTime, formatRelative, formatDuration, formatNumber,
  formatBytes, formatPercent, truncateMiddle, prettyJson, parseJsonObject, levelTone,
} from './format';

describe('format helpers', () => {
  it('formats and guards dates', () => {
    expect(formatDateTime('')).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatTime(0)).not.toBe('—');
  });

  it('renders relative time in Chinese', () => {
    const now = Date.now();
    expect(formatRelative(now, now)).toBe('刚刚');
    expect(formatRelative(now - 3 * 60_000, now)).toBe('3 分钟前');
    expect(formatRelative(undefined)).toBe('—');
  });

  it('formats durations across scales', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(250)).toBe('250 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(65_000)).toBe('1 分 05 秒');
    expect(formatDuration(3_900_000)).toBe('1 小时 5 分');
  });

  it('formats numbers, bytes and percentages', () => {
    expect(formatNumber('nope')).toBe('—');
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(-5)).toBe('—');
    expect(formatPercent(0.256, 1)).toBe('25.6%');
    expect(formatPercent('x')).toBe('—');
  });

  it('truncates middle and pretty prints json', () => {
    expect(truncateMiddle('short')).toBe('short');
    expect(truncateMiddle('abcdefghijklmnopqrstuvwxyz', 10)).toHaveLength(10);
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => prettyJson(circular)).not.toThrow();
  });

  it('parses JSON objects with validation', () => {
    expect(parseJsonObject('')).toEqual({ ok: true, value: {} });
    expect(parseJsonObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonObject('[')).toMatchObject({ ok: false });
    expect(parseJsonObject('[1,2]')).toMatchObject({ ok: false, error: '参数必须是 JSON 对象。' });
  });

  it('maps levels to tones', () => {
    expect(levelTone('error')).toBe('danger');
    expect(levelTone('denied')).toBe('danger');
    expect(levelTone('warn')).toBe('warning');
    expect(levelTone('info')).toBe('info');
    expect(levelTone(undefined)).toBe('neutral');
  });
});
