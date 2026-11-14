import { Fragment, useState } from 'react';
import { Activity, Bot, Plug, Power, RefreshCw, RotateCw, Server } from 'lucide-react';
import { api, ApiError, confirmedRequest } from '../lib/api';
import type { BotSnapshot, PageProps, PluginRecord } from '../lib/types';
import { useAsync } from '../lib/hooks';
import { formatNumber } from '../lib/format';
import {
  Button,
  DataState,
  Descriptions,
  Notice,
  PageTitle,
  Panel,
  Pill,
  StatCard,
  Table,
} from '../components/ui';

/** Gateway summary as returned by `GET /api/bots/:id/gateway`. */
interface GatewayView {
  connected?: boolean;
  ping?: number;
  reconnects?: number;
  username?: string;
  guilds?: number;
}

/**
 * Runtime instance row. Mirrors the server's `BotControlView` (which adds
 * `plugins` and richer gateway fields on top of the shared `BotSnapshot`).
 */
interface BotInstance extends Omit<BotSnapshot, 'gateway'> {
  gateway?: GatewayView;
  plugins?: PluginRecord[];
}

interface BotsResponse {
  bots?: BotInstance[];
}

interface GatewayResponse {
  gateway?: GatewayView;
}

function fmtPing(ping: number | undefined): string {
  return typeof ping === 'number' && ping >= 0 ? `${ping} ms` : '—';
}

function pluginSummary(plugins: PluginRecord[] | undefined): { count: number; errors: number } {
  const list = plugins ?? [];
  return {
    count: list.length,
    errors: list.reduce((sum, plugin) => sum + Number(plugin.errors ?? 0), 0),
  };
}

/** Lazily loads and renders one instance's gateway detail (account/guilds/ping). */
function GatewayDetail({ botId }: { botId: string }) {
  const state = useAsync(
    () => api<GatewayResponse>(`/bots/${encodeURIComponent(botId)}/gateway`),
    [botId],
    '读取网关详情失败',
  );
  const gateway = state.data?.gateway;
  return (
    <DataState
      loading={state.loading}
      error={state.error}
      empty={!state.loading && !gateway}
      emptyTitle="没有网关数据"
      emptyDetail="该实例暂未上报网关状态。"
      onRetry={state.reload}
    >
      {gateway && (
        <Descriptions
          columns={3}
          items={[
            { label: '网关账号', value: gateway.username || '—' },
            { label: '连接状态', value: gateway.connected ? <Pill tone="success">已连接</Pill> : <Pill tone="warning">未连接</Pill> },
            { label: '延迟', value: fmtPing(gateway.ping) },
            { label: '服务器数量', value: gateway.guilds === undefined ? '—' : formatNumber(gateway.guilds) },
            { label: '重连次数', value: formatNumber(gateway.reconnects ?? 0) },
          ]}
        />
      )}
    </DataState>
  );
}

export function Bots({ permissions }: PageProps) {
  const state = useAsync(async () => {
    const result = await api<BotsResponse>('/bots');
    return { bots: Array.isArray(result.bots) ? result.bots : [] };
  }, [], '读取机器人实例失败');

  const [openIds, setOpenIds] = useState<string[]>([]);
  const [busyId, setBusyId] = useState('');
  const [actionError, setActionError] = useState('');

  const canRestart = permissions.includes('runtime.restart');
  const instances = state.data?.bots ?? [];
  const running = instances.filter((bot) => bot.running === true).length;
  const connected = instances.filter((bot) => bot.gateway?.connected === true).length;
  const sessions = instances.reduce((sum, bot) => sum + Number(bot.sessions ?? 0), 0);

  function toggleRow(id: string) {
    setOpenIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  }

  async function restart(bot: BotInstance) {
    setBusyId(bot.id);
    setActionError('');
    try {
      await confirmedRequest(
        `/bots/${encodeURIComponent(bot.id)}/restart`,
        { method: 'POST' },
        {},
        `重启实例 ${bot.name || bot.id}`,
      );
      state.reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 0) return; // 用户取消确认，不提示错误
      setActionError(cause instanceof Error ? cause.message : '重启实例失败');
    } finally {
      setBusyId('');
    }
  }

  return (
    <>
      <PageTitle
        eyebrow="RUNTIME INSTANCES"
        title="机器人"
        description="查看已注册的 Bot 实例、平台网关连接与插件加载状态，并按权限重启实例。"
        actions={<Button onClick={state.reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      {actionError && <Notice tone="danger">{actionError}</Notice>}

      <DataState loading={state.loading && !state.data} error={state.error} onRetry={state.reload}>
        <div className="stat-grid">
          <StatCard label="实例总数" value={formatNumber(instances.length)} note="Runtime 快照" icon={<Bot size={17} />} />
          <StatCard
            label="运行中"
            value={`${running}/${instances.length}`}
            note="正在运行的实例"
            icon={<Power size={17} />}
            tone={instances.length > 0 && running === instances.length ? 'success' : undefined}
          />
          <StatCard
            label="网关在线"
            value={`${connected}/${instances.length}`}
            note="平台连接状态"
            icon={<Server size={17} />}
            tone={instances.length > 0 && connected < instances.length ? 'warning' : undefined}
          />
          <StatCard label="活跃会话" value={formatNumber(sessions)} note="实例上报会话数合计" icon={<Activity size={17} />} />
        </div>

        <Panel
          title="运行实例"
          description={`${instances.length} 个实例 · ${running} 个运行中 · ${connected} 个网关在线`}
        >
          <DataState
            empty={instances.length === 0}
            emptyTitle="没有运行实例"
            emptyDetail="Runtime 尚未注册任何 Bot 实例。"
          >
            <Table minWidth={960}>
              <thead>
                <tr>
                  <th>实例</th>
                  <th>适配器</th>
                  <th>Provider</th>
                  <th>网关</th>
                  <th>延迟</th>
                  <th>重连</th>
                  <th>会话</th>
                  <th>状态</th>
                  <th>插件</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((bot) => {
                  const open = openIds.includes(bot.id);
                  const plugins = pluginSummary(bot.plugins);
                  return (
                    <Fragment key={bot.id}>
                      <tr className={open ? 'selectable-row' : undefined}>
                        <td>
                          <div className="table-primary">{bot.name || bot.id}</div>
                          <small className="muted-text mono">{bot.id}</small>
                        </td>
                        <td>{bot.adapter || '—'}</td>
                        <td>
                          {bot.provider || '—'}
                          <br />
                          <small className="muted-text mono">{bot.model || '—'}</small>
                        </td>
                        <td>
                          {bot.gateway?.connected
                            ? <Pill tone="success">已连接</Pill>
                            : <Pill tone="warning">未连接</Pill>}
                        </td>
                        <td>{fmtPing(bot.gateway?.ping)}</td>
                        <td>{formatNumber(bot.gateway?.reconnects ?? 0)}</td>
                        <td>{formatNumber(bot.sessions ?? 0)}</td>
                        <td>
                          {bot.running ? <Pill tone="success">运行中</Pill> : <Pill tone="danger">已停止</Pill>}
                          {bot.state && <div><small className="muted-text">{bot.state}</small></div>}
                        </td>
                        <td>
                          {formatNumber(plugins.count)}
                          {plugins.errors > 0 && <div><Pill tone="danger">{plugins.errors} 错误</Pill></div>}
                        </td>
                        <td className="table-actions">
                          <Button
                            variant="ghost"
                            aria-expanded={open}
                            onClick={() => toggleRow(bot.id)}
                          >
                            <Plug size={15} /> 详情
                          </Button>
                          {canRestart ? (
                            <Button
                              variant="danger"
                              busy={busyId === bot.id}
                              disabled={busyId !== '' && busyId !== bot.id}
                              onClick={() => { void restart(bot); }}
                            >
                              <RotateCw size={15} /> 重启
                            </Button>
                          ) : (
                            <span className="muted-text">只读</span>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={10}>
                            <GatewayDetail botId={bot.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
