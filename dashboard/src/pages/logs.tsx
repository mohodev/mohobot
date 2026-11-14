import { useCallback, useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Boxes, Download, RefreshCw, Radio, ScrollText, Search } from 'lucide-react';
import { api, hasPermission } from '../lib/api';
import type { LogRecord, PageProps } from '../lib/types';
import { useAsync, useDebouncedValue, useFiltered, useHashParam, usePolling, useToggle } from '../lib/hooks';
import { formatNumber, formatTime, levelTone } from '../lib/format';
import { Button, DataState, Notice, PageTitle, Panel, Pill, Select, StatCard, Switch, Table, Tabs, TextInput } from '../components/ui';

/**
 * 实时日志（OBSERVABILITY）。
 *
 * 读取受权限保护的只读日志窗口 `GET /api/logs`，在客户端按级别与关键词
 * 过滤，并可选地每 5 秒增量拉取新记录（`after` 游标）。页面不产生任何写操作。
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

  const state = useAsync<LogPage>(
    () => api<LogsResponse>(`/logs?${logsQuery({ limit: LOG_LIMIT, level: serverLevel, component: debouncedComponent })}`).then(parseLogs),
    [serverLevel, debouncedComponent],
    '读取日志失败',
  );
  const reload = useCallback(() => state.reload(), [state]);

  const loaded = state.data;
  const allItems = useMemo(() => loaded?.items ?? [], [loaded]);

  const searchFields = useCallback((row: LogRecord) => [rowLevel(row), rowComponent(row), rowMessage(row)], []);
  const searched = useFiltered(allItems, debouncedQuery, searchFields);
  const filtered = useMemo(
    () => (level === 'all' ? searched : searched.filter((row) => rowLevel(row).toLowerCase() === level)),
    [searched, level],
  );
  /* Newest first: the server window is ascending by sequence. */
  const rows = useMemo(() => [...filtered].reverse(), [filtered]);

  const stats = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    const components = new Set<string>();
    for (const row of allItems) {
      const value = rowLevel(row).toLowerCase();
      if (value === 'error' || value === 'fatal') errors += 1;
      else if (value === 'warn' || value === 'warning') warnings += 1;
      components.add(rowComponent(row));
    }
    return { total: allItems.length, errors, warnings, components: components.size };
  }, [allItems]);

  const levelCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allItems.length };
    for (const row of allItems) {
      const value = rowLevel(row).toLowerCase();
      counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
  }, [allItems]);

  const tailPoll = useCallback(() => {
    const current = state.data;
    if (!current) { state.reload(); return; }
    const after = current.items.reduce((max, row) => Math.max(max, rowSeq(row)), 0);
    if (after <= 0) { state.reload(); return; }
    void api<LogsResponse>(`/logs?${logsQuery({ limit: LOG_LIMIT, level: serverLevel, component: debouncedComponent, after })}`)
      .then((result) => {
        const page = parseLogs(result);
        if (page.gap) { state.reload(); return; }
        if (page.items.length === 0) return;
        state.setData(mergeLogs(current, page));
      })
      .catch(() => { /* 实时增量失败保持现有行；手动刷新会显示错误。 */ });
  }, [state, serverLevel, debouncedComponent]);
  usePolling(tailPoll, TAIL_INTERVAL_MS, tail);

  const exportRows = useCallback(() => downloadNdjson(filtered), [filtered]);

  const canRead = hasPermission(permissions, 'logs.read');
  const tabOptions = LEVEL_OPTIONS.map((value) => ({ value, label: LEVEL_LABELS[value], count: levelCounts[value] ?? 0 }));

  return (
    <>
      <PageTitle
        eyebrow="OBSERVABILITY"
        title="实时日志"
        description="读取运行时的结构化日志窗口，按级别与关键词筛选，可导出为 NDJSON。"
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
        <Button onClick={exportRows} disabled={filtered.length === 0} title="导出 NDJSON">
          <Download size={15} /> 导出 NDJSON
        </Button>
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
          <StatCard label="错误" value={formatNumber(stats.errors)} note="error / fatal" icon={<AlertTriangle size={17} />} tone={stats.errors > 0 ? 'danger' : undefined} />
          <StatCard label="警告" value={formatNumber(stats.warnings)} note="warn" icon={<AlertCircle size={17} />} tone={stats.warnings > 0 ? 'warning' : undefined} />
          <StatCard label="组件数" value={formatNumber(stats.components)} note="窗口内唯一组件" icon={<Boxes size={17} />} />
        </div>

        {loaded?.gap && (
          <Notice tone="warning" icon={<AlertTriangle size={17} />}>
            日志缓冲区已发生轮转，部分历史记录可能缺失。
          </Notice>
        )}

        <Panel
          title="日志流"
          description={`显示 ${filtered.length} / ${allItems.length} 条${loaded && loaded.oldestSeq !== undefined && loaded.latestSeq !== undefined ? `，缓冲区序号 ${loaded.oldestSeq}–${loaded.latestSeq}` : ''}${tail ? '，实时刷新中' : ''}`}
          flush
        >
          <DataState
            empty={filtered.length === 0}
            emptyTitle="没有匹配的日志"
            emptyDetail="请调整级别筛选或搜索关键词。"
          >
            <Table minWidth={860}>
              <thead><tr><th>时间</th><th>级别</th><th>组件</th><th>消息</th></tr></thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${rowSeq(row)}:${index}`}>
                    <td className="mono nowrap">{formatTime(rowTime(row))}</td>
                    <td><Pill tone={levelTone(rowLevel(row))}>{rowLevel(row)}</Pill></td>
                    <td className="mono">{rowComponent(row)}</td>
                    <td className="log-message">{rowMessage(row) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </DataState>
        </Panel>
      </DataState>
    </>
  );
}
