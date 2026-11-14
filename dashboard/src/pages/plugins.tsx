import { useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Boxes,
  Brain,
  Database,
  KeyRound,
  Network,
  Plug,
  Puzzle,
  RefreshCw,
  Search,
  TriangleAlert,
} from 'lucide-react';
import { api, ApiError, body, confirmedRequest, hasPermission } from '../lib/api';
import type { BotSnapshot, PageProps, PluginRecord } from '../lib/types';
import { useAsync, useDebouncedValue } from '../lib/hooks';
import { formatNumber } from '../lib/format';
import {
  Button,
  DataState,
  EmptyState,
  Field,
  Notice,
  PageTitle,
  Panel,
  Pill,
  Select,
  StatCard,
  Table,
  Tabs,
} from '../components/ui';

/* ------------------------------------------------------------------ *
 * Runtime plugin inventory (per bot instance)                         *
 * ------------------------------------------------------------------ */

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

type PluginFilter = 'all' | 'failing' | 'healthy';

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

function matchesPlugin(plugin: PluginRecord, bot: BotSnapshot, needle: string): boolean {
  if (!needle) return true;
  return plugin.id.toLowerCase().includes(needle)
    || bot.id.toLowerCase().includes(needle)
    || (bot.name ?? '').toLowerCase().includes(needle);
}

/** Plugin ids can contain characters that interact with the URL, so encode both. */
function reloadPath(botId: string, pluginId: string): string {
  return `/bots/${encodeURIComponent(botId)}/plugins/${encodeURIComponent(pluginId)}/reload`;
}

/* ------------------------------------------------------------------ *
 * Extension registry inventory (provider / gateway / storage / memory)  *
 * ------------------------------------------------------------------ */

/**
 * One registry entry as returned by `GET /api/extensions`. `source` follows the
 * runtime convention: `builtin`, `extension:<file>` or `plugin:<botId>:<id>`.
 */
interface ExtensionEntry {
  name: string;
  source: string;
  description?: string;
  needsKey?: boolean;
}

interface ExtensionsResponse {
  extensions?: {
    providers?: ExtensionEntry[];
    gateways?: ExtensionEntry[];
    storages?: ExtensionEntry[];
    memories?: ExtensionEntry[];
  };
}

type ExtensionCategory = 'providers' | 'gateways' | 'storages' | 'memories';

interface ExtensionRow extends ExtensionEntry {
  category: ExtensionCategory;
  categoryLabel: string;
}

const EXTENSION_CATEGORIES: Array<{ id: ExtensionCategory; label: string; icon: ReactNode }> = [
  { id: 'providers', label: '模型供应商', icon: <Boxes size={13} /> },
  { id: 'gateways', label: '网关', icon: <Network size={13} /> },
  { id: 'storages', label: '存储驱动', icon: <Database size={13} /> },
  { id: 'memories', label: '记忆适配器', icon: <Brain size={13} /> },
];

type SourceKind = 'builtin' | 'extension' | 'plugin' | 'unknown';

const SOURCE_LABELS: Record<SourceKind, string> = {
  builtin: '内置',
  extension: '扩展',
  plugin: '插件',
  unknown: '未知',
};

/** Classifies a registry `source` string into builtin / extension / plugin. */
function sourceKind(source: string): SourceKind {
  const value = String(source ?? '').trim();
  if (value === 'builtin') return 'builtin';
  if (value.startsWith('extension:')) return 'extension';
  if (value.startsWith('plugin:')) return 'plugin';
  return 'unknown';
}

const EXTENSION_SEARCH_FIELDS = (row: ExtensionRow): unknown[] => [
  row.name,
  row.source,
  row.description ?? '',
  row.categoryLabel,
];

/* ------------------------------------------------------------------ */

type TabId = 'runtime' | 'registry';

export function Plugins({ permissions }: PageProps) {
  const state = useAsync(loadPluginGroups, [], '读取插件列表失败');
  const canReload = hasPermission(permissions, 'plugin.reload');
  const canReadExtensions = hasPermission(permissions, 'extensions.read');

  // Only fetch the registry when the principal may read it; otherwise the
  // endpoint would answer 403 and the page would show a guaranteed error.
  const extensionState = useAsync<ExtensionsResponse>(
    async () => (canReadExtensions ? api<ExtensionsResponse>('/extensions') : {}),
    [canReadExtensions],
    '读取扩展注册表失败',
  );

  const [tab, setTab] = useState<TabId>('runtime');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');

  const [query, setQuery] = useState('');
  const [pluginFilter, setPluginFilter] = useState<PluginFilter>('all');
  const [registryQuery, setRegistryQuery] = useState('');
  const [registryCategory, setRegistryCategory] = useState<ExtensionCategory | 'all'>('all');
  const debouncedQuery = useDebouncedValue(query, 200);
  const debouncedRegistryQuery = useDebouncedValue(registryQuery, 200);

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

  const needle = debouncedQuery.trim().toLowerCase();
  const filteredGroups = useMemo(() => groups
    .map((group) => ({
      ...group,
      plugins: group.plugins.filter((plugin) => {
        const failing = FAILURE_PATTERN.test(plugin.state);
        if (pluginFilter === 'failing' && !failing) return false;
        if (pluginFilter === 'healthy' && failing) return false;
        return matchesPlugin(plugin, group.bot, needle);
      }),
    }))
    .filter((group) => Boolean(group.error)
      || group.plugins.length > 0
      || (!needle && pluginFilter === 'all')), [groups, needle, pluginFilter]);

  const filtersActive = needle.length > 0 || pluginFilter !== 'all';

  const extensionRows = useMemo<ExtensionRow[]>(() => {
    const extensions = extensionState.data?.extensions;
    if (!extensions) return [];
    return EXTENSION_CATEGORIES.flatMap(({ id, label }) =>
      (extensions[id] ?? []).map((entry) => ({ ...entry, category: id, categoryLabel: label })));
  }, [extensionState.data]);

  const extensionStats = useMemo(() => {
    const byKind: Record<SourceKind, number> = { builtin: 0, extension: 0, plugin: 0, unknown: 0 };
    let needsKey = 0;
    const categories = new Set<ExtensionCategory>();
    for (const row of extensionRows) {
      byKind[sourceKind(row.source)] += 1;
      if (row.needsKey) needsKey += 1;
      categories.add(row.category);
    }
    return { total: extensionRows.length, needsKey, categories: categories.size, byKind };
  }, [extensionRows]);

  const registryNeedle = debouncedRegistryQuery.trim().toLowerCase();
  const filteredExtensions = useMemo(() => extensionRows.filter((row) => {
    if (registryCategory !== 'all' && row.category !== registryCategory) return false;
    if (!registryNeedle) return true;
    return EXTENSION_SEARCH_FIELDS(row).some((value) => String(value ?? '').toLowerCase().includes(registryNeedle));
  }), [extensionRows, registryCategory, registryNeedle]);

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

  const tabOptions = useMemo(() => {
    const options: Array<{ value: TabId; label: string; count?: number }> = [
      { value: 'runtime', label: '运行时插件', count: stats.totalPlugins },
    ];
    if (canReadExtensions) {
      options.push({ value: 'registry', label: '扩展注册表', count: extensionRows.length });
    }
    return options;
  }, [canReadExtensions, stats.totalPlugins, extensionRows.length]);

  const activeTab: TabId = tabOptions.some((option) => option.value === tab) ? tab : 'runtime';

  return (
    <>
      <PageTitle
        eyebrow="PLUGIN RUNTIME"
        title="插件管理"
        description="按运行实例查看本地已安装插件的状态与错误计数，并在二次确认后重载单个插件；扩展注册表只读展示运行时已注册的能力提供方。"
        actions={<Button onClick={state.reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      <Notice tone="info" icon={<Plug size={17} />}>
        本页仅管理本机已安装的插件，没有远程插件市场，也不提供任意安装或卸载能力。重载失败不会替换当前健康实例，服务端仍会独立校验每次请求。
      </Notice>

      {actionError && <Notice tone="danger" icon={<AlertCircle size={17} />}>{actionError}</Notice>}
      {actionNotice && <Notice tone="info" icon={<Plug size={17} />}>{actionNotice}</Notice>}

      <Tabs value={activeTab} options={tabOptions} onChange={setTab} ariaLabel="插件与扩展视图" />

      {activeTab === 'runtime' && (
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

          {groups.length > 0 && (
            <div className="toolbar">
              <div className="search-field grow">
                <Search size={14} />
                <input
                  value={query}
                  placeholder="按插件或实例搜索…"
                  aria-label="搜索插件"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Field label="状态">
                <Select
                  aria-label="插件状态过滤"
                  value={pluginFilter}
                  onChange={(event) => setPluginFilter(event.target.value as PluginFilter)}
                >
                  <option value="all">全部</option>
                  <option value="failing">仅异常</option>
                  <option value="healthy">仅正常</option>
                </Select>
              </Field>
            </div>
          )}

          {filteredGroups.length === 0 ? (
            <EmptyState title="没有匹配的插件" detail="调整搜索或状态筛选后再试。" />
          ) : (
            <div className="plugin-groups">
              {filteredGroups.map((group) => {
                const botName = group.bot.name || group.bot.id;
                const failing = group.plugins.filter((plugin) => FAILURE_PATTERN.test(plugin.state)).length;
                return (
                  <Panel
                    key={group.bot.id}
                    title={botName}
                    description={`实例 ${group.bot.id} · 平台 ${group.bot.adapter || '未知'} · ${group.plugins.length} 个插件`}
                    action={(
                      <div className="row gap-sm">
                        {failing > 0 && (
                          <Pill tone="danger"><TriangleAlert size={12} /> {failing} 个异常</Pill>
                        )}
                        {group.bot.running ? <Pill tone="success">运行中</Pill> : <Pill tone="danger">已停止</Pill>}
                      </div>
                    )}
                  >
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
                            <tr>
                              <td colSpan={4} className="muted-text">
                                {filtersActive ? '当前筛选条件下该实例没有匹配的插件' : '该实例暂无已安装插件'}
                              </td>
                            </tr>
                          )}
                          {group.plugins.map((plugin) => {
                            const key = `${group.bot.id}:${plugin.id}`;
                            const isBusy = Boolean(busy[key]);
                            const errors = Number(plugin.errors) || 0;
                            return (
                              <tr key={plugin.id}>
                                <td><span className="table-primary mono">{plugin.id}</span></td>
                                <td><Pill tone={failureTone(plugin.state)}>{plugin.state || '未知'}</Pill></td>
                                <td className={errors > 0 ? 'text-danger mono' : 'mono'}>{formatNumber(errors)}</td>
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

                    {failing > 0 && (
                      <p className="muted-text">该实例存在异常插件；重载只会重建这一个插件，不会影响其他实例。</p>
                    )}
                  </Panel>
                );
              })}
            </div>
          )}
        </DataState>
      )}

      {activeTab === 'registry' && canReadExtensions && (
        <DataState
          loading={extensionState.loading && extensionState.data === undefined}
          error={extensionState.error}
          onRetry={extensionState.reload}
          empty={extensionState.data !== undefined && extensionRows.length === 0}
          emptyTitle="注册表为空"
          emptyDetail="运行时的四个扩展注册表都没有注册项；内置能力或 extensions/ 模块未被加载。"
        >
          <div className="stat-grid">
            <StatCard
              label="注册项"
              value={formatNumber(extensionStats.total)}
              note={`覆盖 ${formatNumber(extensionStats.categories)} / 4 个分类`}
              icon={<Puzzle size={17} />}
            />
            <StatCard
              label="内置"
              value={formatNumber(extensionStats.byKind.builtin)}
              note="运行时自带"
              icon={<Boxes size={17} />}
            />
            <StatCard
              label="扩展"
              value={formatNumber(extensionStats.byKind.extension)}
              note="extensions/ 模块注册"
              icon={<Plug size={17} />}
            />
            <StatCard
              label="插件"
              value={formatNumber(extensionStats.byKind.plugin)}
              note="plugin.json 装载"
              icon={<Puzzle size={17} />}
            />
          </div>

          <Panel
            title="扩展注册表"
            description={`共 ${formatNumber(extensionStats.total)} 项能力提供方，其中 ${formatNumber(extensionStats.needsKey)} 项需要密钥；来源区分内置、扩展与插件。`}
            action={<Pill tone="neutral">只读</Pill>}
          >
            <div className="toolbar">
              <div className="search-field grow">
                <Search size={14} />
                <input
                  value={registryQuery}
                  placeholder="按名称、来源或描述搜索…"
                  aria-label="搜索扩展注册项"
                  onChange={(event) => setRegistryQuery(event.target.value)}
                />
              </div>
              <Field label="分类">
                <Select
                  aria-label="扩展分类过滤"
                  value={registryCategory}
                  onChange={(event) => setRegistryCategory(event.target.value as ExtensionCategory | 'all')}
                >
                  <option value="all">全部分类</option>
                  {EXTENSION_CATEGORIES.map((category) => (
                    <option key={category.id} value={category.id}>{category.label}</option>
                  ))}
                </Select>
              </Field>
            </div>

            {filteredExtensions.length === 0 ? (
              <EmptyState title="没有匹配的注册项" detail="调整搜索或分类筛选后再试。" />
            ) : (
              <Table minWidth={880}>
                <thead>
                  <tr>
                    <th>分类</th>
                    <th>名称</th>
                    <th>来源</th>
                    <th>标识</th>
                    <th>密钥</th>
                    <th>描述</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredExtensions.map((row) => (
                    <tr key={`${row.category}:${row.name}`}>
                      <td>
                        <span className="row gap-sm">
                          {EXTENSION_CATEGORIES.find((category) => category.id === row.category)?.icon}
                          {row.categoryLabel}
                        </span>
                      </td>
                      <td><span className="table-primary mono">{row.name}</span></td>
                      <td><Pill tone="neutral">{SOURCE_LABELS[sourceKind(row.source)]}</Pill></td>
                      <td><span className="mono muted-text truncate-cell">{row.source || '—'}</span></td>
                      <td>
                        {row.needsKey
                          ? <Pill tone="info"><KeyRound size={12} /> 需密钥</Pill>
                          : <span className="muted-text">免密钥</span>}
                      </td>
                      <td className="truncate-cell" title={row.description ?? ''}>
                        {row.description ? <span className="muted-text">{row.description}</span> : <span className="muted-text">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        </DataState>
      )}
    </>
  );
}
