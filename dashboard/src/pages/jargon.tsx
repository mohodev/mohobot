import { useCallback, useMemo, useState } from 'react';
import {
  Check, Clock, Download, RefreshCw, RotateCcw, ShieldAlert, Trash2, X,
} from 'lucide-react';
import { api, ApiError, body, confirmedRequest } from '../lib/api';
import type { PageProps } from '../lib/types';
import { useAsync } from '../lib/hooks';
import { formatDateTime, formatNumber, formatPercent, formatRelative, truncateMiddle } from '../lib/format';
import {
  Button, Collapsible, CopyButton, DataState, EmptyState, Field, Modal, Notice, PageTitle, Panel, Pill,
  Select, StatCard, Table, Tabs, TextInput,
} from '../components/ui';

/**
 * 表达与黑话 — 两个标签页：
 *  - 群体黑话（jargon）：审核候选/已批准/已拒绝的群内术语。
 *  - 表达记忆（expression memory）：按 botId/userId 审核表达偏好、回收站恢复、批量删除与导出。
 * 所有写操作都经过服务端确认（confirmedRequest）并按权限隐藏。
 */

type TabId = 'jargon' | 'expressions';

interface JargonEntry {
  id?: string;
  term?: string;
  meaning?: string;
  examples?: string[];
  sourceAuthors?: string[];
  sharingGroup?: { channelId?: string; guildId?: string };
  status?: string;
  confidence?: number;
  firstSeen?: number;
  lastSeen?: number;
  usageCount?: number;
}

interface ExpressionRecord {
  id?: string;
  botId?: string;
  userId?: string;
  channelId?: string;
  category?: string;
  text?: string;
  status?: string;
  confidence?: number;
  createdAt?: number;
  updatedAt?: number;
  expiresAt?: number;
  reviewer?: string;
  tombstone?: { at?: number; reason?: string; reviewer?: string };
}

const JARGON_STATUS_LABELS: Record<string, string> = {
  candidate: '候选', approved: '已批准', rejected: '已拒绝',
};

const EXPRESSION_STATUS_LABELS: Record<string, string> = {
  pending: '待审', approved: '已批准', rejected: '已拒绝', superseded: '已取代',
};

const CATEGORY_LABELS: Record<string, string> = {
  preference: '偏好', addressing: '称呼', 'communication-style': '沟通风格', boundary: '边界',
};

/** State tone for both review planes: candidate/pending are the queue, approved settled, rejected refused. */
function statusTone(status: string | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'approved') return 'success';
  if (status === 'candidate' || status === 'pending') return 'warning';
  if (status === 'rejected') return 'danger';
  return 'neutral';
}

function statusLabel(map: Record<string, string>, status: string | undefined): string {
  if (!status) return '—';
  return map[status] ?? status;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function isCancel(cause: unknown): boolean {
  return cause instanceof ApiError && cause.statusCode === 0;
}

function downloadJsonl(filename: string, text: string): void {
  try {
    const blob = new Blob([text], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch {
    /* 下载在非浏览器环境下会被忽略，内容仍可在弹窗中复制。 */
  }
}

/**
 * The approve/reject pair is identical on both review planes; extracted so the
 * button semantics (busy-per-row, disable-when-settled) stay in one place.
 */
function ReviewActions({ approveBusy, rejectBusy, approveDisabled, rejectDisabled, approveTitle, rejectTitle, onApprove, onReject }: {
  approveBusy: boolean;
  rejectBusy: boolean;
  approveDisabled: boolean;
  rejectDisabled: boolean;
  approveTitle?: string;
  rejectTitle?: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="table-actions">
      <Button variant="secondary" busy={approveBusy} disabled={approveDisabled} title={approveTitle} onClick={onApprove}>
        <Check size={14} /> 批准
      </Button>
      <Button variant="danger" busy={rejectBusy} disabled={rejectDisabled} title={rejectTitle} onClick={onReject}>
        <X size={14} /> 拒绝
      </Button>
    </div>
  );
}

export function Jargon({ permissions }: PageProps) {
  const [tab, setTab] = useState<TabId>('jargon');
  const [nonce, setNonce] = useState(0);
  const canWrite = permissions.includes('memory.write');
  const canDelete = permissions.includes('memory.delete');
  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  return (
    <>
      <PageTitle
        eyebrow="EXPRESSION & JARGON"
        title="表达与黑话"
        description="审核群体黑话候选词条，并管理按机器人/用户隔离的表达记忆、回收站与导出。"
        actions={<Button onClick={refresh}><RefreshCw size={15} /> 刷新</Button>}
      />

      <Tabs<TabId>
        value={tab}
        ariaLabel="表达与黑话视图"
        options={[{ value: 'jargon', label: '群体黑话' }, { value: 'expressions', label: '表达记忆' }]}
        onChange={setTab}
      />

      {!canWrite ? (
        <Notice tone="warning" icon={<ShieldAlert size={17} />}>
          只读模式：当前账号缺少 memory.write 权限，黑话与表达记忆的审批操作已隐藏。
        </Notice>
      ) : (
        <Notice tone="info" icon={<ShieldAlert size={17} />}>
          审批、拒绝、恢复与批量删除均为受保护写操作，提交前需要服务端确认 nonce 二次确认。
        </Notice>
      )}

      {tab === 'jargon'
        ? <JargonTab canWrite={canWrite} refreshToken={nonce} />
        : <ExpressionTab canWrite={canWrite} canDelete={canDelete} refreshToken={nonce} />}
    </>
  );
}

function JargonTab({ canWrite, refreshToken }: { canWrite: boolean; refreshToken: number }) {
  const [status, setStatus] = useState('');
  const [channelId, setChannelId] = useState('');
  const [guildId, setGuildId] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  const state = useAsync(async () => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (channelId.trim()) params.set('channelId', channelId.trim());
    if (guildId.trim()) params.set('guildId', guildId.trim());
    params.set('limit', '100');
    const result = await api<{ entries?: JargonEntry[] }>(`/memory/jargon?${params.toString()}`);
    return Array.isArray(result.entries) ? result.entries : [];
  }, [status, channelId, guildId, refreshToken], '读取群体黑话失败');

  const entries = state.data ?? [];
  const hasFilters = Boolean(status || channelId.trim() || guildId.trim());

  const counts = useMemo(() => {
    let candidate = 0;
    let approved = 0;
    let rejected = 0;
    for (const entry of entries) {
      if (entry.status === 'candidate') candidate += 1;
      else if (entry.status === 'approved') approved += 1;
      else if (entry.status === 'rejected') rejected += 1;
    }
    return { candidate, approved, rejected };
  }, [entries]);

  const resetFilters = useCallback(() => {
    setStatus('');
    setChannelId('');
    setGuildId('');
  }, []);

  async function review(entry: JargonEntry, action: 'approve' | 'reject') {
    const id = entry.id;
    if (!id) return;
    const verb = action === 'approve' ? '批准' : '拒绝';
    setActionError('');
    setNotice('');
    setBusyKey(`${action}:${id}`);
    try {
      await confirmedRequest<{ outcome?: string }>(
        `/memory/jargon/${action}`,
        { method: 'POST', body: body({ id }) },
        { id },
        `${verb}黑话「${entry.term ?? id}」`,
      );
      setNotice(`已${verb}黑话「${entry.term ?? id}」。`);
      state.reload();
    } catch (cause) {
      if (!isCancel(cause)) setActionError(messageOf(cause, `${verb}失败`));
    } finally {
      setBusyKey('');
    }
  }

  return (
    <Panel
      title="群体黑话"
      description="群内术语候选与已审核词条，按状态与共享范围筛选，最多返回 100 条。"
    >
      <div className="filter-row">
        <Select aria-label="黑话状态" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部状态</option>
          <option value="candidate">候选</option>
          <option value="approved">已批准</option>
          <option value="rejected">已拒绝</option>
        </Select>
        <TextInput aria-label="频道 ID" placeholder="频道 ID" value={channelId} onChange={(event) => setChannelId(event.target.value)} />
        <TextInput aria-label="服务器 ID" placeholder="服务器 ID" value={guildId} onChange={(event) => setGuildId(event.target.value)} />
        <Button onClick={resetFilters} disabled={!hasFilters}>重置筛选</Button>
      </div>

      {actionError && <Notice tone="danger">{actionError}</Notice>}
      {notice && <Notice tone="info">{notice}</Notice>}

      <DataState
        loading={state.loading && !state.data}
        error={state.error}
        empty={entries.length === 0}
        emptyTitle="暂无黑话条目"
        emptyDetail={hasFilters ? '当前筛选条件下没有候选或已审核的黑话词条。' : '尚未从群聊中识别到任何黑话候选。'}
        onRetry={state.reload}
      >
        <div className="stat-grid">
          <StatCard label="词条" value={formatNumber(entries.length)} note="当前筛选结果" />
          <StatCard label="候选" value={formatNumber(counts.candidate)} note="待审批" icon={<Clock size={17} />} tone={counts.candidate > 0 ? 'warning' : undefined} />
          <StatCard label="已批准" value={formatNumber(counts.approved)} note="已进入召回" icon={<Check size={17} />} tone={counts.approved > 0 ? 'success' : undefined} />
          <StatCard label="已拒绝" value={formatNumber(counts.rejected)} note="不再召回" icon={<X size={17} />} tone={counts.rejected > 0 ? 'danger' : undefined} />
        </div>

        <Table minWidth={1180}>
          <thead>
            <tr>
              <th>术语</th><th>含义</th><th>共享范围</th><th>示例与来源</th><th>状态</th><th>使用次数</th><th>置信度</th><th>最近出现</th>
              {canWrite && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => {
              const id = entry.id ?? `entry-${index}`;
              const examples = entry.examples ?? [];
              const authors = entry.sourceAuthors ?? [];
              const hasContext = examples.length > 0 || authors.length > 0;
              const term = entry.term ?? id;
              return (
                <tr key={id}>
                  <td>
                    <div className="table-primary">{entry.term || '—'}</div>
                    <small className="muted-text mono" title={id}>{truncateMiddle(id, 20)}</small>
                  </td>
                  <td><span className="truncate-cell" title={entry.meaning || undefined}>{entry.meaning || '—'}</span></td>
                  <td>
                    {entry.sharingGroup?.channelId && <div className="mono dim" title={entry.sharingGroup.channelId}>{entry.sharingGroup.channelId}</div>}
                    {entry.sharingGroup?.guildId && <div className="mono dim">服务器 {entry.sharingGroup.guildId}</div>}
                    {!entry.sharingGroup?.channelId && !entry.sharingGroup?.guildId && <span className="muted-text">—</span>}
                  </td>
                  <td>
                    {hasContext ? (
                      <Collapsible title={`${formatNumber(examples.length)} 示例 · ${formatNumber(authors.length)} 来源`}>
                        {examples.length > 0 && (
                          <div className="col gap-sm">
                            {examples.map((example, exampleIndex) => (
                              <span key={`${exampleIndex}:${example}`} className="muted-text prewrap">「{example}」</span>
                            ))}
                          </div>
                        )}
                        {authors.length > 0 && <div className="muted-text mono mt-2">{authors.join('、')}</div>}
                      </Collapsible>
                    ) : <span className="muted-text">—</span>}
                  </td>
                  <td><Pill tone={statusTone(entry.status)}>{statusLabel(JARGON_STATUS_LABELS, entry.status)}</Pill></td>
                  <td>{formatNumber(entry.usageCount ?? 0)}</td>
                  <td>{typeof entry.confidence === 'number' ? formatPercent(entry.confidence) : '—'}</td>
                  <td className="nowrap" title={formatDateTime(entry.lastSeen)}>{formatRelative(entry.lastSeen)}</td>
                  {canWrite && (
                    <td>
                      <ReviewActions
                        approveBusy={busyKey === `approve:${id}`}
                        rejectBusy={busyKey === `reject:${id}`}
                        approveDisabled={entry.status === 'approved'}
                        rejectDisabled={entry.status === 'rejected'}
                        approveTitle={`通过 ${term}`}
                        rejectTitle={`拒绝 ${term}`}
                        onApprove={() => void review(entry, 'approve')}
                        onReject={() => void review(entry, 'reject')}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </Table>
      </DataState>
    </Panel>
  );
}

function ExpressionTab({ canWrite, canDelete, refreshToken }: {
  canWrite: boolean;
  canDelete: boolean;
  refreshToken: number;
}) {
  const [botText, setBotText] = useState('');
  const [userText, setUserText] = useState('');
  const [status, setStatus] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  const [bulkUser, setBulkUser] = useState('');
  const [bulkChannel, setBulkChannel] = useState('');
  const [bulkBefore, setBulkBefore] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleteNotice, setDeleteNotice] = useState('');

  const [exportBusy, setExportBusy] = useState(false);
  const [exportText, setExportText] = useState<string | null>(null);

  const botId = botText.trim();

  const state = useAsync(async () => {
    if (!botId) return [] as ExpressionRecord[];
    const params = new URLSearchParams({ botId });
    if (userText.trim()) params.set('userId', userText.trim());
    if (status) params.set('status', status);
    const result = await api<{ records?: ExpressionRecord[] }>(`/memory/expressions?${params.toString()}`);
    return Array.isArray(result.records) ? result.records : [];
  }, [botId, userText, status, refreshToken], '读取表达记忆失败');

  const binState = useAsync(async () => {
    if (!botId) return [] as ExpressionRecord[];
    const params = new URLSearchParams({ botId });
    const result = await api<{ records?: ExpressionRecord[] }>(`/memory/expressions/recycle-bin?${params.toString()}`);
    return Array.isArray(result.records) ? result.records : [];
  }, [botId, refreshToken], '读取回收站失败');

  const records = state.data ?? [];
  const binRecords = binState.data ?? [];
  const hasFilters = Boolean(userText.trim() || status);

  const counts = useMemo(() => {
    let pending = 0;
    let approved = 0;
    let rejected = 0;
    for (const record of records) {
      if (record.tombstone !== undefined) continue;
      if (record.status === 'pending') pending += 1;
      else if (record.status === 'approved') approved += 1;
      else if (record.status === 'rejected') rejected += 1;
    }
    return { pending, approved, rejected };
  }, [records]);

  const resetFilters = useCallback(() => {
    setUserText('');
    setStatus('');
  }, []);

  async function review(record: ExpressionRecord, action: 'approve' | 'reject') {
    const id = record.id;
    const owner = record.userId ?? userText.trim();
    if (!id || !botId) return;
    if (!owner) { setActionError('该记录缺少 userId，无法提交审批。'); return; }
    const verb = action === 'approve' ? '批准' : '拒绝';
    setActionError('');
    setNotice('');
    setBusyKey(`${action}:${id}`);
    try {
      await confirmedRequest<{ outcome?: string }>(
        `/memory/expressions/${action}`,
        { method: 'POST', body: body({ botId, userId: owner, id }) },
        { botId, userId: owner, id },
        `${verb}表达记忆「${truncateMiddle(record.text ?? id, 24)}」`,
      );
      setNotice(`已${verb}表达记忆。`);
      state.reload();
    } catch (cause) {
      if (!isCancel(cause)) setActionError(messageOf(cause, `${verb}失败`));
    } finally {
      setBusyKey('');
    }
  }

  async function restore(record: ExpressionRecord) {
    const id = record.id;
    const owner = record.userId ?? userText.trim();
    if (!id || !botId) return;
    if (!owner) { setActionError('该记录缺少 userId，无法恢复。'); return; }
    setActionError('');
    setNotice('');
    setBusyKey(`restore:${id}`);
    try {
      await confirmedRequest<{ outcome?: string }>(
        '/memory/expressions/restore',
        { method: 'POST', body: body({ botId, userId: owner, id }) },
        { botId, userId: owner, id },
        `恢复表达记忆「${truncateMiddle(record.text ?? id, 24)}」`,
      );
      setNotice('已恢复表达记忆。');
      binState.reload();
      state.reload();
    } catch (cause) {
      if (!isCancel(cause)) setActionError(messageOf(cause, '恢复失败'));
    } finally {
      setBusyKey('');
    }
  }

  async function runBulkDelete() {
    setDeleteError('');
    setDeleteNotice('');
    if (!botId) { setDeleteError('请先填写 Bot ID。'); return; }
    const filter: Record<string, unknown> = { botId };
    if (bulkUser.trim()) filter.userId = bulkUser.trim();
    if (bulkChannel.trim()) filter.channelId = bulkChannel.trim();
    if (bulkBefore) {
      const parsed = new Date(bulkBefore).getTime();
      if (Number.isFinite(parsed)) filter.before = parsed;
    }
    if (!filter.userId && !filter.channelId && !filter.before) {
      setDeleteError('至少需要一个筛选条件（User ID、频道 ID 或截止时间）。');
      return;
    }
    setBusyKey('bulk-delete');
    try {
      const result = await confirmedRequest<{ deleted?: number }>(
        '/memory/expressions/bulk-delete',
        { method: 'POST', body: body(filter) },
        filter,
        '批量删除表达记忆（软删除，可回收站恢复）',
      );
      setDeleteNotice(`已删除 ${formatNumber(result.deleted ?? 0)} 条表达记忆。`);
      state.reload();
      binState.reload();
    } catch (cause) {
      if (!isCancel(cause)) setDeleteError(messageOf(cause, '批量删除失败'));
    } finally {
      setBusyKey('');
    }
  }

  async function runExport() {
    if (!botId) { setActionError('请先填写 Bot ID。'); return; }
    setActionError('');
    setExportBusy(true);
    try {
      const params = new URLSearchParams({ botId, limit: '1000' });
      if (status) params.set('status', status);
      const result = await api<{ data?: string }>(`/memory/expressions/export?${params.toString()}`);
      setExportText(typeof result.data === 'string' ? result.data : '');
    } catch (cause) {
      setActionError(messageOf(cause, '导出表达记忆失败'));
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <>
      {actionError && <Notice tone="danger">{actionError}</Notice>}
      {notice && <Notice tone="info">{notice}</Notice>}

      <Panel
        title="表达记忆"
        description="按 Bot ID 与用户筛选表达记忆；Bot ID 为服务端必填项。"
      >
        <div className="toolbar">
          <Field label="Bot ID" hint="服务端必填">
            <TextInput aria-label="Bot ID" placeholder="例如 moho" value={botText} onChange={(event) => setBotText(event.target.value)} />
          </Field>
          <Field label="User ID（可选）">
            <TextInput aria-label="User ID" placeholder="留空则查询全部用户" value={userText} onChange={(event) => setUserText(event.target.value)} />
          </Field>
          <Field label="状态">
            <Select aria-label="表达记忆状态" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">全部状态</option>
              <option value="pending">待审</option>
              <option value="approved">已批准</option>
              <option value="rejected">已拒绝</option>
              <option value="superseded">已取代</option>
            </Select>
          </Field>
          <Button onClick={() => void runExport()} busy={exportBusy} disabled={!botId}>
            <Download size={15} /> 导出 JSONL
          </Button>
          <Button onClick={resetFilters} disabled={!hasFilters}>重置筛选</Button>
        </div>

        {!botId
          ? <Notice tone="info">请输入 Bot ID 后查询该机器人的表达记忆记录。</Notice>
          : (
            <DataState
              loading={state.loading && !state.data}
              error={state.error}
              empty={records.length === 0}
              emptyTitle="暂无表达记忆"
              emptyDetail={hasFilters ? '该机器人下没有符合当前筛选条件的表达记忆记录。' : '该机器人还没有被记录任何表达偏好。'}
              onRetry={state.reload}
            >
              <div className="stat-grid">
                <StatCard label="记录" value={formatNumber(records.length)} note="当前筛选结果" />
                <StatCard label="待审" value={formatNumber(counts.pending)} note="等待审批" icon={<Clock size={17} />} tone={counts.pending > 0 ? 'warning' : undefined} />
                <StatCard label="已批准" value={formatNumber(counts.approved)} note="已生效" icon={<Check size={17} />} tone={counts.approved > 0 ? 'success' : undefined} />
                <StatCard label="已拒绝" value={formatNumber(counts.rejected)} note="不再生效" icon={<X size={17} />} tone={counts.rejected > 0 ? 'danger' : undefined} />
              </div>

              <Table minWidth={1180}>
                <thead>
                  <tr>
                    <th>内容</th><th>类别</th><th>用户</th><th>频道</th><th>状态</th><th>置信度</th><th>更新时间</th>
                    {canWrite && <th>操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {records.map((record, index) => {
                    const id = record.id ?? `record-${index}`;
                    const tombstoned = record.tombstone !== undefined;
                    return (
                      <tr key={id}>
                        <td>
                          <span className="prewrap">{record.text || '—'}</span>
                          <br />
                          <small className="muted-text mono" title={id}>{truncateMiddle(id, 20)}</small>
                        </td>
                        <td>{statusLabel(CATEGORY_LABELS, record.category)}</td>
                        <td className="mono dim">{record.userId ?? '—'}</td>
                        <td className="mono dim">{record.channelId ?? '—'}</td>
                        <td>
                          <Pill tone={statusTone(record.status)}>{statusLabel(EXPRESSION_STATUS_LABELS, record.status)}</Pill>
                          {tombstoned && <div className="mt-2"><Pill tone="danger">已删除</Pill></div>}
                        </td>
                        <td>{typeof record.confidence === 'number' ? formatPercent(record.confidence) : '—'}</td>
                        <td className="nowrap" title={formatDateTime(record.updatedAt)}>{formatRelative(record.updatedAt)}</td>
                        {canWrite && (
                          <td>
                            <ReviewActions
                              approveBusy={busyKey === `approve:${id}`}
                              rejectBusy={busyKey === `reject:${id}`}
                              approveDisabled={record.status === 'approved' || tombstoned}
                              rejectDisabled={record.status === 'rejected' || tombstoned}
                              approveTitle={`批准 ${truncateMiddle(record.text ?? id, 24)}`}
                              rejectTitle={`拒绝 ${truncateMiddle(record.text ?? id, 24)}`}
                              onApprove={() => void review(record, 'approve')}
                              onReject={() => void review(record, 'reject')}
                            />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </DataState>
          )}
      </Panel>

      {botId && (
        <Panel
          title="回收站"
          description="软删除的表达记忆可在此恢复；到期后由保留策略物理清除。"
        >
          <DataState
            loading={binState.loading && !binState.data}
            error={binState.error}
            empty={binRecords.length === 0}
            emptyTitle="回收站为空"
            emptyDetail="当前没有可恢复的表达记忆。"
            onRetry={binState.reload}
          >
            <Table minWidth={1080}>
              <thead>
                <tr>
                  <th>内容</th><th>类别</th><th>用户</th><th>删除原因</th><th>删除时间</th><th>到期时间</th>
                  {canWrite && <th>操作</th>}
                </tr>
              </thead>
              <tbody>
                {binRecords.map((record, index) => {
                  const id = record.id ?? `bin-${index}`;
                  return (
                    <tr key={id}>
                      <td>
                        <span className="prewrap">{record.text || '—'}</span>
                        <br />
                        <small className="muted-text mono" title={id}>{truncateMiddle(id, 20)}</small>
                      </td>
                      <td>{statusLabel(CATEGORY_LABELS, record.category)}</td>
                      <td className="mono dim">{record.userId ?? '—'}</td>
                      <td className="truncate-cell" title={record.tombstone?.reason}>{record.tombstone?.reason || '—'}</td>
                      <td className="nowrap" title={formatDateTime(record.tombstone?.at)}>{formatRelative(record.tombstone?.at)}</td>
                      <td className="nowrap" title={record.expiresAt ? formatDateTime(record.expiresAt) : undefined}>{record.expiresAt ? formatDateTime(record.expiresAt) : '—'}</td>
                      {canWrite && (
                        <td>
                          <div className="table-actions">
                            <Button
                              variant="secondary"
                              busy={busyKey === `restore:${id}`}
                              onClick={() => void restore(record)}
                            >
                              <RotateCcw size={14} /> 恢复
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </DataState>
        </Panel>
      )}

      <Panel title="批量删除" description="软删除匹配的表达记忆；可在回收站恢复。需要 memory.delete 权限。">
        {!canDelete
          ? <Notice tone="warning" icon={<ShieldAlert size={17} />}>只读：当前账号缺少 memory.delete 权限，批量删除已禁用。</Notice>
          : (
            <>
              {deleteError && <Notice tone="danger">{deleteError}</Notice>}
              {deleteNotice && <Notice tone="info">{deleteNotice}</Notice>}
              <div className="form-grid form-grid-3">
                <Field label="User ID（可选）">
                  <TextInput aria-label="批量 User ID" placeholder="限定某个用户" value={bulkUser} onChange={(event) => setBulkUser(event.target.value)} />
                </Field>
                <Field label="频道 ID（可选）">
                  <TextInput aria-label="批量频道 ID" placeholder="限定某个频道" value={bulkChannel} onChange={(event) => setBulkChannel(event.target.value)} />
                </Field>
                <Field label="截止时间（可选）" hint="删除该时间之前创建的记录">
                  <TextInput aria-label="批量截止时间" type="datetime-local" value={bulkBefore} onChange={(event) => setBulkBefore(event.target.value)} />
                </Field>
              </div>
              <div className="row row-wrap">
                <Button variant="danger" busy={busyKey === 'bulk-delete'} disabled={!botId} onClick={() => void runBulkDelete()}>
                  <Trash2 size={15} /> 批量删除
                </Button>
                <span className="muted-text">至少填写一个筛选条件（User ID、频道 ID 或截止时间），避免误删全部记录；Bot ID 取自上方的输入框。</span>
              </div>
            </>
          )}
      </Panel>

      <Modal
        open={exportText !== null}
        onClose={() => setExportText(null)}
        title="导出表达记忆"
        description="服务端已移除用户与频道标识，每行一条 JSON（JSONL）。"
        width={760}
        footer={<>
          <Button variant="ghost" onClick={() => setExportText(null)}>关闭</Button>
          <Button onClick={() => downloadJsonl(`expressions-${botId || 'unknown'}.jsonl`, exportText ?? '')}>
            <Download size={15} /> 下载 JSONL
          </Button>
        </>}
      >
        {exportText
          ? (
            <>
              <div className="row row-between">
                <span className="muted-text">共 {formatNumber(exportText.split('\n').filter(Boolean).length)} 行</span>
                <CopyButton value={exportText} label="复制全部" />
              </div>
              <pre className="prewrap mono json-view">{exportText}</pre>
            </>
          )
          : <EmptyState title="没有可导出的记录" detail="该机器人下没有符合当前筛选条件的表达记忆。" />}
      </Modal>
    </>
  );
}
