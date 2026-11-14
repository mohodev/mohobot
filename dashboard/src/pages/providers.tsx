import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, Waypoints } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { ProviderRecord } from '../lib/types';
import { Button, EmptyState, ErrorState, Loading, PageTitle, Panel, Pill, Table } from '../components/ui';

export function Providers() {
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [probe, setProbe] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api<{ providers?: ProviderRecord[] }>('/providers');
      setProviders(Array.isArray(result.providers) ? result.providers : []);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '读取 Provider 列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const cached = sessionStorage.getItem('moho-admin-permissions');
    setPermissions(cached ? JSON.parse(cached) as string[] : []);
    void load();
  }, [load]);

  async function test(botId: string) {
    setProbe((current) => ({ ...current, [botId]: 'checking' }));
    try {
      const result = await api<{ probe?: { ok?: boolean; detail?: string } }>(`/providers/${encodeURIComponent(botId)}/probe`, { method: 'POST', body: '{}' });
      setProbe((current) => ({ ...current, [botId]: result.probe?.ok ? 'connected' : result.probe?.detail || 'failed' }));
    } catch (cause) {
      setProbe((current) => ({ ...current, [botId]: cause instanceof Error ? cause.message : '失败' }));
    }
  }

  return (
    <>
      <PageTitle eyebrow="MODEL CONNECTIVITY" title="模型供应商" description="查看 Bot 绑定的 Provider、模型与密钥配置状态。密钥不会在管理界面回显。" actions={<Button onClick={load}><RefreshCw size={15} /> 刷新</Button>} />
      <div className="notice-line"><ShieldCheck size={17} /><span>API Key 和服务端密钥只显示配置状态，实际值只从环境变量读取。</span></div>
      {loading ? <Loading /> : error ? <ErrorState message={error} retry={load} /> : (
        <Panel title="已配置供应商" description="按 Bot 展示当前供应商映射。">
          {providers.length === 0 ? <EmptyState title="尚未配置 Provider" detail="请在经典控制台的供应商配置中完成初始设置。" /> : (
            <Table>
              <thead><tr><th>Bot</th><th>Provider</th><th>默认模型</th><th>密钥状态</th><th>任务路由</th><th>连接探测</th></tr></thead>
              <tbody>{providers.map((provider) => (
                <tr key={provider.botId}>
                  <td className="table-primary">{provider.botId}</td><td>{provider.provider}</td><td><code>{provider.model}</code></td>
                  <td>{provider.apiKeyConfigured ? <Pill tone="success">已配置</Pill> : <Pill tone="warning">未配置</Pill>}</td>
                  <td><span className="muted-text">{Object.keys(provider.taskRoutes ?? {}).length} 个任务路由</span></td>
                  <td>{permissions.includes('providers.probe') ? <div className="inline-action"><Button onClick={() => void test(provider.botId)}><Waypoints size={14} /> 探测</Button>{probe[provider.botId] && <Pill tone={probe[provider.botId] === 'connected' ? 'success' : probe[provider.botId] === 'checking' ? 'info' : 'danger'}>{probe[provider.botId] === 'connected' ? '正常' : probe[provider.botId] === 'checking' ? '检测中' : probe[provider.botId]}</Pill>}</div> : <span className="muted-text">无探测权限</span>}</td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Panel>
      )}
    </>
  );
}
