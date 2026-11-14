import { useMemo, useState } from 'react';
import { AlertCircle, Boxes, Plug, Puzzle, RefreshCw, TriangleAlert } from 'lucide-react';
import { api, ApiError, body, confirmedRequest, hasPermission } from '../lib/api';
import type { BotSnapshot, PageProps, PluginRecord } from '../lib/types';
import { useAsync } from '../lib/hooks';
import { formatNumber } from '../lib/format';
import { Button, DataState, Notice, PageTitle, Panel, Pill, StatCard, Table } from '../components/ui';

interface BotsResponse { bots?: BotSnapshot[]; }
interface PluginsResponse { plugins?: PluginRecord[]; }

/** One bot plus its locally installed plugins (or the per-bot load failure). */
interface PluginGroup {
  bot: BotSnapshot;
  plugins: PluginRecord[];
  /** Non-empty when only this bot's plugin listing failed. */
  error: string;
}

/** Server states use lowercase tokens such as `failed`, `error`, `crashed`. */
const FAILURE_PATTERN = /fail|error|crash/i;

function errorText(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'string' && cause) return cause;
  return fallback;
}

/**
 * Loads every bot, then its plugin listing. A failing per-bot request is
 * captured on that group so the remaining bots still render.
 */
async function loadPluginGroups(): Promise<PluginGroup[]> {
  const listed = await api<BotsResponse>('/bots');
  const bots = Array.isArray(listed.bots) ? listed.bots : [];
  return Promise.all(
    bots.map(async (bot): Promise<PluginGroup> => {
      try {
        const result = await api<PluginsResponse>(`/bots/${encodeURIComponent(bot.id)}/plugins`);
        return { bot, plugins: Array.isArray(result.plugins) ? result.plugins : [], error: '' };
      } catch (cause) {
        return { bot, plugins: [], error: errorText(cause, '插件列表读取失败') };
      }
    }),
  );
}

function failureTone(state: string): 'danger' | 'success' {
  return FAILURE_PATTERN.test(state) ? 'danger' : 'success';
}

/** Plugin ids can contain characters that interact with the URL, so encode both. */
function reloadPath(botId: string, pluginId: string): string {
  return `/bots/${encodeURIComponent(botId)}/plugins/${encodeURIComponent(pluginId)}/reload`;
}

export function Plugins({ permissions }: PageProps) {
  const state = useAsync(loadPluginGroups, [], '读取插件列表失败');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');

  const canReload = hasPermission(permissions, 'plugin.reload');
  const groups = state.data ?? [];

  const stats = useMemo(() => {
    let totalPlugins = 0;
    let failingPlugins = 0;
    let totalErrors = 0;
    for (const group of groups) {
      totalPlugins += group.plugins.length;
      for (const plugin of group.plugins) {
        if (FAILURE_PATTERN.test(plugin.state)) failingPlugins += 1;
        const errors = Number(plugin.errors);
        if (Number.isFinite(errors) && errors > 0) totalErrors += errors;
      }
    }
    return { bots: groups.length, totalPlugins, failingPlugins, totalErrors };
  }, [groups]);

  async function reloadPlugin(bot: BotSnapshot, plugin: PluginRecord): Promise<void> {
    const key = `${bot.id}:${plugin.id}`;
    setActionError('');
    setActionNotice('');
    setBusy((current) => ({ ...current, [key]: true }));
    try {
      await confirmedRequest<{ plugin?: PluginRecord }>(
        reloadPath(bot.id, plugin.id),
        { method: 'POST', body: body({}) },
        {},
        `重载插件 ${plugin.id}`,
      );
      state.reload();
      setActionNotice(`已重载插件 ${plugin.id}（实例 ${bot.id}）。`);
    } catch (cause) {
      // statusCode 0 means the operator cancelled the confirmation prompt.
      if (cause instanceof ApiError && cause.statusCode === 0) return;
      setActionError(`重载插件 ${plugin.id} 失败：${errorText(cause, '请求失败')}`);
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  return (
    <>
      <PageTitle
        eyebrow="PLUGIN RUNTIME"
        title="插件管理"
        description="按运行实例查看本地已安装插件的状态与错误计数，并在二次确认后重载单个插件。"
        actions={<Button onClick={state.reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      <Notice tone="info" icon={<Plug size={17} />}>
        此页面仅管理本机已安装的插件，没有远程插件市场，也不提供任意安装或卸载能力。重载失败不会替换当前健康实例。
      </Notice>

      {actionError && <Notice tone="danger" icon={<AlertCircle size={17} />}>{actionError}</Notice>}
      {actionNotice && <Notice tone="info" icon={<Plug size={17} />}>{actionNotice}</Notice>}

      <DataState
        loading={state.loading && state.data === undefined}
        error={state.error}
        onRetry={state.reload}
        empty={state.data !== undefined && groups.length === 0}
        emptyTitle="没有运行实例"
        emptyDetail="尚未发现可读取插件的 Bot 实例。"
      >
        <div className="stat-grid">
          <StatCard label="Bot 实例" value={formatNumber(stats.bots)} note="来自插件分组" icon={<Boxes size={17} />} />
          <StatCard label="插件总数" value={formatNumber(stats.totalPlugins)} note="本地已安装" icon={<Plug size={17} />} />
          <StatCard
            label="异常插件"
            value={formatNumber(stats.failingPlugins)}
            note="状态含 fail / error / crash"
            icon={<TriangleAlert size={17} />}
            tone={stats.failingPlugins > 0 ? 'danger' : undefined}
          />
          <StatCard
            label="累计错误"
            value={formatNumber(stats.totalErrors)}
            note="插件上报错误计数之和"
            icon={<AlertCircle size={17} />}
            tone={stats.totalErrors > 0 ? 'warning' : undefined}
          />
        </div>

        {!canReload && (
          <Notice tone="warning" icon={<AlertCircle size={17} />}>
            当前账号没有 plugin.reload 权限，插件列表为只读；服务端仍会独立校验每次请求。
          </Notice>
        )}

        {groups.map((group) => {
          const botName = group.bot.name || group.bot.id;
          return (
            <Panel
              key={group.bot.id}
              title={botName}
              description={`实例 ${group.bot.id} · 平台 ${group.bot.adapter || '未知'} · ${group.plugins.length} 个插件`}
              action={group.bot.running ? <Pill tone="success">运行中</Pill> : <Pill tone="danger">已停止</Pill>}
            >
              <div className="toolbar">
                <Pill tone="neutral"><Boxes size={12} /> {group.bot.adapter || '未知平台'}</Pill>
                <Pill tone={group.bot.running ? 'success' : 'danger'}>{group.bot.running ? '运行中' : '已停止'}</Pill>
                <span className="mono muted-text">{group.bot.id}</span>
                <span className="muted-text">插件 {group.plugins.length} 个</span>
              </div>

              {group.error ? (
                <Notice tone="danger" icon={<AlertCircle size={17} />}>
                  读取该实例插件失败：{group.error}
                </Notice>
              ) : (
                <Table minWidth={640}>
                  <thead>
                    <tr><th>插件</th><th>状态</th><th>错误</th><th>操作</th></tr>
                  </thead>
                  <tbody>
                    {group.plugins.length === 0 && (
                      <tr><td colSpan={4} className="muted-text">该实例暂无已安装插件</td></tr>
                    )}
                    {group.plugins.map((plugin) => {
                      const key = `${group.bot.id}:${plugin.id}`;
                      const isBusy = Boolean(busy[key]);
                      return (
                        <tr key={plugin.id}>
                          <td><span className="table-primary mono">{plugin.id}</span></td>
                          <td><Pill tone={failureTone(plugin.state)}>{plugin.state || '未知'}</Pill></td>
                          <td>{formatNumber(Number(plugin.errors) || 0)}</td>
                          <td>
                            <Button
                              variant="secondary"
                              busy={isBusy}
                              disabled={!canReload || !group.bot.running}
                              title={!group.bot.running ? '实例未运行，无法重载插件' : undefined}
                              onClick={() => { void reloadPlugin(group.bot, plugin); }}
                            >
                              <Puzzle size={14} /> 重载
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}

              {group.plugins.some((plugin) => FAILURE_PATTERN.test(plugin.state)) && (
                <p className="muted-text">该实例存在异常插件；重载只会重建这一个插件，不会影响其他实例。</p>
              )}
            </Panel>
          );
        })}
      </DataState>
    </>
  );
}
