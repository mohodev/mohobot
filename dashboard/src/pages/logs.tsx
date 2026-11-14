import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Search } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { LogRecord } from '../lib/types';
import { Button, EmptyState, ErrorState, Loading, PageTitle, Panel, Pill, Table } from '../components/ui';

export function Logs() {
  const [rows, setRows] = useState<LogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api<{ logs?: { items?: LogRecord[] }; items?: LogRecord[] }>('/logs?limit=200');
      const items = result.logs?.items ?? result.items ?? [];
      setRows(Array.isArray(items) ? items : []);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '读取日志失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => rows.filter((row) => {
    const value = [row.level, row.component, row.msg, row.message].join(' ').toLowerCase();
    return (level === 'all' || String(row.level ?? '').toLowerCase() === level) && value.includes(query.toLowerCase());
  }), [rows, level, query]);

  function exportLogs() {
    const blob = new Blob([filtered.map((row) => JSON.stringify(row)).join('\n')], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mohobot-logs.jsonl';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageTitle eyebrow="OBSERVABILITY" title="实时日志" description="读取服务端有界脱敏日志缓冲，可按级别和关键字筛选。" actions={<><Button onClick={exportLogs} disabled={!filtered.length}><Download size={15} /> 导出</Button><Button onClick={load}><RefreshCw size={15} /> 刷新</Button></>} />
      <Panel>
        <div className="filter-row">
          <label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索日志内容、模块..." /></label>
          <select value={level} onChange={(event) => setLevel(event.target.value)}><option value="all">全部级别</option><option value="error">ERROR</option><option value="warn">WARN</option><option value="info">INFO</option><option value="debug">DEBUG</option></select>
          <span className="muted-text">{filtered.length} / {rows.length} 条</span>
        </div>
        {loading ? <Loading /> : error ? <ErrorState message={error} retry={load} /> : filtered.length === 0 ? <EmptyState title="没有匹配的日志" detail="调整筛选条件或等待新的运行记录。" /> : (
          <Table>
            <thead><tr><th>时间</th><th>级别</th><th>模块</th><th>消息</th></tr></thead>
            <tbody>{filtered.map((row, index) => {
              const tone = String(row.level).toLowerCase() === 'error' || String(row.level).toLowerCase() === 'fatal' ? 'danger' : String(row.level).toLowerCase() === 'warn' ? 'warning' : 'neutral';
              return <tr key={String(row.id ?? index)}><td className="nowrap">{row.ts ? new Date(row.ts).toLocaleString() : row.at ?? '—'}</td><td><Pill tone={tone}>{String(row.level ?? 'INFO').toUpperCase()}</Pill></td><td>{row.component ?? 'runtime'}</td><td className="log-message">{String(row.msg ?? row.message ?? '')}</td></tr>;
            })}</tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
