import { useMemo } from 'react';
import { Activity, Bot, HeartPulse, RefreshCw, Server, Wifi, WifiOff } from 'lucide-react';
import { api } from '../lib/api';
import type { BotSnapshot, HealthSnapshot, PageProps } from '../lib/types';
import { useAsync, usePolling, useToggle } from '../lib/hooks';
import { formatDuration, formatNumber, formatRelative, formatTime } from '../lib/format';
import { Button, DataState, Descriptions, EmptyState, Notice, PageTitle, Panel, Pill, StatCard, Table, Switch } from '../components/ui';

/* ------------------------------------------------------------------ *
 * Response envelopes (server truth in src/admin/route-policy.ts and
 * src/admin/api-routes). Only the fields this page reads are typed.
 * ------------------------------------------------------------------ */

interface StatusResponse { now?: string; bots?: BotSnapshot[]; }
interface HealthResponse { health?: HealthSnapshot; }
interface MetricsResponse { metrics?: Record<string, unknown>; }

interface OverviewData {
  loadedAt: string;
  now: string;
  /** True only when the runtime status snapshot was fetched successfully. */
  statusOk: boolean;
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
  const loadedAt = new Date().toISOString();
  let now = loadedAt;
  let statusOk = false;
  let bots: BotSnapshot[] = [];
  if (status.status === 'fulfilled') {
    statusOk = true;
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
  return { loadedAt, now, statusOk, bots, health: healthValue, metrics: metricsValue, failures };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : '读取失败';
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function runtimeLabel(runtime: string): string {
  if (runtime === 'up') return '运行中';
  if (runtime === 'idle') return '空闲';
  if (runtime === 'down') return '不可用';
  return runtime || '未知';
}

/** Scalar metrics only; structured objects belong to the 服务健康 page. */
function scalarMetrics(metrics: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(metrics)
    .filter(([, value]) => typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
    .map(([key, value]) => [key, typeof value === 'number' ? formatNumber(value) : String(value)]);
}

export function Overview({}: PageProps) {
  const state = useAsync(loadOverview, [], '读取运行总览失败');
  const [auto, setAuto] = useToggle(true);
  usePolling(state.reload, 10000, auto);

  const data = state.data;
  const bots = data?.bots ?? [];
  const online = useMemo(() => bots.filter((bot) => Boolean(bot.running || bot.gateway?.connected)).length, [bots]);
  const connected = useMemo(() => bots.filter((bot) => bot.gateway?.connected).length, [bots]);
  const sessions = useMemo(() => bots.reduce((sum, bot) => sum + Number(bot.sessions ?? 0), 0), [bots]);
  const pings = useMemo(
    () => bots.map((bot) => bot.gateway?.ping).filter((ping): ping is number => typeof ping === 'number' && ping >= 0),
    [bots],
  );
  const avgPing = pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : undefined;
  const runtimeState = String(data?.health.runtime ?? (data?.statusOk ? (bots.length ? 'up' : 'idle') : 'down'));
  const requestsTotal = data ? finite(data.metrics.requests) ?? finite(data.metrics.requestCount) : undefined;
  const errorsTotal = data ? finite(data.metrics.errors) ?? finite(data.metrics.errorCount) : undefined;
  const scalars = useMemo(() => (data ? scalarMetrics(data.metrics) : []), [data]);

  return (
    <>
      <PageTitle
        eyebrow="RUNTIME OVERVIEW"
        title="运行总览"
        description="查看机器人运行状态、平台连接、会话规模与运行指标快照。数据每 10 秒自动刷新，单点失败只降级对应区块。"
        actions={<>
          <Switch checked={auto} onChange={(next) => setAuto(next)} label="自动刷新" />
          <Button onClick={state.reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>
        </>}
      />

      <div className="toolbar">
        <Pill tone={auto ? 'success' : 'neutral'}>
          <Activity size={12} /> {auto ? '自动刷新 10 秒' : '手动刷新'}
        </Pill>
        <span className="muted-text">最近更新：{formatTime(data?.loadedAt)}</span>
        {data?.statusOk && <span className="muted-text mono">快照时间 {formatTime(data.now)}</span>}
        {data && (data.failures.length > 0
          ? <Pill tone="warning">{data.failures.length} 个数据源不可用</Pill>
          : <Pill tone="success">全部数据源正常</Pill>)}
      </div>

      {data && data.failures.length > 0 && (
        <Notice tone="warning" icon={<HeartPulse size={17} />}>
          部分数据源不可用：{data.failures.join('；')}。其余区块已独立降级展示。
        </Notice>
      )}

      <DataState loading={state.loading && !data} error={state.error} onRetry={state.reload}>
        <div className="stat-grid">
          <StatCard
            label="Runtime 状态"
            value={runtimeLabel(runtimeState)}
            note={data?.failures.some((failure) => failure.startsWith('依赖健康')) ? '健康快照不可用' : `快照：${runtimeState}`}
            icon={<HeartPulse size={17} />}
            tone={runtimeState === 'up' ? 'success' : 'warning'}
          />
          <StatCard
            label="运行中的 Bot"
            value={`${online}/${bots.length}`}
            note={bots.length && online < bots.length ? `${bots.length - online} 个未就绪` : '全部就绪'}
            icon={<Bot size={17} />}
            tone={bots.length && online === bots.length ? 'success' : undefined}
          />
          <StatCard
            label="连接中的网关"
            value={`${connected}/${bots.length}`}
            note={avgPing === undefined ? '暂无可用延迟' : `平均延迟 ${avgPing} ms`}
            icon={<Server size={17} />}
            tone={bots.length && connected < bots.length ? 'warning' : undefined}
          />
          <StatCard
            label="活跃会话"
            value={formatNumber(sessions)}
            note={data?.statusOk ? `${bots.length} 个实例合计` : '运行状态不可用'}
            icon={<Activity size={17} />}
          />
        </div>

        <div className="content-grid content-grid-wide">
          <Panel title="机器人实例" description={`${bots.length} 个已注册实例`}>
            {data && !data.statusOk ? (
              <Notice tone="danger" icon={<WifiOff size={17} />}>
                运行状态不可用：{data.failures.find((failure) => failure.startsWith('运行状态'))?.replace('运行状态：', '') ?? '读取失败'}
              </Notice>
            ) : bots.length === 0 ? (
              <EmptyState title="没有运行实例" detail="尚未发现可展示的 Bot 快照。" />
            ) : (
              <Table minWidth={720}>
                <thead><tr><th>实例</th><th>平台</th><th>Provider / 模型</th><th>网关</th><th>延迟</th><th>会话</th><th>状态</th></tr></thead>
                <tbody>{bots.map((bot) => (
                  <tr key={bot.id}>
                    <td><div className="table-primary">{bot.name || bot.id}</div><small className="muted-text mono">{bot.id}</small></td>
                    <td>{bot.adapter || '—'}</td>
                    <td>{bot.provider || '—'}<br /><small className="muted-text mono truncate-cell">{bot.model || '—'}</small></td>
                    <td>{bot.gateway?.connected
                      ? <Pill tone="success"><Wifi size={12} /> 已连接</Pill>
                      : <Pill tone="warning"><WifiOff size={12} /> 离线</Pill>}
                      {typeof bot.gateway?.reconnects === 'number' && bot.gateway.reconnects > 0 && (
                        <div><small className="muted-text">重连 {formatNumber(bot.gateway.reconnects)} 次</small></div>
                      )}
                    </td>
                    <td>{bot.gateway?.ping == null || bot.gateway.ping < 0 ? '—' : `${bot.gateway.ping} ms`}</td>
                    <td>{formatNumber(bot.sessions ?? 0)}</td>
                    <td>{bot.running ? <Pill tone="success">运行中</Pill> : <Pill tone="danger">已停止</Pill>}</td>
                  </tr>
                ))}</tbody>
              </Table>
            )}
          </Panel>

          <Panel title="运行健康" description="依赖健康与请求计数快照。">
            <Descriptions columns={1} items={[
              { label: 'Bot 数量', value: formatNumber(data?.health.bots ?? bots.length) },
              { label: '请求计数', value: requestsTotal === undefined ? '—' : formatNumber(requestsTotal) },
              { label: '错误计数', value: errorsTotal === undefined ? '—' : formatNumber(errorsTotal) },
              { label: '快照时间', value: formatTime(data?.now) },
              { label: '数据年龄', value: formatRelative(data?.now) },
            ]} />
          </Panel>
        </div>

        {data && scalars.length > 0 && (
          <Panel title="运行指标" description={`${scalars.length} 个指标字段，原样展示权限过滤后的快照。完整延迟与缓存分解见「服务健康」。`}>
            <Descriptions columns={3} items={scalars.map(([label, value]) => ({ label, value }))} />
            {typeof data.metrics.uptimeMs === 'number' && <p className="muted-text mt-2">运行时长：{formatDuration(data.metrics.uptimeMs)}</p>}
          </Panel>
        )}
      </DataState>
    </>
  );
}
