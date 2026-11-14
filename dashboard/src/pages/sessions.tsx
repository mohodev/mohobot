import { useCallback, useMemo, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, History, MessageSquare, RefreshCw, ScrollText, Trash2, Wrench } from 'lucide-react';
import { ApiError, api, body, confirmedRequest, hasPermission } from '../lib/api';
import type { OpsAudit, OpsPage, OpsSession, PageProps } from '../lib/types';
import { useAsync, useDebouncedValue } from '../lib/hooks';
import { formatDateTime, formatNumber, formatRelative, levelTone } from '../lib/format';
import {
  Button,
  DataState,
  Modal,
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

/**
 * 会话与审计（OBSERVABILITY）。
 *
 * 三个互相独立的只读视图：
 *  - 会话：`GET /api/ops/sessions` 的持久化会话分页列表，可展开聊天记录弹窗，
 *    并在二次确认后删除单条会话（`DELETE /api/ops/sessions/:id`）；
 *  - Discord 日志：`GET /api/ops/discord-chat-log` 的进程内收发环形缓冲；
 *  - 审计：`GET /api/admin/audit` 的管理面审计分页；
 *  - 运维：`GET /api/ops/operator-audit` 与 `GET /api/ops/operator-tools`。
 *
 * 页面只做只读展示；唯一的写操作是删除会话，受 `sessions.chat.delete` 约束
 * 并走服务端确认 nonce。
 */

const PAGE_SIZE = 25;
const LOG_LIMIT = 50;

type TabValue = 'sessions' | 'audit' | 'operator';
type OutcomeFilter = '' | 'allowed' | 'denied';
type DirectionFilter = '' | 'in' | 'out';

/** One persisted chat-log row from `GET /api/ops/chat-log` (SQLite column names). */
interface ChatLogRow {
  id: number;
  channel_id: string;
  message_id?: string;
  author_id?: string;
  username?: string;
  content?: string;
  mentions_bot?: number;
  bot_id?: string;
  ts?: string;
  created_at?: number;
}

/** One in-memory entry from `GET /api/ops/discord-chat-log`. */
interface DiscordChatEntry {
  seq: number;
  time: number;
  direction: 'in' | 'out';
  botId: string;
  channelId: string;
  userId: string;
  summary: string;
  traceId?: string;
  outcome: string;
}

/** One `AuditEntry` from the operator registry (`GET /api/ops/operator-audit`). */
interface OperatorAuditEntry {
  ts: number;
  tool: string;
  args: string;
  caller: string;
  outcome: string;
  detail?: string;
}

/** One descriptor from `listOperatorToolDescriptors()` (`GET /api/ops/operator-tools`). */
interface OperatorToolDescriptor {
  name: string;
  risk: string;
  usage: string;
  description: string;
  confirm: boolean;
}

interface SessionsResponse { sessions?: OpsPage<OpsSession>; }
interface AuditResponse { audit?: OpsPage<OpsAudit>; }
interface ChatLogResponse { messages?: ChatLogRow[]; }
interface DiscordChatResponse { messages?: DiscordChatEntry[]; }
interface OperatorAuditResponse { entries?: OperatorAuditEntry[]; }
interface OperatorToolsResponse { tools?: OperatorToolDescriptor[]; }

function errorText(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'string' && cause) return cause;
  return fallback;
}

/** Normalises an `OpsPage` envelope so a malformed/absent body never crashes the table. */
function pageOf<T>(value: OpsPage<T> | undefined, fallbackLimit: number, fallbackOffset: number): OpsPage<T> {
  return {
    items: Array.isArray(value?.items) ? value.items : [],
    limit: typeof value?.limit === 'number' ? value.limit : fallbackLimit,
    offset: typeof value?.offset === 'number' ? value.offset : fallbackOffset,
    hasMore: value?.hasMore === true,
  };
}

function isCancelled(cause: unknown): boolean {
  return cause instanceof ApiError && cause.statusCode === 0;
}

function riskTone(risk: string): 'info' | 'warning' | 'danger' | 'neutral' {
  if (risk === 'danger') return 'danger';
  if (risk === 'write') return 'warning';
  if (risk === 'read') return 'info';
  return 'neutral';
}

function chatLogTime(row: ChatLogRow): unknown {
  return row.ts ?? row.created_at;
}

export function Sessions({ permissions }: PageProps) {
  const canReadSessions = hasPermission(permissions, 'sessions.chat.read');
  const canDelete = hasPermission(permissions, 'sessions.chat.delete');
  const canReadDiscord = hasPermission(permissions, 'chats.log.read');
  const canReadAudit = hasPermission(permissions, 'audit.read');

  const [tab, setTab] = useState<TabValue>(canReadSessions ? 'sessions' : canReadAudit ? 'audit' : 'sessions');
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');

  /* ------------------------------------------------------------------ *
   * 会话列表
   * ------------------------------------------------------------------ */

  const [botIdInput, setBotIdInput] = useState('');
  const [channelIdInput, setChannelIdInput] = useState('');
  const [userIdInput, setUserIdInput] = useState('');
  const botId = useDebouncedValue(botIdInput.trim(), 250);
  const channelId = useDebouncedValue(channelIdInput.trim(), 250);
  const userId = useDebouncedValue(userIdInput.trim(), 250);
  const [offset, setOffset] = useState(0);

  const sessionsState = useAsync(async () => {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    if (botId) params.set('botId', botId);
    if (channelId) params.set('channelId', channelId);
    if (userId) params.set('userId', userId);
    const result = await api<SessionsResponse>(`/ops/sessions?${params.toString()}`);
    return pageOf(result.sessions, PAGE_SIZE, offset);
  }, [offset, botId, channelId, userId], '读取会话列表失败');

  const sessions = sessionsState.data;
  const rows = sessions?.items ?? [];

  const sessionStats = useMemo(() => {
    let messages = 0;
    let deleted = 0;
    let content = 0;
    for (const row of rows) {
      messages += Number(row.messageCount ?? 0);
      deleted += Number(row.deletedCount ?? 0);
      content += Number(row.contentLength ?? 0);
    }
    return { messages, deleted, content };
  }, [rows]);

  const resetFilters = useCallback(() => {
    setBotIdInput('');
    setChannelIdInput('');
    setUserIdInput('');
    setOffset(0);
  }, []);

  /* ---- 删除会话（二次确认） ---- */

  const [busyId, setBusyId] = useState('');

  const deleteSession = useCallback(async (row: OpsSession) => {
    setActionError('');
    setActionNotice('');
    setBusyId(row.id);
    try {
      await confirmedRequest<{ deleted?: boolean }>(
        `/ops/sessions/${encodeURIComponent(row.id)}`,
        { method: 'DELETE', body: body({}) },
        {},
        `删除会话 ${row.id}`,
      );
      setActionNotice(`已删除会话 ${row.id}（频道 ${row.channelId}）。`);
      sessionsState.reload();
    } catch (cause) {
      if (!isCancelled(cause)) setActionError(`删除会话 ${row.id} 失败：${errorText(cause, '请求失败')}`);
    } finally {
      setBusyId('');
    }
  }, [sessionsState]);

  /* ---- 聊天记录弹窗 ---- */

  const [logSession, setLogSession] = useState<OpsSession | null>(null);

  const chatLogState = useAsync(async () => {
    if (!logSession) return [];
    const params = new URLSearchParams();
    params.set('channelId', logSession.channelId);
    params.set('limit', String(LOG_LIMIT));
    params.set('botId', logSession.botId);
    const result = await api<ChatLogResponse>(`/ops/chat-log?${params.toString()}`);
    return Array.isArray(result.messages) ? result.messages : [];
  }, [logSession], '读取聊天记录失败');

  const chatLogRows = chatLogState.data ?? [];

  /* ---- Discord 双向日志 ---- */

  const [direction, setDirection] = useState<DirectionFilter>('');
  const [discordChannelInput, setDiscordChannelInput] = useState('');
  const discordChannel = useDebouncedValue(discordChannelInput.trim(), 250);

  const discordState = useAsync<DiscordChatEntry[]>(async () => {
    if (!canReadDiscord) return [];
    const params = new URLSearchParams();
    params.set('limit', String(LOG_LIMIT));
    if (direction) params.set('direction', direction);
    if (discordChannel) params.set('channelId', discordChannel);
    const result = await api<DiscordChatResponse>(`/ops/discord-chat-log?${params.toString()}`);
    return Array.isArray(result.messages) ? result.messages : [];
  }, [direction, discordChannel, canReadDiscord], '读取 Discord 聊天日志失败');

  const discordRows = discordState.data ?? [];

  /* ------------------------------------------------------------------ *
   * 管理面审计
   * ------------------------------------------------------------------ */

  const [actorInput, setActorInput] = useState('');
  const [actionInput, setActionInput] = useState('');
  const [methodInput, setMethodInput] = useState('');
  const [outcome, setOutcome] = useState<OutcomeFilter>('');
  const [auditOffset, setAuditOffset] = useState(0);
  const actor = useDebouncedValue(actorInput.trim(), 250);
  const action = useDebouncedValue(actionInput.trim(), 250);
  const method = useDebouncedValue(methodInput.trim(), 250);

  const auditState = useAsync(async () => {
    if (!canReadAudit) return pageOf<OpsAudit>(undefined, PAGE_SIZE, auditOffset);
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(auditOffset));
    if (actor) params.set('actor', actor);
    if (action) params.set('action', action);
    if (method) params.set('method', method);
    if (outcome) params.set('outcome', outcome);
    const result = await api<AuditResponse>(`/admin/audit?${params.toString()}`);
    return pageOf(result.audit, PAGE_SIZE, auditOffset);
  }, [auditOffset, actor, action, method, outcome, canReadAudit], '读取审计日志失败');

  const audit = auditState.data;
  const auditRows = audit?.items ?? [];

  const resetAuditFilters = useCallback(() => {
    setActorInput('');
    setActionInput('');
    setMethodInput('');
    setOutcome('');
    setAuditOffset(0);
  }, []);

  /* ------------------------------------------------------------------ *
   * 运维审计与工具清单（并行读取，允许部分失败）
   * ------------------------------------------------------------------ */

  const operatorState = useAsync(async () => {
    if (!canReadAudit) return { entries: [] as OperatorAuditEntry[], tools: [] as OperatorToolDescriptor[], failures: [] as string[] };
    const [auditResult, toolsResult] = await Promise.allSettled([
      api<OperatorAuditResponse>('/ops/operator-audit?limit=50'),
      api<OperatorToolsResponse>('/ops/operator-tools'),
    ]);
    const failures: string[] = [];
    let entries: OperatorAuditEntry[] = [];
    if (auditResult.status === 'fulfilled') {
      entries = Array.isArray(auditResult.value.entries) ? auditResult.value.entries : [];
    } else {
      failures.push(`运维审计：${errorText(auditResult.reason, '读取失败')}`);
    }
    let tools: OperatorToolDescriptor[] = [];
    if (toolsResult.status === 'fulfilled') {
      tools = Array.isArray(toolsResult.value.tools) ? toolsResult.value.tools : [];
    } else {
      failures.push(`工具清单：${errorText(toolsResult.reason, '读取失败')}`);
    }
    return { entries, tools, failures };
  }, [canReadAudit], '读取运维审计失败');

  const operator = operatorState.data;
  const operatorEntries = operator?.entries ?? [];
  const operatorTools = operator?.tools ?? [];

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  const tabOptions = useMemo(() => {
    const options: Array<{ value: TabValue; label: string; count?: number }> = [];
    if (canReadSessions) options.push({ value: 'sessions', label: '会话', count: rows.length });
    if (canReadAudit) {
      options.push({ value: 'audit', label: '审计', count: auditRows.length });
      options.push({ value: 'operator', label: '运维', count: operatorEntries.length });
    }
    return options;
  }, [canReadSessions, canReadAudit, rows.length, auditRows.length, operatorEntries.length]);

  const activeTab: TabValue = tabOptions.some((option) => option.value === tab)
    ? tab
    : (tabOptions[0]?.value ?? 'sessions');

  const refreshActive = useCallback(() => {
    if (activeTab === 'sessions') { sessionsState.reload(); discordState.reload(); return; }
    if (activeTab === 'audit') { auditState.reload(); return; }
    operatorState.reload();
  }, [activeTab, sessionsState, discordState, auditState, operatorState]);

  const refreshing = activeTab === 'sessions'
    ? sessionsState.loading || discordState.loading
    : activeTab === 'audit'
      ? auditState.loading
      : operatorState.loading;

  return (
    <>
      <PageTitle
        eyebrow="SESSIONS & AUDIT"
        title="会话与审计"
        description="查看持久化会话、物理聊天日志、管理面审计与运维工具轨迹；删除会话需要二次确认。"
        actions={<Button onClick={refreshActive} busy={refreshing}><RefreshCw size={15} /> 刷新</Button>}
      />

      {actionError && <Notice tone="danger" icon={<AlertCircle size={17} />}>{actionError}</Notice>}
      {actionNotice && <Notice tone="info" icon={<ScrollText size={17} />}>{actionNotice}</Notice>}

      {tabOptions.length === 0 ? (
        <Panel>
          <Notice tone="warning" icon={<AlertCircle size={17} />}>
            当前账号缺少 sessions.chat.read 与 audit.read 权限，无法查看会话与审计数据。
          </Notice>
        </Panel>
      ) : (
        <>
          <Tabs value={activeTab} options={tabOptions} onChange={setTab} ariaLabel="会话与审计视图" />

          {activeTab === 'sessions' && (
            <>
              <div className="toolbar">
                <TextInput
                  aria-label="按 botId 过滤"
                  placeholder="botId，如 moho"
                  value={botIdInput}
                  onChange={(event) => { setBotIdInput(event.target.value); setOffset(0); }}
                />
                <TextInput
                  aria-label="按 channelId 过滤"
                  placeholder="channelId"
                  value={channelIdInput}
                  onChange={(event) => { setChannelIdInput(event.target.value); setOffset(0); }}
                />
                <TextInput
                  aria-label="按 userId 过滤"
                  placeholder="userId"
                  value={userIdInput}
                  onChange={(event) => { setUserIdInput(event.target.value); setOffset(0); }}
                />
                <Button
                  onClick={resetFilters}
                  disabled={!botIdInput && !channelIdInput && !userIdInput}
                >
                  重置过滤
                </Button>
              </div>

              <DataState
                loading={sessionsState.loading && sessions === undefined}
                error={sessionsState.error}
                empty={sessions !== undefined && rows.length === 0}
                emptyTitle="暂无会话"
                emptyDetail={botId || channelId || userId ? '当前过滤条件下没有匹配的持久化会话。' : '存储中还没有可读取的会话记录。'}
                onRetry={sessionsState.reload}
              >
                <div className="stat-grid">
                  <StatCard label="本页会话" value={formatNumber(rows.length)} note={`offset ${formatNumber(sessions?.offset ?? 0)}`} icon={<ScrollText size={17} />} />
                  <StatCard label="本页消息" value={formatNumber(sessionStats.messages)} note="含已删除消息" icon={<MessageSquare size={17} />} />
                  <StatCard
                    label="本页已删除"
                    value={formatNumber(sessionStats.deleted)}
                    note="deletedCount 合计"
                    icon={<Trash2 size={17} />}
                    tone={sessionStats.deleted > 0 ? 'warning' : undefined}
                  />
                  <StatCard label="本页正文长度" value={formatNumber(sessionStats.content)} note="活跃消息字符合计" icon={<History size={17} />} />
                </div>

                <Panel
                  title="持久化会话"
                  description={`第 ${formatNumber((sessions?.offset ?? 0) + (rows.length ? 1 : 0))}–${formatNumber((sessions?.offset ?? 0) + rows.length)} 条，每页 ${PAGE_SIZE} 条`}
                  action={canDelete ? undefined : <Pill tone="neutral">只读</Pill>}
                  flush
                >
                  <Table minWidth={1080}>
                    <thead>
                      <tr>
                        <th>会话 ID</th>
                        <th>botId</th>
                        <th>channelId</th>
                        <th>userId</th>
                        <th>更新时间</th>
                        <th>消息数</th>
                        <th>已删除</th>
                        <th>正文长度</th>
                        <th>摘要哈希</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id}>
                          <td className="mono truncate-cell" title={row.id}>{row.id}</td>
                          <td className="mono">{row.botId}</td>
                          <td className="mono">{row.channelId}</td>
                          <td className="mono">{row.userId ?? '—'}</td>
                          <td className="nowrap" title={formatDateTime(row.updatedAt)}>{formatRelative(row.updatedAt)}</td>
                          <td>{formatNumber(row.messageCount)}</td>
                          <td>{row.deletedCount > 0 ? <Pill tone="warning">{formatNumber(row.deletedCount)}</Pill> : formatNumber(row.deletedCount)}</td>
                          <td>{formatNumber(row.contentLength)}</td>
                          <td className="mono truncate-cell" title={row.summaryHash}>{row.summaryHash || '—'}</td>
                          <td>
                            <div className="table-actions">
                              <Button
                                variant="ghost"
                                onClick={() => { setActionError(''); setActionNotice(''); setLogSession(row); }}
                                title="查看聊天记录"
                              >
                                <MessageSquare size={14} /> 聊天记录
                              </Button>
                              {canDelete && (
                                <Button
                                  variant="danger"
                                  busy={busyId === row.id}
                                  onClick={() => void deleteSession(row)}
                                  title="删除该会话（需要二次确认）"
                                >
                                  <Trash2 size={14} /> 删除
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>

                  <div className="row-between mt-3">
                    <span className="muted-text">
                      {sessions?.hasMore ? '还有更多会话' : '已到最后一页'}
                    </span>
                    <div className="row">
                      <Button onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))} disabled={(sessions?.offset ?? 0) <= 0} busy={sessionsState.loading}>
                        <ChevronLeft size={15} /> 上一页
                      </Button>
                      <Button onClick={() => setOffset((value) => value + PAGE_SIZE)} disabled={!sessions?.hasMore} busy={sessionsState.loading}>
                        下一页 <ChevronRight size={15} />
                      </Button>
                    </div>
                  </div>
                </Panel>

                <Panel
                  title="Discord 双向聊天日志"
                  description={`进程内环形缓冲，最近 ${LOG_LIMIT} 条；进程重启即清空。`}
                  action={
                    <div className="row">
                      <Select
                        aria-label="消息方向"
                        value={direction}
                        onChange={(event) => setDirection(event.target.value === 'in' || event.target.value === 'out' ? event.target.value : '')}
                      >
                        <option value="">全部方向</option>
                        <option value="in">收到 in</option>
                        <option value="out">发出 out</option>
                      </Select>
                      <TextInput
                        aria-label="Discord 频道过滤"
                        placeholder="channelId"
                        value={discordChannelInput}
                        onChange={(event) => setDiscordChannelInput(event.target.value)}
                      />
                    </div>
                  }
                  flush
                >
                  {!canReadDiscord && (
                    <Notice tone="warning" icon={<AlertCircle size={17} />}>
                      当前账号缺少 chats.log.read 权限，无法读取 Discord 聊天日志。
                    </Notice>
                  )}
                  <DataState
                    loading={canReadDiscord && discordState.loading && discordState.data === undefined}
                    error={discordState.error}
                    empty={canReadDiscord && discordRows.length === 0}
                    emptyTitle="暂无 Discord 聊天日志"
                    emptyDetail="缓冲区为空，或当前过滤条件下没有收发记录。"
                    onRetry={discordState.reload}
                  >
                    <Table minWidth={860}>
                      <thead>
                        <tr><th>#</th><th>时间</th><th>方向</th><th>botId</th><th>channelId</th><th>userId</th><th>结果</th><th>摘要</th></tr>
                      </thead>
                      <tbody>
                        {discordRows.map((row) => (
                          <tr key={row.seq}>
                            <td className="mono nowrap">{row.seq}</td>
                            <td className="mono nowrap" title={formatDateTime(row.time)}>{formatRelative(row.time)}</td>
                            <td>{row.direction === 'in' ? <Pill tone="info">in</Pill> : <Pill tone="success">out</Pill>}</td>
                            <td className="mono">{row.botId}</td>
                            <td className="mono truncate-cell" title={row.channelId}>{row.channelId}</td>
                            <td className="mono truncate-cell" title={row.userId}>{row.userId}</td>
                            <td><Pill tone={levelTone(row.outcome)}>{row.outcome}</Pill></td>
                            <td className="log-message truncate-cell" title={row.summary}>{row.summary || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </DataState>
                </Panel>
              </DataState>
            </>
          )}

          {activeTab === 'audit' && (
            <>
              <div className="toolbar">
                <TextInput
                  aria-label="按操作者过滤"
                  placeholder="actor"
                  value={actorInput}
                  onChange={(event) => { setActorInput(event.target.value); setAuditOffset(0); }}
                />
                <TextInput
                  aria-label="按动作过滤"
                  placeholder="action，如 ops.sessions.delete"
                  value={actionInput}
                  onChange={(event) => { setActionInput(event.target.value); setAuditOffset(0); }}
                />
                <TextInput
                  aria-label="按方法过滤"
                  placeholder="method，如 DELETE"
                  value={methodInput}
                  onChange={(event) => { setMethodInput(event.target.value); setAuditOffset(0); }}
                />
                <Select
                  aria-label="按结果过滤"
                  value={outcome}
                  onChange={(event) => {
                    const value = event.target.value;
                    setOutcome(value === 'allowed' || value === 'denied' ? value : '');
                    setAuditOffset(0);
                  }}
                >
                  <option value="">全部结果</option>
                  <option value="allowed">allowed</option>
                  <option value="denied">denied</option>
                </Select>
                <Button onClick={resetAuditFilters} disabled={!actorInput && !actionInput && !methodInput && !outcome}>
                  重置过滤
                </Button>
              </div>

              <DataState
                loading={auditState.loading && audit === undefined}
                error={auditState.error}
                empty={audit !== undefined && auditRows.length === 0}
                emptyTitle="暂无审计记录"
                emptyDetail="当前过滤条件下没有匹配的管理面审计条目。"
                onRetry={auditState.reload}
              >
                <Panel
                  title="管理面审计"
                  description={`共显示 ${formatNumber(auditRows.length)} 条；offset ${formatNumber(audit?.offset ?? 0)}`}
                  flush
                >
                  <Table minWidth={980}>
                    <thead>
                      <tr><th>时间</th><th>操作者</th><th>动作</th><th>请求</th><th>状态码</th><th>结果</th></tr>
                    </thead>
                    <tbody>
                      {auditRows.map((row) => (
                        <tr key={row.id}>
                          <td className="mono nowrap" title={formatDateTime(row.at)}>{formatRelative(row.at)}</td>
                          <td className="mono">{row.actor}</td>
                          <td className="mono">{row.action}</td>
                          <td>
                            <div className="row">
                              <Pill tone="neutral">{row.method}</Pill>
                              <span className="mono truncate-cell" title={row.path}>{row.path}</span>
                            </div>
                          </td>
                          <td className="mono">{row.status}</td>
                          <td><Pill tone={levelTone(row.outcome)}>{row.outcome}</Pill></td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>

                  <div className="row-between mt-3">
                    <span className="muted-text">{audit?.hasMore ? '还有更多审计记录' : '已到最后一页'}</span>
                    <div className="row">
                      <Button onClick={() => setAuditOffset((value) => Math.max(0, value - PAGE_SIZE))} disabled={(audit?.offset ?? 0) <= 0} busy={auditState.loading}>
                        <ChevronLeft size={15} /> 上一页
                      </Button>
                      <Button onClick={() => setAuditOffset((value) => value + PAGE_SIZE)} disabled={!audit?.hasMore} busy={auditState.loading}>
                        下一页 <ChevronRight size={15} />
                      </Button>
                    </div>
                  </div>
                </Panel>
              </DataState>
            </>
          )}

          {activeTab === 'operator' && (
            <DataState
              loading={operatorState.loading && operator === undefined}
              error={operatorState.error}
              onRetry={operatorState.reload}
            >
              {operator && operator.failures.length > 0 && (
                <Notice tone="warning" icon={<AlertCircle size={17} />}>
                  部分数据源不可用：{operator.failures.join('；')}
                </Notice>
              )}

              <Panel
                title="运维工具清单"
                description={`${formatNumber(operatorTools.length)} 个已注册工具；描述来自服务端注册表。`}
                flush
              >
                <DataState
                  empty={operatorTools.length === 0}
                  emptyTitle="没有运维工具"
                  emptyDetail="服务端未返回任何工具描述符。"
                >
                  <Table minWidth={900}>
                    <thead>
                      <tr><th>工具</th><th>风险</th><th>需二次确认</th><th>用法</th><th>说明</th></tr>
                    </thead>
                    <tbody>
                      {operatorTools.map((tool) => (
                        <tr key={tool.name}>
                          <td className="mono">{tool.name}</td>
                          <td><Pill tone={riskTone(tool.risk)}>{tool.risk}</Pill></td>
                          <td>{tool.confirm ? <Pill tone="warning">需要</Pill> : <span className="muted-text">无需</span>}</td>
                          <td className="mono truncate-cell" title={tool.usage}>{tool.usage}</td>
                          <td>{tool.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </DataState>
              </Panel>

              <Panel
                title="运维审计轨迹"
                description={`最近 ${LOG_LIMIT} 条调用记录（允许 / 拒绝 / 失败均记录）。`}
                flush
              >
                <DataState
                  empty={operatorEntries.length === 0}
                  emptyTitle="暂无运维审计"
                  emptyDetail="还没有运维工具调用记录，或存储中尚未写入审计条目。"
                >
                  <Table minWidth={900}>
                    <thead>
                      <tr><th>时间</th><th>工具</th><th>调用者</th><th>结果</th><th>参数</th><th>详情</th></tr>
                    </thead>
                    <tbody>
                      {operatorEntries.map((entry, index) => (
                        <tr key={`${entry.ts}:${entry.tool}:${index}`}>
                          <td className="mono nowrap" title={formatDateTime(entry.ts)}>{formatRelative(entry.ts)}</td>
                          <td className="mono">{entry.tool}</td>
                          <td className="mono">{entry.caller}</td>
                          <td><Pill tone={levelTone(entry.outcome)}>{entry.outcome}</Pill></td>
                          <td className="mono truncate-cell" title={entry.args}>{entry.args || '—'}</td>
                          <td className="truncate-cell" title={entry.detail}>{entry.detail || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </DataState>
              </Panel>

              <Panel title="运维说明" description="这些工具只能在机器人外部由管理员触发。">
                <Notice tone="info" icon={<Wrench size={17} />}>
                  此页面只展示运维工具的描述符与审计轨迹，不提供任何工具调用入口；破坏性操作不在本控制台执行。
                </Notice>
              </Panel>
            </DataState>
          )}
        </>
      )}

      <Modal
        open={logSession !== null}
        onClose={() => setLogSession(null)}
        title="聊天记录"
        description={logSession ? `botId ${logSession.botId} · channelId ${logSession.channelId} · 最近 ${LOG_LIMIT} 条` : undefined}
        width={880}
        footer={<Button onClick={() => setLogSession(null)}>关闭</Button>}
      >
        <DataState
          loading={chatLogState.loading && chatLogState.data === undefined}
          error={chatLogState.error}
          empty={chatLogRows.length === 0}
          emptyTitle="暂无物理聊天日志"
          emptyDetail="该频道还没有写入 SQLite 的聊天日志，或日志已被保留策略清理。"
          onRetry={chatLogState.reload}
        >
          <Table minWidth={720}>
            <thead>
              <tr><th>时间</th><th>作者</th><th>提及机器人</th><th>内容</th></tr>
            </thead>
            <tbody>
              {chatLogRows.map((row) => (
                <tr key={row.id}>
                  <td className="mono nowrap" title={formatDateTime(chatLogTime(row))}>{formatDateTime(chatLogTime(row))}</td>
                  <td>
                    <div className="table-primary">{row.username || row.author_id || '—'}</div>
                    <small className="muted-text mono">{row.author_id || '—'}</small>
                  </td>
                  <td>{row.mentions_bot ? <Pill tone="info">是</Pill> : <span className="muted-text">否</span>}</td>
                  <td className="log-message prewrap">{row.content || '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </DataState>
      </Modal>
    </>
  );
}
