import type { AbVote } from './persona-ab.js';

/** Chinese aliases for admin commands; handlers use the English keys. */
export const ADMIN_COMMAND_ALIASES: Record<string, string> = {
  '好感度': 'favor',
  '关系阶段': 'stage',
  '好感排行': 'favor-rank',
  '设好感': 'set-favor',
  '设亲密': 'set-intimacy',
  '用量': 'usage',
  '广播': 'broadcast',
  '广播预告': 'broadcast',
  '广播确认': 'broadcast-confirm',
  '广播取消': 'broadcast-cancel',
  '同步歌曲': 'songsync',
};

/** Normalize an A/B vote token; non-vote input returns null. */
export function normalizeAbVote(token: string): AbVote | null {
  const text = token.trim();
  if (text === 'A' || text === 'a') return 'A';
  if (text === 'B' || text === 'b') return 'B';
  if (text === '平局' || text === '都不好' || text === '跳过') return text;
  return null;
}
