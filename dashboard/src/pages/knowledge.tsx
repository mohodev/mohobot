import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Eye, FileText, Link2, Plus, RefreshCw, Save, Search, Trash2, Unlink } from 'lucide-react';
import { api, ApiError, body, confirmedRequest } from '../lib/api';
import type { KnowledgeBase, KnowledgeBinding, KnowledgeDocument, PageProps } from '../lib/types';
import { useAsync, useFiltered, useToggle } from '../lib/hooks';
import { formatBytes, formatDateTime, formatNumber, formatRelative } from '../lib/format';
import {
  Button,
  CopyButton,
  DataState,
  Descriptions,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  Notice,
  PageTitle,
  Panel,
  Pill,
  Select,
  Table,
  Tabs,
  TextArea,
  TextInput,
} from '../components/ui';

/** Detail views for the selected knowledge base. */
type DetailTab = 'documents' | 'search' | 'bindings';

/** A paginated list response, normalised from either a bare array or `{ items, total }`. */
interface ListPage<T> {
  items: T[];
  total: number;
}

/**
 * Detail for the selected base. Each sub-resource is loaded independently so a
 * single failing endpoint degrades to a partial view instead of blanking the
 * whole panel.
 */
interface BaseDetail {
  base?: KnowledgeBase;
  baseError?: string;
  documents: KnowledgeDocument[];
  documentsTotal: number;
  documentsError?: string;
  bindings: KnowledgeBinding[];
  bindingsError?: string;
}

/** One keyword-search hit (mirrors the server's chunk result row). */
interface SearchHit {
  documentId: string;
  chunkId: string;
  index: number;
  text: string;
  score: number;
}

interface DocumentPayload {
  id?: string;
  name: string;
  text: string;
}

/** The server wraps list payloads as `{ items, total, offset, limit }`; accept both shapes. */
function collect<T>(value: unknown): ListPage<T> {
  if (Array.isArray(value)) return { items: value as T[], total: value.length };
  if (value && typeof value === 'object') {
    const record = value as { items?: unknown; total?: unknown };
    if (Array.isArray(record.items)) {
      const total = typeof record.total === 'number' && Number.isFinite(record.total) ? record.total : record.items.length;
      return { items: record.items as T[], total };
    }
  }
  return { items: [], total: 0 };
}

function messageOf(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

/** A cancelled confirmation prompt is signalled with statusCode 0 and is not an error. */
function isCancel(cause: unknown): boolean {
  return cause instanceof ApiError && cause.statusCode === 0;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function loadDetail(id: string): Promise<BaseDetail> {
  const segment = `/knowledge-bases/${encodeURIComponent(id)}`;
  const [baseResult, documentResult, bindingResult] = await Promise.allSettled([
    api<{ base?: KnowledgeBase }>(segment),
    api<{ documents?: unknown }>(`${segment}/documents?offset=0&limit=100`),
    api<{ bindings?: unknown }>(`${segment}/bindings`),
  ]);

  // Only surface a hard panel error when nothing at all could be read; otherwise
  // render whatever succeeded and flag the failed sections inline.
  if (baseResult.status === 'rejected' && documentResult.status === 'rejected' && bindingResult.status === 'rejected') {
    throw baseResult.reason;
  }

  const documents = documentResult.status === 'fulfilled'
    ? collect<KnowledgeDocument>(documentResult.value.documents)
    : { items: [], total: 0 };
  const bindings = bindingResult.status === 'fulfilled'
    ? collect<KnowledgeBinding>(bindingResult.value.bindings)
    : { items: [], total: 0 };

  return {
    base: baseResult.status === 'fulfilled' ? baseResult.value.base : undefined,
    baseError: baseResult.status === 'rejected' ? messageOf(baseResult.reason, '读取知识库基础信息失败') : undefined,
    documents: documents.items,
    documentsTotal: documents.total,
    documentsError: documentResult.status === 'rejected' ? messageOf(documentResult.reason, '读取文档列表失败') : undefined,
    bindings: bindings.items,
    bindingsError: bindingResult.status === 'rejected' ? messageOf(bindingResult.reason, '读取绑定列表失败') : undefined,
  };
}

/** Module-level field selectors keep the `useFiltered` memo dependencies stable. */
const BASE_FIELDS = (base: KnowledgeBase): unknown[] => [base.name, base.id, base.description];
const DOCUMENT_FIELDS = (doc: KnowledgeDocument): unknown[] => [doc.name, doc.id];

/** Shared "primary label over a mono id" cell, reused by the base list and the document table. */
function EntityCell({ primary, id, badge }: { primary: string; id: string; badge?: ReactNode }) {
  return (
    <td>
      <div className="table-primary">{primary}{badge}</div>
      <small className="muted-text mono">{id}</small>
    </td>
  );
}

export function Knowledge({ permissions }: PageProps) {
  const canWrite = permissions.includes('knowledge.write');
  const canDelete = permissions.includes('knowledge.delete');

  const basesState = useAsync(async () => {
    const result = await api<{ bases?: unknown }>('/knowledge-bases?offset=0&limit=100');
    return collect<KnowledgeBase>(result.bases);
  }, [], '读取知识库列表失败');
  const bases = basesState.data?.items ?? [];
  const basesTotal = basesState.data?.total ?? 0;

  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState('');
  const [docFilter, setDocFilter] = useState('');
  const [tab, setTab] = useState<DetailTab>('documents');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');

  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  const detailState = useAsync(
    () => (selectedId ? loadDetail(selectedId) : Promise.resolve(undefined)),
    [selectedId],
    '读取知识库详情失败',
  );
  const detail = detailState.data;

  useEffect(() => {
    setTab('documents');
    setActionError('');
    setQuery('');
    setSubmitted('');
    setResults(null);
    setSearchError('');
    setDocFilter('');
  }, [selectedId]);

  /* ----------------------------- 新建知识库 ----------------------------- */

  const [createOpen, toggleCreate] = useToggle(false);
  const [createName, setCreateName] = useState('');
  const [createId, setCreateId] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');

  const filteredBases = useFiltered(bases, filter, BASE_FIELDS);
  const filteredDocuments = useFiltered(detail?.documents ?? [], docFilter, DOCUMENT_FIELDS);
  const documentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const doc of detail?.documents ?? []) map.set(doc.id, doc.name || doc.id);
    return map;
  }, [detail]);

  async function createBase() {
    const name = createName.trim();
    if (!name) {
      setCreateError('请填写知识库名称。');
      return;
    }
    const id = createId.trim();
    const description = createDescription.trim();
    const payload: { id?: string; name: string; description?: string } = id ? { id, name } : { name };
    if (description) payload.description = description;

    setCreateBusy(true);
    setCreateError('');
    try {
      await confirmedRequest(
        '/knowledge-bases',
        { method: 'POST', body: body(payload) },
        payload,
        `创建知识库 ${name}`,
      );
      toggleCreate(false);
      setCreateName('');
      setCreateId('');
      setCreateDescription('');
      basesState.reload();
    } catch (cause) {
      if (isCancel(cause)) return;
      setCreateError(messageOf(cause, '创建知识库失败'));
    } finally {
      setCreateBusy(false);
    }
  }

  async function deleteBase(base: KnowledgeBase) {
    const label = base.name || base.id;
    setBusy('base');
    setActionError('');
    try {
      await confirmedRequest(
        `/knowledge-bases/${encodeURIComponent(base.id)}`,
        { method: 'DELETE' },
        {},
        `删除知识库 ${label}`,
      );
      if (selectedId === base.id) setSelectedId('');
      basesState.reload();
    } catch (cause) {
      if (isCancel(cause)) return;
      setActionError(messageOf(cause, '删除知识库失败'));
    } finally {
      setBusy('');
    }
  }

  /* ------------------------------- 文档 ------------------------------- */

  const [documentOpen, toggleDocument] = useToggle(false);
  const [documentForm, setDocumentForm] = useState<DocumentPayload>({ name: '', text: '' });
  const [documentBusy, setDocumentBusy] = useState(false);
  const [documentError, setDocumentError] = useState('');
  const [viewDocument, setViewDocument] = useState<{ id: string; name: string; text: string } | null>(null);

  async function fetchDocument(id: string): Promise<{ id: string; name: string; text: string }> {
    const segment = `/knowledge-bases/${encodeURIComponent(selectedId)}/documents/${encodeURIComponent(id)}`;
    const result = await api<{ document?: KnowledgeDocument }>(segment);
    const doc = result.document;
    if (!doc) throw new ApiError('文档不存在', 404);
    return { id: doc.id, name: doc.name || doc.id, text: textOf(doc.text) };
  }

  function openDocumentCreate() {
    setDocumentForm({ name: '', text: '' });
    setDocumentError('');
    toggleDocument(true);
  }

  async function openDocumentEdit(doc: KnowledgeDocument) {
    setActionError('');
    setBusy(`view:${doc.id}`);
    try {
      const full = await fetchDocument(doc.id);
      setDocumentForm({ id: full.id, name: full.name, text: full.text });
      setDocumentError('');
      toggleDocument(true);
    } catch (cause) {
      setActionError(messageOf(cause, '读取文档失败'));
    } finally {
      setBusy('');
    }
  }

  async function openDocumentView(doc: KnowledgeDocument) {
    setActionError('');
    setBusy(`view:${doc.id}`);
    try {
      setViewDocument(await fetchDocument(doc.id));
    } catch (cause) {
      setActionError(messageOf(cause, '读取文档失败'));
    } finally {
      setBusy('');
    }
  }

  async function saveDocument() {
    const name = documentForm.name.trim();
    if (!name) {
      setDocumentError('请填写文档名称。');
      return;
    }
    if (!documentForm.text.trim()) {
      setDocumentError('请填写文档正文。');
      return;
    }
    const payload: DocumentPayload = documentForm.id
      ? { id: documentForm.id, name, text: documentForm.text }
      : { name, text: documentForm.text };

    setDocumentBusy(true);
    setDocumentError('');
    try {
      await confirmedRequest(
        `/knowledge-bases/${encodeURIComponent(selectedId)}/documents`,
        { method: 'POST', body: body(payload) },
        payload,
        `保存文档 ${name}`,
      );
      toggleDocument(false);
      detailState.reload();
      basesState.reload();
    } catch (cause) {
      if (isCancel(cause)) return;
      setDocumentError(messageOf(cause, '保存文档失败'));
    } finally {
      setDocumentBusy(false);
    }
  }

  async function deleteDocument(doc: KnowledgeDocument) {
    setBusy(`document:${doc.id}`);
    setActionError('');
    try {
      await confirmedRequest(
        `/knowledge-bases/${encodeURIComponent(selectedId)}/documents/${encodeURIComponent(doc.id)}`,
        { method: 'DELETE' },
        {},
        `删除文档 ${doc.name || doc.id}`,
      );
      detailState.reload();
      basesState.reload();
    } catch (cause) {
      if (isCancel(cause)) return;
      setActionError(messageOf(cause, '删除文档失败'));
    } finally {
      setBusy('');
    }
  }

  /* ------------------------------- 检索 ------------------------------- */

  async function runSearch() {
    if (!selectedId) return;
    const keyword = query.trim();
    setSubmitted(keyword);
    setSearching(true);
    setSearchError('');
    try {
      const segment = `/knowledge-bases/${encodeURIComponent(selectedId)}/search`;
      const result = await api<{ results?: unknown }>(
        `${segment}?q=${encodeURIComponent(keyword)}&offset=0&limit=50`,
      );
      setResults(collect<SearchHit>(result.results).items);
    } catch (cause) {
      setResults(null);
      setSearchError(messageOf(cause, '检索失败'));
    } finally {
      setSearching(false);
    }
  }

  /* ------------------------------- 绑定 ------------------------------- */

  const [bindType, setBindType] = useState<'bot' | 'character'>('bot');
  const [bindTarget, setBindTarget] = useState('');
  const [bindBusy, setBindBusy] = useState(false);

  async function addBinding() {
    const targetId = bindTarget.trim();
    if (!targetId) {
      setActionError('请填写绑定目标 ID。');
      return;
    }
    setBindBusy(true);
    setActionError('');
    try {
      const payload = { targetType: bindType, targetId };
      await confirmedRequest(
        `/knowledge-bases/${encodeURIComponent(selectedId)}/bindings`,
        { method: 'POST', body: body(payload) },
        payload,
        `绑定知识库到${bindType === 'bot' ? '机器人' : '角色'} ${targetId}`,
      );
      setBindTarget('');
      detailState.reload();
    } catch (cause) {
      if (isCancel(cause)) return;
      setActionError(messageOf(cause, '创建绑定失败'));
    } finally {
      setBindBusy(false);
    }
  }

  async function removeBinding(binding: KnowledgeBinding) {
    const key = `binding:${binding.targetType}:${binding.targetId}`;
    setBusy(key);
    setActionError('');
    try {
      await confirmedRequest(
        `/knowledge-bases/${encodeURIComponent(selectedId)}/bindings/${encodeURIComponent(binding.targetType)}/${encodeURIComponent(binding.targetId)}`,
        { method: 'DELETE' },
        {},
        `解绑 ${binding.targetType} ${binding.targetId}`,
      );
      detailState.reload();
    } catch (cause) {
      if (isCancel(cause)) return;
      setActionError(messageOf(cause, '解绑失败'));
    } finally {
      setBusy('');
    }
  }

  function refresh() {
    basesState.reload();
    if (selectedId) detailState.reload();
  }

  const selectedBase = detail?.base ?? bases.find((base) => base.id === selectedId);
  const documents = detail?.documents ?? [];
  const listEmpty = filteredBases.length === 0;

  const listDescription = `${basesTotal > bases.length
    ? `已加载 ${formatNumber(bases.length)} / 共 ${formatNumber(basesTotal)} 个知识库`
    : `${formatNumber(bases.length)} 个知识库`}${filter ? ` · 筛选中 ${formatNumber(filteredBases.length)} 个` : ''}`;

  const detailDescription = detail?.base?.description || '管理该知识库的文档、关键词检索与机器人 / 角色绑定。';

  const documentCountLabel = detail?.documentsError
    ? '文档列表不可用'
    : detail && detail.documentsTotal > detail.documents.length
      ? `${formatNumber(detail.documents.length)} / ${formatNumber(detail.documentsTotal)} 个文档`
      : `${formatNumber(documents.length)} 个文档`;

  return (
    <>
      <PageTitle
        eyebrow="KNOWLEDGE BASE"
        title="本地知识库"
        description="纯文本知识库：确定性分块、关键词检索，并把知识库绑定到机器人或角色以注入上下文。文档正文仅按纯文本展示。"
        actions={
          <>
            {!canWrite && <span className="muted-text">只读权限</span>}
            <Button onClick={refresh} busy={basesState.loading}>
              <RefreshCw size={15} /> 刷新
            </Button>
            {canWrite && (
              <Button variant="primary" onClick={() => { setCreateError(''); toggleCreate(true); }}>
                <Plus size={15} /> 新建知识库
              </Button>
            )}
          </>
        }
      />

      {actionError && <Notice tone="danger">{actionError}</Notice>}

      <div className="detail-split">
        <Panel
          title={selectedBase?.name || selectedId || '知识库详情'}
          description={selectedId ? detailDescription : '从右侧列表选择一个知识库以查看文档、检索与绑定。'}
          action={
            selectedId && canDelete ? (
              <Button variant="danger" busy={busy === 'base'} onClick={() => { if (selectedBase) void deleteBase(selectedBase); }}>
                <Trash2 size={15} /> 删除知识库
              </Button>
            ) : undefined
          }
        >
          {!selectedId ? (
            <EmptyState title="未选择知识库" detail="在右侧列表中选择一个知识库，或先创建一个知识库。" />
          ) : (
            <DataState loading={detailState.loading} error={detailState.error} onRetry={detailState.reload}>
              {detail ? (
                <>
                  {detail.baseError && (
                    <Notice tone="warning" icon={<AlertTriangle size={16} />}>
                      基础信息读取失败：{detail.baseError}
                    </Notice>
                  )}

                  <Descriptions
                    columns={3}
                    items={[
                      {
                        label: 'ID',
                        value: (
                          <span className="row gap-sm">
                            <span className="mono">{selectedId}</span>
                            <CopyButton value={selectedId} />
                          </span>
                        ),
                      },
                      { label: '文档数', value: formatNumber(detail.base?.documentCount ?? detail.documentsTotal) },
                      { label: '绑定数', value: formatNumber(detail.bindings.length) },
                      { label: '创建时间', value: formatDateTime(detail.base?.createdAt) },
                      { label: '更新时间', value: formatRelative(detail.base?.updatedAt) },
                      { label: '描述', value: detail.base?.description || '—' },
                    ]}
                  />

                  <Tabs
                    value={tab}
                    ariaLabel="知识库详情视图"
                    onChange={setTab}
                    options={[
                      { value: 'documents', label: '文档', count: detail.documents.length },
                      { value: 'search', label: '检索' },
                      { value: 'bindings', label: '绑定', count: detail.bindings.length },
                    ]}
                  />

                  {tab === 'documents' && (
                    <>
                      <div className="toolbar">
                        <div className="search-field grow">
                          <Search size={15} />
                          <input
                            value={docFilter}
                            aria-label="筛选文档"
                            placeholder="按文档名称或 ID 筛选"
                            onChange={(event) => setDocFilter(event.target.value)}
                          />
                        </div>
                        <span className="muted-text nowrap">{documentCountLabel} · 正文按纯文本存储与展示</span>
                        {canWrite ? (
                          <Button variant="primary" onClick={openDocumentCreate}>
                            <Plus size={15} /> 新增 / 覆盖文档
                          </Button>
                        ) : (
                          <span className="muted-text">只读</span>
                        )}
                      </div>
                      {detail.documentsError ? (
                        <ErrorState message={detail.documentsError} retry={detailState.reload} />
                      ) : detail.documents.length === 0 ? (
                        <EmptyState title="还没有文档" detail="新增纯文本文档后即可按关键词检索。" />
                      ) : filteredDocuments.length === 0 ? (
                        <EmptyState title="没有匹配的文档" detail="调整筛选关键词后重试。" />
                      ) : (
                        <Table minWidth={640}>
                          <thead>
                            <tr>
                              <th>文档</th>
                              <th>分块</th>
                              <th>大小</th>
                              <th>更新时间</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredDocuments.map((doc) => (
                              <tr key={doc.id}>
                                <EntityCell primary={doc.name || doc.id} id={doc.id} />
                                <td>{formatNumber(doc.chunkCount ?? 0)}</td>
                                <td className="nowrap">{formatBytes(doc.textLength)}</td>
                                <td className="nowrap">{formatRelative(doc.updatedAt)}</td>
                                <td className="table-actions">
                                  <Button
                                    variant="ghost"
                                    busy={busy === `view:${doc.id}`}
                                    onClick={() => { void openDocumentView(doc); }}
                                  >
                                    <Eye size={15} /> 查看
                                  </Button>
                                  {canWrite && (
                                    <Button variant="ghost" onClick={() => { void openDocumentEdit(doc); }}>
                                      <FileText size={15} /> 编辑
                                    </Button>
                                  )}
                                  {canDelete ? (
                                    <Button
                                      variant="danger"
                                      busy={busy === `document:${doc.id}`}
                                      onClick={() => { void deleteDocument(doc); }}
                                    >
                                      <Trash2 size={15} /> 删除
                                    </Button>
                                  ) : null}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </Table>
                      )}
                    </>
                  )}

                  {tab === 'search' && (
                    <>
                      <div className="toolbar">
                        <div className="search-field grow">
                          <Search size={15} />
                          <input
                            value={query}
                            aria-label="检索关键词"
                            placeholder="输入关键词后回车检索"
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }}
                          />
                        </div>
                        <Button variant="primary" busy={searching} onClick={() => { void runSearch(); }}>
                          <Search size={15} /> 检索
                        </Button>
                      </div>
                      {searchError && <Notice tone="danger">{searchError}</Notice>}
                      {results === null ? (
                        <EmptyState title="尚未检索" detail="输入关键词，在当前知识库的分块中做确定性关键词匹配。" />
                      ) : results.length === 0 ? (
                        <EmptyState title="没有匹配的分块" detail={`关键词“${submitted}”没有命中任何分块。`} />
                      ) : (
                        <>
                          <p className="muted-text">关键词“{submitted}”命中 {formatNumber(results.length)} 个分块，按得分降序排列。</p>
                          <div className="timeline">
                            {results.map((hit) => (
                              <div className="timeline-item" key={`${hit.documentId}:${hit.chunkId}`}>
                                <span className="timeline-marker" />
                                <div className="grow">
                                  <div className="row row-between">
                                    <div className="table-primary">
                                      {documentNames.get(hit.documentId) ?? hit.documentId}
                                      <small className="muted-text mono">{hit.documentId}</small>
                                    </div>
                                    <Pill tone="info">得分 {formatNumber(hit.score)}</Pill>
                                  </div>
                                  <p className="prewrap muted-text">{hit.text}</p>
                                  <small className="muted-text">分块 #{formatNumber(hit.index)}</small>
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </>
                  )}

                  {tab === 'bindings' && (
                    <>
                      {canWrite ? (
                        <div className="form-inline">
                          <Field label="目标类型">
                            <Select
                              value={bindType}
                              onChange={(event) => setBindType(event.target.value === 'character' ? 'character' : 'bot')}
                            >
                              <option value="bot">机器人 (bot)</option>
                              <option value="character">角色 (character)</option>
                            </Select>
                          </Field>
                          <Field label="目标 ID" hint="例如 moho 或角色 ID">
                            <TextInput
                              value={bindTarget}
                              placeholder="目标 ID"
                              onChange={(event) => setBindTarget(event.target.value)}
                            />
                          </Field>
                          <Button
                            variant="primary"
                            busy={bindBusy}
                            disabled={!bindTarget.trim()}
                            onClick={() => { void addBinding(); }}
                          >
                            <Link2 size={15} /> 绑定
                          </Button>
                        </div>
                      ) : (
                        <p className="muted-text">当前账号没有 knowledge.write 权限，无法创建绑定。</p>
                      )}
                      {detail.bindingsError ? (
                        <ErrorState message={detail.bindingsError} retry={detailState.reload} />
                      ) : detail.bindings.length === 0 ? (
                        <EmptyState title="暂无绑定" detail="把知识库绑定到机器人或角色后，检索结果会注入对应上下文。" />
                      ) : (
                        <Table minWidth={460}>
                          <thead>
                            <tr>
                              <th>类型</th>
                              <th>目标</th>
                              <th>创建时间</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.bindings.map((binding) => (
                              <tr key={`${binding.targetType}:${binding.targetId}`}>
                                <td>
                                  <Pill tone={binding.targetType === 'bot' ? 'info' : 'neutral'}>
                                    {binding.targetType === 'bot' ? '机器人' : '角色'}
                                  </Pill>
                                </td>
                                <td className="mono">{binding.targetId}</td>
                                <td className="nowrap">{formatRelative(binding.createdAt)}</td>
                                <td className="table-actions">
                                  {canDelete ? (
                                    <Button
                                      variant="danger"
                                      busy={busy === `binding:${binding.targetType}:${binding.targetId}`}
                                      onClick={() => { void removeBinding(binding); }}
                                    >
                                      <Unlink size={15} /> 解绑
                                    </Button>
                                  ) : (
                                    <span className="muted-text">只读</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </Table>
                      )}
                    </>
                  )}
                </>
              ) : (
                <EmptyState title="暂无详情" detail="未读取到该知识库的详情数据。" />
              )}
            </DataState>
          )}
        </Panel>

        <Panel title="知识库列表" description={listDescription}>
          <div className="toolbar">
            <div className="search-field grow">
              <Search size={15} />
              <input
                value={filter}
                aria-label="筛选知识库"
                placeholder="按名称或 ID 筛选"
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
          </div>
          <DataState
            loading={basesState.loading}
            error={basesState.error}
            empty={listEmpty}
            emptyTitle={bases.length === 0 ? '还没有知识库' : '没有匹配的知识库'}
            emptyDetail={bases.length === 0 ? '创建第一个知识库后即可上传纯文本文档并按关键词检索。' : '调整筛选关键词后重试。'}
            onRetry={basesState.reload}
          >
            <Table minWidth={340}>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>文档</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {filteredBases.map((base) => (
                  <tr
                    key={base.id}
                    className="selectable-row"
                    tabIndex={0}
                    aria-selected={base.id === selectedId}
                    onClick={() => setSelectedId(base.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedId(base.id);
                      }
                    }}
                  >
                    <EntityCell
                      primary={base.name || base.id}
                      id={base.id}
                      badge={base.id === selectedId ? <Pill tone="success">已选</Pill> : undefined}
                    />
                    <td>{formatNumber(base.documentCount ?? 0)}</td>
                    <td className="nowrap">{formatRelative(base.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </DataState>
        </Panel>
      </div>

      <Modal
        open={createOpen}
        onClose={() => toggleCreate(false)}
        title="新建知识库"
        description="名称与描述按纯文本处理，不会被渲染为 HTML。"
        footer={
          <>
            <Button onClick={() => toggleCreate(false)}>取消</Button>
            <Button variant="primary" busy={createBusy} onClick={() => { void createBase(); }}>
              <Save size={15} /> 创建
            </Button>
          </>
        }
      >
        {createError && <Notice tone="danger">{createError}</Notice>}
        <Field label="名称" hint="必填，最长 120 字符">
          <TextInput
            value={createName}
            maxLength={120}
            placeholder="例如：产品手册"
            onChange={(event) => setCreateName(event.target.value)}
          />
        </Field>
        <Field label="ID" hint="可选，仅字母、数字、下划线或连字符；留空由服务端生成">
          <TextInput
            value={createId}
            placeholder="product-docs"
            onChange={(event) => setCreateId(event.target.value)}
          />
        </Field>
        <Field label="描述" hint="可选，最长 2000 字符">
          <TextArea
            value={createDescription}
            rows={3}
            maxLength={2000}
            onChange={(event) => setCreateDescription(event.target.value)}
          />
        </Field>
      </Modal>

      <Modal
        open={documentOpen}
        onClose={() => toggleDocument(false)}
        title={documentForm.id ? '编辑文档' : '新增文档'}
        description="同名的文档会按名称确定性覆盖（同一 ID 会替换旧分块）。"
        width={680}
        footer={
          <>
            <Button onClick={() => toggleDocument(false)}>取消</Button>
            <Button variant="primary" busy={documentBusy} onClick={() => { void saveDocument(); }}>
              <Save size={15} /> 保存
            </Button>
          </>
        }
      >
        {documentError && <Notice tone="danger">{documentError}</Notice>}
        <Field label="文档名称" hint="同一知识库内按名称确定性生成文档 ID">
          <TextInput
            value={documentForm.name}
            maxLength={120}
            placeholder="例如：退换货政策"
            onChange={(event) => setDocumentForm((current) => ({ ...current, name: event.target.value }))}
          />
        </Field>
        <Field label="文档正文" hint="纯文本，最大 512 KiB">
          <TextArea
            value={documentForm.text}
            rows={12}
            placeholder="粘贴纯文本正文…"
            onChange={(event) => setDocumentForm((current) => ({ ...current, text: event.target.value }))}
          />
        </Field>
      </Modal>

      <Modal
        open={viewDocument !== null}
        onClose={() => setViewDocument(null)}
        title={viewDocument?.name ?? '文档正文'}
        description={viewDocument ? `文档 ID：${viewDocument.id}` : undefined}
        width={680}
        footer={<Button onClick={() => setViewDocument(null)}>关闭</Button>}
      >
        <pre className="prewrap mono">{viewDocument?.text}</pre>
      </Modal>
    </>
  );
}
