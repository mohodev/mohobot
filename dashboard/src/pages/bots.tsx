import { useCallback, useEffect, useState } from 'react';
import { RotateCw, Wifi, WifiOff } from 'lucide-react';
import { api, ApiError, confirmedRequest } from '../lib/api';
import type { BotSnapshot } from '../lib/types';
import { Button, EmptyState, ErrorState, Loading, PageTitle, Panel, Pill, Table } from '../components/ui';

export function Bots() {
  const [bots, setBots] = useState<BotSnapshot[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api<{ bots?: BotSnapshot[] }>('/bots');
      setBots(Array.isArray(result.bots) ? result.bots : []);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '读取 Bot 列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const cached = sessionStorage.getItem('moho-admin-permissions');
    setPermissions(cached ? JSON.parse(cached) as string[] : []);
    void load();
  }, [load]);

  async function restart(bot: BotSnapshot) {
    setBusy(bot.id);
    try {
      await confirmedRequest(`/bots/${encodeURIComponent(bot.id)}/restart`, { method: 'POST', body: '{}' }, {}, `重启机器人 ${bot.name || bot.id}`);
      await load();
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.statusCode !== 0) setError(cause instanceof Error ? cause.message : '重启失败');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <PageTitle eyebrow="RUNTIME INSTANCES" title="机器人" description="查看网关连接、延迟和实例运行状态。" actions={<Button onClick={load}><RotateCw size={15} /> 刷新</Button>} />
      {loading ? <Loading /> : error ? <ErrorState message={error} retry={load} /> : (
        <Panel title="Bot 实例" description={`发现 ${bots.length} 个实例`}>
          {bots.length === 0 ? <EmptyState title="暂无 Bot" detail="启用的机器人将在这里显示。" /> : (
            <Table>
              <thead><tr><th>名称</th><th>适配器</th><th>网关</th><th>延迟</th><th>重连</th><th>运行状态</th><th>操作</th></tr></thead>
              <tbody>{bots.map((bot) => (
                <tr key={bot.id}>
                  <td><div className="table-primary">{bot.name || bot.id}</div><small className="muted-text">{bot.id}</small></td>
                  <td>{bot.adapter || '—'}</td>
                  <td>{bot.gateway?.connected ? <Pill tone="success"><Wifi size={12} /> 已连接</Pill> : <Pill tone="warning"><WifiOff size={12} /> 离线</Pill>}</td>
                  <td>{bot.gateway?.ping == null ? '—' : `${bot.gateway.ping} ms`}</td>
                  <td>{bot.gateway?.reconnects ?? 0}</td>
                  <td>{bot.running ? <Pill tone="success">运行中</Pill> : <Pill tone="danger">已停止</Pill>}</td>
                  <td>{permissions.includes('runtime.restart') ? <Button variant="danger" busy={busy === bot.id} disabled={Boolean(busy)} onClick={() => void restart(bot)}>重启</Button> : <span className="muted-text">只读</span>}</td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Panel>
      )}
    </>
  );
}
