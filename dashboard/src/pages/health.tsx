import { useCallback, useMemo, useState } from 'react';
import {
  Activity,
  Bot,
  Database,
  Gauge,
  HeartPulse,
  ListChecks,
  RefreshCw,
  Server,
  ShieldAlert,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import type { BotSnapshot, HealthSnapshot, PageProps } from '../lib/types';
import { useAsync, usePolling, useToggle } from '../lib/hooks';
import { formatNumber, formatPercent, formatTime } from '../lib/format';
import {
  Button,
  DataState,
  Descriptions,
  EmptyState,
  Notice,
  PageTitle,
  Panel,
  Pill,
  StatCard,
  Switch,
  Table,
  Tabs,
} from '../components/ui';

/* ------------------------------------------------------------------ *
 * Response envelopes (server truth in src/admin/api-routes/ops.ts and
 * src/admin/api-router.ts). Only the fields this page reads are typed;
 * the snapshot objects stay loose records so newer builds keep working.
 * ------------------------------------------------------------------ */

interface HealthResponse { health?: HealthSnapshot; }
interface MetricsResponse { metrics?: Record<string, unknown>; }
interface StatusResponse { now?: string; bots?: BotSnapshot[]; }

interface ActionRecord {
  id: string;
  title: string;
  risk: string;
  confirmation: boolean;
  description: string;
}
interface ActionsResponse { actions?: ActionRecord[]; }

/** LatencyMetric.summary() from src/core/metrics.ts. */
interface LatencySummary { count: number; failures: number; p50Ms: number; p95Ms: number; averageMs: number; }
/** CacheMetric.snapshot() from src/core/metrics.ts. */
interface CacheSummary { hits: number; misses: number; ratio: number; }

interface MetricsView {
  latency: Array<{ key: string; label: string; value: LatencySummary }>;
  cache: Array<{ key: string; label: string; value: CacheSummary }>;
  /** Scalar metrics that are not part of the known tooling shape. */
  scalars: Array<{ key: string; value: number | string | boolean }>;
}

interface SectionFailure { section: string; message: string; }

interface HealthData {
  loadedAt: string;
  now: string;
  runtime: string;
  healthBots: number | undefined;
  metrics: MetricsView | undefined;
  bots: BotSnapshot[] | undefined;
  actions: ActionRecord[] | undefined;
  failures: SectionFailure[];
}

/**
 * Metrics keys this page understands structurally; anything else is surfaced
 * as a labelled scalar fallback rather than a raw JSON dump.
 */
const KNOWN_LATENCY: Array<{ key: string; label: string }> = [
  { key: 'ai', label: 'AI 推理' },
  { key: 'embedding', label: '向量嵌入' },
  { key: 'rerank', label: '重排序' },
];
const KNOWN_CACHE: Array<{ key: string; label: string }> = [
  { key: 'world', label: '世界缓存' },
  { key: 'device', label: '设备缓存' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorText(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return '读取失败';
}

function parseLatency(value: unknown): LatencySummary | undefined {
  if (!isRecord(value)) return undefined;
  const count = finite(value.count);
  if (count === undefined) return undefined;
  return {
    count,
    failures: finite(value.failures) ?? 0,
    p50Ms: finite(value.p50Ms) ?? 0,
    p95Ms: finite(value.p95Ms) ?? 0,
    averageMs: finite(value.averageMs) ?? 0,
  };
}

function parseCache(value: unknown): CacheSummary | undefined {
  if (!isRecord(value)) return undefined;
  const hits = finite(value.hits);
  const misses = finite(value.misses);
  if (hits === undefined && misses === undefined) return undefined;
  return { hits: hits ?? 0, misses: misses ?? 0, ratio: finite(value.ratio) ?? 0 };
}

/**
 * Interprets the runtime-metrics snapshot. The tooling shape (ai/embedding/
 * rerank latencies plus world/device caches) is rendered structurally; any
 * extra scalar fields are surfaced as a labelled fallback list rather than a
 * raw JSON dump.
 */
function parseMetrics(metrics: Record<string, unknown>): MetricsView {
  const latency: MetricsView['latency'] = [];
  for (const { key, label } of KNOWN_LATENCY) {
    const parsed = parseLatency(metrics[key]);
    if (parsed) latency.push({ key, label, value: parsed });
  }
  const cache: MetricsView['cache'] = [];
  const cacheRoot = metrics.cache;
  if (isRecord(cacheRoot)) {
    for (const { key, label } of KNOWN_CACHE) {
      const parsed = parseCache(cacheRoot[key]);
      if (parsed) cache.push({ key, label, value: parsed });
    }
  }
  const known = new Set<string>([...KNOWN_LATENCY.map((item) => item.key), 'cache']);
  const scalars: MetricsView['scalars'] = [];
  for (const [key, value] of Object.entries(metrics)) {
    if (known.has(key) || isRecord(value)) continue;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      scalars.push({ key, value });
    }
  }
  return { latency, cache, scalars };
}

function parseActions(value: unknown): ActionRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: ActionRecord[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    rows.push({
      id: String(entry.id ?? ''),
      title: String(entry.title ?? entry.id ?? ''),
      risk: String(entry.risk ?? 'read'),
      confirmation: Boolean(entry.confirmation),
      description: String(entry.description ?? ''),
    });
  }
  return rows;
}

async function loadHealth(): Promise<HealthData> {
  const [health, metrics, status, actions] = await Promise.allSettled([
    api<HealthResponse>('/admin/health'),
    api<MetricsResponse>('/metrics'),
    api<StatusResponse>('/status'),
    api<ActionsResponse>('/admin/actions'),
  ]);

  const failures: SectionFailure[] = [];
  const loadedAt = new Date().toISOString();

  let healthValue: HealthSnapshot = {};
  if (health.status === 'fulfilled') {
    healthValue = health.value.health ?? {};
  } else {
    failures.push({ section: '依赖健康', message: errorText(health.reason) });
  }

  let metricsValue: MetricsView | undefined;
  if (metrics.status === 'fulfilled') {
    metricsValue = parseMetrics(metrics.value.metrics ?? {});
  } else {
    failures.push({ section: '运行指标', message: errorText(metrics.reason) });
  }

  let now = loadedAt;
  let bots: BotSnapshot[] | undefined;
  if (status.status === 'fulfilled') {
    now = status.value.now ?? now;
    bots = Array.isArray(status.value.bots) ? status.value.bots : [];
  } else {
    failures.push({ section: '运行状态', message: errorText(status.reason) });
  }

  let actionsValue: ActionRecord[] | undefined;
  if (actions.status === 'fulfilled') {
    actionsValue = parseActions(actions.value.actions) ?? [];
  } else {
    failures.push({ section: '能力清单', message: errorText(actions.reason) });
  }

  return {
    loadedAt,
    now,
    runtime: String(healthValue.runtime ?? ''),
    healthBots: finite(healthValue.bots),
    metrics: metricsValue,
    bots,
    actions: actionsValue,
    failures,
  };
}

const RISK_META: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  read: { label: '只读', tone: 'info' },
  reversible: { label: '可逆', tone: 'neutral' },
  impact: { label: '有影响', tone: 'warning' },
  dangerous: { label: '危险', tone: 'danger' },
};

function riskMeta(risk: string): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' } {
  return RISK_META[risk] ?? { label: risk || '未知', tone: 'neutral' };
}

function failureOf(data: HealthData | undefined, section: string): string {
  return data?.failures.find((failure) => failure.section === section)?.message ?? '读取失败';
}

function runtimeLabel(runtime: string): string {
  if (runtime === 'up') return '运行中';
  if (runtime === 'idle') return '空闲';
  if (runtime === 'down') return '不可用';
  return runtime || '未知';
}

/** An instance is "unhealthy" when it is stopped or its gateway is offline. */
function isUnhealthy(bot: BotSnapshot): boolean {
  return !bot.running || !bot.gateway?.connected;
}

type InstanceFilter = 'all' | 'issues';

export function Health({}: PageProps) {
  const state = useAsync(loadHealth, [], '读取服务健康失败');
  const [auto, setAuto] = useToggle(true);
  const [instanceFilter, setInstanceFilter] = useState<InstanceFilter>('all');
  const reload = useCallback(() => state.reload(), [state]);
  usePolling(reload, 10000, auto);

  const data = state.data;
  const bots = data?.bots ?? [];
  const connected = useMemo(() => bots.filter((bot) => bot.gateway?.connected).length, [bots]);
  const unhealthy = useMemo(() => bots.filter(isUnhealthy).length, [bots]);
  const visibleBots = useMemo(
    () => (instanceFilter === 'issues' ? bots.filter(isUnhealthy) : bots),
    [bots, instanceFilter],
  );
  const pings = useMemo(
    () => bots.map((bot) => bot.gateway?.ping).filter((ping): ping is number => typeof ping === 'number' && ping >= 0),
    [bots],
  );
  const avgPing = pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : undefined;
  const runtimeState = data?.runtime || (bots.length ? 'up' : 'idle');
  const botCount = data?.healthBots ?? bots.length;

  const metrics = data?.metrics;
  const hasMetrics = Boolean(metrics && (metrics.latency.length || metrics.cache.length || metrics.scalars.length));
  const failures = data?.failures ?? [];

  return (
    <>
      <PageTitle
        eyebrow="SERVICE HEALTH"
        title="服务健康"
        description="读取依赖健康、运行指标、实例状态与能力清单。四个数据源独立加载，单点失败只降级对应区块，不会清空页面。"
        actions={<>
          <Switch checked={auto} onChange={(next) => setAuto(next)} label="自动刷新" />
          <Button onClick={reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>
        </>}
      />

      <div className="toolbar">
        <Pill tone={auto ? 'success' : 'neutral'}>
          <Activity size={12} /> {auto ? '自动刷新 10 秒' : '手动刷新'}
        </Pill>
        <span className="muted-text">最近更新：{formatTime(data?.loadedAt)}</span>
        {data?.now && <span className="muted-text mono">快照时间 {formatTime(data.now)}</span>}
        {data && (failures.length > 0
          ? <Pill tone="warning">{failures.length} 个数据源不可用</Pill>
          : <Pill tone="success">全部数据源正常</Pill>)}
      </div>

      {failures.length > 0 && (
        <Notice tone="warning" icon={<HeartPulse size={17} />}>
          以下数据源暂不可用：{failures.map((failure) => failure.section).join('、')}。其余区块已独立降级展示。
        </Notice>
      )}

      <DataState loading={state.loading && !data} error={state.error} onRetry={reload}>
        <div className="stat-grid">
          <StatCard
            label="Runtime 状态"
            value={runtimeLabel(runtimeState)}
            note={`快照：${runtimeState}`}
            icon={<HeartPulse size={17} />}
            tone={runtimeState === 'up' ? 'success' : undefined}
          />
          <StatCard
            label="Bot 数量"
            value={formatNumber(botCount)}
            note={data?.healthBots === undefined ? '来自实例列表' : '来自健康快照'}
            icon={<Bot size={17} />}
          />
          <StatCard
            label="连接中的网关"
            value={`${connected}/${bots.length}`}
            note={unhealthy > 0 ? `${unhealthy} 个实例异常` : '平台连接状态'}
            icon={<Server size={17} />}
            tone={unhealthy > 0 ? 'warning' : undefined}
          />
          <StatCard
            label="平均网关延迟"
            value={avgPing === undefined ? '—' : `${avgPing} ms`}
            note={pings.length ? `${pings.length} 个已连接实例` : '暂无可用延迟'}
            icon={<Gauge size={17} />}
          />
        </div>

        <Panel title="实例健康" description={`${bots.length} 个已注册实例`}>
          {data && data.bots === undefined ? (
            <Notice tone="danger" icon={<WifiOff size={17} />}>
              运行状态不可用：{failureOf(data, '运行状态')}
            </Notice>
          ) : bots.length === 0 ? (
            <EmptyState title="没有运行实例" detail="尚未发现可展示的 Bot 快照。" />
          ) : (
            <>
              <Tabs
                value={instanceFilter}
                options={[
                  { value: 'all', label: '全部实例', count: bots.length },
                  { value: 'issues', label: '异常实例', count: unhealthy },
                ]}
                onChange={setInstanceFilter}
                ariaLabel="实例筛选"
              />
              {visibleBots.length === 0 ? (
                <EmptyState title="没有异常实例" detail="所有实例均在运行且网关已连接。" />
              ) : (
                <Table minWidth={760}>
                  <thead>
                    <tr><th>实例</th><th>平台</th><th>Provider / 模型</th><th>网关</th><th>延迟</th><th>会话</th><th>状态</th></tr>
                  </thead>
                  <tbody>
                    {visibleBots.map((bot) => (
                      <tr key={bot.id}>
                        <td>
                          <div className="table-primary">{bot.name || bot.id}</div>
                          <small className="muted-text mono">{bot.id}</small>
                        </td>
                        <td>{bot.adapter || '—'}</td>
                        <td>
                          {bot.provider || '—'}
                          <br />
                          <small className="muted-text mono truncate-cell">{bot.model || '—'}</small>
                        </td>
                        <td>
                          {bot.gateway?.connected
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
                    ))}
                  </tbody>
                </Table>
              )}
            </>
          )}
        </Panel>

        <Panel
          title="运行指标"
          description={hasMetrics
            ? `${metrics?.latency.length ?? 0} 个延迟指标 · ${metrics?.cache.length ?? 0} 个缓存指标`
            : '运行时指标快照（来自 /api/metrics）'}
        >
          {data && !metrics && (
            <Notice tone="danger" icon={<Zap size={17} />}>
              运行指标不可用：{failureOf(data, '运行指标')}
            </Notice>
          )}
          {metrics && !hasMetrics && (
            <EmptyState title="暂无运行指标" detail="指标快照已返回，但尚未记录延迟、缓存或标量指标。" />
          )}
          {metrics && hasMetrics && (
            <>
              {metrics.latency.length > 0 ? (
                <Table minWidth={640}>
                  <thead>
                    <tr><th>指标</th><th>样本</th><th>失败</th><th>P50</th><th>P95</th><th>平均</th></tr>
                  </thead>
                  <tbody>
                    {metrics.latency.map((row) => (
                      <tr key={row.key}>
                        <td>
                          <div className="table-primary">{row.label}</div>
                          <small className="muted-text mono">{row.key}</small>
                        </td>
                        <td>{formatNumber(row.value.count)}</td>
                        <td>{row.value.failures > 0
                          ? <Pill tone="danger">{formatNumber(row.value.failures)}</Pill>
                          : <Pill tone="success">0</Pill>}</td>
                        <td>{row.value.count ? `${formatNumber(row.value.p50Ms)} ms` : '—'}</td>
                        <td>{row.value.count ? `${formatNumber(row.value.p95Ms)} ms` : '—'}</td>
                        <td>{row.value.count ? `${formatNumber(row.value.averageMs)} ms` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="muted-text">暂无延迟指标样本，尚未记录 AI / 嵌入 / 重排序调用。</p>
              )}

              {metrics.cache.length > 0 && (
                <>
                  <h3 className="mt-2"><Database size={14} /> 缓存命中</h3>
                  <Table minWidth={520}>
                    <thead>
                      <tr><th>缓存</th><th>命中</th><th>未命中</th><th>命中率</th></tr>
                    </thead>
                    <tbody>
                      {metrics.cache.map((row) => (
                        <tr key={row.key}>
                          <td>
                            <div className="table-primary">{row.label}</div>
                            <small className="muted-text mono">{row.key}</small>
                          </td>
                          <td>{formatNumber(row.value.hits)}</td>
                          <td>{formatNumber(row.value.misses)}</td>
                          <td>
                            <div className="row row-between"><span>{formatPercent(row.value.ratio)}</span></div>
                            <div className="meter">
                              <span style={{ width: `${Math.round(row.value.ratio * 100)}%` }} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </>
              )}

              {metrics.scalars.length > 0 && (
                <>
                  <h3 className="mt-2"><Zap size={14} /> 其他指标</h3>
                  <Descriptions columns={3} items={metrics.scalars.map((row) => ({
                    label: row.key,
                    value: typeof row.value === 'number' ? formatNumber(row.value) : String(row.value),
                  }))} />
                </>
              )}
            </>
          )}
        </Panel>

        <Panel title="能力清单" description={`${data?.actions?.length ?? 0} 项已注册的管理操作`}>
          {data && !data.actions && (
            <Notice tone="danger" icon={<ShieldAlert size={17} />}>
              能力清单不可用：{failureOf(data, '能力清单')}
            </Notice>
          )}
          {data?.actions && (
            <DataState empty={data.actions.length === 0} emptyTitle="暂无管理操作" emptyDetail="能力清单为空。">
              <Table minWidth={720}>
                <thead>
                  <tr><th>操作</th><th>风险</th><th>确认</th><th>说明</th></tr>
                </thead>
                <tbody>
                  {data.actions.map((action) => {
                    const meta = riskMeta(action.risk);
                    return (
                      <tr key={action.id}>
                        <td>
                          <div className="table-primary"><ListChecks size={13} /> {action.title}</div>
                          <small className="muted-text mono">{action.id}</small>
                        </td>
                        <td><Pill tone={meta.tone}>{meta.label}</Pill></td>
                        <td>{action.confirmation
                          ? <Pill tone="warning">需确认</Pill>
                          : <Pill tone="neutral">免确认</Pill>}</td>
                        <td className="prewrap muted-text">{action.description || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </DataState>
          )}
        </Panel>
      </DataState>
    </>
  );
}
