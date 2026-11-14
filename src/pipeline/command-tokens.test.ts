import { describe, expect, it } from 'vitest';
import { ADMIN_COMMAND_ALIASES, normalizeAbVote } from './command-tokens.js';

describe('pipeline command token helpers', () => {
  it('maps supported Chinese administration aliases to stable command IDs', () => {
    expect(ADMIN_COMMAND_ALIASES['好感度']).toBe('favor');
    expect(ADMIN_COMMAND_ALIASES['关系阶段']).toBe('stage');
    expect(ADMIN_COMMAND_ALIASES['广播确认']).toBe('broadcast-confirm');
    expect(ADMIN_COMMAND_ALIASES['同步歌曲']).toBe('songsync');
    expect(ADMIN_COMMAND_ALIASES['未知']).toBeUndefined();
  });

  it('normalizes A/B votes and accepted abstention tokens', () => {
    expect(normalizeAbVote(' A ')).toBe('A');
    expect(normalizeAbVote('b')).toBe('B');
    expect(normalizeAbVote('平局')).toBe('平局');
    expect(normalizeAbVote('都不好')).toBe('都不好');
    expect(normalizeAbVote('跳过')).toBe('跳过');
    expect(normalizeAbVote('maybe')).toBeNull();
  });
});
