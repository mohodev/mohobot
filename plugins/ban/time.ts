/**
 * Duration parsing for the ban plugin.
 *
 * Mirrors the upstream carefreesongs712/mohobot format: `1d` `2h` `30m` `10s`,
 * freely combinable (`1d2h`, `30m10s`). A missing duration means "permanent".
 */

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

export interface ParsedDuration {
  /** Epoch ms when the ban expires; undefined = permanent. */
  until?: number;
}

/**
 * Parse a duration string into an expiry timestamp. Returns `{ until: undefined }`
 * for empty/blank input (permanent). Throws on a malformed duration.
 */
export function parseDuration(input: string, now = Date.now()): ParsedDuration {
  const text = input.trim();
  if (text.length === 0) return {};
  const match = text.match(/^(\d+[smhd])+$/);
  if (!match) throw new Error(`invalid duration: ${JSON.stringify(input)} (expected like 1d, 2h30m, 10s)`);

  let total = 0;
  for (const part of text.match(/\d+[smhd]/g) ?? []) {
    const value = Number(part.slice(0, -1));
    const unit = part.slice(-1);
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid duration part: ${part}`);
    total += value * (UNIT_MS[unit] ?? 0);
  }
  if (total <= 0) throw new Error(`invalid duration: ${JSON.stringify(input)}`);
  return { until: now + total };
}

/** Human readable remaining time, or `permanent`. */
export function describeUntil(until: number | undefined, now = Date.now()): string {
  if (until === undefined) return 'permanent';
  const ms = until - now;
  if (ms <= 0) return 'expired';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}
