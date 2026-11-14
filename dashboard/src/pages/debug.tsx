import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, FlaskConical, Gauge, RefreshCw, Send, ShieldAlert } from 'lucide-react';
import { api, ApiError, body } from '../lib/api';
import type { BotSnapshot, PageProps } from '../lib/types';
import { useAsync } from '../lib/hooks';
import { formatDateTime, formatDuration, formatNumber, prettyJson } from '../lib/format';
import {
  Button, Collapsible, DataState, Descriptions, Field, Notice, PageTitle, Panel, Pill, Select,
  StatCard, Switch, Table, Tabs, TextArea, TextInput,
} from '../components/ui';

/* ------------------------------------------------------------------ *
 * Wire shapes (server truth).
 *  - GET  /api/debug/chat/capabilities → { capabilities: DebugCapabilities }
 *  - POST /api/debug/chat              → { reply: DebugChatReply }
 *  - POST /api/behavior/dry-run        → { result: DryRunResult }
 * ------------------------------------------------------------------ */

type DebugTab = 'chat' | 'dryrun' | 'capabilities';

interface DebugLimitSet { maxInputChars: number; timeoutMs: number; requestsPerMinute: number }
interface DebugBotCapability { id: string; model: string; available: boolean }
interface DebugCapabilities { bots: DebugBotCapability[]; limits: DebugLimitSet }
interface DebugChatTrace {
  id: string;
  at: number;
  actorId: string;
  botId: string;
  model: string;
  latencyMs: number;
  outcome: 'ok' | 'timeout' | 'rate_limited' | 'failed';
  fallback: boolean;
}
interface DebugChatReply { trace: DebugChatTrace; content: string }

interface DryRunDecision { action: string; urgency: string; reason: string }
interface DryRunInputs {
  energy: number;
  stress: number;
  deviceDelay: boolean;
  affinity: number;
  recentReplies: number;
  dm: boolean;
  mentionsBot: boolean;
}
interface DryRunResult { decision: DryRunDecision; inputs: DryRunInputs }

interface TranscriptTurn {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  at: number;
  meta?: string;
  tone?: 'success' | 'warning' | 'danger';
}

interface BotOption { id: string; label: string }

const EMPTY_CAPABILITIES: DebugCapabilities = {
  bots: [],
  limits: { maxInputChars: 0, timeoutMs: 0, requestsPerMinute: 0 },
};

async function loadCapabilities(): Promise<DebugCapabilities> {
  const response = await api<{ capabilities?: DebugCapabilities }>('/debug/chat/capabilities');
  return response.capabilities ?? EMPTY_CAPABILITIES;
}

async function loadBots(): Promise<BotSnapshot[]> {
  const response = await api<{ bots?: BotSnapshot[] }>('/bots');
  return Array.isArray(response.bots) ? response.bots : [];
}

function errorText(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) return cause.message || fallback;
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

function outcomeTone(outcome: DebugChatTrace['outcome']): 'success' | 'warning' | 'danger' {
  if (outcome === 'ok') return 'success';
  if (outcome === 'timeout' || outcome === 'rate_limited') return 'warning';
  return 'danger';
}

const OUTCOME_LABEL: Record<DebugChatTrace['outcome'], string> = {
  ok: '成功',
  timeout: '超时',
  rate_limited: '限流',
  failed: '失败',
};

/** Bot snapshot ids are the canonical target list; capability ids are the fallback provider view. */
function snapshotOptions(bots: BotSnapshot[]): BotOption[] {
  return bots.map((bot) => ({ id: bot.id, label: bot.name ? `${bot.name} (${bot.id})` : bot.id }));
}

function capabilityOptions(bots: DebugBotCapability[]): BotOption[] {
  return bots.map((bot) => ({ id: bot.id, label: `${bot.id} · ${bot.model}` }));
}

/**
 * Resolves the selectable options once, honouring the existing precedence:
 * the live `/api/bots` snapshot wins, the debug capability snapshot is the
 * fallback. Shared by the chat and dry-run tabs so both offer the same targets.
 */
function useBotOptions(bots: BotSnapshot[], capabilities: DebugBotCapability[]): BotOption[] {
  return useMemo(
    () => (bots.length > 0 ? snapshotOptions(bots) : capabilityOptions(capabilities)),
    [bots, capabilities],
  );
}

/** Selects the first option once, without clobbering a later user choice. */
function useAutoSelectFirst(botId: string, options: BotOption[], setBotId: (id: string) => void): void {
  useEffect(() => {
    if (botId || options.length === 0) return;
    const first = options[0];
    if (first) setBotId(first.id);
  }, [botId, options, setBotId]);
}

export function Debug({ permissions }: PageProps) {
  const [tab, setTab] = useState<DebugTab>('chat');
  const canChat = permissions.includes('debug.chat');
  const canDryRun = permissions.includes('behavior.dry-run');

  const caps = useAsync(loadCapabilities, [], '读取调试能力失败');
  const bots = useAsync(loadBots, [], '读取 Bot 列表失败');

  const capabilities = caps.data ?? EMPTY_CAPABILITIES;
  const botSnapshots = bots.data ?? [];

  const refresh = () => {
    caps.reload();
    bots.reload();
  };

  const tabOptions = useMemo<Array<{ value: DebugTab; label: string; count?: number }>>(() => [
    { value: 'chat', label: '受控调试聊天' },
    { value: 'dryrun', label: '行为 Dry-run' },
    { value: 'capabilities', label: '能力', count: capabilities.bots.length },
  ], [capabilities.bots.length]);

  return (
    <>
      <PageTitle
        eyebrow="DEBUG WORKBENCH"
        title="调试工作台"
        description="隔离的调试聊天、行为决策 Dry-run 与调试能力快照。所有调用均以当前管理员身份受服务端权限与审计约束。"
        actions={<Button onClick={refresh} busy={caps.loading || bots.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      <Tabs value={tab} options={tabOptions} onChange={setTab} ariaLabel="调试工作台视图" />

      {tab === 'chat' && (
        <ChatTab
          capabilities={capabilities}
          limitsKnown={Boolean(caps.data)}
          bots={botSnapshots}
          loading={caps.loading && !caps.data}
          error={caps.error}
          onRetry={caps.reload}
          canChat={canChat}
        />
      )}

      {tab === 'dryrun' && (
        <DryRunTab
          bots={botSnapshots}
          loading={bots.loading && !bots.data}
          error={bots.error}
          onRetry={bots.reload}
          canDryRun={canDryRun}
        />
      )}

      {tab === 'capabilities' && (
        <CapabilitiesTab
          capabilities={capabilities}
          loading={caps.loading && !caps.data}
          error={caps.error}
          onRetry={caps.reload}
          canChat={canChat}
        />
      )}
    </>
  );
}

/* ----------------------------- Chat tab ----------------------------- */

function ChatTab({ capabilities, limitsKnown, bots, loading, error, onRetry, canChat }: {
  capabilities: DebugCapabilities;
  limitsKnown: boolean;
  bots: BotSnapshot[];
  loading: boolean;
  error: string;
  onRetry: () => void;
  canChat: boolean;
}) {
  const [botId, setBotId] = useState('');
  const [content, setContent] = useState('');
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState('');
  const nextId = useRef(1);

  const options = useBotOptions(bots, capabilities.bots);
  useAutoSelectFirst(botId, options, setBotId);

  const maxChars = capabilities.limits.maxInputChars || 4000;
  const selected = capabilities.bots.find((bot) => bot.id === botId);
  const overLimit = content.length > maxChars;

  const counterHint = limitsKnown
    ? `${formatNumber(content.length)} / ${formatNumber(maxChars)} 字符，单账号 ${formatNumber(capabilities.limits.requestsPerMinute)} 次/分钟`
    : `${formatNumber(content.length)} 字符`;

  async function send() {
    const trimmed = content.trim();
    if (!canChat || busy) return;
    if (!botId) { setInlineError('请选择要调试的 Bot。'); return; }
    if (!trimmed) { setInlineError('请输入调试内容。'); return; }
    if (overLimit) { setInlineError(`内容超过上限 ${formatNumber(maxChars)} 字符。`); return; }

    const turnId = nextId.current;
    nextId.current += 1;
    setInlineError('');
    setTurns((list) => [...list, { id: turnId, role: 'user', content: trimmed, at: Date.now() }]);
    setContent('');
    setBusy(true);
    try {
      const response = await api<{ reply?: DebugChatReply }>('/debug/chat', {
        method: 'POST',
        body: body({ botId, content: trimmed, task: 'admin' }),
      });
      const reply = response.reply;
      const replyId = nextId.current;
      nextId.current += 1;
      if (reply) {
        const meta = `${reply.trace.model} · ${formatDuration(reply.trace.latencyMs)} · ${OUTCOME_LABEL[reply.trace.outcome]}`;
        setTurns((list) => [...list, {
          id: replyId,
          role: 'assistant',
          content: reply.content,
          at: reply.trace.at,
          meta,
          tone: outcomeTone(reply.trace.outcome),
        }]);
      } else {
        setTurns((list) => [...list, { id: replyId, role: 'assistant', content: '（服务端未返回 reply 字段）', at: Date.now() }]);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 0) return; // cancelled client-side
      setInlineError(errorText(cause, '调试聊天请求失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Notice tone="info" icon={<ShieldAlert size={17} />}>
        这是管理员调试通道，并非面向用户的聊天产品。回复来自隔离的调试上下文，不接入 Discord、私聊记忆、会话或世界/设备状态。
      </Notice>

      <DataState
        loading={loading}
        error={error}
        empty={options.length === 0}
        emptyTitle="没有可调试的 Bot"
        emptyDetail="GET /api/bots 与调试能力快照都未返回 Bot，请确认 Provider 与 Bot 已配置。"
        onRetry={onRetry}
      >
        <div className="detail-split">
          <Panel
            title="对话记录"
            description={`本次会话 ${turns.length} 条消息（仅保存在当前页面，刷新即清空）。`}
            flush
          >
            {turns.length === 0
              ? <div className="muted-text mt-2">尚无调试消息，填写下方表单并发送。</div>
              : (
                <div className="timeline">
                  {turns.map((turn) => (
                    <div className="timeline-item" key={turn.id}>
                      <span className="timeline-marker" />
                      <div className="grow">
                        <div className="row-between">
                          <Pill tone={turn.role === 'user' ? 'info' : (turn.tone ?? 'neutral')}>
                            {turn.role === 'user' ? '管理员' : '调试模型'}
                          </Pill>
                          <small className="muted-text">{formatDateTime(turn.at)}</small>
                        </div>
                        <p className="prewrap mt-2">{turn.content}</p>
                        {turn.meta && <small className="muted-text mono">{turn.meta}</small>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </Panel>

          <Panel title="发送调试消息" description="请求在服务端以 task=admin 的隔离上下文执行。">
            {!canChat && (
              <Notice tone="warning" icon={<ShieldAlert size={17} />}>
                只读：当前账号缺少 debug.chat 权限，无法发送调试消息。
              </Notice>
            )}
            <Field label="目标 Bot" hint={selected ? `模型：${selected.model}${selected.available ? '' : '（不可用）'}` : '来自 /api/bots 或调试能力快照'}>
              <Select value={botId} onChange={(event) => setBotId(event.target.value)} disabled={!canChat}>
                <option value="">请选择 Bot</option>
                {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </Select>
            </Field>
            <Field
              label="调试内容"
              hint={counterHint}
              error={overLimit ? '已超过输入上限' : undefined}
            >
              <TextArea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="输入用于隔离调试的消息内容"
                disabled={!canChat}
                rows={5}
              />
            </Field>
            {inlineError && <div className="inline-error">{inlineError}</div>}
            <div className="table-actions mt-2">
              <Button variant="primary" onClick={() => void send()} busy={busy} disabled={!canChat || !content.trim() || overLimit}>
                <Send size={15} /> 发送
              </Button>
              {turns.length > 0 && (
                <Button onClick={() => setTurns([])} disabled={busy}>清空记录</Button>
              )}
            </div>
          </Panel>
        </div>
      </DataState>
    </>
  );
}

/* ---------------------------- Dry-run tab --------------------------- */

function DryRunTab({ bots, loading, error, onRetry, canDryRun }: {
  bots: BotSnapshot[];
  loading: boolean;
  error: string;
  onRetry: () => void;
  canDryRun: boolean;
}) {
  const [botId, setBotId] = useState('');
  const [channelId, setChannelId] = useState('dm:debug-user');
  const [guildId, setGuildId] = useState('');
  const [userId, setUserId] = useState('debug-user');
  const [content, setContent] = useState('在吗？');
  const [dm, setDm] = useState(true);
  const [mentionsBot, setMentionsBot] = useState(false);
  const [recentReplies, setRecentReplies] = useState('0');
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState('');
  const [result, setResult] = useState<DryRunResult | null>(null);

  const options = useMemo(() => snapshotOptions(bots), [bots]);
  useAutoSelectFirst(botId, options, setBotId);

  const parsedReplies = Number(recentReplies);
  const repliesValid = Number.isSafeInteger(parsedReplies) && parsedReplies >= 0 && parsedReplies <= 100;

  async function run() {
    if (!canDryRun || busy) return;
    if (!botId) { setInlineError('请选择要预览的 Bot。'); return; }
    if (!channelId.trim()) { setInlineError('请填写 channelId。'); return; }
    if (!userId.trim()) { setInlineError('请填写 userId。'); return; }
    if (!content.trim()) { setInlineError('请填写消息内容。'); return; }
    if (!repliesValid) { setInlineError('recentReplies 必须是 0-100 的整数。'); return; }

    setInlineError('');
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        botId: botId.trim(),
        channelId: channelId.trim(),
        userId: userId.trim(),
        content: content.trim(),
        dm,
        mentionsBot,
        recentReplies: parsedReplies,
      };
      if (guildId.trim()) payload.guildId = guildId.trim();
      const response = await api<{ result?: DryRunResult }>('/behavior/dry-run', {
        method: 'POST',
        body: body(payload),
      });
      setResult(response.result ?? null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 0) return;
      setInlineError(errorText(cause, 'Dry-run 请求失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Notice tone="info" icon={<FlaskConical size={17} />}>
        Dry-run 只读取世界/设备/好感度快照后计算社交决策，不会写入任何状态，也不会真的回复消息。
      </Notice>

      <DataState
        loading={loading}
        error={error}
        empty={options.length === 0}
        emptyTitle="没有可预览的 Bot"
        emptyDetail="GET /api/bots 未返回任何 Bot，无法构造 Dry-run 目标。"
        onRetry={onRetry}
      >
        <div className="detail-split">
          <Panel title="决策输入" description="字段与服务端 parseBehaviorDryRun 的校验一致。">
            {!canDryRun && (
              <Notice tone="warning" icon={<ShieldAlert size={17} />}>
                只读：当前账号缺少 behavior.dry-run 权限，无法执行预览。
              </Notice>
            )}
            <div className="form-grid">
              <Field label="Bot">
                <Select value={botId} onChange={(event) => setBotId(event.target.value)} disabled={!canDryRun}>
                  <option value="">请选择 Bot</option>
                  {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </Select>
              </Field>
              <Field label="userId">
                <TextInput value={userId} onChange={(event) => setUserId(event.target.value)} disabled={!canDryRun} />
              </Field>
              <Field label="channelId" hint="例如 dm:debug-user 或频道 ID">
                <TextInput value={channelId} onChange={(event) => setChannelId(event.target.value)} disabled={!canDryRun} />
              </Field>
              <Field label="guildId" hint="可选，留空则按私聊/无公会处理">
                <TextInput value={guildId} onChange={(event) => setGuildId(event.target.value)} disabled={!canDryRun} />
              </Field>
              <Field label="recentReplies" error={repliesValid ? undefined : '必须是 0-100 的整数'}>
                <TextInput
                  type="number"
                  min={0}
                  max={100}
                  value={recentReplies}
                  onChange={(event) => setRecentReplies(event.target.value)}
                  disabled={!canDryRun}
                />
              </Field>
            </div>
            <Field label="消息内容">
              <TextArea value={content} onChange={(event) => setContent(event.target.value)} disabled={!canDryRun} rows={3} />
            </Field>
            <div className="row row-wrap mt-2">
              <Switch checked={dm} onChange={setDm} disabled={!canDryRun} label="私聊（dm）" />
              <Switch checked={mentionsBot} onChange={setMentionsBot} disabled={!canDryRun} label="@ 提及机器人" />
            </div>
            {inlineError && <div className="inline-error">{inlineError}</div>}
            <div className="table-actions mt-3">
              <Button variant="primary" onClick={() => void run()} busy={busy} disabled={!canDryRun}>
                <Activity size={15} /> 运行 Dry-run
              </Button>
            </div>
          </Panel>

          <Panel title="决策结果" description="来自 POST /api/behavior/dry-run 的 result。">
            {!result
              ? <div className="muted-text">尚未运行。填写左侧输入并点击“运行 Dry-run”。</div>
              : (
                <>
                  <div className="row-between">
                    <div className="row">
                      <Pill tone={result.decision.action === 'reply' ? 'success' : 'neutral'}>
                        {result.decision.action === 'reply' ? '回复' : '忽略'}
                      </Pill>
                      <Pill tone="neutral">{result.decision.urgency}</Pill>
                    </div>
                    <small className="muted-text">决策 / 紧急度</small>
                  </div>
                  <p className="mt-2"><span className="muted-text">原因：</span><span className="mono">{result.decision.reason}</span></p>

                  <Descriptions columns={2} items={[
                    { label: '能量 energy', value: formatNumber(result.inputs.energy, 2) },
                    { label: '压力 stress', value: formatNumber(result.inputs.stress, 2) },
                    { label: '好感度 affinity', value: formatNumber(result.inputs.affinity, 2) },
                    { label: '近期回复 recentReplies', value: formatNumber(result.inputs.recentReplies) },
                    { label: '设备延迟 deviceDelay', value: result.inputs.deviceDelay ? '是' : '否' },
                    { label: '私聊 dm', value: result.inputs.dm ? '是' : '否' },
                    { label: '@ 提及 mentionsBot', value: result.inputs.mentionsBot ? '是' : '否' },
                  ]} />

                  <Collapsible title="原始 result JSON">
                    <pre className="json-view">{prettyJson(result)}</pre>
                  </Collapsible>
                </>
              )}
          </Panel>
        </div>
      </DataState>
    </>
  );
}

/* -------------------------- Capabilities tab ------------------------ */

function CapabilitiesTab({ capabilities, loading, error, onRetry, canChat }: {
  capabilities: DebugCapabilities;
  loading: boolean;
  error: string;
  onRetry: () => void;
  canChat: boolean;
}) {
  const available = capabilities.bots.filter((bot) => bot.available).length;

  return (
    <>
      <Notice tone="info" icon={<Gauge size={17} />}>
        只读快照：以下数据来自 GET /api/debug/chat/capabilities，不代表真实会话能力。
      </Notice>

      {!canChat && (
        <Notice tone="warning" icon={<ShieldAlert size={17} />}>
          当前账号缺少 debug.chat 权限；此视图仅在服务端已授权时才有数据。
        </Notice>
      )}

      <DataState
        loading={loading}
        error={error}
        empty={capabilities.bots.length === 0}
        emptyTitle="没有可用的调试模型"
        emptyDetail="调试能力快照未返回任何 Bot，请确认 Provider 已配置。"
        onRetry={onRetry}
      >
        <div className="stat-grid">
          <StatCard label="最大输入字符" value={formatNumber(capabilities.limits.maxInputChars)} note="单条调试消息上限" />
          <StatCard label="单次超时" value={formatDuration(capabilities.limits.timeoutMs)} note="超时按失败记录 trace" />
          <StatCard label="每分钟请求上限" value={formatNumber(capabilities.limits.requestsPerMinute)} note="按管理员账号限流" />
          <StatCard
            label="可用 Bot"
            value={`${formatNumber(available)} / ${formatNumber(capabilities.bots.length)}`}
            tone={available === 0 ? 'danger' : undefined}
            note="调试聊天按账号限流，失败会记录 trace 且不写入会话"
          />
        </div>

        <Panel title="调试 Bot" description={`${capabilities.bots.length} 个候选，其中 ${available} 个可用。`}>
          <Table minWidth={520}>
            <thead><tr><th>Bot</th><th>调试模型</th><th>可用性</th></tr></thead>
            <tbody>
              {capabilities.bots.map((bot) => (
                <tr key={bot.id}>
                  <td className="table-primary mono">{bot.id}</td>
                  <td className="mono">{bot.model}</td>
                  <td>{bot.available ? <Pill tone="success">可用</Pill> : <Pill tone="danger">不可用</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      </DataState>
    </>
  );
}
