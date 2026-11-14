import { useCallback, useMemo, useState } from 'react';
import { KeyRound, PlugZap, RefreshCw, Route, ShieldCheck, Wifi, XCircle } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { PageProps, ProviderRecord } from '../lib/types';
import { useAsync } from '../lib/hooks';
import { formatNumber, formatRelative, formatTime } from '../lib/format';
import { Button, DataState, Notice, PageTitle, Panel, Pill, StatCard, Table } from '../components/ui';

interface ProvidersResponse { providers?: ProviderRecord[]; }

interface ProbeResult {
  botId: string;
  ok: boolean;
  detail?: string;
  checkedAt: number;
}

interface ProbeResponse { probe?: ProbeResult; }

interface ProbeEntry {
  pending: boolean;
  probe?: ProbeResult;
  error?: string;
}

/** Formats one task-route value, which may be a model id or a nested routing object. */
function routeLabel(value: unknown): string {
  if (typeof value === 'string') return value || '—';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}=${typeof item === 'string' ? item : JSON.stringify(item)}`);
    return entries.length ? entries.join('，') : '—';
  }
  return value == null ? '—' : String(value);
}

function routeEntries(record: ProviderRecord): Array<[string, string]> {
  const routes = record.taskRoutes;
  if (!routes || typeof routes !== 'object') return [];
  return Object.entries(routes).map(([task, value]) => [task, routeLabel(value)]);
}

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error && cause.message) return cause.message;
  return '探测失败';
}

export function Providers({ permissions }: PageProps) {
  const state = useAsync<ProvidersResponse>(() => api<ProvidersResponse>('/providers'), [], '读取模型供应商失败');
  const [probes, setProbes] = useState<Record<string, ProbeEntry>>({});

  const canProbe = permissions.includes('providers.probe');
  const providers = useMemo(() => state.data?.providers ?? [], [state.data]);

  const stats = useMemo(() => {
    const keysConfigured = providers.filter((row) => row.apiKeyConfigured).length;
    const withRoutes = providers.filter((row) => routeEntries(row).length > 0).length;
    const probesOk = Object.values(probes).filter((entry) => entry.probe?.ok).length;
    return { keysConfigured, withRoutes, probesOk };
  }, [providers, probes]);

  const runProbe = useCallback(async (botId: string) => {
    setProbes((current) => ({ ...current, [botId]: { pending: true } }));
    try {
      const result = await api<ProbeResponse>(`/providers/${encodeURIComponent(botId)}/probe`, { method: 'POST' });
      const probe = result.probe;
      setProbes((current) => ({ ...current, [botId]: probe ? { pending: false, probe } : { pending: false, error: '探测响应缺少结果' } }));
    } catch (cause) {
      setProbes((current) => ({ ...current, [botId]: { pending: false, error: errorMessage(cause) } }));
    }
  }, []);

  const reload = useCallback(() => {
    setProbes({});
    state.reload();
  }, [state]);

  return (
    <>
      <PageTitle
        eyebrow="MODEL CONNECTIVITY"
        title="模型供应商"
        description="查看每个 Bot 生效的模型供应商、密钥/地址配置状态、任务路由，并发起一次只读连接探测。"
        actions={<Button onClick={reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      <Notice tone="info" icon={<ShieldCheck size={17} />}>
        供应商密钥仅在服务端从环境变量读取，管理接口只回显“是否已配置”，密钥内容与 Base URL 原文永不出现在此页面。
      </Notice>

      <DataState loading={state.loading && !state.data} error={state.error} onRetry={reload}>
        <div className="stat-grid">
          <StatCard label="供应商总数" value={formatNumber(providers.length)} note="来自 /api/providers" icon={<PlugZap size={17} />} />
          <StatCard label="已配置密钥" value={formatNumber(stats.keysConfigured)} note={`共 ${providers.length} 个 Bot`} icon={<KeyRound size={17} />} tone={providers.length > 0 && stats.keysConfigured < providers.length ? 'warning' : undefined} />
          <StatCard label="探测正常" value={formatNumber(stats.probesOk)} note="本次页面会话的探测结果" icon={<Wifi size={17} />} tone={stats.probesOk > 0 ? 'success' : undefined} />
          <StatCard label="含任务路由" value={formatNumber(stats.withRoutes)} note="配置了 taskRoutes 的 Bot" icon={<Route size={17} />} />
        </div>

        <Panel
          title="供应商连接"
          description={`${providers.length} 个 Bot 的模型连接配置${canProbe ? '' : '（当前账号只读，不含探测权限）'}`}
        >
          <DataState
            empty={providers.length === 0}
            emptyTitle="没有可展示的供应商"
            emptyDetail="尚未从运行配置中读取到任何 Bot 的模型供应商信息。"
          >
            <Table minWidth={900}>
              <thead>
                <tr>
                  <th>Bot</th>
                  <th>供应商</th>
                  <th>模型</th>
                  <th>密钥</th>
                  <th>Base URL</th>
                  <th>任务路由</th>
                  <th>连接探测</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((row) => {
                  const routes = routeEntries(row);
                  const entry = probes[row.botId];
                  return (
                    <tr key={row.botId}>
                      <td><div className="table-primary mono">{row.botId}</div></td>
                      <td>{row.provider || '—'}</td>
                      <td className="mono">{row.model || '—'}</td>
                      <td>
                        {row.apiKeyConfigured
                          ? <Pill tone="success"><KeyRound size={12} /> 已配置</Pill>
                          : <Pill tone="warning"><XCircle size={12} /> 未配置</Pill>}
                      </td>
                      <td>
                        {row.baseUrlConfigured
                          ? <Pill tone="success">已配置</Pill>
                          : <Pill tone="neutral">使用默认</Pill>}
                      </td>
                      <td>
                        {routes.length === 0
                          ? <span className="muted-text">无</span>
                          : (
                            <details className="collapsible">
                              <summary>{routes.length} 条路由</summary>
                              <div className="collapsible-body">
                                <dl className="descriptions descriptions-1">
                                  {routes.map(([task, model]) => (
                                    <div className="description-item" key={task}>
                                      <dt className="mono">{task}</dt>
                                      <dd className="mono">{model}</dd>
                                    </div>
                                  ))}
                                </dl>
                              </div>
                            </details>
                          )}
                      </td>
                      <td>
                        <div className="col">
                          {canProbe ? (
                            <Button
                              variant="secondary"
                              busy={entry?.pending}
                              onClick={() => { void runProbe(row.botId); }}
                            >
                              <PlugZap size={14} /> 探测
                            </Button>
                          ) : (
                            <span className="muted-text">只读（缺少 providers.probe）</span>
                          )}
                          {entry?.pending && <Pill tone="info">检测中…</Pill>}
                          {entry?.probe && (
                            <div className="col">
                              {entry.probe.ok
                                ? <Pill tone="success">正常</Pill>
                                : <Pill tone="danger">失败</Pill>}
                              {entry.probe.detail && <small className="muted-text prewrap">{entry.probe.detail}</small>}
                              <small className="muted-text nowrap">
                                最近检测：{formatTime(entry.probe.checkedAt)}（{formatRelative(entry.probe.checkedAt)}）
                              </small>
                            </div>
                          )}
                          {entry?.error && <small className="inline-error">{entry.error}</small>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </DataState>
        </Panel>
      </DataState>
    </>
  );
}
