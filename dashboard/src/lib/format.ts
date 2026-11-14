/**
 * Shared formatting helpers for the dashboard.
 *
 * Frozen shared contract: pages may import from this module, but only additive
 * changes are allowed here (never rename or remove an export).
 */

/** Locale-aware timestamp; falls back to an em dash for empty/invalid input. */
export function formatDateTime(value: unknown): string {
  const date = toDate(value);
  return date ? date.toLocaleString() : '—';
}

/** Time only (HH:mm:ss) — used by log/event views. */
export function formatTime(value: unknown): string {
  const date = toDate(value);
  return date ? date.toLocaleTimeString() : '—';
}

/**
 * Human-friendly relative time in Chinese, e.g. "3 分钟前". Returns "刚刚" for
 * sub-minute deltas and "—" when the input cannot be interpreted.
 */
export function formatRelative(value: unknown, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return '—';
  const delta = now - date.getTime();
  const future = delta < 0;
  const seconds = Math.round(Math.abs(delta) / 1000);
  if (seconds < 45) return future ? '即将' : '刚刚';
  const units: Array<[number, string]> = [[60, '秒'], [60, '分钟'], [24, '小时'], [30, '天'], [12, '个月']];
  let amount = seconds;
  let unit = '秒';
  for (const [step, label] of units) {
    if (amount < step) { unit = label; break; }
    amount = amount / step;
    unit = label;
  }
  const rounded = Math.max(1, Math.round(amount));
  if (unit === '秒') { unit = '分钟'; return future ? `约 ${1} 分钟前` : '刚刚'; }
  return `${future ? '约 ' : ''}${rounded} ${unit}前`;
}

/** Formats a duration in milliseconds as "1.2 s", "3 分 05 秒", or "2 小时 10 分". */
export function formatDuration(ms: unknown): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} 分 ${String(restSeconds).padStart(2, '0')} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/** Compact integer formatting with thousands separators; "—" for non-numbers. */
export function formatNumber(value: unknown, maximumFractionDigits = 0): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('zh-CN', { maximumFractionDigits });
}

/** Byte size formatting (KiB/MiB/GiB). */
export function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[index]}`;
}

/** Percentage from a 0..1 ratio, guarding NaN. */
export function formatPercent(ratio: unknown, digits = 0): string {
  const num = Number(ratio);
  if (!Number.isFinite(num)) return '—';
  return `${(num * 100).toFixed(digits)}%`;
}

/** Shortens long ids while keeping their head and tail recognizable. */
export function truncateMiddle(value: unknown, max = 32): string {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** Pretty-prints any value as JSON, never throwing. */
export function prettyJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? 'null'; } catch { return String(value); }
}

/** Parses a JSON object from a textarea, returning a discriminated result. */
export function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return { ok: false, error: '参数必须是有效 JSON。' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: '参数必须是 JSON 对象。' };
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Lowercases a level and maps it to a pill tone for log/audit rows. */
export function levelTone(level: unknown): 'danger' | 'warning' | 'info' | 'neutral' {
  const value = String(level ?? '').toLowerCase();
  if (value === 'error' || value === 'fatal' || value === 'denied') return 'danger';
  if (value === 'warn' || value === 'warning') return 'warning';
  if (value === 'info' || value === 'allowed') return 'info';
  return 'neutral';
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    const date = Number.isFinite(numeric) && /^\d+$/.test(value.trim()) ? new Date(numeric) : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}
