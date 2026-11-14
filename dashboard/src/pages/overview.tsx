import { useCallback, useEffect, useState } from 'react';
import { Activity, Bot, Clock3, Cpu, RefreshCw, Server } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { BotSnapshot } from '../lib/types';
import { Button, EmptyState, ErrorState, Loading, PageTitle, Panel, Pill, StatCard, Table } from '../components/ui';

export function Overview() {
  const [bots, setBots] = useState<BotSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api<{ bots?: BotSnapshot[] }>('/status');
      setBots(Array.isArray(result.bots) ? result.bots : []);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '读取运行状态失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const online = bots.filter((bot) => Boolean(bot.running || bot.gateway?.connected)).length;
  const sessions = bots.reduce((sum, bot) => sum + Number(bot.sessions ?? 0), 0);

  return (
    <>
      <PageTitle eyebrow="RUNTIME OVERVIEW" title="运行总览" description="查看机器人运行状态、平台连接与当前实例概况。" actions={<Button onClick={load}><RefreshCw size={15} /> 刷新</Button>} />
      {loading ? <Loading /> : error ? <ErrorState message={error} retry={load} /> : (
        <>
          <div className="stat-grid">
            <StatCard label="运行中的 Bot" value={online} note={`共 ${bots.length} 个已配置实例`} icon={<Bot size={17} />} />
            <StatCard label="活跃会话" value={sessions} note="来自 Runtime 快照" icon={<Activity size={17} />} />
            <StatCard label="连接中的网关" value={bots.filter((bot) => bot.gateway?.connected).length} note="平台连接状态" icon={<Server size={17} />} />
            <StatCard label="模型供应链" value={bots.filter((bot) => Boolean(bot.provider)).length} note="已配置 Provider 的 Bot" icon={<Cpu size={17} />} />
          </div>
          <div className="content-grid content-grid-wide">
            <Panel title="机器人实例" description="当前 Runtime 中注册的 Bot。">
              {bots.length === 0 ? <EmptyState title="没有运行实例" detail="尚未发现可展示的 Bot 快照。" /> : (
                <Table>
                  <thead><tr><th>实例</th><th>平台</th><th>Provider</th><th>网关</th><th>会话</th><th>状态</th></tr></thead>
                  <tbody>{bots.map((bot) => (
                    <tr key={bot.id}>
                      <td><div className="table-primary">{bot.name || bot.id}</div><small className="muted-text">{bot.id}</small></td>
                      <td>{bot.adapter || '—'}</td><td>{bot.provider || '—'}</td>
                      <td>{bot.gateway?.connected ? <Pill tone="success">已连接</Pill> : <Pill tone="warning">离线</Pill>}</td>
                      <td>{bot.sessions ?? 0}</td>
                      <td>{bot.running ? <Pill tone="success">运行中</Pill> : <Pill tone="danger">已停止</Pill>}</td>
                    </tr>
                  ))}</tbody>
                </Table>
              )}
            </Panel>
            <Panel title="运行提示" description="首轮重建的管理面能力。">
              <div className="info-list">
                <div><span className="info-icon"><Clock3 size={16} /></span><div><strong>低风险只读总览</strong><p>此页面只读取状态快照，不触发模型调用或修改运行状态。</p></div></div>
                <div><span className="info-icon"><Activity size={16} /></span><div><strong>按权限显示功能</strong><p>导航和操作入口依据服务端返回的权限列表过滤，服务端仍执行最终授权。</p></div></div>
                <div><span className="info-icon"><Server size={16} /></span><div><strong>旧控制台仍然保留</strong><p>其他模块会逐步迁移；尚未迁移的功能仍可从经典控制台进入。</p></div></div>
              </div>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
