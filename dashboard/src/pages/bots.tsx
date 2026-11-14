import { Fragment, useMemo, useState } from 'react';
import {
  Activity,
  Bot,
  ClipboardCheck,
  Database,
  Layers,
  ListChecks,
  Plug,
  Power,
  RefreshCw,
  RotateCw,
  Server,
  ShieldAlert,
  Wand2,
} from 'lucide-react';
import { api, ApiError, body, confirmedRequest } from '../lib/api';
import type { BotSnapshot, PageProps, PluginRecord } from '../lib/types';
import { useAsync } from '../lib/hooks';
import { formatDateTime, formatNumber, prettyJson } from '../lib/format';
import {
  Button,
  Collapsible,
  CopyButton,
  DataState,
  Descriptions,
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
  TextInput,
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

/* ------------------------------------------------------------------ *
 * Guild workspace planner (server truth in src/platform/guild.ts,
 * src/admin/guild-plan.ts and src/admin/api-routes/world.ts). Kept
 * page-local so the frozen shared contract stays untouched.
 * ------------------------------------------------------------------ */

type GuildChannelKind = 'category' | 'text' | 'voice' | 'other';

interface GuildChannelView {
  id: string;
  name: string;
  kind: GuildChannelKind;
  parentId?: string;
  position: number;
  topic?: string;
}

interface GuildRoleView {
  id: string;
  name: string;
  position: number;
  managed: boolean;
}

interface GuildInventory {
  guildId: string;
  name: string;
  ownerId: string;
  communityEnabled: boolean;
  channels: GuildChannelView[];
  roles: GuildRoleView[];
}

type GuildPlanAction =
  | { kind: 'create-category'; name: string }
  | { kind: 'create-text'; category: string; name: string; topic: string }
  | { kind: 'create-voice'; category: string; name: string }
  | { kind: 'move-channel'; channelId: string; category: string }
  | { kind: 'rename-channel'; channelId: string; name: string }
  | { kind: 'set-topic'; channelId: string; topic: string };

interface GuildPlan {
  guildId: string;
  generatedAt: string;
  communityEnabled: false;
  actions: GuildPlanAction[];
  preservedChannelIds: string[];
  summary: { create: number; move: number; rename: number; topic: number };
}

interface GuildInventoryResponse {
  inventory?: GuildInventory;
  digest?: string;
}

interface GuildPlanResponse {
  plan?: GuildPlan;
  inventoryDigest?: string;
}

interface GuildApplyResult {
  applied?: number;
  skipped?: number;
  idempotent?: boolean;
  inventoryDigest?: string;
  results?: Array<{ index: number; status: 'applied' | 'skipped' | 'failed'; error?: string }>;
}

const CHANNEL_KIND_LABEL: Record<GuildChannelKind, string> = {
  category: '分类',
  text: '文字',
  voice: '语音',
  other: '其它',
};

const CHANNEL_KIND_TONE: Record<GuildChannelKind, 'neutral' | 'info' | 'success' | 'warning'> = {
  category: 'neutral',
  text: 'info',
  voice: 'success',
  other: 'warning',
};

const APPLY_STATUS_LABEL: Record<'applied' | 'skipped' | 'failed', string> = {
  applied: '已应用',
  skipped: '已跳过',
  failed: '失败',
};

const APPLY_STATUS_TONE: Record<'applied' | 'skipped' | 'failed', 'success' | 'warning' | 'danger'> = {
  applied: 'success',
  skipped: 'warning',
  failed: 'danger',
};

type GuildBusy = '' | 'inventory' | 'plan' | 'apply';
type BotView = 'instances' | 'guild';

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

/** Describes one plan action for the review table. */
function describeAction(action: GuildPlanAction): { label: string; detail: string } {
  switch (action.kind) {
    case 'create-category':
      return { label: '新建分类', detail: action.name };
    case 'create-text':
      return { label: '新建文字频道', detail: `${action.category} / ${action.name}` };
    case 'create-voice':
      return { label: '新建语音频道', detail: `${action.category} / ${action.name}` };
    case 'move-channel':
      return { label: '移动频道', detail: `${action.channelId} → ${action.category}` };
    case 'rename-channel':
      return { label: '重命名频道', detail: `${action.channelId} → ${action.name}` };
    case 'set-topic':
      return { label: '设置话题', detail: `${action.channelId} → ${action.topic}` };
    default:
      return { label: '未知操作', detail: '—' };
  }
}

/** Idempotency key for a single apply attempt (server caps it at 128 chars). */
function newIdempotencyKey(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `guild-apply-${Date.now().toString(36)}-${random}`;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
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

  const [view, setView] = useState<BotView>('instances');
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [busyId, setBusyId] = useState('');
  const [actionError, setActionError] = useState('');

  const canRestart = permissions.includes('runtime.restart');
  const canGuildRead = permissions.includes('guild.read');
  const canGuildManage = permissions.includes('guild.manage');

  const instances = state.data?.bots ?? [];

  /* ---- guild workspace planner state ---- */
  const [guildBotId, setGuildBotId] = useState('');
  const [guildIdDraft, setGuildIdDraft] = useState('');
  const [inventory, setInventory] = useState<GuildInventory | undefined>();
  const [inventoryDigest, setInventoryDigest] = useState('');
  const [plan, setPlan] = useState<GuildPlan | undefined>();
  const [planDigest, setPlanDigest] = useState('');
  const [planStale, setPlanStale] = useState(false);
  const [applyResult, setApplyResult] = useState<GuildApplyResult | undefined>();
  const [guildBusy, setGuildBusy] = useState<GuildBusy>('');
  const [guildError, setGuildError] = useState('');
  const [plannerUnavailable, setPlannerUnavailable] = useState(false);
  const [guildNotice, setGuildNotice] = useState<{ tone: 'info' | 'warning' | 'danger'; text: string } | undefined>();

  const running = instances.filter((bot) => bot.running === true).length;
  const connected = instances.filter((bot) => bot.gateway?.connected === true).length;
  const sessions = instances.reduce((sum, bot) => sum + Number(bot.sessions ?? 0), 0);

  const guildBot = guildBotId || instances[0]?.id || '';

  const channelNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const channel of inventory?.channels ?? []) map.set(channel.id, channel.name);
    return map;
  }, [inventory]);

  const sortedChannels = useMemo(
    () => [...(inventory?.channels ?? [])].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [inventory],
  );

  const sortedRoles = useMemo(
    () => [...(inventory?.roles ?? [])].sort((a, b) => b.position - a.position || a.name.localeCompare(b.name)),
    [inventory],
  );

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

  /* ---- guild workspace planner actions ---- */

  /** Clears every downstream step whenever the inventory selection changes. */
  function resetPlannerDerived() {
    setPlan(undefined);
    setPlanDigest('');
    setPlanStale(false);
    setApplyResult(undefined);
    setGuildNotice(undefined);
  }

  async function loadInventory(): Promise<void> {
    const guildId = guildIdDraft.trim();
    setGuildError('');
    setPlannerUnavailable(false);
    resetPlannerDerived();
    if (!canGuildRead) {
      setGuildError('当前账号缺少 guild.read 权限，无法读取服务器清单。');
      return;
    }
    if (!guildId) {
      setInventory(undefined);
      setInventoryDigest('');
      setGuildError('请先填写 guildId。');
      return;
    }
    setGuildBusy('inventory');
    try {
      const params = new URLSearchParams();
      params.set('botId', guildBot);
      params.set('guildId', guildId);
      const result = await api<GuildInventoryResponse>(`/guild/inventory?${params.toString()}`);
      if (!result.inventory) throw new ApiError('清单响应缺少 inventory 字段', 500);
      setInventory(result.inventory);
      setInventoryDigest(result.digest ?? '');
    } catch (cause) {
      setInventory(undefined);
      setInventoryDigest('');
      // 409 means the deployment has no guild planner wired in: a disabled
      // state the operator cannot fix by retrying, so show it as such.
      if (cause instanceof ApiError && cause.statusCode === 409) setPlannerUnavailable(true);
      else setGuildError(messageOf(cause, '读取服务器清单失败'));
    } finally {
      setGuildBusy('');
    }
  }

  async function generatePlan(): Promise<void> {
    const guildId = inventory?.guildId ?? guildIdDraft.trim();
    setGuildError('');
    setGuildNotice(undefined);
    setApplyResult(undefined);
    if (!canGuildRead) {
      setGuildNotice({ tone: 'danger', text: '当前账号缺少 guild.read 权限，无法生成计划。' });
      return;
    }
    if (!guildId) {
      setGuildNotice({ tone: 'danger', text: '请先读取服务器清单。' });
      return;
    }
    setGuildBusy('plan');
    try {
      const result = await api<GuildPlanResponse>('/guild/plan', {
        method: 'POST',
        body: body({ botId: guildBot, guildId }),
      });
      if (!result.plan) throw new ApiError('计划响应缺少 plan 字段', 500);
      setPlan(result.plan);
      setPlanDigest(result.inventoryDigest ?? inventoryDigest);
      setPlanStale(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 409) setPlannerUnavailable(true);
      else setGuildNotice({ tone: 'danger', text: messageOf(cause, '生成计划失败') });
    } finally {
      setGuildBusy('');
    }
  }

  async function applyPlan(): Promise<void> {
    if (!plan) {
      setGuildNotice({ tone: 'danger', text: '请先生成计划。' });
      return;
    }
    if (!canGuildManage) {
      setGuildNotice({ tone: 'danger', text: '当前账号缺少 guild.manage 权限，无法应用计划。' });
      return;
    }
    const expectedDigest = planDigest || inventoryDigest;
    if (!expectedDigest) {
      setGuildNotice({ tone: 'danger', text: '缺少期望摘要，请重新读取清单并生成计划。' });
      return;
    }
    const payload: Record<string, unknown> = {
      botId: guildBot,
      plan,
      expectedDigest,
      idempotencyKey: newIdempotencyKey(),
    };
    setGuildBusy('apply');
    setGuildNotice(undefined);
    setGuildError('');
    try {
      const result = await confirmedRequest<GuildApplyResult>(
        '/guild/apply',
        { method: 'POST', body: body(payload) },
        payload,
        `将工作区计划应用到服务器 ${plan.guildId}`,
      );
      setApplyResult(result);
      setPlanStale(true); // 清单已被本次写入改变，摘要失效，需重新生成计划
      setGuildNotice({
        tone: 'info',
        text: `已应用 ${formatNumber(result.applied ?? 0)} 项，跳过 ${formatNumber(result.skipped ?? 0)} 项。`,
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 0) return; // 用户取消确认，不提示错误
      setGuildNotice({ tone: 'danger', text: messageOf(cause, '应用计划失败') });
    } finally {
      setGuildBusy('');
    }
  }

  const planSummary = plan?.summary;
  const failedResults = applyResult?.results?.filter((row) => row.status === 'failed') ?? [];
  const hasGuildDraft = Boolean(plan || planDigest || applyResult);

  return (
    <>
      <PageTitle
        eyebrow="RUNTIME INSTANCES"
        title="机器人"
        description="查看已注册的 Bot 实例、平台网关连接与插件加载状态，按权限重启实例，并用工作区规划器整理服务器频道结构。"
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

        <Tabs
          value={view}
          onChange={setView}
          ariaLabel="机器人视图"
          options={[
            { value: 'instances', label: '运行实例', count: instances.length },
            { value: 'guild', label: 'Guild 工作区规划' },
          ]}
        />

        {view === 'instances' && (
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
                            <small className="muted-text mono" title={bot.id}>{bot.id}</small>
                          </td>
                          <td>{bot.adapter || '—'}</td>
                          <td>
                            {bot.provider || '—'}
                            <br />
                            <small className="muted-text mono" title={bot.model || ''}>{bot.model || '—'}</small>
                          </td>
                          <td>
                            {bot.gateway?.connected
                              ? <Pill tone="success">已连接</Pill>
                              : <Pill tone="warning">未连接</Pill>}
                          </td>
                          <td className="mono nowrap">{fmtPing(bot.gateway?.ping)}</td>
                          <td className="mono">{formatNumber(bot.gateway?.reconnects ?? 0)}</td>
                          <td className="mono">{formatNumber(bot.sessions ?? 0)}</td>
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
        )}

        {view === 'guild' && (
          <Panel
            title="Guild 工作区规划"
            description="选择实例并填写 guildId，读取服务器清单、生成整理计划、核对摘要后应用。计划只新增/移动频道，绝不删除频道、角色或权限。"
            action={
              !canGuildRead
                ? <Pill tone="neutral">无 guild.read 权限</Pill>
                : plannerUnavailable
                  ? <Pill tone="warning">未启用</Pill>
                  : plan
                    ? <Pill tone={planStale ? 'warning' : 'info'}>{planStale ? '计划已过期' : `待应用 ${formatNumber(plan.actions.length)} 项`}</Pill>
                    : <Pill tone="neutral">待生成计划</Pill>
            }
          >
            {guildNotice && <Notice tone={guildNotice.tone}>{guildNotice.text}</Notice>}

            {!canGuildRead && (
              <Notice tone="warning" icon={<ShieldAlert size={17} />}>
                当前账号缺少 guild.read 权限，无法读取服务器清单与生成计划。应用计划还需要 guild.manage 权限。
              </Notice>
            )}

            {plannerUnavailable ? (
              <Notice tone="warning" icon={<Database size={17} />}>
                Guild 计划器在当前部署中不可用（服务端未启用）。这不是错误：请让部署方配置 Discord 网关的服务器清单支持后再使用此工作流。
              </Notice>
            ) : (
              <>
                <div className="form-inline">
                  <Field label="实例" hint="要整理的 Bot 实例">
                    <Select
                      value={guildBot}
                      disabled={instances.length === 0 || !canGuildRead}
                      aria-label="选择实例"
                      onChange={(event) => {
                        setGuildBotId(event.target.value);
                        setInventory(undefined);
                        setInventoryDigest('');
                        setGuildError('');
                        resetPlannerDerived();
                      }}
                    >
                      {instances.length === 0 && <option value="">（无可用实例）</option>}
                      {instances.map((bot) => <option key={bot.id} value={bot.id}>{bot.name || bot.id}</option>)}
                    </Select>
                  </Field>
                  <Field label="guildId" hint="服务器 ID，必填">
                    <TextInput
                      value={guildIdDraft}
                      disabled={!canGuildRead}
                      placeholder="例如 123456789012345678"
                      aria-label="guildId"
                      onChange={(event) => setGuildIdDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') void loadInventory(); }}
                    />
                  </Field>
                  <Button
                    onClick={() => { void loadInventory(); }}
                    busy={guildBusy === 'inventory'}
                    disabled={!canGuildRead || guildBusy !== ''}
                  >
                    <RefreshCw size={15} /> 读取清单
                  </Button>
                </div>

                {hasGuildDraft && <p className="migration-hint">重新读取清单会清除当前计划与结果。</p>}

                <DataState
                  loading={guildBusy === 'inventory'}
                  error={guildError}
                  onRetry={() => { void loadInventory(); }}
                >
                  {!inventory ? (
                    <EmptyState title="尚未读取服务器清单" detail="填写 guildId 后点击“读取清单”。" />
                  ) : (
                    <>
                      <Descriptions
                        columns={3}
                        items={[
                          { label: '服务器', value: inventory.name || '—' },
                          { label: '服务器 ID', value: <span className="mono">{inventory.guildId}</span> },
                          { label: '所有者 ID', value: <span className="mono">{inventory.ownerId || '—'}</span> },
                          {
                            label: '社区模式',
                            value: inventory.communityEnabled
                              ? <Pill tone="info">已启用</Pill>
                              : <Pill tone="neutral">未启用</Pill>,
                          },
                          { label: '频道', value: formatNumber(sortedChannels.length) },
                          { label: '角色', value: formatNumber(sortedRoles.length) },
                        ]}
                      />

                      <div className="row row-between mt-3">
                        <span className="muted-text">清单摘要（生成计划时作为期望摘要校验）</span>
                        <div className="inline-action">
                          <span className="mono truncate-cell" title={inventoryDigest}>{inventoryDigest || '—'}</span>
                          {inventoryDigest && <CopyButton value={inventoryDigest} label="复制摘要" />}
                        </div>
                      </div>

                      <Collapsible title={`服务器频道清单（${formatNumber(sortedChannels.length)}）`} defaultOpen>
                        <DataState empty={sortedChannels.length === 0} emptyTitle="该服务器没有频道" emptyDetail="清单中未返回任何频道。">
                          <Table minWidth={720}>
                            <thead>
                              <tr>
                                <th>名称</th>
                                <th>类型</th>
                                <th>上级</th>
                                <th>位置</th>
                                <th>话题</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sortedChannels.map((channel) => (
                                <tr key={channel.id}>
                                  <td>
                                    <div className="table-primary mono">{channel.name}</div>
                                    <small className="muted-text mono" title={channel.id}>{channel.id}</small>
                                  </td>
                                  <td><Pill tone={CHANNEL_KIND_TONE[channel.kind]}>{CHANNEL_KIND_LABEL[channel.kind] ?? channel.kind}</Pill></td>
                                  <td className="mono">{channel.parentId ? (channelNames.get(channel.parentId) ?? channel.parentId) : '—'}</td>
                                  <td className="mono">{formatNumber(channel.position)}</td>
                                  <td className="truncate-cell" title={channel.topic ?? ''}>{channel.topic || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </Table>
                        </DataState>
                      </Collapsible>

                      <Collapsible title={`服务器角色清单（${formatNumber(sortedRoles.length)}）`}>
                        <DataState empty={sortedRoles.length === 0} emptyTitle="该服务器没有角色" emptyDetail="清单中未返回任何角色。">
                          <Table minWidth={520}>
                            <thead><tr><th>角色</th><th>位置</th><th>托管</th></tr></thead>
                            <tbody>
                              {sortedRoles.map((role) => (
                                <tr key={role.id}>
                                  <td className="mono">{role.name}</td>
                                  <td className="mono">{formatNumber(role.position)}</td>
                                  <td>{role.managed ? <Pill tone="neutral">托管</Pill> : <span className="muted-text">—</span>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </Table>
                        </DataState>
                      </Collapsible>

                      <div className="row mt-3">
                        <Button
                          variant="primary"
                          onClick={() => { void generatePlan(); }}
                          busy={guildBusy === 'plan'}
                          disabled={!canGuildRead || guildBusy !== ''}
                        >
                          <Wand2 size={15} /> 生成计划
                        </Button>
                        {!canGuildRead && <span className="muted-text">只读：缺少 guild.read 权限</span>}
                      </div>
                    </>
                  )}
                </DataState>
              </>
            )}

            {inventory && plan && planSummary && (
              <>
                <h2 className="mt-3">整理计划</h2>
                <div className="stat-grid">
                  <StatCard label="新建" value={formatNumber(planSummary.create)} note="分类 / 文字 / 语音频道" icon={<Layers size={17} />} />
                  <StatCard label="移动" value={formatNumber(planSummary.move)} note="归入目标分类" icon={<ListChecks size={17} />} />
                  <StatCard label="重命名" value={formatNumber(planSummary.rename)} note="调整频道名称" icon={<ClipboardCheck size={17} />} />
                  <StatCard label="话题" value={formatNumber(planSummary.topic)} note="设置频道话题" icon={<Database size={17} />} />
                </div>

                <p className="muted-text">
                  生成于 {formatDateTime(plan.generatedAt)} · 保留 {formatNumber(plan.preservedChannelIds.length)} 个既有频道 · 服务器 ID <span className="mono">{plan.guildId}</span>
                </p>

                {plan.actions.length === 0 ? (
                  <Notice tone="info" icon={<ClipboardCheck size={17} />}>清单已符合目标结构，无需任何变更。</Notice>
                ) : (
                  <Table minWidth={640}>
                    <thead>
                      <tr><th>#</th><th>操作</th><th>对象 / 详情</th></tr>
                    </thead>
                    <tbody>
                      {plan.actions.map((action, index) => {
                        const described = describeAction(action);
                        return (
                          <tr key={`${action.kind}:${index}`}>
                            <td className="mono">{formatNumber(index + 1)}</td>
                            <td><Pill tone="info">{described.label}</Pill></td>
                            <td className="truncate-cell" title={described.detail}>{described.detail}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                )}

                <div className="row row-between mt-3">
                  <div className="inline-action">
                    <span className="muted-text">期望摘要</span>
                    <span className="mono truncate-cell" title={planDigest}>{planDigest || '—'}</span>
                    {planDigest && <CopyButton value={planDigest} label="复制摘要" />}
                  </div>
                  {planStale
                    ? <Pill tone="warning">摘要已过期</Pill>
                    : <Pill tone="success">摘要有效</Pill>}
                </div>

                {planStale && (
                  <Notice tone="warning" icon={<ShieldAlert size={17} />}>
                    服务器清单可能已变更，当前计划摘要已过期。请重新读取清单并生成计划后再应用。
                  </Notice>
                )}

                <Collapsible title="原始计划 JSON">
                  <div className="json-view">{prettyJson(plan)}</div>
                </Collapsible>

                <div className="row mt-3">
                  {canGuildManage ? (
                    <Button
                      variant="danger"
                      onClick={() => { void applyPlan(); }}
                      busy={guildBusy === 'apply'}
                      disabled={planStale || plan.actions.length === 0 || guildBusy !== ''}
                    >
                      <ClipboardCheck size={15} /> 应用计划
                    </Button>
                  ) : (
                    <span className="muted-text">应用计划需要 guild.manage 权限。</span>
                  )}
                </div>
              </>
            )}

            {applyResult && (
              <>
                <h2 className="mt-3">应用结果</h2>
                <div className="row row-between">
                  <span className="muted-text">
                    已应用 {formatNumber(applyResult.applied ?? 0)} 项 · 跳过 {formatNumber(applyResult.skipped ?? 0)} 项
                    {applyResult.idempotent ? ' · 幂等重放' : ''}
                  </span>
                  {failedResults.length > 0
                    ? <Pill tone="danger">{formatNumber(failedResults.length)} 项失败</Pill>
                    : <Pill tone="success">全部完成</Pill>}
                </div>

                {failedResults.length > 0 && (
                  <Notice tone="danger" icon={<ShieldAlert size={17} />}>
                    有 {formatNumber(failedResults.length)} 项未能应用，请检查下方说明后重新生成计划。
                  </Notice>
                )}

                {applyResult.results && applyResult.results.length > 0 ? (
                  <Table minWidth={560}>
                    <thead><tr><th>#</th><th>状态</th><th>说明</th></tr></thead>
                    <tbody>
                      {applyResult.results.map((row) => (
                        <tr key={row.index}>
                          <td className="mono">{formatNumber(row.index + 1)}</td>
                          <td><Pill tone={APPLY_STATUS_TONE[row.status]}>{APPLY_STATUS_LABEL[row.status]}</Pill></td>
                          <td className="prewrap">{row.error || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <p className="muted-text">服务端未返回逐项结果。</p>
                )}
              </>
            )}
          </Panel>
        )}
      </DataState>
    </>
  );
}
