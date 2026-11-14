import { useCallback, useMemo, useState } from 'react';
import {
  BookUser,
  FileText,
  MessagesSquare,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Upload,
} from 'lucide-react';
import { api, ApiError, body, confirmedRequest } from '../lib/api';
import type { CharacterRecord, PageProps } from '../lib/types';
import { useAsync, useFiltered } from '../lib/hooks';
import { formatDateTime, formatDuration, formatNumber, prettyJson, truncateMiddle } from '../lib/format';
import {
  Button,
  CopyButton,
  DataState,
  Descriptions,
  EmptyState,
  Field,
  Loading,
  Modal,
  Notice,
  PageTitle,
  Panel,
  Pill,
  Select,
  Switch,
  Table,
  Tabs,
  TextArea,
  TextInput,
} from '../components/ui';

/* ------------------------------------------------------------------ *
 * Response shapes (mirror src/admin/api-routes/characters-mcp.ts).
 * ------------------------------------------------------------------ */

interface CharactersResponse { characters?: CharacterRecord[]; }
interface CharacterResponse { character?: CharacterRecord; }

interface ImportSkipped { index: number; name?: string; reason: string; }
interface ImportFailed { index: number; name?: string; error: string; }
interface ImportReport {
  total: number;
  imported: CharacterRecord[];
  skipped: ImportSkipped[];
  failed: ImportFailed[];
}
interface ImportResponse { report?: ImportReport; }

interface CrossChatTurn { speakerId: string; speakerName: string; content: string; at: number; }
interface CrossChatResult { turns: CrossChatTurn[]; stopReason: string; totalMs: number; error?: string; }
interface CrossChatResponse { result?: CrossChatResult; }

const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const MIN_PROMPT_LENGTH = 20;
const CROSS_CHAT_TOPIC_MAX = 500;

type TabValue = 'library' | 'import' | 'crosschat';
type ConflictPolicy = 'skip' | 'overwrite';

function errorText(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

/** Cancelled confirmation prompts throw ApiError with statusCode 0 — never surface those. */
function isCancelled(cause: unknown): boolean {
  return cause instanceof ApiError && cause.statusCode === 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseImportItems(text: string): { ok: true; items: Array<Record<string, unknown>> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: '请粘贴要导入的角色 JSON 数组。' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'items 必须是有效 JSON。' };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'items 必须是 JSON 数组。' };
  if (parsed.length === 0) return { ok: false, error: 'items 数组为空，没有可导入的角色。' };
  for (const entry of parsed) {
    if (!isPlainObject(entry)) return { ok: false, error: 'items 的每一项都必须是 JSON 对象。' };
  }
  return { ok: true, items: parsed.map((entry) => entry as Record<string, unknown>) };
}

/* ------------------------------------------------------------------ *
 * Derived-field helpers.
 *
 * The list response omits `prompt` and the catalog does not persist
 * `enabled`, so every "default" here is explicit instead of fabricated.
 * ------------------------------------------------------------------ */

function revisionOf(record?: CharacterRecord): string {
  return typeof record?.revision === 'string' ? record.revision : '';
}

function hasValidRevision(record?: CharacterRecord): boolean {
  return REVISION_PATTERN.test(revisionOf(record));
}

/** Prefers the server-reported length, falling back to the loaded prompt body. */
function promptLengthOf(record: CharacterRecord): number | undefined {
  if (typeof record.promptLength === 'number') return record.promptLength;
  if (typeof record.prompt === 'string') return record.prompt.length;
  return undefined;
}

function promptLengthText(record: CharacterRecord): string {
  const length = promptLengthOf(record);
  return length === undefined ? '—' : formatNumber(length);
}

/** `enabled` is optional in the contract; only claim a state when the server sends one. */
function StatusPill({ enabled }: { enabled?: boolean }) {
  if (enabled === true) return <Pill tone="success">启用</Pill>;
  if (enabled === false) return <Pill tone="warning">已停用</Pill>;
  return <span className="dim">—</span>;
}

const CROSS_CHAT_STOP_LABEL: Record<string, string> = {
  completed: '正常结束',
  max_turns: '达到轮次上限',
  repetition: '检测到重复',
  error: '出错中断',
};

function crossChatStopTone(reason: string): 'success' | 'danger' | 'warning' | 'info' {
  if (reason === 'completed') return 'success';
  if (reason === 'error') return 'danger';
  if (reason === 'repetition') return 'warning';
  return 'info';
}

export function Characters({ permissions }: PageProps) {
  const canWrite = permissions.includes('characters.write');
  const canImport = permissions.includes('characters.import');
  const canCrossChat = permissions.includes('characters.crosschat');

  const [tab, setTab] = useState<TabValue>('library');

  /* ----------------------------- list ----------------------------- */

  const list = useAsync(async () => {
    const response = await api<CharactersResponse>('/characters');
    return Array.isArray(response.characters) ? response.characters : [];
  }, [], '读取角色档案失败');
  const characters = list.data ?? [];

  const [query, setQuery] = useState('');
  const searchFields = useCallback(
    (item: CharacterRecord) => [item.id, item.name, item.description, item.source, (item.tags ?? []).join(' ')],
    [],
  );
  const filtered = useFiltered(characters, query, searchFields);

  /* ---------------------------- detail ---------------------------- */

  const [selectedId, setSelectedId] = useState('');
  const detail = useAsync(async () => {
    if (!selectedId) return undefined;
    const response = await api<CharacterResponse>(`/characters/${encodeURIComponent(selectedId)}`);
    return response.character;
  }, [selectedId], '读取角色详情失败');
  const selected = detail.data;
  const currentRevision = revisionOf(selected);

  const closeDetail = useCallback(() => setSelectedId(''), []);

  const refreshAll = useCallback(() => {
    list.reload();
    if (selectedId) detail.reload();
  }, [detail, list, selectedId]);

  /* ---------------------------- editor ---------------------------- */

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<CharacterRecord | undefined>(undefined);
  const [formName, setFormName] = useState('');
  const [formPrompt, setFormPrompt] = useState('');
  const [formSource, setFormSource] = useState('');
  const [formError, setFormError] = useState('');
  const [editorLoading, setEditorLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const closeEditor = useCallback(() => { if (!saving) setEditorOpen(false); }, [saving]);

  const openCreate = useCallback(() => {
    setEditing(undefined);
    setFormName('');
    setFormPrompt('');
    setFormSource('');
    setFormError('');
    setEditorLoading(false);
    setEditorOpen(true);
  }, []);

  // The list response omits `prompt` and may omit `revision`, so an edit always
  // re-reads the record from the detail endpoint before the form is populated.
  const openEdit = useCallback(async (record: CharacterRecord) => {
    setEditing(record);
    setFormName(typeof record.name === 'string' ? record.name : '');
    setFormPrompt('');
    setFormSource(typeof record.source === 'string' ? record.source : '');
    setFormError('');
    setEditorOpen(true);
    setEditorLoading(true);
    try {
      const response = await api<CharacterResponse>(`/characters/${encodeURIComponent(record.id)}`);
      const full = response.character;
      if (!full) { setFormError('服务端没有返回该角色的详情。'); return; }
      setEditing(full);
      setFormName(typeof full.name === 'string' && full.name ? full.name : record.id);
      setFormPrompt(typeof full.prompt === 'string' ? full.prompt : '');
      setFormSource(typeof full.source === 'string' ? full.source : '');
    } catch (cause) {
      if (!isCancelled(cause)) setFormError(errorText(cause, '读取角色详情失败'));
    } finally {
      setEditorLoading(false);
    }
  }, []);

  const submitEditor = useCallback(async () => {
    const name = formName.trim();
    const prompt = formPrompt;
    if (!name) { setFormError('请填写角色名称。'); return; }
    if (prompt.trim().length < MIN_PROMPT_LENGTH) { setFormError(`提示词至少需要 ${MIN_PROMPT_LENGTH} 个字符。`); return; }
    if (!editing && !canWrite) { setFormError('缺少 characters.write 权限。'); return; }

    const revision = revisionOf(editing);
    if (editing && !REVISION_PATTERN.test(revision)) {
      setFormError('缺少有效的角色 revision（需要 64 位十六进制），请刷新详情后重试。');
      return;
    }

    const payload: Record<string, unknown> = { name, prompt };
    if (formSource.trim()) payload.source = formSource.trim();
    if (editing) payload.expectedRevision = revision;

    const path = editing ? `/characters/${encodeURIComponent(editing.id)}` : '/characters';
    const description = editing ? `更新角色「${name}」` : `创建角色「${name}」`;
    setSaving(true);
    setFormError('');
    try {
      await confirmedRequest(path, { method: editing ? 'PUT' : 'POST', body: body(payload) }, payload, description);
      setEditorOpen(false);
      list.reload();
      if (editing) detail.reload();
    } catch (cause) {
      if (!isCancelled(cause)) setFormError(errorText(cause, '保存角色失败'));
    } finally {
      setSaving(false);
    }
  }, [canWrite, detail, editing, formName, formPrompt, formSource, list]);

  /* ---------------------------- import ---------------------------- */

  const [importText, setImportText] = useState('');
  const [importDryRun, setImportDryRun] = useState(true);
  const [onConflict, setOnConflict] = useState<ConflictPolicy>('skip');
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [importReport, setImportReport] = useState<ImportReport | undefined>(undefined);

  const resetImport = useCallback(() => {
    setImportText('');
    setImportReport(undefined);
    setImportError('');
  }, []);

  const runImport = useCallback(async () => {
    if (!canImport) { setImportError('缺少 characters.import 权限。'); return; }
    const parsed = parseImportItems(importText);
    if (!parsed.ok) { setImportError(parsed.error); setImportReport(undefined); return; }
    const payload = { items: parsed.items, dryRun: importDryRun, onConflict };
    setImportBusy(true);
    setImportError('');
    try {
      const response = await confirmedRequest<ImportResponse>(
        '/characters/import',
        { method: 'POST', body: body(payload) },
        payload,
        importDryRun ? '预演角色批量导入（dry-run）' : '执行角色批量导入',
      );
      setImportReport(response.report);
      if (!importDryRun) list.reload();
    } catch (cause) {
      if (!isCancelled(cause)) setImportError(errorText(cause, '导入角色失败'));
    } finally {
      setImportBusy(false);
    }
  }, [canImport, importDryRun, importText, list, onConflict]);

  /* --------------------------- cross-chat -------------------------- */

  const [crossIds, setCrossIds] = useState<string[]>([]);
  const [crossTopic, setCrossTopic] = useState('');
  const [crossStartWith, setCrossStartWith] = useState('');
  const [crossBusy, setCrossBusy] = useState(false);
  const [crossError, setCrossError] = useState('');
  const [crossResult, setCrossResult] = useState<CrossChatResult | undefined>(undefined);

  const toggleCrossId = useCallback((id: string) => {
    setCrossIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  }, []);

  const runCrossChat = useCallback(async () => {
    if (!canCrossChat) { setCrossError('缺少 characters.crosschat 权限。'); return; }
    if (crossIds.length < 2) { setCrossError('角色互聊至少需要选择 2 个角色。'); return; }
    const topic = crossTopic.trim();
    if (!topic) { setCrossError('请填写互聊主题。'); return; }
    if (topic.length > CROSS_CHAT_TOPIC_MAX) { setCrossError(`主题最多 ${CROSS_CHAT_TOPIC_MAX} 字符。`); return; }
    const payload: Record<string, unknown> = { characterIds: crossIds, topic };
    if (crossStartWith) payload.startWith = crossStartWith;
    setCrossBusy(true);
    setCrossError('');
    try {
      const response = await api<CrossChatResponse>('/characters/cross-chat', { method: 'POST', body: body(payload) });
      setCrossResult(response.result);
    } catch (cause) {
      setCrossError(errorText(cause, '角色互聊失败'));
    } finally {
      setCrossBusy(false);
    }
  }, [canCrossChat, crossIds, crossStartWith, crossTopic]);

  const crossTurns = crossResult?.turns ?? [];
  const selectedCharacters = useMemo(
    () => characters.filter((record) => crossIds.includes(record.id)),
    [characters, crossIds],
  );

  const listCountLabel = useMemo(() => {
    if (query.trim()) return `${filtered.length} / ${characters.length} 个角色`;
    return `${characters.length} 个角色`;
  }, [characters.length, filtered.length, query]);

  const tabOptions = useMemo<Array<{ value: TabValue; label: string; count?: number }>>(() => [
    { value: 'library', label: '角色库', count: characters.length },
    { value: 'import', label: '批量导入' },
    { value: 'crosschat', label: '互聊沙盒' },
  ], [characters.length]);

  return (
    <>
      <PageTitle
        eyebrow="PERSONA CATALOG"
        title="角色档案"
        description="浏览与管理 data/characters 下的角色提示词、批量导入以及角色互聊沙盒。"
        actions={<>
          <Button onClick={refreshAll} busy={list.loading}><RefreshCw size={15} /> 刷新</Button>
          <Button variant="primary" onClick={openCreate} disabled={!canWrite}><Plus size={15} /> 新建角色</Button>
        </>}
      />

      <Notice tone="info" icon={<Save size={17} />}>
        提示词编辑受 revision 冲突保护：保存时会提交详情中读取到的 revision，若角色文件已被其他会话修改，服务端会返回 <span className="mono">409</span> 冲突，请刷新详情后重试。
      </Notice>
      {!canWrite && (
        <Notice tone="warning" icon={<BookUser size={17} />}>
          只读模式：缺少 <span className="mono">characters.write</span> 权限，无法创建或更新角色。
        </Notice>
      )}

      <Tabs value={tab} options={tabOptions} onChange={setTab} ariaLabel="角色档案视图" />

      {tab === 'library' && (
        <>
          <Panel
            title="角色列表"
            description={listCountLabel}
            action={(
              <div className="search-field">
                <Search size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="按名称 / ID / 标签搜索"
                  aria-label="搜索角色"
                />
              </div>
            )}
          >
            <DataState
              loading={list.loading && !list.data}
              error={list.error}
              empty={!list.loading && filtered.length === 0}
              emptyTitle={query.trim() ? '没有匹配的角色' : '还没有角色档案'}
              emptyDetail={query.trim() ? '换个关键词，或清空搜索框查看全部角色。' : '在 data/characters 中添加 Markdown 提示词后即可在此管理。'}
              onRetry={() => list.reload()}
            >
              <Table minWidth={860}>
                <thead>
                  <tr>
                    <th>角色</th>
                    <th>标签</th>
                    <th>提示词长度</th>
                    <th>revision</th>
                    <th>状态</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((record) => {
                    const name = record.name || record.id;
                    const revision = revisionOf(record);
                    const tags = Array.isArray(record.tags) ? record.tags : [];
                    return (
                      <tr key={record.id} className="selectable-row" onClick={() => setSelectedId(record.id)}>
                        <td>
                          <div className="table-primary">{name}</div>
                          <small className="muted-text mono">{record.id}</small>
                          {record.description ? <div className="dim truncate-cell" title={String(record.description)}>{String(record.description)}</div> : null}
                        </td>
                        <td>
                          {tags.length > 0
                            ? <div className="row row-wrap gap-sm">{tags.map((tag) => <Pill key={String(tag)} tone="info">{String(tag)}</Pill>)}</div>
                            : <span className="dim">—</span>}
                        </td>
                        <td>{promptLengthText(record)}</td>
                        <td><span className="mono dim" title={revision || undefined}>{revision ? truncateMiddle(revision, 14) : '—'}</span></td>
                        <td><StatusPill enabled={record.enabled} /></td>
                        <td className="nowrap" title={record.updatedAt ? formatDateTime(record.updatedAt) : undefined}>
                          {record.updatedAt ? formatDateTime(record.updatedAt) : '—'}
                        </td>
                        <td>
                          <div className="table-actions" onClick={(event) => event.stopPropagation()}>
                            <Button variant="ghost" onClick={() => setSelectedId(record.id)}><FileText size={14} /> 详情</Button>
                            <Button
                              onClick={() => { void openEdit(record); }}
                              disabled={!canWrite}
                              title={canWrite ? '编辑角色' : '缺少 characters.write 权限'}
                            >
                              <Pencil size={14} /> 编辑
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </DataState>
          </Panel>

          {selectedId && (
            <Panel
              title="角色详情"
              description={selected ? `${selected.name || selected.id} · 提示词只读展示` : selectedId}
              action={(
                <div className="row">
                  <Button onClick={() => detail.reload()} busy={detail.loading}><RefreshCw size={14} /> 刷新详情</Button>
                  <Button variant="ghost" onClick={closeDetail}>关闭</Button>
                </div>
              )}
            >
              <DataState
                loading={detail.loading && !selected}
                error={detail.error}
                empty={!detail.loading && !selected}
                emptyTitle="未找到角色"
                emptyDetail={`服务端没有返回 id 为 ${selectedId} 的角色。`}
                onRetry={() => detail.reload()}
              >
                {selected && (
                  <>
                    <Descriptions
                      columns={3}
                      items={[
                        { label: 'ID', value: <span className="mono">{selected.id}</span> },
                        { label: '名称', value: typeof selected.name === 'string' && selected.name ? selected.name : '—' },
                        { label: '来源', value: typeof selected.source === 'string' && selected.source ? selected.source : '—' },
                        { label: '提示词长度', value: promptLengthText(selected) },
                        {
                          label: '标签',
                          value: Array.isArray(selected.tags) && selected.tags.length > 0
                            ? <div className="row row-wrap gap-sm">{selected.tags.map((tag) => <Pill key={String(tag)} tone="info">{String(tag)}</Pill>)}</div>
                            : '—',
                        },
                        { label: '更新时间', value: selected.updatedAt ? formatDateTime(selected.updatedAt) : '—' },
                        {
                          label: 'revision',
                          value: currentRevision
                            ? <span className="mono" title={currentRevision}>{truncateMiddle(currentRevision, 18)}</span>
                            : '—',
                        },
                      ]}
                    />
                    <Panel
                      title="提示词（只读）"
                      description={hasValidRevision(selected) ? '编辑将提交该 revision 以检测冲突。' : '未取得有效 revision，编辑前请刷新详情。'}
                      action={(
                        <div className="row">
                          <CopyButton value={selected.prompt ?? ''} label="复制提示词" />
                          {canWrite
                            ? <Button onClick={() => { void openEdit(selected); }}><Pencil size={14} /> 编辑提示词</Button>
                            : <span className="dim">只读</span>}
                        </div>
                      )}
                    >
                      <pre className="json-view prewrap mono">{selected.prompt ?? '（该角色没有提示词内容）'}</pre>
                    </Panel>
                  </>
                )}
              </DataState>
            </Panel>
          )}
        </>
      )}

      {tab === 'import' && (
        <Panel
          title="批量导入"
          description="按 JSON 数组导入角色档案，支持 dry-run 预演与冲突策略。"
          action={importText || importReport
            ? <Button onClick={resetImport} disabled={importBusy}>清空</Button>
            : undefined}
        >
          {!canImport ? (
            <EmptyState title="只读" detail="缺少 characters.import 权限，无法执行批量导入。" />
          ) : (
            <>
              <Notice tone="info" icon={<Upload size={17} />}>
                先以 dry-run 预演校验，确认无冲突后再关闭预演执行写入；执行导入是受服务端 nonce 保护的写操作。
              </Notice>
              <Field
                label="items（JSON 数组）"
                hint='每项形如 { "id": "mika", "name": "Mika", "prompt": "…", "source": "manual", "expectedRevision": "<64位十六进制>" }'
              >
                <TextArea
                  rows={8}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  placeholder='[{"name":"Mika","prompt":"你是一位温柔的…"}]'
                  aria-label="导入角色 JSON"
                />
              </Field>
              <div className="form-inline">
                <Switch checked={importDryRun} onChange={(next) => setImportDryRun(next)} label="dry-run 预演（不写入文件）" />
                <Field label="冲突策略">
                  <Select
                    value={onConflict}
                    onChange={(event) => setOnConflict(event.target.value === 'overwrite' ? 'overwrite' : 'skip')}
                    aria-label="冲突策略"
                  >
                    <option value="skip">skip（跳过已存在）</option>
                    <option value="overwrite">overwrite（覆盖已存在）</option>
                  </Select>
                </Field>
                <Button variant={importDryRun ? 'secondary' : 'primary'} onClick={runImport} busy={importBusy}>
                  <Upload size={15} /> {importDryRun ? '预演导入' : '执行导入'}
                </Button>
              </div>
              {importError && <div className="inline-error">{importError}</div>}
              {importReport && (
                <div className="mt-2">
                  <Descriptions
                    columns={3}
                    items={[
                      { label: '总数', value: formatNumber(importReport.total) },
                      {
                        label: importDryRun ? '可导入' : '已导入',
                        value: <span className="text-success">{formatNumber(importReport.imported.length)}</span>,
                      },
                      {
                        label: '跳过',
                        value: importReport.skipped.length > 0
                          ? <Pill tone="warning">{formatNumber(importReport.skipped.length)}</Pill>
                          : formatNumber(importReport.skipped.length),
                      },
                      {
                        label: '失败',
                        value: importReport.failed.length > 0
                          ? <Pill tone="danger">{formatNumber(importReport.failed.length)}</Pill>
                          : formatNumber(importReport.failed.length),
                      },
                    ]}
                  />
                  {importReport.failed.length > 0 && (
                    <Notice tone="danger">
                      失败：{importReport.failed.map((item) => `${item.name ?? `#${item.index}`}（${item.error}）`).join('；')}
                    </Notice>
                  )}
                  {importReport.skipped.length > 0 && (
                    <Panel title="跳过明细" flush>
                      <Table minWidth={520}>
                        <thead><tr><th>#</th><th>名称</th><th>原因</th></tr></thead>
                        <tbody>
                          {importReport.skipped.map((item) => (
                            <tr key={`skip-${item.index}-${item.reason}`}>
                              <td className="mono">{item.index}</td>
                              <td>{item.name ?? '—'}</td>
                              <td className="prewrap">{item.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </Panel>
                  )}
                  {importReport.imported.length > 0 ? (
                    <Panel title={importDryRun ? '预演结果（未写入）' : '已导入角色'} flush>
                      <Table minWidth={520}>
                        <thead><tr><th>ID</th><th>名称</th><th>提示词长度</th></tr></thead>
                        <tbody>
                          {importReport.imported.map((record) => (
                            <tr key={record.id}>
                              <td className="mono">{record.id}</td>
                              <td>{record.name || record.id}</td>
                              <td>{promptLengthText(record)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </Panel>
                  ) : (
                    <EmptyState
                      title="没有可导入的角色"
                      detail={importReport.skipped.length > 0 ? '全部条目都被跳过，请检查冲突策略或 items 内容。' : '服务端没有返回任何成功条目。'}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </Panel>
      )}

      {tab === 'crosschat' && (
        <Panel title="角色互聊沙盒" description="选择至少 2 个角色，围绕一个主题进行离线角色扮演对话；对话在沙盒内生成，不触及真实频道或记忆。">
          {!canCrossChat ? (
            <EmptyState title="只读" detail="缺少 characters.crosschat 权限，无法启动角色互聊。" />
          ) : (
            <>
              <DataState
                loading={list.loading && !list.data}
                error={list.error}
                empty={!list.loading && characters.length === 0}
                emptyTitle="没有可选角色"
                emptyDetail="角色库里还没有任何档案，先创建角色再进行互聊。"
                onRetry={() => list.reload()}
              >
                <div className="field">
                  <span className="field-label">参与角色（至少 2 个）</span>
                  <div className="card-grid">
                    {characters.map((record) => (
                      <label className="row" key={record.id}>
                        <input
                          type="checkbox"
                          checked={crossIds.includes(record.id)}
                          onChange={() => toggleCrossId(record.id)}
                          aria-label={`选择角色 ${record.name || record.id}`}
                        />
                        <span className="grow">{record.name || record.id}</span>
                        <small className="muted-text mono">{record.id}</small>
                      </label>
                    ))}
                  </div>
                  <span className="field-hint">
                    已选择 {crossIds.length} 个角色{crossIds.length < 2 ? '（至少再选 1 个才能开始）' : ''}
                  </span>
                </div>
                {crossIds.length > 0 && (
                  <div className="toolbar">
                    <Button onClick={() => { setCrossIds([]); setCrossStartWith(''); }}>清空选择</Button>
                  </div>
                )}
                <div className="form-grid">
                  <Field label="主题" hint={`最多 ${CROSS_CHAT_TOPIC_MAX} 字符（当前 ${formatNumber(crossTopic.trim().length)}）`}>
                    <TextInput
                      value={crossTopic}
                      onChange={(event) => setCrossTopic(event.target.value)}
                      placeholder="例如：两人讨论周末露营计划"
                      aria-label="互聊主题"
                    />
                  </Field>
                  <Field label="开场角色（可选）" hint="必须属于已选角色">
                    <Select value={crossStartWith} onChange={(event) => setCrossStartWith(event.target.value)} aria-label="开场角色">
                      <option value="">由服务端决定</option>
                      {selectedCharacters.map((record) => (
                        <option key={record.id} value={record.id}>{record.name || record.id}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Button
                  variant="primary"
                  onClick={runCrossChat}
                  busy={crossBusy}
                  disabled={crossIds.length < 2 || !crossTopic.trim()}
                >
                  <MessagesSquare size={15} /> 开始互聊
                </Button>
                {crossError && <div className="inline-error">{crossError}</div>}
                {crossResult && (
                  <div className="mt-2">
                    <Descriptions
                      columns={3}
                      items={[
                        {
                          label: '结束原因',
                          value: (
                            <span className="row gap-sm">
                              <Pill tone={crossChatStopTone(crossResult.stopReason)}>
                                {CROSS_CHAT_STOP_LABEL[crossResult.stopReason] ?? crossResult.stopReason}
                              </Pill>
                              <span className="dim mono">{crossResult.stopReason}</span>
                            </span>
                          ),
                        },
                        { label: '轮次', value: formatNumber(crossTurns.length) },
                        { label: '耗时', value: formatDuration(crossResult.totalMs) },
                      ]}
                    />
                    {crossResult.error && <Notice tone="danger">对话中断：{crossResult.error}</Notice>}
                    {crossTurns.length > 0 ? (
                      <div className="timeline">
                        {crossTurns.map((turn, index) => (
                          <div className="timeline-item" key={`${turn.speakerId}-${turn.at}-${index}`}>
                            <div className="timeline-marker" />
                            <div>
                              <div className="table-primary">{turn.speakerName}<span className="dim mono"> · {formatDateTime(turn.at)}</span></div>
                              <p className="prewrap">{turn.content}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyState
                        title="没有产生对话"
                        detail={crossResult.error ? '对话在首个回合前中断，详见上方错误。' : '服务端返回了空对话记录。'}
                      />
                    )}
                    <details className="schema-details">
                      <summary>原始结果</summary>
                      <pre className="json-view mono">{prettyJson(crossResult)}</pre>
                    </details>
                  </div>
                )}
              </DataState>
            </>
          )}
        </Panel>
      )}

      <Modal
        open={editorOpen}
        onClose={closeEditor}
        title={editing ? '编辑角色' : '创建角色'}
        description={editing
          ? `保存时将提交 revision ${truncateMiddle(revisionOf(editing), 14) || '—'} 以检测冲突。`
          : '创建新的角色档案文件。'}
        width={720}
        footer={<>
          <Button onClick={closeEditor} disabled={saving}>取消</Button>
          <Button variant="primary" onClick={() => { void submitEditor(); }} busy={saving} disabled={editorLoading}><Save size={15} /> 保存</Button>
        </>}
      >
        {editorLoading && <Loading label="正在读取完整提示词…" />}
        <Field label="名称" hint="用于生成角色 ID，必填">
          <TextInput value={formName} onChange={(event) => setFormName(event.target.value)} aria-label="角色名称" />
        </Field>
        <Field
          label="提示词"
          hint={`至少 ${MIN_PROMPT_LENGTH} 个字符，将写入 data/characters（当前 ${formatNumber(formPrompt.length)} 字符）`}
        >
          <TextArea rows={12} value={formPrompt} onChange={(event) => setFormPrompt(event.target.value)} aria-label="角色提示词" />
        </Field>
        <Field label="来源（可选）" hint="记录该角色的出处，便于审计">
          <TextInput value={formSource} onChange={(event) => setFormSource(event.target.value)} aria-label="角色来源" />
        </Field>
        {editing && (
          <p className="dim mono">expectedRevision: {hasValidRevision(editing) ? revisionOf(editing) : '缺失（需要刷新详情）'}</p>
        )}
        {formError && <div className="inline-error">{formError}</div>}
      </Modal>
    </>
  );
}
