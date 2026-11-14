import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Button, EmptyState, ErrorState, Loading, PageTitle, Panel, StatCard, Table } from '../components/ui';

interface ModelRecord { id?: string; name?: string; provider?: string; contextLength?: number; [key: string]: unknown; }

export function Models() {
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [health, setHealth] = useState<Record<string, unknown>>({});
  const [dashboard, setDashboard] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [catalogResult, healthResult, opsResult] = await Promise.all([
        api<{ catalog?: { models?: ModelRecord[] } }>('/models'),
        api<{ health?: Record<string, unknown> }>('/models/health'),
        api<{ dashboard?: Record<string, unknown> }>('/models/dashboard').catch(() => ({ dashboard: {} })),
      ]);
      setModels(Array.isArray(catalogResult.catalog?.models) ? catalogResult.catalog.models : []);
      setHealth(healthResult.health ?? {});
      setDashboard(opsResult.dashboard ?? {});
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '读取模型运营数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const healthState = String(health.status ?? health.state ?? (health.configured ? 'configured' : 'unknown'));

  return (
    <>
      <PageTitle eyebrow="MODEL OPERATIONS" title="模型运营" description="查看模型目录、Provider 健康和调用运营数据。" actions={<Button onClick={load}><RefreshCw size={15} /> 刷新</Button>} />
      {loading ? <Loading /> : error ? <ErrorState message={error} retry={load} /> : (
        <>
          <div className="stat-grid">
            <StatCard label="目录模型" value={models.length} note="当前 catalog 快照" />
            <StatCard label="健康状态" value={healthState} note="模型健康协调器" icon={<Activity size={17} />} />
            <StatCard label="运营指标" value={Object.keys(dashboard).length} note="Dashboard 数据字段" />
          </div>
          <Panel title="模型目录" description="当前可选模型及其基础元数据。">
            {models.length === 0 ? <EmptyState title="目录为空" detail="模型目录刷新后会在这里显示。" /> : (
              <Table>
                <thead><tr><th>模型</th><th>供应商</th><th>上下文长度</th><th>标识</th></tr></thead>
                <tbody>{models.map((model, index) => (
                  <tr key={String(model.id ?? model.name ?? index)}>
                    <td className="table-primary">{model.name ?? model.id ?? '未命名模型'}</td>
                    <td>{model.provider ?? '—'}</td><td>{model.contextLength ? Number(model.contextLength).toLocaleString() : '—'}</td>
                    <td><code>{model.id ?? '—'}</code></td>
                  </tr>
                ))}</tbody>
              </Table>
            )}
          </Panel>
          <Panel title="健康快照" description="原样展示经过权限过滤后的健康信息。">
            <pre className="json-view">{JSON.stringify(health, null, 2)}</pre>
          </Panel>
          <Panel title="运营快照" description="用量、Fallback 与熔断事件由现有 Model Operations 服务提供。">
            {Object.keys(dashboard).length ? <pre className="json-view">{JSON.stringify(dashboard, null, 2)}</pre> : <EmptyState title="暂无运营数据" detail="当前没有可展示的运营事件。" />}
          </Panel>
        </>
      )}
    </>
  );
}
