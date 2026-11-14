import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Brain, Download, Eye, RefreshCw, RotateCcw, Search, ShieldAlert, Trash2, Upload,
} from 'lucide-react';
import { ApiError, api, body, confirmedRequest } from '../lib/api';
import type { MemoryRecord, PageProps } from '../lib/types';
import { useAsync } from '../lib/hooks';
import { formatDateTime, formatNumber, prettyJson } from '../lib/format';
import {
  Button, DataState, Descriptions, Field, Modal, Notice, PageTitle, Panel, Pill, Select, Table, Tabs,
  TextArea, TextInput,
} from '../components/ui';

type ScopeValue = '' | 'private' | 'relationship' | 'shared';
type GovernanceTab = 'recycle' | 'export' | 'import' | 'bulk';

interface ListFilters {
  scope: ScopeValue;
  botId: string;
  userId: string;
  limit: number;
}

interface DryRunResult {
  lines?: number;
  valid?: number;
  invalid?: number;
  records?: unknown[];
}

const EMPTY_FILTERS: ListFilters = { scope: '', botId: '', userId: '', limit: 100 };

const SCOPE_META: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  private: { label: '私密', tone: 'warning' },
  relationship: { label: '关系', tone: 'info' },
  shared: { label: '共享', tone: 'success' },
};

const LIMIT_OPTIONS = [20, 50, 100, 200];

function isCancelled(cause: unknown): boolean {
  return cause instanceof ApiError && cause.statusCode === 0;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : '操作失败，请稍后重试。';
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Storage key used by the detail/delete routes; falls back to the record id. */
function recordKey(memory: MemoryRecord | undefined): string {
  if (!memory) return '';
  const key = memory.key;
  if (typeof key === 'string' && key) return key;
  return typeof memory.id === 'string' ? memory.id : '';
}

function recordUpdatedAt(memory: MemoryRecord): unknown {
  return memory.updatedAt ?? memory.createdAt;
}

function recordSummary(memory: MemoryRecord): string {
  if (typeof memory.summary === 'string' && memory.summary) return memory.summary;
  const parts: string[] = [];
  if (typeof memory.textLength === 'number') parts.push(`${formatNumber(memory.textLength)} 字节`);
  if (typeof memory.textHash === 'string' && memory.textHash) parts.push(memory.textHash.slice(0, 12));
  return parts.length ? parts.join(' · ') : '—';
}

/** Builds the `/api/memory` query string; exported for the filter test. */
export function buildMemoryQuery(filters: ListFilters): string {
  const params = new URLSearchParams();
  if (filters.scope) params.set('scope', filters.scope);
  if (filters.botId.trim()) params.set('botId', filters.botId.trim());
  if (filters.userId.trim()) params.set('userId', filters.userId.trim());
  params.set('limit', String(filters.limit));
  return `?${params.toString()}`;
}

function ScopePill({ scope }: { scope: unknown }) {
  const value = typeof scope === 'string' ? scope : '';
  const meta = SCOPE_META[value];
  return <Pill tone={meta?.tone ?? 'neutral'}>{meta?.label ?? (value || '未知')}</Pill>;
}

export function Memory({ permissions }: PageProps) {
  const canRead = permissions.includes('memory.read');
  const canWrite = permissions.includes('memory.write');
  const canDelete = permissions.includes('memory.delete');

  /* ------------------------------ list ------------------------------ */

  const [draft, setDraft] = useState<ListFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<ListFilters>(EMPTY_FILTERS);
  const query = useMemo(() => buildMemoryQuery(filters), [filters]);

  const listState = useAsync(async () => {
    const result = await api<{ memories?: MemoryRecord[] }>(`/memory${query}`);
    return Array.isArray(result.memories) ? result.memories : [];
  }, [query], '读取语义记忆失败');
  const memories = listState.data ?? [];

  const [busyKey, setBusyKey] = useState('');
  const [actionError, setActionError] = useState('');

  /* ----------------------------- detail ----------------------------- */

  const [detailKey, setDetailKey] = useState<string | null>(null);
  const detailState = useAsync(async () => {
    if (!detailKey) return undefined;
    const result = await api<{ memory?: MemoryRecord }>(`/memory/${encodeURIComponent(detailKey)}`);
    return result.memory;
  }, [detailKey], '读取记忆详情失败');
  const detail = detailState.data;

  const openDetail = useCallback((memory: MemoryRecord) => {
    if (!canRead) return;
    const key = recordKey(memory);
    if (!key) { setActionError('该记录缺少可读取的存储键。'); return; }
    setActionError('');
    setDetailKey(key);
  }, [canRead]);

  const removeMemory = useCallback(async (memory: MemoryRecord) => {
    const key = recordKey(memory);
    if (!key) { setActionError('该记录缺少可删除的存储键。'); return; }
    setBusyKey(key);
    setActionError('');
    try {
      await confirmedRequest(
        `/memory/${encodeURIComponent(key)}`,
        { method: 'DELETE', body: body({}) },
        {},
        `删除语义记忆 ${key}`,
      );
      setDetailKey((current) => (current === key ? null : current));
      listState.reload();
    } catch (cause) {
      if (!isCancelled(cause)) setActionError(messageOf(cause));
    } finally {
      setBusyKey('');
    }
  }, [listState]);

  /* --------------------------- governance --------------------------- */

  const [govBotId, setGovBotId] = useState('');
  const [govTab, setGovTab] = useState<GovernanceTab>('recycle');
  const [recycleTick, setRecycleTick] = useState(0);
  const [exportTick, setExportTick] = useState(0);
  const [govBusy, setGovBusy] = useState('');
  const [govError, setGovError] = useState('');
  const [govNotice, setGovNotice] = useState('');

  const recycle = useAsync(async () => {
    const botId = govBotId.trim();
    if (!canRead || !botId || govTab !== 'recycle') return [];
    const result = await api<{ records?: MemoryRecord[] }>(
      `/memory/semantic/recycle-bin?botId=${encodeURIComponent(botId)}`,
    );
    return Array.isArray(result.records) ? result.records : [];
  }, [canRead, govBotId, govTab, recycleTick], '读取回收站失败');
  const recycleRecords = recycle.data ?? [];

  const exportState = useAsync(async () => {
    const botId = govBotId.trim();
    if (!canRead || !botId || govTab !== 'export') return '';
    const result = await api<{ data?: string }>(`/memory/semantic/export?botId=${encodeURIComponent(botId)}`);
    return typeof result.data === 'string' ? result.data : '';
  }, [canRead, govBotId, govTab, exportTick], '读取导出数据失败');

  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState<DryRunResult | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const runDryRun = useCallback(async () => {
    setImportBusy(true);
    setGovError('');
    setGovNotice('');
    setImportResult(null);
    try {
      const result = await api<{ result?: DryRunResult }>('/memory/semantic/import-dry-run', {
        method: 'POST',
        body: body({ data: importText }),
      });
      setImportResult(result.result ?? null);
    } catch (cause) {
      if (!isCancelled(cause)) setGovError(messageOf(cause));
    } finally {
      setImportBusy(false);
    }
  }, [importText]);

  const [bulk, setBulk] = useState({ userId: '', channelId: '', sourceMessageId: '', reason: '' });
  const [bulkDeleted, setBulkDeleted] = useState<number | null>(null);

  const runBulkDelete = useCallback(async () => {
    const botId = govBotId.trim();
    const payload: Record<string, string> = { botId };
    if (bulk.userId.trim()) payload.userId = bulk.userId.trim();
    if (bulk.channelId.trim()) payload.channelId = bulk.channelId.trim();
    if (bulk.sourceMessageId.trim()) payload.sourceMessageId = bulk.sourceMessageId.trim();
    if (!payload.userId && !payload.channelId && !payload.sourceMessageId) {
      setGovError('批量删除至少需要一个筛选条件（userId / channelId / sourceMessageId）。');
      return;
    }
    setGovBusy('bulk');
    setGovError('');
    setGovNotice('');
    setBulkDeleted(null);
    try {
      const result = await confirmedRequest<{ deleted?: number }>(
        '/memory/semantic/bulk-delete',
        { method: 'POST', body: body(payload) },
        payload,
        `批量删除 Bot ${botId} 下符合条件的语义记忆`,
      );
      setBulkDeleted(typeof result.deleted === 'number' ? result.deleted : 0);
      setGovNotice(`已删除 ${formatNumber(typeof result.deleted === 'number' ? result.deleted : 0)} 条记忆（进入回收站）。`);
      setRecycleTick((value) => value + 1);
    } catch (cause) {
      if (!isCancelled(cause)) setGovError(messageOf(cause));
    } finally {
      setGovBusy('');
    }
  }, [bulk, govBotId]);

  const restoreSemantic = useCallback(async (record: MemoryRecord) => {
    const botId = govBotId.trim();
    const userId = typeof record.userId === 'string' ? record.userId : '';
    const id = typeof record.id === 'string' ? record.id : '';
    if (!botId || !userId || !id) { setGovError('恢复需要 botId、userId 与记录 id。'); return; }
    setGovBusy(`restore:${id}`);
    setGovError('');
    setGovNotice('');
    try {
      const result = await confirmedRequest<{ outcome?: string }>(
        '/memory/semantic/restore',
        { method: 'POST', body: body({ botId, userId, id }) },
        { botId, userId, id },
        `恢复语义记忆 ${id}`,
      );
      setGovNotice(`恢复请求已提交，服务端结果：${result.outcome ?? '未知'}`);
      setRecycleTick((value) => value + 1);
    } catch (cause) {
      if (!isCancelled(cause)) setGovError(messageOf(cause));
    } finally {
      setGovBusy('');
    }
  }, [govBotId]);

  const downloadExport = useCallback(() => {
    const text = exportState.data ?? '';
    if (!text || typeof URL.createObjectURL !== 'function') return;
    const blob = new Blob([text], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `semantic-memory-${govBotId.trim() || 'bot'}.jsonl`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [exportState.data, govBotId]);

  const detailItems: Array<{ label: string; value: ReactNode }> = detail ? [
    { label: '记录键', value: <span className="mono prewrap">{recordKey(detail) || '—'}</span> },
    { label: '记录 ID', value: <span className="mono">{detail.id ?? '—'}</span> },
    { label: 'Bot', value: detail.botId ?? '—' },
    { label: '用户', value: detail.userId ?? '—' },
    { label: '频道', value: detail.channelId ?? '—' },
    { label: '范围', value: <ScopePill scope={detail.scope} /> },
    { label: '类型', value: typeof detail.kind === 'string' && detail.kind ? detail.kind : '—' },
    { label: '更新时间', value: formatDateTime(recordUpdatedAt(detail)) },
    { label: '文本长度', value: typeof detail.textLength === 'number' ? `${formatNumber(detail.textLength)} 字节` : '—' },
    { label: '文本哈希', value: <span className="mono">{typeof detail.textHash === 'string' ? detail.textHash : '—'}</span> },
    { label: '向量', value: detail.hasEmbedding ? <Pill tone="success">已生成</Pill> : <Pill tone="neutral">无</Pill> },
    { label: '嵌入模型', value: typeof detail.embeddingModel === 'string' && detail.embeddingModel ? detail.embeddingModel : '—' },
  ] : [];

  return (
    <>
      <PageTitle
        eyebrow="SEMANTIC MEMORY"
        title="语义记忆"
        description="按 scope 隔离查看语义记忆元数据，并治理回收站、脱敏导出与批量删除。"
        actions={<Button onClick={() => listState.reload()} busy={listState.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      <Notice tone="info" icon={<ShieldAlert size={17} />}>
        记忆按 scope 隔离存放：私密（private）内容仅授权主体可读，管理面读取同样受 memory.read 权限约束；
        治理导出接口只返回脱敏后的文本与时间字段，不含用户与频道标识。
      </Notice>

      {actionError && <Notice tone="danger" icon={<ShieldAlert size={17} />}>{actionError}</Notice>}

      <Panel
        title="记忆列表"
        description={`当前返回 ${memories.length} 条记录（按 scope 与主体过滤后的元数据）。`}
        action={<span className="muted-text">列表需 memory.metadata.read；详情需 memory.read</span>}
      >
        <div className="filter-row">
          <Select
            aria-label="范围筛选"
            value={draft.scope}
            onChange={(event) => setDraft({ ...draft, scope: event.target.value as ScopeValue })}
          >
            <option value="">全部范围</option>
            <option value="private">私密</option>
            <option value="relationship">关系</option>
            <option value="shared">共享</option>
          </Select>
          <TextInput
            aria-label="Bot 筛选"
            placeholder="Bot ID（例如 main）"
            value={draft.botId}
            onChange={(event) => setDraft({ ...draft, botId: event.target.value })}
          />
          <TextInput
            aria-label="用户筛选"
            placeholder="用户 ID（例如 user-1）"
            value={draft.userId}
            onChange={(event) => setDraft({ ...draft, userId: event.target.value })}
          />
          <Select
            aria-label="返回上限"
            value={String(draft.limit)}
            onChange={(event) => setDraft({ ...draft, limit: Number(event.target.value) || 100 })}
          >
            {LIMIT_OPTIONS.map((value) => <option key={value} value={value}>{value} 条</option>)}
          </Select>
          <Button variant="primary" onClick={() => setFilters(draft)}><Search size={15} /> 查询</Button>
          <Button onClick={() => { setDraft(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); }}>重置</Button>
        </div>

        <DataState
          loading={listState.loading}
          error={listState.error}
          empty={memories.length === 0}
          emptyTitle="没有匹配的语义记忆"
          emptyDetail="调整筛选条件后重试，或确认该 Bot 是否已写入记忆。"
          onRetry={() => listState.reload()}
        >
          <Table minWidth={960}>
            <thead>
              <tr>
                <th>类型</th>
                <th>Bot / 用户</th>
                <th>范围 / 频道</th>
                <th>摘要</th>
                <th>更新时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {memories.map((memory, index) => {
                const key = recordKey(memory);
                return (
                  <tr
                    key={key || `row-${index}`}
                    className="selectable-row"
                    onClick={() => openDetail(memory)}
                  >
                    <td>{typeof memory.kind === 'string' && memory.kind ? memory.kind : '—'}</td>
                    <td>
                      <div className="table-primary">{memory.botId ?? '—'}</div>
                      <small className="muted-text mono">{memory.userId ?? '—'}</small>
                    </td>
                    <td>
                      <ScopePill scope={memory.scope} />
                      <small className="muted-text mono">{memory.channelId ?? '—'}</small>
                    </td>
                    <td className="truncate-cell">{recordSummary(memory)}</td>
                    <td className="nowrap">{formatDateTime(recordUpdatedAt(memory))}</td>
                    <td>
                      <div className="table-actions">
                        <Button
                          variant="ghost"
                          disabled={!canRead}
                          onClick={(event) => { event.stopPropagation(); openDetail(memory); }}
                        >
                          <Eye size={14} /> 详情
                        </Button>
                        {canDelete ? (
                          <Button
                            variant="danger"
                            busy={busyKey === key}
                            onClick={(event) => { event.stopPropagation(); void removeMemory(memory); }}
                          >
                            <Trash2 size={14} /> 删除
                          </Button>
                        ) : (
                          <span className="muted-text">只读</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </DataState>
      </Panel>

      <Panel
        title="语义记忆治理"
        description="回收站、脱敏导出、导入试运行与按主体批量删除。"
        action={<Brain size={16} />}
      >
        <div className="filter-row">
          <TextInput
            aria-label="治理 Bot"
            placeholder="治理目标 Bot ID（例如 main）"
            value={govBotId}
            onChange={(event) => setGovBotId(event.target.value)}
          />
        </div>

        {!canRead && (
          <Notice tone="warning" icon={<ShieldAlert size={17} />}>
            当前账号缺少 memory.read 权限，治理读取（回收站 / 导出 / 导入试运行）不可用。
          </Notice>
        )}
        {govError && <Notice tone="danger" icon={<ShieldAlert size={17} />}>{govError}</Notice>}
        {govNotice && <Notice tone="info" icon={<ShieldAlert size={17} />}>{govNotice}</Notice>}

        <Tabs<GovernanceTab>
          value={govTab}
          ariaLabel="语义记忆治理"
          onChange={(next) => { setGovNotice(''); setGovError(''); setGovTab(next); }}
          options={[
            { value: 'recycle', label: '回收站', count: govTab === 'recycle' ? recycleRecords.length : undefined },
            { value: 'export', label: '脱敏导出' },
            { value: 'import', label: '导入试运行' },
            { value: 'bulk', label: '批量删除' },
          ]}
        />

        {govTab === 'recycle' && (
          <DataState
            loading={recycle.loading}
            error={recycle.error}
            empty={!govBotId.trim() || recycleRecords.length === 0}
            emptyTitle={govBotId.trim() ? '回收站为空' : '请先填写治理目标 Bot ID'}
            emptyDetail={govBotId.trim() ? '该 Bot 暂无可恢复的已删除记忆。' : undefined}
            onRetry={() => setRecycleTick((value) => value + 1)}
          >
            <Table minWidth={820}>
              <thead>
                <tr><th>记录 ID</th><th>用户</th><th>范围</th><th>删除原因</th><th>删除时间</th><th /></tr>
              </thead>
              <tbody>
                {recycleRecords.map((record, index) => {
                  const id = typeof record.id === 'string' ? record.id : `row-${index}`;
                  const tomb = asObject(record.tombstone);
                  return (
                    <tr key={`${id}-${index}`}>
                      <td className="mono">{id}</td>
                      <td className="mono">{record.userId ?? '—'}</td>
                      <td><ScopePill scope={record.scope} /></td>
                      <td className="truncate-cell">{typeof tomb.reason === 'string' && tomb.reason ? tomb.reason : '—'}</td>
                      <td className="nowrap">{formatDateTime(tomb.at)}</td>
                      <td>
                        <div className="table-actions">
                          {canWrite ? (
                            <Button
                              variant="secondary"
                              busy={govBusy === `restore:${id}`}
                              onClick={() => void restoreSemantic(record)}
                            >
                              <RotateCcw size={14} /> 恢复
                            </Button>
                          ) : (
                            <span className="muted-text">需 memory.write</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </DataState>
        )}

        {govTab === 'export' && (
          <div className="col">
            <div className="row row-between">
              <span className="muted-text">导出内容为脱敏后的 JSONL（不含用户与频道标识），可用于离线备份。</span>
              <div className="row">
                <Button onClick={() => setExportTick((value) => value + 1)} busy={exportState.loading}>
                  <RefreshCw size={15} /> 重载
                </Button>
                <Button variant="primary" disabled={!exportState.data} onClick={downloadExport}>
                  <Download size={15} /> 下载 JSONL
                </Button>
              </div>
            </div>
            {!govBotId.trim() && <Notice tone="info">请先填写治理目标 Bot ID 后再读取导出数据。</Notice>}
            {exportState.error && <Notice tone="danger" icon={<ShieldAlert size={17} />}>{exportState.error}</Notice>}
            {govBotId.trim() && !exportState.loading && !exportState.error && (
              exportState.data
                ? <pre className="json-view">{exportState.data}</pre>
                : <Notice tone="warning">该 Bot 没有可导出的记忆行。</Notice>
            )}
          </div>
        )}

        {govTab === 'import' && (
          <div className="col">
            <Field label="JSONL 数据" hint="每行一条脱敏记录；试运行只做校验，不写入存储。">
              <TextArea
                rows={8}
                placeholder='{"id":"...","scope":"shared","text":"...","createdAt":1700000000000}'
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
              />
            </Field>
            <div className="row">
              <Button
                variant="primary"
                disabled={!canRead || !importText.trim()}
                busy={importBusy}
                onClick={() => void runDryRun()}
              >
                <Upload size={15} /> 试运行校验
              </Button>
            </div>
            {importResult && (
              <>
                <Descriptions columns={3} items={[
                  { label: '解析行数', value: formatNumber(importResult.lines ?? 0) },
                  { label: '有效记录', value: formatNumber(importResult.valid ?? 0) },
                  { label: '无效记录', value: formatNumber(importResult.invalid ?? 0) },
                ]} />
                {importResult.records && importResult.records.length > 0 && (
                  <pre className="json-view">{prettyJson(importResult.records.slice(0, 20))}</pre>
                )}
              </>
            )}
          </div>
        )}

        {govTab === 'bulk' && (
          <div className="col">
            <Notice tone="warning" icon={<ShieldAlert size={17} />}>
              批量删除会为所有匹配记录写入墓碑（可在回收站恢复），需要 memory.delete 权限与二次确认。
            </Notice>
            <div className="form-grid">
              <Field label="用户 ID" hint="至少填写 userId / channelId / sourceMessageId 之一。">
                <TextInput aria-label="批量用户 ID" value={bulk.userId} onChange={(event) => setBulk({ ...bulk, userId: event.target.value })} />
              </Field>
              <Field label="频道 ID">
                <TextInput aria-label="批量频道 ID" value={bulk.channelId} onChange={(event) => setBulk({ ...bulk, channelId: event.target.value })} />
              </Field>
              <Field label="来源消息 ID">
                <TextInput aria-label="批量来源消息 ID" value={bulk.sourceMessageId} onChange={(event) => setBulk({ ...bulk, sourceMessageId: event.target.value })} />
              </Field>
              <Field label="原因（可选）">
                <TextInput aria-label="批量删除原因" value={bulk.reason} onChange={(event) => setBulk({ ...bulk, reason: event.target.value })} />
              </Field>
            </div>
            <div className="row">
              {canDelete ? (
                <Button variant="danger" busy={govBusy === 'bulk'} onClick={() => void runBulkDelete()}>
                  <Trash2 size={15} /> 批量删除
                </Button>
              ) : (
                <span className="muted-text">当前账号缺少 memory.delete 权限，批量删除不可用。</span>
              )}
            </div>
            {bulkDeleted !== null && (
              <Notice tone="info">本次共删除 {formatNumber(bulkDeleted)} 条记忆（已进入回收站）。</Notice>
            )}
          </div>
        )}
      </Panel>

      <Modal
        open={detailKey !== null}
        onClose={() => setDetailKey(null)}
        title="记忆详情"
        description="服务端返回的单条记忆元数据与正文（需 memory.read 权限）。"
        width={760}
        footer={canDelete && detail ? (
          <Button variant="danger" busy={busyKey !== '' && busyKey === detailKey} onClick={() => void removeMemory(detail)}>
            <Trash2 size={15} /> 删除此记忆
          </Button>
        ) : undefined}
      >
        {detailState.loading && <p className="muted-text">正在读取记忆详情…</p>}
        {!detailState.loading && detailState.error && (
          <Notice tone="danger" icon={<ShieldAlert size={17} />}>{detailState.error}</Notice>
        )}
        {!detailState.loading && !detailState.error && detail && (
          <>
            <Descriptions columns={2} items={detailItems} />
            <Field label="正文">
              <pre className="prewrap mono">{typeof detail.text === 'string' && detail.text ? detail.text : '（无正文）'}</pre>
            </Field>
            <Descriptions columns={2} items={[
              { label: '用户输入', value: <span className="prewrap mono">{detail.user ? prettyJson(detail.user) : '—'}</span> },
              { label: '助手回复', value: <span className="prewrap mono">{detail.assistant ? prettyJson(detail.assistant) : '—'}</span> },
            ]} />
          </>
        )}
        {!detailState.loading && !detailState.error && !detail && <p className="muted-text">未找到该记忆记录。</p>}
        {!canDelete && detail && <p className="muted-text">当前账号缺少 memory.delete 权限，仅可查看。</p>}
      </Modal>
    </>
  );
}
