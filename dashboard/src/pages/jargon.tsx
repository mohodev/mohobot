import { useCallback, useState } from 'react';
import {
  Check, Download, RefreshCw, RotateCcw, ShieldAlert, Trash2, X,
} from 'lucide-react';
import { api, ApiError, body, confirmedRequest } from '../lib/api';
import type { PageProps } from '../lib/types';
import { useAsync } from '../lib/hooks';
import { formatDateTime, formatNumber, formatPercent, formatRelative, truncateMiddle } from '../lib/format';
import {
  Button, CopyButton, DataState, EmptyState, Field, Modal, Notice, PageTitle, Panel, Pill,
  Select, Table, Tabs, TextInput,
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

function jargonTone(status: string | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'approved') return 'success';
  if (status === 'candidate') return 'warning';
  if (status === 'rejected') return 'danger';
  return 'neutral';
}

function expressionTone(status: string | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'approved') return 'success';
  if (status === 'pending') return 'warning';
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

      {!canWrite && (
        <Notice tone="warning" icon={<ShieldAlert size={17} />}>
          只读模式：当前账号缺少 memory.write 权限，黑话与表达记忆的审批操作已隐藏。
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
      description={state.data ? `${formatNumber(entries.length)} 条词条（最多显示 100 条）` : '按状态与共享范围筛选群内术语。'}
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
      </div>

      {actionError && <Notice tone="danger">{actionError}</Notice>}
      {notice && <Notice tone="info">{notice}</Notice>}

      <DataState
        loading={state.loading && !state.data}
        error={state.error}
        empty={entries.length === 0}
        emptyTitle="暂无黑话条目"
        emptyDetail="当前筛选条件下没有候选或已审核的黑话词条。"
        onRetry={state.reload}
      >
        <Table minWidth={900}>
          <thead>
            <tr>
              <th>术语</th><th>含义</th><th>共享范围</th><th>状态</th><th>使用次数</th><th>最近出现</th>
              {canWrite && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => {
              const id = entry.id ?? `entry-${index}`;
              return (
                <tr key={id}>
                  <td><div className="table-primary">{entry.term || '—'}</div><small className="muted-text mono">{truncateMiddle(id, 20)}</small></td>
                  <td><span className="prewrap">{entry.meaning || '—'}</span></td>
                  <td>
                    {entry.sharingGroup?.channelId && <div className="mono dim">{entry.sharingGroup.channelId}</div>}
                    {entry.sharingGroup?.guildId && <div className="mono dim">服务器 {entry.sharingGroup.guildId}</div>}
                    {!entry.sharingGroup?.channelId && !entry.sharingGroup?.guildId && '—'}
                  </td>
                  <td><Pill tone={jargonTone(entry.status)}>{statusLabel(JARGON_STATUS_LABELS, entry.status)}</Pill></td>
                  <td>{formatNumber(entry.usageCount ?? 0)}</td>
                  <td className="nowrap">{formatRelative(entry.lastSeen)}</td>
                  {canWrite && (
                    <td>
                      <div className="table-actions">
                        <Button
                          variant="secondary"
                          busy={busyKey === `approve:${id}`}
                          disabled={entry.status === 'approved'}
                          onClick={() => void review(entry, 'approve')}
                          title={`通过 ${entry.term ?? id}`}
                        >
                          <Check size={14} /> 批准
                        </Button>
                        <Button
                          variant="danger"
                          busy={busyKey === `reject:${id}`}
                          disabled={entry.status === 'rejected'}
                          onClick={() => void review(entry, 'reject')}
                          title={`拒绝 ${entry.term ?? id}`}
                        >
                          <X size={14} /> 拒绝
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

      <Panel title="表达记忆" description={state.data ? `${formatNumber(records.length)} 条记录` : '按 Bot ID 与用户筛选表达记忆。'}>
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
        </div>

        {!botId
          ? <Notice tone="info">请输入 Bot ID 后查询该机器人的表达记忆记录。</Notice>
          : (
            <DataState
              loading={state.loading && !state.data}
              error={state.error}
              empty={records.length === 0}
              emptyTitle="暂无表达记忆"
              emptyDetail="该机器人下没有符合当前筛选条件的表达记忆记录。"
              onRetry={state.reload}
            >
              <Table minWidth={980}>
                <thead>
                  <tr>
                    <th>内容</th><th>类别</th><th>用户</th><th>频道</th><th>状态</th><th>置信度</th><th>更新时间</th>
                    {canWrite && <th>操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {records.map((record, index) => {
                    const id = record.id ?? `record-${index}`;
                    return (
                      <tr key={id}>
                        <td><span className="prewrap">{record.text || '—'}</span><br /><small className="muted-text mono">{truncateMiddle(id, 20)}</small></td>
                        <td>{statusLabel(CATEGORY_LABELS, record.category)}</td>
                        <td className="mono dim">{record.userId ?? '—'}</td>
                        <td className="mono dim">{record.channelId ?? '—'}</td>
                        <td><Pill tone={expressionTone(record.status)}>{statusLabel(EXPRESSION_STATUS_LABELS, record.status)}</Pill></td>
                        <td>{typeof record.confidence === 'number' ? formatPercent(record.confidence) : '—'}</td>
                        <td className="nowrap">{formatDateTime(record.updatedAt)}</td>
                        {canWrite && (
                          <td>
                            <div className="table-actions">
                              <Button
                                variant="secondary"
                                busy={busyKey === `approve:${id}`}
                                disabled={record.status === 'approved' || record.tombstone !== undefined}
                                onClick={() => void review(record, 'approve')}
                              >
                                <Check size={14} /> 批准
                              </Button>
                              <Button
                                variant="danger"
                                busy={busyKey === `reject:${id}`}
                                disabled={record.status === 'rejected' || record.tombstone !== undefined}
                                onClick={() => void review(record, 'reject')}
                              >
                                <X size={14} /> 拒绝
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
          )}
      </Panel>

      {botId && (
        <Panel title="回收站" description={binState.data ? `${formatNumber(binRecords.length)} 条已软删除记录` : '软删除的表达记忆可在此恢复。'}>
          <DataState
            loading={binState.loading && !binState.data}
            error={binState.error}
            empty={binRecords.length === 0}
            emptyTitle="回收站为空"
            emptyDetail="当前没有可恢复的表达记忆。"
            onRetry={binState.reload}
          >
            <Table minWidth={880}>
              <thead>
                <tr>
                  <th>内容</th><th>类别</th><th>用户</th><th>删除时间</th><th>到期时间</th>
                  {canWrite && <th>操作</th>}
                </tr>
              </thead>
              <tbody>
                {binRecords.map((record, index) => {
                  const id = record.id ?? `bin-${index}`;
                  return (
                    <tr key={id}>
                      <td><span className="prewrap">{record.text || '—'}</span><br /><small className="muted-text mono">{truncateMiddle(id, 20)}</small></td>
                      <td>{statusLabel(CATEGORY_LABELS, record.category)}</td>
                      <td className="mono dim">{record.userId ?? '—'}</td>
                      <td className="nowrap">{formatDateTime(record.tombstone?.at)}</td>
                      <td className="nowrap">{record.expiresAt ? formatDateTime(record.expiresAt) : '—'}</td>
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
              <div className="toolbar">
                <Field label="User ID（可选）">
                  <TextInput aria-label="批量 User ID" placeholder="限定某个用户" value={bulkUser} onChange={(event) => setBulkUser(event.target.value)} />
                </Field>
                <Field label="频道 ID（可选）">
                  <TextInput aria-label="批量频道 ID" placeholder="限定某个频道" value={bulkChannel} onChange={(event) => setBulkChannel(event.target.value)} />
                </Field>
                <Field label="截止时间（可选）">
                  <TextInput aria-label="批量截止时间" type="datetime-local" value={bulkBefore} onChange={(event) => setBulkBefore(event.target.value)} />
                </Field>
                <Button variant="danger" busy={busyKey === 'bulk-delete'} disabled={!botId} onClick={() => void runBulkDelete()}>
                  <Trash2 size={15} /> 批量删除
                </Button>
              </div>
              <p className="muted-text">至少填写一个筛选条件（User ID、频道 ID 或截止时间），避免误删全部记录。Bot ID 取自上方的输入框。</p>
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
