import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, UserRound } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { EmptyState, ErrorState, Loading, PageTitle, Panel, Pill, Table, Button } from '../components/ui';

interface Character { id: string; name?: string; description?: string; promptLength?: number; tags?: string[]; enabled?: boolean; }

export function Characters() {
  const [items, setItems] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api<{ characters?: Character[] }>('/characters');
      setItems(Array.isArray(result.characters) ? result.characters : []);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '读取角色列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <PageTitle eyebrow="PERSONA CATALOG" title="角色档案" description="查看已经导入的角色与人设资料。详细编辑、批量导入和角色互聊暂时保留在经典控制台。" actions={<Button onClick={load}><RefreshCw size={15} /> 刷新</Button>} />
      {loading ? <Loading /> : error ? <ErrorState message={error} retry={load} /> : (
        <Panel title="已注册角色" description={`共 ${items.length} 个角色`}>
          {items.length === 0 ? <EmptyState title="尚无角色档案" detail="可以从经典控制台创建或批量导入角色。" /> : (
            <Table>
              <thead><tr><th>角色</th><th>说明</th><th>提示词长度</th><th>标签</th><th>状态</th></tr></thead>
              <tbody>{items.map((item) => (
                <tr key={item.id}>
                  <td><div className="table-primary"><UserRound size={15} /> {item.name || item.id}</div><small className="muted-text">{item.id}</small></td>
                  <td className="truncate-cell">{item.description || '—'}</td><td>{item.promptLength ?? '—'}</td>
                  <td>{item.tags?.length ? item.tags.join('、') : '—'}</td><td><Pill tone={item.enabled === false ? 'warning' : 'success'}>{item.enabled === false ? '已停用' : '可用'}</Pill></td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Panel>
      )}
      <div className="migration-hint">角色创建、Prompt 编辑、批量导入和多角色互聊可在 <a href="/#characters">经典控制台角色页</a> 使用。</div>
    </>
  );
}
