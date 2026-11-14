import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Boxes, Download, RefreshCw, Radio, ScrollText, Search } from 'lucide-react';
import { api, hasPermission } from '../lib/api';
import type { LogRecord, PageProps } from '../lib/types';
import { useAsync, useDebouncedValue, useFiltered, useHashParam, usePolling, useToggle } from '../lib/hooks';
import { formatNumber, formatPercent, formatRelative, formatTime, levelTone } from '../lib/format';
import { Button, DataState, EmptyState, Notice, PageTitle, Panel, Pill, Select, StatCard, Switch, Table, Tabs, TextInput } from '../components/ui';

/**
 * 实时日志（OBSERVABILITY）。
 *
 * 读取受权限保护的只读日志窗口 `GET /api/logs`（唯一接口，无写操作）：
 * - 客户端筛选（级别标签、关键词搜索）在已加载的窗口内即时生效；
 * - 服务端筛选（`level` / `component`）会重新拉取窗口；
 * - 可选每 5 秒以 `after` 游标增量拉取新记录，`gap=true` 表示缓冲区轮转、
 *   存在缺失，此时整窗重载并给出提示。
 *
 * 页面不产生任何写操作，因此不涉及 confirmedRequest。
 */

const LOG_LIMIT = 500;
const TAIL_INTERVAL_MS = 5000;

const LEVEL_OPTIONS = ['all', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
type LevelFilter = (typeof LEVEL_OPTIONS)[number];
const LEVEL_LABELS: Record<LevelFilter, string> = {
  all: '全部',
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
};
const SERVER_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

interface LogsPayload {
  items?: LogRecord[];
  oldestSeq?: number;
  latestSeq?: number;
  nextSeq?: number;
  gap?: boolean;
}

interface LogsResponse {
  logs?: LogsPayload;
  items?: LogRecord[];
}

interface LogPage {
  items: LogRecord[];
  oldestSeq?: number;
  latestSeq?: number;
  nextSeq?: number;
  gap: boolean;
}

/** One normalised log row: every accessor resolved once for filtering + rendering. */
interface LogRowView {
  key: string;
  raw: LogRecord;
  seq: number;
  time: unknown;
  level: string;
  tone: ReturnType<typeof levelTone>;
  component: string;
  message: string;
}

function asLevelFilter(value: string): LevelFilter {
  return (LEVEL_OPTIONS as readonly string[]).includes(value) ? (value as LevelFilter) : 'all';
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Accepts both `{ logs: { items } }` and a bare `{ items }` envelope. */
function parseLogs(result: LogsResponse): LogPage {
  const payload: LogsPayload | undefined = result.logs ?? (Array.isArray(result.items) ? { items: result.items } : undefined);
  const raw = payload?.items;
  return {
    items: Array.isArray(raw) ? raw : [],
    oldestSeq: numberOrUndefined(payload?.oldestSeq),
    latestSeq: numberOrUndefined(payload?.latestSeq),
    nextSeq: numberOrUndefined(payload?.nextSeq),
    gap: payload?.gap === true,
  };
}

function rowLevel(row: LogRecord): string {
  return typeof row.level === 'string' && row.level ? row.level : 'info';
}

function rowComponent(row: LogRecord): string {
  return typeof row.component === 'string' && row.component.trim() ? row.component : 'core';
}

function rowMessage(row: LogRecord): string {
  const value = row.message ?? row.msg;
  if (typeof value === 'string') return value;
  return value === undefined || value === null ? '' : String(value);
}

function rowTime(row: LogRecord): unknown {
  return row.time ?? row.ts ?? row.at;
}

function rowSeq(row: LogRecord): number {
  const value = row.seq ?? row.id;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return -1;
}

/** Resolves every field a row needs exactly once, so the table never re-derives them. */
function toRowView(row: LogRecord, index: number): LogRowView {
  const level = rowLevel(row);
  return {
    key: `${rowSeq(row)}:${index}`,
    raw: row,
    seq: rowSeq(row),
    time: rowTime(row),
    level,
    tone: levelTone(level),
    component: rowComponent(row),
    message: rowMessage(row) || '—',
  };
}

function logsQuery(input: { limit: number; level: string; component: string; after?: number }): string {
  const params = new URLSearchParams();
  params.set('limit', String(input.limit));
  if (input.level) params.set('level', input.level);
  const component = input.component.trim();
  if (component) params.set('component', component);
  if (typeof input.after === 'number' && input.after > 0) params.set('after', String(input.after));
  return params.toString();
}

function mergeLogs(current: LogPage, incoming: LogPage): LogPage {
  const seen = new Set(current.items.map((row) => rowSeq(row)));
  const added = incoming.items.filter((row) => !seen.has(rowSeq(row)));
  return {
    ...current,
    items: [...current.items, ...added],
    latestSeq: incoming.latestSeq ?? current.latestSeq,
    nextSeq: incoming.nextSeq ?? current.nextSeq,
    gap: false,
  };
}

function errorText(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'string' && cause) return cause;
  return '实时增量拉取失败';
}

function downloadNdjson(rows: LogRecord[]): void {
  if (rows.length === 0) return;
  if (typeof URL.createObjectURL !== 'function') return;
  const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const blob = new Blob([text], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `mohobot-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function Logs({ permissions }: PageProps) {
  const [levelParam, setLevelParam] = useHashParam('level', 'all');
  const level = asLevelFilter(levelParam);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);
  const [serverLevel, setServerLevel] = useState('');
  const [serverComponent, setServerComponent] = useState('');
  const debouncedComponent = useDebouncedValue(serverComponent, 250);
  const [tail, setTail] = useToggle(false);
  const [tailError, setTailError] = useState('');

  const state = useAsync<LogPage>(
    () => api<LogsResponse>(`/logs?${logsQuery({ limit: LOG_LIMIT, level: serverLevel, component: debouncedComponent })}`).then(parseLogs),
    [serverLevel, debouncedComponent],
    '读取日志失败',
  );
  const reload = useCallback(() => state.reload(), [state]);

  const loaded = state.data;
  const allItems = useMemo(() => loaded?.items ?? [], [loaded]);
  /** Ascending buffer window (server order), resolved once into render-ready rows. */
  const views = useMemo(() => allItems.map((row, index) => toRowView(row, index)), [allItems]);

  const searchFields = useCallback((row: LogRowView) => [row.level, row.component, row.message], []);
  const searched = useFiltered(views, debouncedQuery, searchFields);
  const filtered = useMemo(
    () => (level === 'all' ? searched : searched.filter((row) => row.level.toLowerCase() === level)),
    [searched, level],
  );
  /* Newest first: the server window is ascending by sequence. */
  const rows = useMemo(() => [...filtered].reverse(), [filtered]);

  const stats = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    const components = new Set<string>();
    for (const row of views) {
      const value = row.level.toLowerCase();
      if (value === 'error' || value === 'fatal') errors += 1;
      else if (value === 'warn' || value === 'warning') warnings += 1;
      components.add(row.component);
    }
    return { total: views.length, errors, warnings, components: components.size };
  }, [views]);

  const levelCounts = useMemo(() => {
    const counts: Record<string, number> = { all: views.length };
    for (const row of views) {
      const value = row.level.toLowerCase();
      counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
  }, [views]);

  const tailPoll = useCallback(() => {
    const current = state.data;
    if (!current) { state.reload(); return; }
    const after = current.items.reduce((max, row) => Math.max(max, rowSeq(row)), 0);
    if (after <= 0) { state.reload(); return; }
    void api<LogsResponse>(`/logs?${logsQuery({ limit: LOG_LIMIT, level: serverLevel, component: debouncedComponent, after })}`)
      .then((result) => {
        setTailError('');
        const page = parseLogs(result);
        if (page.gap) { state.reload(); return; }
        if (page.items.length === 0) return;
        state.setData(mergeLogs(current, page));
      })
      .catch((cause: unknown) => { setTailError(errorText(cause)); });
  }, [state, serverLevel, debouncedComponent]);
  usePolling(tailPoll, TAIL_INTERVAL_MS, tail);

  /* The partial-failure banner only applies while streaming is on. */
  useEffect(() => { if (!tail) setTailError(''); }, [tail]);

  const exportRows = useCallback(() => downloadNdjson(filtered.map((row) => row.raw)), [filtered]);

  const clearFilters = useCallback(() => {
    setQuery('');
    setServerComponent('');
    setServerLevel('');
    setLevelParam('all');
  }, [setLevelParam]);

  const canRead = hasPermission(permissions, 'logs.read');
  const tabOptions = LEVEL_OPTIONS.map((value) => ({
    value,
    label: LEVEL_LABELS[value],
    count: loaded ? (levelCounts[value] ?? 0) : undefined,
  }));

  const newestTime = views.at(-1)?.time;
  const atLimit = allItems.length >= LOG_LIMIT;
  const activeFilters = [
    level === 'all' ? '' : `级别 ${level}`,
    debouncedQuery.trim() ? `关键词「${debouncedQuery.trim()}」` : '',
    serverLevel ? `服务端级别 ${serverLevel}` : '',
    debouncedComponent.trim() ? `服务端组件 ${debouncedComponent.trim()}` : '',
  ].filter(Boolean);
  const filterHint = activeFilters.length
    ? `当前筛选：${activeFilters.join(' · ')}。清除筛选可恢复完整窗口。`
    : '日志缓冲区为空，或服务端返回的窗口没有记录。';

  return (
    <>
      <PageTitle
        eyebrow="OBSERVABILITY"
        title="实时日志"
        description="读取运行时的结构化日志窗口。级别标签与关键词在本地即时筛选，服务端筛选会重新拉取窗口，可导出为 NDJSON。"
        actions={<>
          {tail ? <Pill tone="success"><Radio size={12} /> 实时</Pill> : <Pill tone="neutral">已暂停</Pill>}
          <Switch checked={tail} onChange={(next) => setTail(next)} label="实时刷新" />
          <Button onClick={reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>
        </>}
      />

      {!canRead && (
        <Notice tone="warning" icon={<AlertTriangle size={17} />}>
          当前账号缺少 logs.read 权限，日志接口可能返回 403。
        </Notice>
      )}

      <div className="toolbar">
        <Tabs value={level} options={tabOptions} onChange={setLevelParam} ariaLabel="日志级别过滤" />
        <div className="grow search-field">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索级别 / 组件 / 消息"
            aria-label="搜索日志"
          />
        </div>
        <Button onClick={exportRows} disabled={filtered.length === 0} title="导出当前筛选结果（NDJSON）">
          <Download size={15} /> 导出 NDJSON
        </Button>
      </div>

      <div className="filter-row">
        <span className="muted-text">服务端过滤（重新拉取窗口）</span>
        <Select aria-label="服务端级别" value={serverLevel} onChange={(event) => setServerLevel(event.target.value)}>
          <option value="">服务端级别：全部</option>
          {SERVER_LEVELS.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
        <TextInput
          aria-label="服务端组件"
          placeholder="服务端组件，如 runtime"
          value={serverComponent}
          onChange={(event) => setServerComponent(event.target.value)}
        />
        {activeFilters.length > 0 && (
          <Button variant="ghost" onClick={clearFilters}>清除筛选</Button>
        )}
      </div>

      <DataState
        loading={state.loading && !loaded}
        error={state.error}
        empty={allItems.length === 0}
        emptyTitle="暂无日志"
        emptyDetail="日志缓冲区为空，或服务端返回的窗口没有记录。"
        onRetry={reload}
      >
        <div className="stat-grid">
          <StatCard label="窗口内日志" value={formatNumber(stats.total)} note={`读取上限 ${formatNumber(LOG_LIMIT)} 条`} icon={<ScrollText size={17} />} />
          <StatCard
            label="错误"
            value={formatNumber(stats.errors)}
            note={stats.total > 0 ? `error / fatal · ${formatPercent(stats.errors / stats.total)}` : 'error / fatal'}
            icon={<AlertTriangle size={17} />}
            tone={stats.errors > 0 ? 'danger' : undefined}
          />
          <StatCard
            label="警告"
            value={formatNumber(stats.warnings)}
            note={stats.total > 0 ? `warn · ${formatPercent(stats.warnings / stats.total)}` : 'warn'}
            icon={<AlertCircle size={17} />}
            tone={stats.warnings > 0 ? 'warning' : undefined}
          />
          <StatCard label="组件数" value={formatNumber(stats.components)} note="窗口内唯一组件" icon={<Boxes size={17} />} />
        </div>

        {loaded?.gap && (
          <Notice tone="warning" icon={<AlertTriangle size={17} />}>
            日志缓冲区已发生轮转，部分历史记录可能缺失。
          </Notice>
        )}

        {tailError && (
          <Notice tone="warning" icon={<AlertTriangle size={17} />}>
            实时增量拉取失败，当前显示的是上次成功的数据：{tailError}
          </Notice>
        )}

        <Panel
          title="日志流"
          description={`显示 ${filtered.length} / ${allItems.length} 条${tail ? '，实时刷新中' : ''}`}
          action={
            <div className="panel-actions">
              {loaded && loaded.oldestSeq !== undefined && loaded.latestSeq !== undefined && (
                <Pill tone="neutral">序号 {loaded.oldestSeq}–{loaded.latestSeq}</Pill>
              )}
              {atLimit && <Pill tone="warning">已达读取上限</Pill>}
              {newestTime !== undefined && <span className="muted-text">最新 {formatRelative(newestTime)}</span>}
            </div>
          }
          flush
        >
          {rows.length === 0 ? (
            <EmptyState
              title="没有匹配的日志"
              detail={filterHint}
              action={<Button variant="ghost" onClick={clearFilters}>清除筛选</Button>}
            />
          ) : (
            <Table minWidth={920}>
              <thead><tr><th>序号</th><th>时间</th><th>级别</th><th>组件</th><th>消息</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td className="mono muted-text nowrap">{row.seq >= 0 ? row.seq : '—'}</td>
                    <td className="mono nowrap">{formatTime(row.time)}</td>
                    <td><Pill tone={row.tone}>{row.level}</Pill></td>
                    <td className="mono">{row.component}</td>
                    <td className="log-message">{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </DataState>
    </>
  );
}
