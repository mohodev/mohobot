import { useCallback, useMemo } from 'react';
import { Activity, Bot, Cpu, Gauge, HeartPulse, RefreshCw, Server, Wifi, WifiOff } from 'lucide-react';
import { api } from '../lib/api';
import type { BotSnapshot, HealthSnapshot, PageProps } from '../lib/types';
import { useAsync, usePolling, useToggle } from '../lib/hooks';
import { formatDuration, formatNumber, formatRelative, formatTime } from '../lib/format';
import { Button, DataState, Descriptions, Notice, PageTitle, Panel, Pill, StatCard, Table, Switch } from '../components/ui';

interface StatusResponse { now?: string; bots?: BotSnapshot[]; }
interface HealthResponse { health?: HealthSnapshot; }
interface MetricsResponse { metrics?: Record<string, unknown>; }

interface OverviewData {
  now: string;
  bots: BotSnapshot[];
  health: HealthSnapshot;
  metrics: Record<string, unknown>;
  failures: string[];
}

async function loadOverview(): Promise<OverviewData> {
  const [status, health, metrics] = await Promise.allSettled([
    api<StatusResponse>('/status'),
    api<HealthResponse>('/admin/health'),
    api<MetricsResponse>('/metrics'),
  ]);
  const failures: string[] = [];
  let now = new Date().toISOString();
  let bots: BotSnapshot[] = [];
  if (status.status === 'fulfilled') {
    now = status.value.now ?? now;
    bots = Array.isArray(status.value.bots) ? status.value.bots : [];
  } else {
    failures.push(`运行状态：${errorText(status.reason)}`);
  }
  let healthValue: HealthSnapshot = {};
  if (health.status === 'fulfilled') healthValue = health.value.health ?? {};
  else failures.push(`依赖健康：${errorText(health.reason)}`);
  let metricsValue: Record<string, unknown> = {};
  if (metrics.status === 'fulfilled') metricsValue = metrics.value.metrics ?? {};
  else failures.push(`运行指标：${errorText(metrics.reason)}`);
  return { now, bots, health: healthValue, metrics: metricsValue, failures };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : '读取失败';
}

function numeric(metrics: Record<string, unknown>, key: string): number | undefined {
  const value = metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function Overview({}: PageProps) {
  const state = useAsync(loadOverview, [], '读取运行总览失败');
  const [auto, setAuto] = useToggle(true);
  const reload = useCallback(() => state.reload(), [state]);
  usePolling(reload, 10000, auto);

  const data = state.data;
  const bots = data?.bots ?? [];
  const online = useMemo(() => bots.filter((bot) => Boolean(bot.running || bot.gateway?.connected)).length, [bots]);
  const connected = useMemo(() => bots.filter((bot) => bot.gateway?.connected).length, [bots]);
  const sessions = useMemo(() => bots.reduce((sum, bot) => sum + Number(bot.sessions ?? 0), 0), [bots]);
  const pings = bots.map((bot) => bot.gateway?.ping).filter((ping): ping is number => typeof ping === 'number' && ping >= 0);
  const avgPing = pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : undefined;
  const runtimeState = String(data?.health.runtime ?? (bots.length ? 'up' : 'idle'));
  const requestsTotal = data ? numeric(data.metrics, 'requests') ?? numeric(data.metrics, 'requestCount') : undefined;
  const errorsTotal = data ? numeric(data.metrics, 'errors') ?? numeric(data.metrics, 'errorCount') : undefined;

  return (
    <>
      <PageTitle
        eyebrow="RUNTIME OVERVIEW"
        title="运行总览"
        description="查看机器人运行状态、平台连接、会话规模与运行指标快照。"
        actions={<>
          <Switch checked={auto} onChange={(next) => setAuto(next)} label="自动刷新" />
          <Button onClick={reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>
        </>}
      />

      {data && data.failures.length > 0 && (
        <Notice tone="warning" icon={<HeartPulse size={17} />}>
          部分数据源不可用：{data.failures.join('；')}
        </Notice>
      )}

      <DataState loading={state.loading && !data} error={state.error} onRetry={reload}>
        <div className="stat-grid">
          <StatCard label="运行中的 Bot" value={`${online}/${bots.length}`} note="运行或网关在线" icon={<Bot size={17} />} tone={bots.length && online === bots.length ? 'success' : undefined} />
          <StatCard label="活跃会话" value={formatNumber(sessions)} note="来自 Runtime 快照" icon={<Activity size={17} />} />
          <StatCard label="连接中的网关" value={`${connected}/${bots.length}`} note="平台连接状态" icon={<Server size={17} />} tone={bots.length && connected < bots.length ? 'warning' : undefined} />
          <StatCard label="平均网关延迟" value={avgPing === undefined ? '—' : `${avgPing} ms`} note="已连接实例" icon={<Gauge size={17} />} />
        </div>

        <div className="content-grid content-grid-wide">
          <Panel title="机器人实例" description={`${bots.length} 个已注册实例`}>
            <DataState empty={bots.length === 0} emptyTitle="没有运行实例" emptyDetail="尚未发现可展示的 Bot 快照。">
              <Table minWidth={720}>
                <thead><tr><th>实例</th><th>平台</th><th>Provider</th><th>网关</th><th>延迟</th><th>会话</th><th>状态</th></tr></thead>
                <tbody>{bots.map((bot) => (
                  <tr key={bot.id}>
                    <td><div className="table-primary">{bot.name || bot.id}</div><small className="muted-text mono">{bot.id}</small></td>
                    <td>{bot.adapter || '—'}</td>
                    <td>{bot.provider || '—'}<br /><small className="muted-text mono">{bot.model || '—'}</small></td>
                    <td>{bot.gateway?.connected
                      ? <Pill tone="success"><Wifi size={12} /> 已连接</Pill>
                      : <Pill tone="warning"><WifiOff size={12} /> 离线</Pill>}</td>
                    <td>{bot.gateway?.ping == null || bot.gateway.ping < 0 ? '—' : `${bot.gateway.ping} ms`}</td>
                    <td>{formatNumber(bot.sessions ?? 0)}</td>
                    <td>{bot.running ? <Pill tone="success">运行中</Pill> : <Pill tone="danger">已停止</Pill>}</td>
                  </tr>
                ))}</tbody>
              </Table>
            </DataState>
          </Panel>

          <div className="col">
            <Panel title="运行健康" description="依赖健康与运行指标快照。">
              <Descriptions columns={1} items={[
                { label: 'Runtime 状态', value: <Pill tone={runtimeState === 'up' ? 'success' : 'warning'}>{runtimeState === 'up' ? '运行中' : runtimeState}</Pill> },
                { label: 'Bot 数量', value: formatNumber(data?.health.bots ?? bots.length) },
                { label: '请求计数', value: requestsTotal === undefined ? '—' : formatNumber(requestsTotal) },
                { label: '错误计数', value: errorsTotal === undefined ? '—' : formatNumber(errorsTotal) },
                { label: '快照时间', value: formatTime(data?.now) },
                { label: '数据年龄', value: formatRelative(data?.now) },
              ]} />
            </Panel>
            <Panel title="运行提示" description="首轮重建的管理面能力。">
              <div className="info-list">
                <div><span className="info-icon"><Cpu size={16} /></span><div><strong>低风险只读总览</strong><p>此页面只读取状态、健康与指标快照，不触发模型调用或修改运行状态。</p></div></div>
                <div><span className="info-icon"><Activity size={16} /></span><div><strong>按权限显示功能</strong><p>导航与操作入口依据服务端返回的权限列表过滤，服务端仍执行最终授权。</p></div></div>
                <div><span className="info-icon"><HeartPulse size={16} /></span><div><strong>部分失败可降级</strong><p>任一数据源不可用时其余面板仍会渲染，并在顶部给出告警。</p></div></div>
              </div>
            </Panel>
          </div>
        </div>

        {data && Object.keys(data.metrics).length > 0 && (
          <Panel title="运行指标" description={`${Object.keys(data.metrics).length} 个指标字段，原样展示权限过滤后的快照。`}>
            <Descriptions columns={3} items={Object.entries(data.metrics).slice(0, 12).map(([key, value]) => ({
              label: key,
              value: typeof value === 'number' ? formatNumber(value) : String(value),
            }))} />
            {typeof data.metrics.uptimeMs === 'number' && <p className="muted-text mt-2">运行时长：{formatDuration(data.metrics.uptimeMs)}</p>}
          </Panel>
        )}
      </DataState>
    </>
  );
}
