import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Puzzle } from 'lucide-react';
import { api, ApiError, confirmedRequest } from '../lib/api';
import type { BotSnapshot } from '../lib/types';
import { Button, EmptyState, ErrorState, Loading, PageTitle, Panel, Pill, Table } from '../components/ui';

interface PluginRecord {
  id: string;
  state: string;
  errors: number;
}

interface PluginGroup {
  bot: BotSnapshot;
  plugins: PluginRecord[];
  error?: string;
}

export function Plugins({ permissions }: { permissions: string[] }) {
  const [groups, setGroups] = useState<PluginGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const canReload = permissions.includes('plugin.reload');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api<{ bots?: BotSnapshot[] }>('/bots');
      const bots = Array.isArray(result.bots) ? result.bots : [];
      const next = await Promise.all(bots.map(async (bot): Promise<PluginGroup> => {
        try {
          const response = await api<{ plugins?: PluginRecord[] }>(`/bots/${encodeURIComponent(bot.id)}/plugins`);
          return { bot, plugins: Array.isArray(response.plugins) ? response.plugins : [] };
        } catch (cause) {
          return {
            bot,
            plugins: [],
            error: cause instanceof Error ? cause.message : '插件列表读取失败',
          };
        }
      }));
      setGroups(next);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '读取 Bot 列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function reloadPlugin(group: PluginGroup, plugin: PluginRecord) {
    const key = `${group.bot.id}:${plugin.id}`;
    setBusy(key);
    setError('');
    try {
      const path = `/bots/${encodeURIComponent(group.bot.id)}/plugins/${encodeURIComponent(plugin.id)}/reload`;
      await confirmedRequest(path, { method: 'POST', body: '{}' }, {}, `重载插件 ${plugin.id}`);
      await load();
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.statusCode !== 0) {
        setError(cause instanceof Error ? cause.message : '插件重载失败');
      }
    } finally {
      setBusy('');
    }
  }

  const pluginCount = groups.reduce((sum, group) => sum + group.plugins.length, 0);

  return (
    <>
      <PageTitle
        eyebrow="PLUGIN RUNTIME"
        title="插件管理"
        description="查看各个 Bot 已加载的插件状态；重载操作由服务端权限、确认 nonce 和审计链路保护。"
        actions={<Button onClick={load}><RefreshCw size={15} /> 刷新</Button>}
      />
      {loading ? <Loading /> : error ? <ErrorState message={error} retry={load} /> : (
        <>
          <div className="notice-line"><Puzzle size={17} /><span>当前页面只管理本地已安装插件，不提供远程插件市场或任意代码安装。</span></div>
          <Panel title="已加载插件" description={`${groups.length} 个 Bot · ${pluginCount} 个插件`}>
            {groups.length === 0 ? <EmptyState title="没有 Bot 实例" detail="启动一个 Bot 后，它加载的插件会显示在这里。" /> : (
              <div className="plugin-groups">
                {groups.map((group) => (
                  <section className="plugin-group" key={group.bot.id}>
                    <div className="plugin-group-heading">
                      <div><strong>{group.bot.name || group.bot.id}</strong><small>{group.bot.id} · {group.bot.adapter}</small></div>
                      <Pill tone={group.bot.running ? 'success' : 'warning'}>{group.bot.running ? '运行中' : '已停止'}</Pill>
                    </div>
                    {group.error ? <div className="inline-error">{group.error}</div> : group.plugins.length === 0 ? (
                      <EmptyState title="暂无插件" detail="此 Bot 当前没有注册插件。" />
                    ) : (
                      <Table>
                        <thead><tr><th>插件</th><th>状态</th><th>错误计数</th><th>操作</th></tr></thead>
                        <tbody>{group.plugins.map((plugin) => {
                          const key = `${group.bot.id}:${plugin.id}`;
                          const failed = /fail|error|crash/i.test(plugin.state);
                          return (
                            <tr key={plugin.id}>
                              <td className="table-primary"><Puzzle size={14} /> {plugin.id}</td>
                              <td><Pill tone={failed ? 'danger' : plugin.state === 'active' ? 'success' : 'neutral'}>{plugin.state}</Pill></td>
                              <td>{plugin.errors}</td>
                              <td>{canReload ? (
                                <Button busy={busy === key} disabled={Boolean(busy) || !group.bot.running} onClick={() => void reloadPlugin(group, plugin)}>
                                  <RefreshCw size={14} /> 重载
                                </Button>
                              ) : <span className="muted-text">只读</span>}</td>
                            </tr>
                          );
                        })}</tbody>
                      </Table>
                    )}
                  </section>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
