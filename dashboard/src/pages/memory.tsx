import { useCallback, useEffect, useState } from 'react';
import { BrainCircuit, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { EmptyState, ErrorState, Loading, PageTitle, Panel, Pill, Table, Button } from '../components/ui';

interface MemoryRecord { id?: string; botId?: string; userId?: string; channelId?: string; scope?: string; kind?: string; summary?: string; updatedAt?: number | string; [key: string]: unknown; }

export function Memory() {
  const [items, setItems] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api<{ memories?: MemoryRecord[] }>('/memory?limit=100');
      setItems(Array.isArray(result.memories) ? result.memories : []);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '读取记忆元数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <PageTitle eyebrow="MEMORY GOVERNANCE" title="长期记忆" description="默认仅展示记忆元数据；内容访问、删除、恢复和导出继续受服务端权限控制。" actions={<Button onClick={load}><RefreshCw size={15} /> 刷新</Button>} />
      <div className="notice-line"><BrainCircuit size={17} /><span>用户、Bot、频道与共享群体的记忆 scope 相互隔离。此页面不会显示原始私聊内容。</span></div>
      {loading ? <Loading /> : error ? <ErrorState message={error} retry={load} /> : (
        <Panel title="记忆索引" description={`当前返回 ${items.length} 条元数据`}>
          {items.length === 0 ? <EmptyState title="没有可显示的记忆" detail="可能尚未启用记忆，或当前账号只能读取元数据。" /> : (
            <Table>
              <thead><tr><th>类型</th><th>Bot / 用户</th><th>Scope</th><th>摘要</th><th>更新时间</th></tr></thead>
              <tbody>{items.map((item, index) => (
                <tr key={String(item.id ?? index)}>
                  <td><Pill tone="info">{item.kind ?? 'memory'}</Pill></td>
                  <td><div className="table-primary">{item.botId ?? '—'}</div><small className="muted-text">{item.userId ?? '—'}</small></td>
                  <td>{item.scope ?? item.channelId ?? '—'}</td><td className="truncate-cell">{item.summary ?? '受权限保护的记忆条目'}</td>
                  <td>{item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '—'}</td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Panel>
      )}
      <div className="migration-hint">记忆审核、批量删除、回收站、恢复、导出与 dry-run 导入仍可在 <a href="/#memory">经典控制台记忆页</a> 使用。</div>
    </>
  );
}
