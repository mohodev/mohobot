/**
 * Environment perception helpers.
 *
 * Foreign replacement for the upstream perception plugin: it keeps the generic
 * parts (time-of-day period, weekday/workday, holiday awareness, channel
 * context) and drops the China-specific parts (lunar calendar, 二十四节气 and
 * the Chinese working-day/调休 table). All logic is local and dependency-free.
 */

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** month-day -> international holiday, kept deliberately small and Western/global. */
export const HOLIDAYS: Record<string, string> = {
  '01-01': '元旦 New Year',
  '02-14': '情人节 Valentine’s Day',
  '03-17': '圣帕特里克节 St. Patrick’s Day',
  '04-22': '世界地球日 Earth Day',
  '10-31': '万圣节 Halloween',
  '12-24': '平安夜 Christmas Eve',
  '12-25': '圣诞节 Christmas',
  '12-31': '跨年夜 New Year’s Eve',
};

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Coarse period-of-day label from a local hour. */
export function periodOf(hour: number): string {
  if (hour < 5) return '深夜';
  if (hour < 9) return '早晨';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 20) return '傍晚';
  if (hour < 23) return '晚上';
  return '深夜';
}

/** "+08:00" style offset for a timezone at the given instant. */
export function tzOffset(now: Date, timeZone: string): string {
  const probe = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
  const value = probe.formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const match = value.match(/([+-]\d{2}:\d{2})/);
  return match?.[1] ?? '+00:00';
}

export interface Environment {
  /** YYYY-MM-DD in the configured timezone. */
  date: string;
  weekday: string;
  hour: number;
  minute: number;
  period: string;
  workday: boolean;
  holiday?: string;
  tzOffset: string;
}

/** Compute the environment snapshot for a timezone, dependency-free. */
export function environmentAt(now: Date, timeZone: string): Environment {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  // The weekday of a YYYY-MM-DD calendar date is timezone-independent.
  const iso = new Date(`${date}T00:00:00Z`).getUTCDay();
  const weekday = WEEKDAYS[iso] ?? '';

  return {
    date,
    weekday,
    hour,
    minute,
    period: periodOf(hour),
    workday: iso >= 1 && iso <= 5,
    holiday: HOLIDAYS[`${get('month')}-${get('day')}`],
    tzOffset: tzOffset(now, timeZone),
  };
}

/** Build the system block injected before the AI call. */
export function buildEnvironmentBlock(env: Environment, channel: { dm: boolean; name?: string }): string {
  const lines = [
    '[环境感知 - 系统注入，非用户发言]',
    `今天是 ${env.date} ${env.weekday}，${env.period}（本地时间 ${pad2(env.hour)}:${pad2(env.minute)}，UTC${env.tzOffset}）`,
    env.workday ? '今天是工作日。' : '今天是周末。',
  ];
  if (env.holiday) lines.push(`今天是节日：${env.holiday}。`);
  lines.push(channel.dm ? '当前是私聊。' : `当前是群聊${channel.name ? `（${channel.name}）` : ''}。`);
  lines.push('以上环境信息仅用于感知当前时间与场景，请不要过度演绎。');
  return lines.join('\n');
}
