import { useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, Boxes, Cpu, HeartPulse, RefreshCw, Search, Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import type { PageProps } from '../lib/types';
import { useAsync, useHashParam } from '../lib/hooks';
import { formatNumber, formatRelative } from '../lib/format';
import {
  Button, Collapsible, DataState, Descriptions, EmptyState, ErrorState, Field, Modal, Notice,
  PageTitle, Panel, Pill, Select, StatCard, Table, Tabs, TextInput,
} from '../components/ui';

/* ------------------------------------------------------------------ *
 * Response shapes (mirrors src/ai/model-catalog.ts, model-operations.ts
 * and health-coordinator.ts). The page normalises every payload through
 * guards, so partially-populated or older responses never crash it.
 * ------------------------------------------------------------------ */

interface CatalogModelView {
  id: string;
  name: string;
  provider: string;
  contextLength?: number;
  capabilities: string[];
  freeEndpoint?: boolean;
  description?: string;
}

interface CatalogView {
  source?: string;
  fetchedAt?: string;
  totalModels?: number;
  freeEndpointCount?: number;
  models: CatalogModelView[];
}

interface ProfileHealthView {
  key: string;
  modelId: string;
  availability: string;
  circuit?: string;
  latencyMs?: number;
  consecutiveFailures: number;
  checkedAt?: number;
}

interface BotHealthView {
  botId: string;
  generatedAt?: number;
  configured: boolean;
  profiles: ProfileHealthView[];
}

interface ModelOperationView {
  profileId: string;
  modelId: string;
  availability: string;
  circuit: string;
  latencyMs?: number;
  consecutiveFailures: number;
}

interface BotSummaryView {
  botId: string;
  botName: string;
  running: boolean;
  provider: string;
  model: string;
  sessions: number;
  healthModels: ModelOperationView[];
  usage?: { calls: number; input: number; output: number };
}

interface ProviderSummaryView {
  provider: string;
  modelCount: number;
  availableCount: number;
  avgLatencyMs: number | null;
  models: ModelOperationView[];
}

interface ModelEventView {
  at: number;
  kind: string;
  lane?: string;
  model?: string;
  detail: string;
}

interface DashboardView {
  generatedAt?: number;
  totals: { bots: number; running: number; models: number; availableModels: number };
  bots: BotSummaryView[];
  providers: ProviderSummaryView[];
  events: ModelEventView[];
}

interface UsageRowView { module: string; name: string; calls: number; input: number; output: number; }
interface UsageDetailView {
  botId: string;
  botName: string;
  running: boolean;
  provider: string;
  model: string;
  models: ModelOperationView[];
  usage: UsageRowView[];
}

interface ProviderHealthDetailView {
  provider: string;
  bots: Array<{ botId: string; botName: string; model: string }>;
  models: ModelOperationView[];
  avgLatencyMs: number | null;
  availableCount: number;
  totalCount: number;
}

interface ModelsData {
  catalog?: CatalogView;
  catalogError?: string;
  recommendations: CatalogModelView[];
  healthBots: BotHealthView[];
  healthError?: string;
  dashboard?: DashboardView;
  dashboardError?: string;
  failures: string[];
}

type ModelsTab = 'catalog' | 'health' | 'ops';
type EndpointFilter = 'all' | 'free';

const TAB_VALUES: ModelsTab[] = ['catalog', 'health', 'ops'];

/** Task lanes the catalog can recommend against (src/ai/model-catalog.ts). */
const TASK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'reply', label: '回复 reply' },
  { value: 'vision', label: '视觉 vision' },
  { value: 'embedding', label: '向量 embedding' },
  { value: 'rerank', label: '重排 rerank' },
  { value: 'planner', label: '规划 planner' },
  { value: 'reflection', label: '反思 reflection' },
  { value: 'summary', label: '摘要 summary' },
  { value: 'world', label: '世界 world' },
  { value: 'translation', label: '翻译 translation' },
  { value: 'safety', label: '安全 safety' },
];

/* ------------------------------ guards ---------------------------- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function errorText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : '读取失败';
}

function describeError(prefix: string, cause: unknown): string {
  return `${prefix}：${errorText(cause)}`;
}

/* --------------------------- normalisers -------------------------- */

function normalizeCatalogModel(value: unknown): CatalogModelView {
  const record = asRecord(value) ?? {};
  const id = asString(record.id) ?? '—';
  return {
    id,
    name: asString(record.name) ?? id,
    provider: asString(record.provider) ?? asString(record.publisher) ?? '—',
    contextLength: asNumber(record.contextLength),
    capabilities: asArray(record.capabilities)
      .map((capability) => asString(capability))
      .filter((capability): capability is string => Boolean(capability)),
    freeEndpoint: asBool(record.freeEndpoint),
    description: asString(record.description),
  };
}

function normalizeCatalog(raw: unknown): CatalogView | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  return {
    source: asString(record.source),
    fetchedAt: asString(record.fetchedAt),
    totalModels: asNumber(record.totalModels),
    freeEndpointCount: asNumber(record.freeEndpointCount),
    models: asArray(record.models).map(normalizeCatalogModel),
  };
}

function normalizeProfileHealth(value: unknown, fallbackKey: string): ProfileHealthView {
  const record = asRecord(value) ?? {};
  return {
    key: asString(record.profileId) ?? asString(record.id) ?? fallbackKey,
    modelId: asString(record.modelId) ?? asString(record.model) ?? fallbackKey,
    availability: asString(record.availability) ?? 'unknown',
    circuit: asString(record.circuit),
    latencyMs: asNumber(record.latencyMs),
    consecutiveFailures: asNumber(record.consecutiveFailures) ?? 0,
    checkedAt: asNumber(record.checkedAt),
  };
}

function snapshotProfiles(raw: unknown): ProfileHealthView[] {
  const record = asRecord(raw);
  if (!record) return [];
  if (Array.isArray(record.profiles)) {
    return record.profiles.map((profile, index) => normalizeProfileHealth(profile, `profile-${index + 1}`));
  }
  const models = asRecord(record.models);
  if (models) {
    return Object.entries(models).map(([key, value]) => normalizeProfileHealth(value, key));
  }
  return [];
}

function normalizeHealth(raw: unknown): BotHealthView[] {
  const record = asRecord(raw);
  if (!record) return [];
  // A bare HealthSnapshot has `profiles`/`models` at the top level.
  if (Array.isArray(record.profiles) || asRecord(record.models)) {
    return [{ botId: 'runtime', generatedAt: asNumber(record.generatedAt), configured: true, profiles: snapshotProfiles(record) }];
  }
  const bots: BotHealthView[] = [];
  for (const [botId, value] of Object.entries(record)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const configured = entry.configured !== false;
    bots.push({
      botId,
      generatedAt: asNumber(entry.generatedAt),
      configured,
      profiles: configured ? snapshotProfiles(entry) : [],
    });
  }
  return bots;
}

function normalizeModelOperation(value: unknown): ModelOperationView {
  const record = asRecord(value) ?? {};
  return {
    profileId: asString(record.profileId) ?? asString(record.id) ?? '—',
    modelId: asString(record.modelId) ?? asString(record.model) ?? '—',
    availability: asString(record.availability) ?? 'unknown',
    circuit: asString(record.circuit) ?? 'closed',
    latencyMs: asNumber(record.latencyMs),
    consecutiveFailures: asNumber(record.consecutiveFailures) ?? 0,
  };
}

function normalizeOpsModels(raw: unknown): ModelOperationView[] {
  const record = asRecord(raw);
  if (!record) return [];
  return asArray(record.models).map(normalizeModelOperation);
}

function normalizeDashboard(raw: unknown): DashboardView | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const totals = asRecord(record.totals) ?? {};
  return {
    generatedAt: asNumber(record.generatedAt),
    totals: {
      bots: asNumber(totals.bots) ?? 0,
      running: asNumber(totals.running) ?? 0,
      models: asNumber(totals.models) ?? 0,
      availableModels: asNumber(totals.availableModels) ?? 0,
    },
    bots: asArray(record.bots).map((entry) => {
      const bot = asRecord(entry) ?? {};
      const usage = asRecord(bot.usage);
      return {
        botId: asString(bot.botId) ?? '—',
        botName: asString(bot.botName) ?? asString(bot.botId) ?? '—',
        running: asBool(bot.running) ?? false,
        provider: asString(bot.provider) ?? '—',
        model: asString(bot.model) ?? '—',
        sessions: asNumber(bot.sessions) ?? 0,
        healthModels: normalizeOpsModels(bot.health),
        usage: usage
          ? { calls: asNumber(usage.calls) ?? 0, input: asNumber(usage.input) ?? 0, output: asNumber(usage.output) ?? 0 }
          : undefined,
      };
    }),
    providers: asArray(record.providers).map((entry) => {
      const provider = asRecord(entry) ?? {};
      return {
        provider: asString(provider.provider) ?? '—',
        modelCount: asNumber(provider.modelCount) ?? 0,
        availableCount: asNumber(provider.availableCount) ?? 0,
        avgLatencyMs: asNumber(provider.avgLatencyMs) ?? null,
        models: asArray(provider.models).map(normalizeModelOperation),
      };
    }),
    events: asArray(record.events).map((entry) => {
      const event = asRecord(entry) ?? {};
      return {
        at: asNumber(event.at) ?? 0,
        kind: asString(event.kind) ?? 'event',
        lane: asString(event.lane),
        model: asString(event.model),
        detail: asString(event.detail) ?? '',
      };
    }),
  };
}

function normalizeUsage(raw: unknown): UsageDetailView | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  return {
    botId: asString(record.botId) ?? '—',
    botName: asString(record.botName) ?? asString(record.botId) ?? '—',
    running: asBool(record.running) ?? false,
    provider: asString(record.provider) ?? '—',
    model: asString(record.model) ?? '—',
    models: normalizeOpsModels(record.health),
    usage: asArray(record.usage).map((entry) => {
      const row = asRecord(entry) ?? {};
      return {
        module: asString(row.module) ?? '—',
        name: asString(row.name) ?? '—',
        calls: asNumber(row.calls) ?? 0,
        input: asNumber(row.input) ?? 0,
        output: asNumber(row.output) ?? 0,
      };
    }),
  };
}

function normalizeProviderHealth(raw: unknown): ProviderHealthDetailView | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  return {
    provider: asString(record.provider) ?? '—',
    bots: asArray(record.bots).map((entry) => {
      const bot = asRecord(entry) ?? {};
      return {
        botId: asString(bot.botId) ?? '—',
        botName: asString(bot.botName) ?? asString(bot.botId) ?? '—',
        model: asString(bot.model) ?? '—',
      };
    }),
    models: asArray(record.models).map(normalizeModelOperation),
    avgLatencyMs: asNumber(record.avgLatencyMs) ?? null,
    availableCount: asNumber(record.availableCount) ?? 0,
    totalCount: asNumber(record.totalCount) ?? 0,
  };
}

/* ------------------------------ loader ---------------------------- */

async function loadModels(task: string): Promise<ModelsData> {
  const query = task ? `?task=${encodeURIComponent(task)}` : '';
  const [catalogResult, healthResult, dashboardResult] = await Promise.allSettled([
    api<unknown>(`/models${query}`),
    api<unknown>('/models/health'),
    api<unknown>('/models/dashboard'),
  ]);

  const failures: string[] = [];
  const data: ModelsData = { recommendations: [], healthBots: [], failures };

  if (catalogResult.status === 'fulfilled') {
    const envelope = asRecord(catalogResult.value);
    data.catalog = normalizeCatalog(envelope?.catalog);
    data.recommendations = asArray(envelope?.recommendations).map(normalizeCatalogModel);
  } else {
    data.catalogError = describeError('模型目录', catalogResult.reason);
    failures.push(data.catalogError);
  }

  if (healthResult.status === 'fulfilled') {
    data.healthBots = normalizeHealth(asRecord(healthResult.value)?.health);
  } else {
    data.healthError = describeError('模型健康', healthResult.reason);
    failures.push(data.healthError);
  }

  if (dashboardResult.status === 'fulfilled') {
    data.dashboard = normalizeDashboard(asRecord(dashboardResult.value)?.dashboard);
  } else {
    data.dashboardError = describeError('运营看板', dashboardResult.reason);
    failures.push(data.dashboardError);
  }

  return data;
}

/* ------------------------------ badges ---------------------------- */

function availabilityTone(value: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (value === 'available') return 'success';
  if (value === 'open' || value === 'unavailable') return 'danger';
  if (value === 'stale' || value === 'unknown') return 'warning';
  return 'neutral';
}

function availabilityLabel(value: string): string {
  switch (value) {
    case 'available': return '可用';
    case 'unavailable': return '不可用';
    case 'open': return '熔断';
    case 'stale': return '过期';
    case 'unknown': return '未知';
    default: return value;
  }
}

const CIRCUIT_LABEL: Record<string, string> = { closed: '闭合', open: '断开', 'half-open': '半开' };

function circuitTone(value: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (value === 'closed') return 'success';
  if (value === 'half-open') return 'warning';
  if (value === 'open') return 'danger';
  return 'neutral';
}

function availabilityPill(value: string) {
  return <Pill tone={availabilityTone(value)}>{availabilityLabel(value)}</Pill>;
}

function circuitPill(value: string) {
  return <Pill tone={circuitTone(value)}>{CIRCUIT_LABEL[value] ?? value}</Pill>;
}

function contextLabel(value: number | undefined): string {
  return value === undefined ? '—' : formatNumber(value);
}

function endpointPill(value: boolean | undefined) {
  if (value === undefined) return <span className="muted-text">—</span>;
  return value ? <Pill tone="success">免费</Pill> : <Pill tone="neutral">付费</Pill>;
}

/* --------------------- shared health/catalog tables ---------------- *
 * Every model-health surface (per-bot health, usage drill-down,
 * provider drill-down) renders the same columns, so they share one
 * table with optional Profile and 延迟 columns. The catalog and its
 * task recommendations share one table with optional 能力/端点 columns.
 * ------------------------------------------------------------------ */

interface HealthRow {
  key: string;
  model: string;
  availability: string;
  circuit?: string;
  latencyMs?: number;
  failures: number;
}

function profileRows(bot: BotHealthView): HealthRow[] {
  return bot.profiles.map((profile) => ({
    key: profile.key,
    model: profile.modelId,
    availability: profile.availability,
    circuit: profile.circuit,
    latencyMs: profile.latencyMs,
    failures: profile.consecutiveFailures,
  }));
}

function operationRows(models: ModelOperationView[]): HealthRow[] {
  return models.map((model) => ({
    key: model.profileId,
    model: model.modelId,
    availability: model.availability,
    circuit: model.circuit,
    latencyMs: model.latencyMs,
    failures: model.consecutiveFailures,
  }));
}

function HealthTable({ rows, minWidth = 620, showProfile = false, showLatency = true }: {
  rows: HealthRow[];
  minWidth?: number;
  showProfile?: boolean;
  showLatency?: boolean;
}) {
  return (
    <Table minWidth={minWidth}>
      <thead>
        <tr>
          {showProfile && <th>Profile</th>}
          <th>模型</th>
          <th>可用性</th>
          <th>熔断</th>
          {showLatency && <th>延迟</th>}
          <th>连续失败</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            {showProfile && <td className="mono">{row.key}</td>}
            <td className="mono truncate-cell" title={row.model}>{row.model}</td>
            <td>{availabilityPill(row.availability)}</td>
            <td>{row.circuit ? circuitPill(row.circuit) : '—'}</td>
            {showLatency && <td className="nowrap">{row.latencyMs === undefined ? '—' : `${formatNumber(row.latencyMs)} ms`}</td>}
            <td>{formatNumber(row.failures)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function CatalogTable({ models, minWidth, showCapabilities = true, showEndpoint = false }: {
  models: CatalogModelView[];
  minWidth: number;
  showCapabilities?: boolean;
  showEndpoint?: boolean;
}) {
  return (
    <Table minWidth={minWidth}>
      <thead>
        <tr>
          <th>名称</th>
          <th>供应商</th>
          {showCapabilities && <th>能力</th>}
          <th>上下文长度</th>
          <th>模型 ID</th>
          {showEndpoint && <th>端点</th>}
        </tr>
      </thead>
      <tbody>
        {models.map((model) => (
          <tr key={model.id}>
            <td>
              <div className="table-primary">{model.name}</div>
              {model.description && <small className="muted-text">{model.description}</small>}
            </td>
            <td>{model.provider}</td>
            {showCapabilities && <td>{model.capabilities.length ? model.capabilities.join('、') : '—'}</td>}
            <td className="nowrap">{contextLabel(model.contextLength)}</td>
            <td className="mono truncate-cell" title={model.id}>{model.id}</td>
            {showEndpoint && <td>{endpointPill(model.freeEndpoint)}</td>}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/* ------------------------------ page ------------------------------ */

export function Models({}: PageProps) {
  const [tabParam, setTabParam] = useHashParam('tab', 'catalog');
  const activeTab: ModelsTab = (TAB_VALUES as string[]).includes(tabParam) ? tabParam as ModelsTab : 'catalog';
  const [task, setTask] = useState('');
  const [selectedBot, setSelectedBot] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('');

  const state = useAsync(() => loadModels(task), [task], '读取模型运营数据失败');
  const data = state.data;

  const catalog = data?.catalog;
  const models = catalog?.models ?? [];
  const dashboard = data?.dashboard;
  const healthBots = data?.healthBots ?? [];

  const [query, setQuery] = useState('');
  const [endpoint, setEndpoint] = useState<EndpointFilter>('all');
  const needle = query.trim().toLowerCase();
  const filteredModels = useMemo(() => {
    const scoped = endpoint === 'free' ? models.filter((model) => model.freeEndpoint === true) : models;
    if (!needle) return scoped;
    return scoped.filter((model) => (
      [model.name, model.id, model.provider, ...model.capabilities]
        .some((field) => field.toLowerCase().includes(needle))
    ));
  }, [models, needle, endpoint]);

  const healthProfiles = useMemo(() => healthBots.flatMap((bot) => bot.profiles), [healthBots]);
  const availableProfiles = healthProfiles.filter((profile) => profile.availability === 'available').length;
  const openCircuits = healthProfiles.filter((profile) => profile.circuit && profile.circuit !== 'closed').length;
  const configuredBots = healthBots.filter((bot) => bot.configured).length;
  const providerCount = dashboard?.providers.length
    ?? new Set(models.map((model) => model.provider)).size;

  const fallbackEvents = dashboard?.events.filter((event) => event.kind === 'fallback').length;

  const usageState = useAsync(async () => {
    if (!selectedBot) return undefined;
    return normalizeUsage(asRecord(await api<unknown>(`/models/usage/${encodeURIComponent(selectedBot)}`))?.usage);
  }, [selectedBot], '读取模型用量失败');

  const providerState = useAsync(async () => {
    if (!selectedProvider) return undefined;
    return normalizeProviderHealth(asRecord(await api<unknown>(`/models/health/${encodeURIComponent(selectedProvider)}`))?.health);
  }, [selectedProvider], '读取供应商健康失败');

  const reload = () => state.reload();

  const healthTone: 'success' | 'warning' | 'danger' | undefined =
    healthProfiles.length === 0
      ? undefined
      : availableProfiles === healthProfiles.length
        ? 'success'
        : availableProfiles === 0
          ? 'danger'
          : 'warning';

  const circuitAlertTone: 'success' | 'warning' | 'danger' | undefined =
    healthProfiles.length === 0 ? undefined : openCircuits > 0 ? 'danger' : 'success';

  const catalogNote = catalog?.totalModels !== undefined
    ? `条目 ${formatNumber(catalog.models.length)} / 收录 ${formatNumber(catalog.totalModels)}`
    : '来自模型目录快照';

  const catalogDescription = catalog
    ? [
      `${formatNumber(catalog.models.length)} 个条目`,
      catalog.freeEndpointCount !== undefined ? `免费端点 ${formatNumber(catalog.freeEndpointCount)}` : undefined,
      `来源 ${catalog.source ?? '—'}`,
      `抓取于 ${formatRelative(catalog.fetchedAt)}`,
    ].filter(Boolean).join(' · ')
    : '尚未加载目录快照。';

  return (
    <>
      <PageTitle
        eyebrow="MODEL OPERATIONS"
        title="模型运营"
        description="参考模型目录、探测健康与跨机器人运营看板；所有数字均来自管理 API 实时快照。"
        actions={<Button onClick={reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      {data && data.failures.length > 0 && (
        <Notice tone="warning" icon={<AlertTriangle size={17} />}>
          部分数据源不可用：{data.failures.join('；')}
        </Notice>
      )}

      <DataState loading={state.loading && !data} error={state.error} onRetry={reload}>
        <div className="stat-grid">
          <StatCard
            label="模型可用"
            value={healthProfiles.length ? `${availableProfiles}/${healthProfiles.length}` : (configuredBots ? '无探测' : '未配置')}
            note={healthProfiles.length ? `已探测 ${formatNumber(healthProfiles.length)} 个模型` : '尚未返回健康探测'}
            icon={<HeartPulse size={17} />}
            tone={healthTone}
          />
          <StatCard
            label="熔断中"
            value={healthProfiles.length ? formatNumber(openCircuits) : '—'}
            note={healthProfiles.length ? (openCircuits > 0 ? '存在断开 / 半开熔断' : '全部熔断闭合') : '尚无健康探测'}
            icon={<Zap size={17} />}
            tone={circuitAlertTone}
          />
          <StatCard
            label="回退事件"
            value={dashboard ? formatNumber(fallbackEvents ?? 0) : '—'}
            note={dashboard ? `近 ${formatNumber(dashboard.events.length)} 条运营事件` : '暂无运营快照'}
            icon={<Activity size={17} />}
            tone={fallbackEvents ? 'warning' : undefined}
          />
          <StatCard
            label="目录模型数"
            value={formatNumber(catalog?.models.length ?? 0)}
            note={catalogNote}
            icon={<Cpu size={17} />}
          />
          <StatCard
            label="Provider 数"
            value={formatNumber(providerCount)}
            note={dashboard ? '运营看板聚合' : '目录去重统计'}
            icon={<Boxes size={17} />}
          />
        </div>

        <div className="row row-between toolbar">
          <Tabs
            value={activeTab}
            ariaLabel="模型运营视图"
            onChange={(next) => setTabParam(next)}
            options={[
              { value: 'catalog', label: '目录', count: catalog?.models.length },
              { value: 'health', label: '健康', count: healthBots.length },
              { value: 'ops', label: '运营', count: dashboard?.bots.length },
            ]}
          />
          <Field label="任务推荐">
            <Select value={task} onChange={(event) => setTask(event.target.value)} aria-label="任务推荐">
              <option value="">全部模型</option>
              {TASK_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </Field>
        </div>

        {activeTab === 'catalog' && (
          <>
            <Panel title="模型目录" description={catalogDescription}>
              <div className="toolbar">
                <label className="search-field grow">
                  <Search size={14} />
                  <TextInput
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索名称 / 供应商 / 能力…"
                    aria-label="搜索模型目录"
                  />
                </label>
                <Field label="端点">
                  <Select
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value as EndpointFilter)}
                    aria-label="端点筛选"
                  >
                    <option value="all">全部端点</option>
                    <option value="free">仅免费端点</option>
                  </Select>
                </Field>
              </div>
              <DataState
                error={data?.catalogError}
                empty={filteredModels.length === 0}
                emptyTitle={needle || endpoint === 'free' ? '没有匹配的模型' : '目录为空'}
                emptyDetail={needle || endpoint === 'free' ? '尝试更换关键词或清除端点筛选。' : '模型目录尚未收录任何条目。'}
                onRetry={reload}
              >
                <CatalogTable models={filteredModels} minWidth={900} showEndpoint />
              </DataState>
            </Panel>

            {task && (
              <Panel
                title="任务推荐"
                description={data?.recommendations.length
                  ? `任务 ${task} 的推荐模型 ${formatNumber(data.recommendations.length)} 个`
                  : `任务 ${task} 暂无推荐模型`}
              >
                {data?.catalogError ? (
                  <ErrorState message={data.catalogError} retry={reload} />
                ) : data?.recommendations.length ? (
                  <CatalogTable models={data.recommendations} minWidth={720} />
                ) : (
                  <EmptyState title="暂无推荐" detail="该任务在当前目录与可用性下没有匹配模型。" />
                )}
              </Panel>
            )}
          </>
        )}

        {activeTab === 'health' && (
          <Panel title="模型健康" description={`${formatNumber(healthBots.length)} 个配置的探测目标。`}>
            {data?.healthError ? (
              <ErrorState message={data.healthError} retry={reload} />
            ) : healthBots.length === 0 ? (
              <EmptyState title="暂无健康探测" detail="模型健康协调器尚未返回任何探测结果。" />
            ) : (
              <div className="col">
                {healthBots.map((bot) => {
                  const rows = profileRows(bot);
                  const available = bot.profiles.filter((profile) => profile.availability === 'available').length;
                  const open = bot.profiles.filter((profile) => profile.circuit && profile.circuit !== 'closed').length;
                  const needsAttention = available < bot.profiles.length || open > 0;
                  return (
                    <Collapsible
                      key={bot.botId}
                      title={bot.botId}
                      defaultOpen={healthBots.length === 1 || needsAttention}
                      meta={<span className="muted-text">{bot.configured ? `可用 ${formatNumber(available)}/${formatNumber(bot.profiles.length)}` : '未配置'}</span>}
                    >
                      {!bot.configured ? (
                        <Notice tone="info" icon={<HeartPulse size={16} />}>该机器人未启用模型健康探测。</Notice>
                      ) : rows.length === 0 ? (
                        <EmptyState title="无探测记录" detail="此目标暂未返回 profile 健康数据。" />
                      ) : (
                        <>
                          <Descriptions columns={2} items={[
                            { label: 'Profile 数', value: formatNumber(bot.profiles.length) },
                            { label: '可用 Profile', value: formatNumber(available) },
                            { label: '熔断', value: open > 0 ? <Pill tone="warning">{formatNumber(open)} 个</Pill> : <Pill tone="success">正常</Pill> },
                            { label: '快照时间', value: bot.generatedAt ? formatRelative(bot.generatedAt) : '—' },
                          ]} />
                          <HealthTable rows={rows} minWidth={640} showProfile />
                        </>
                      )}
                    </Collapsible>
                  );
                })}
              </div>
            )}
          </Panel>
        )}

        {activeTab === 'ops' && (
          <>
            {data?.dashboardError ? (
              <Panel title="运营看板"><ErrorState message={data.dashboardError} retry={reload} /></Panel>
            ) : !dashboard ? (
              <Panel title="运营看板"><EmptyState title="暂无运营数据" detail="运营看板尚未返回聚合快照。" /></Panel>
            ) : (
              <>
                <Panel title="运营概要" description={`聚合于 ${dashboard.generatedAt ? formatRelative(dashboard.generatedAt) : '—'}`}>
                  <Descriptions columns={3} items={[
                    { label: 'Bot 数', value: `${formatNumber(dashboard.totals.running)}/${formatNumber(dashboard.totals.bots)} 运行` },
                    { label: '模型数', value: `${formatNumber(dashboard.totals.availableModels)}/${formatNumber(dashboard.totals.models)} 可用` },
                    { label: 'Provider 数', value: formatNumber(dashboard.providers.length) },
                    { label: '事件数', value: formatNumber(dashboard.events.length) },
                  ]} />
                </Panel>

                <Panel title="机器人模型状态" description={`${formatNumber(dashboard.bots.length)} 个机器人实例。点击查看用量明细。`}>
                  <DataState
                    empty={dashboard.bots.length === 0}
                    emptyTitle="没有机器人实例"
                    emptyDetail="当前运行时没有配置任何机器人。"
                  >
                    <Table minWidth={860}>
                      <thead><tr><th>实例</th><th>Provider</th><th>模型</th><th>状态</th><th>会话</th><th>模型数</th><th>熔断</th><th></th></tr></thead>
                      <tbody>
                        {dashboard.bots.map((bot) => {
                          const openC = bot.healthModels.filter((model) => model.circuit !== 'closed').length;
                          return (
                            <tr key={bot.botId} className="selectable-row">
                              <td><div className="table-primary">{bot.botName}</div><small className="muted-text mono">{bot.botId}</small></td>
                              <td>{bot.provider}</td>
                              <td className="mono truncate-cell" title={bot.model}>{bot.model}</td>
                              <td>{bot.running ? <Pill tone="success">运行中</Pill> : <Pill tone="danger">已停止</Pill>}</td>
                              <td>{formatNumber(bot.sessions)}</td>
                              <td>{formatNumber(bot.healthModels.length)}</td>
                              <td>{openC === 0 ? <Pill tone="success">正常</Pill> : <Pill tone="warning">{formatNumber(openC)} 个</Pill>}</td>
                              <td className="table-actions">
                                <Button variant="ghost" onClick={() => setSelectedBot(bot.botId)}>用量</Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </Table>
                  </DataState>
                </Panel>

                <Panel title="Provider 聚合" description={`${formatNumber(dashboard.providers.length)} 个 provider。点击查看健康明细。`}>
                  <DataState
                    empty={dashboard.providers.length === 0}
                    emptyTitle="没有 Provider"
                    emptyDetail="运营看板未聚合到任何 provider。"
                  >
                    <Table minWidth={760}>
                      <thead><tr><th>Provider</th><th>模型数</th><th>可用</th><th>平均延迟</th><th></th></tr></thead>
                      <tbody>
                        {dashboard.providers.map((provider) => (
                          <tr key={provider.provider}>
                            <td className="table-primary">{provider.provider}</td>
                            <td>{formatNumber(provider.modelCount)}</td>
                            <td>{formatNumber(provider.availableCount)}</td>
                            <td className="nowrap">{provider.avgLatencyMs === null ? '—' : `${formatNumber(provider.avgLatencyMs)} ms`}</td>
                            <td className="table-actions">
                              <Button variant="ghost" onClick={() => setSelectedProvider(provider.provider)}>健康</Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </DataState>
                </Panel>

                <Panel title="模型运营事件" description={`最近 ${formatNumber(dashboard.events.length)} 条 lane / fallback / circuit 事件。`}>
                  {dashboard.events.length === 0 ? (
                    <EmptyState title="暂无事件" detail="尚未记录模型运营事件。" />
                  ) : (
                    <div className="timeline">
                      {dashboard.events.map((event, index) => (
                        <div className="timeline-item" key={`${event.at}:${index}`}>
                          <span className="timeline-marker" />
                          <div>
                            <div className="row">
                              <Pill tone={event.kind === 'circuit' ? 'danger' : event.kind === 'fallback' ? 'warning' : 'info'}>{event.kind}</Pill>
                              <span className="muted-text">{formatRelative(event.at)}</span>
                            </div>
                            <p className="prewrap">{event.detail}</p>
                            {(event.model || event.lane) && (
                              <small className="muted-text mono">
                                {event.lane ? `lane=${event.lane}` : ''}{event.lane && event.model ? ' · ' : ''}{event.model ? `model=${event.model}` : ''}
                              </small>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>
              </>
            )}
          </>
        )}
      </DataState>

      <Modal
        open={Boolean(selectedBot)}
        onClose={() => setSelectedBot('')}
        title={usageState.data ? `模型用量 · ${usageState.data.botName}` : `模型用量 · ${selectedBot}`}
        description="按模块统计的近期调用与 token 用量，以及该机器人当前的模型健康。"
        width={720}
      >
        <DataState
          loading={usageState.loading && !usageState.data}
          error={usageState.error || undefined}
          onRetry={selectedBot ? () => usageState.reload() : undefined}
        >
          {usageState.data && (
            <>
              <Descriptions columns={2} items={[
                { label: '机器人', value: usageState.data.botName },
                { label: '运行状态', value: usageState.data.running ? <Pill tone="success">运行中</Pill> : <Pill tone="danger">已停止</Pill> },
                { label: 'Provider', value: usageState.data.provider },
                { label: '模型', value: <span className="mono">{usageState.data.model}</span> },
              ]} />
              {usageState.data.usage.length === 0 ? (
                <EmptyState title="暂无用量记录" detail="该机器人在统计窗口内没有调用记录。" />
              ) : (
                <Table minWidth={560}>
                  <thead><tr><th>模块</th><th>名称</th><th>调用</th><th>输入</th><th>输出</th></tr></thead>
                  <tbody>
                    {usageState.data.usage.map((row, index) => (
                      <tr key={`${row.module}:${row.name}:${index}`}>
                        <td>{row.module}</td>
                        <td>{row.name}</td>
                        <td>{formatNumber(row.calls)}</td>
                        <td>{formatNumber(row.input)}</td>
                        <td>{formatNumber(row.output)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {usageState.data.models.length > 0 && (
                <HealthTable rows={operationRows(usageState.data.models)} minWidth={560} showLatency={false} />
              )}
            </>
          )}
        </DataState>
      </Modal>

      <Modal
        open={Boolean(selectedProvider)}
        onClose={() => setSelectedProvider('')}
        title={providerState.data ? `Provider 健康 · ${providerState.data.provider}` : `Provider 健康 · ${selectedProvider}`}
        description="该 provider 下所有机器人与模型的探测结果。"
        width={720}
      >
        <DataState
          loading={providerState.loading && !providerState.data}
          error={providerState.error || undefined}
          onRetry={selectedProvider ? () => providerState.reload() : undefined}
        >
          {providerState.data && (
            <>
              <Descriptions columns={2} items={[
                { label: '可用模型', value: `${formatNumber(providerState.data.availableCount)}/${formatNumber(providerState.data.totalCount)}` },
                { label: '平均延迟', value: providerState.data.avgLatencyMs === null ? '—' : `${formatNumber(providerState.data.avgLatencyMs)} ms` },
                { label: '关联机器人', value: formatNumber(providerState.data.bots.length) },
                { label: '模型探测数', value: formatNumber(providerState.data.models.length) },
              ]} />
              {providerState.data.models.length === 0 ? (
                <EmptyState title="暂无模型健康" detail="该 provider 尚未返回模型探测数据。" />
              ) : (
                <HealthTable rows={operationRows(providerState.data.models)} minWidth={620} />
              )}
            </>
          )}
        </DataState>
      </Modal>
    </>
  );
}
