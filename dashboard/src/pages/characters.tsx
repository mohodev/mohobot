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
import { useAsync, useFiltered, useToggle } from '../lib/hooks';
import { formatDateTime, formatNumber, prettyJson, truncateMiddle } from '../lib/format';
import {
  Button,
  DataState,
  Descriptions,
  EmptyState,
  Field,
  Modal,
  Notice,
  PageTitle,
  Panel,
  Pill,
  Select,
  Switch,
  Table,
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

export function Characters({ permissions }: PageProps) {
  const canWrite = permissions.includes('characters.write');
  const canImport = permissions.includes('characters.import');
  const canCrossChat = permissions.includes('characters.crosschat');

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
  const currentRevision = typeof selected?.revision === 'string' ? selected.revision : '';

  /* ---------------------------- editor ---------------------------- */

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<CharacterRecord | undefined>(undefined);
  const [formName, setFormName] = useState('');
  const [formPrompt, setFormPrompt] = useState('');
  const [formSource, setFormSource] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const closeEditor = useCallback(() => { if (!saving) setEditorOpen(false); }, [saving]);

  const openCreate = useCallback(() => {
    setEditing(undefined);
    setFormName('');
    setFormPrompt('');
    setFormSource('');
    setFormError('');
    setEditorOpen(true);
  }, []);

  const [editorLoading, setEditorLoading] = useState(false);

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

    const revision = editing ? String(editing.revision ?? '') : '';
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

  const [importOpen, toggleImport] = useToggle(false);
  const [importText, setImportText] = useState('');
  const [importDryRun, setImportDryRun] = useState(true);
  const [onConflict, setOnConflict] = useState<'skip' | 'overwrite'>('skip');
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [importReport, setImportReport] = useState<ImportReport | undefined>(undefined);

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

  const [crossOpen, toggleCross] = useToggle(false);
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

  const listCountLabel = useMemo(() => {
    if (query.trim()) return `${filtered.length} / ${characters.length} 个角色`;
    return `${characters.length} 个角色`;
  }, [characters.length, filtered.length, query]);

  return (
    <>
      <PageTitle
        eyebrow="PERSONA CATALOG"
        title="角色档案"
        description="浏览与管理 data/characters 下的角色提示词、批量导入以及角色互聊沙盒。"
        actions={<>
          <Button onClick={() => list.reload()} busy={list.loading}><RefreshCw size={15} /> 刷新</Button>
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
                const revision = typeof record.revision === 'string' ? record.revision : '';
                return (
                  <tr key={record.id} className="selectable-row" onClick={() => setSelectedId(record.id)}>
                    <td>
                      <div className="table-primary">{name}</div>
                      <small className="muted-text mono">{record.id}</small>
                      {record.description ? <div className="dim truncate-cell">{String(record.description)}</div> : null}
                    </td>
                    <td>
                      {Array.isArray(record.tags) && record.tags.length > 0
                        ? record.tags.map((tag) => <Pill key={String(tag)} tone="info">{String(tag)}</Pill>)
                        : <span className="dim">—</span>}
                    </td>
                    <td>{record.promptLength == null ? '—' : formatNumber(record.promptLength)}</td>
                    <td><span className="mono dim">{revision ? truncateMiddle(revision, 14) : '—'}</span></td>
                    <td>
                      {record.enabled === false ? <Pill tone="warning">已停用</Pill> : <Pill tone="success">启用</Pill>}
                    </td>
                    <td className="nowrap">{record.updatedAt ? formatDateTime(record.updatedAt) : '—'}</td>
                    <td>
                      <div className="table-actions" onClick={(event) => event.stopPropagation()}>
                        <Button onClick={() => setSelectedId(record.id)}><FileText size={14} /> 详情</Button>
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
          description={`${selected?.name || selectedId} · 提示词只读展示`}
          action={<Button onClick={() => detail.reload()} busy={detail.loading}><RefreshCw size={14} /> 刷新详情</Button>}
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
                    { label: '提示词长度', value: selected.promptLength == null ? formatNumber((selected.prompt ?? '').length) : formatNumber(selected.promptLength) },
                    { label: '更新时间', value: selected.updatedAt ? formatDateTime(selected.updatedAt) : '—' },
                    { label: 'revision', value: <span className="mono">{currentRevision || '—'}</span> },
                  ]}
                />
                <Panel
                  title="提示词（只读）"
                  description={REVISION_PATTERN.test(currentRevision) ? '编辑将提交该 revision 以检测冲突。' : '未取得有效 revision，编辑前请刷新详情。'}
                  action={canWrite
                    ? <Button onClick={() => { void openEdit(selected); }}><Pencil size={14} /> 编辑提示词</Button>
                    : <span className="dim">只读</span>}
                >
                  <pre className="json-view prewrap mono">{selected.prompt ?? '（该角色没有提示词内容）'}</pre>
                </Panel>
              </>
            )}
          </DataState>
        </Panel>
      )}

      <Panel
        title="批量导入"
        description="按 JSON 数组导入角色档案，支持 dry-run 预演与冲突策略。"
        action={<Button onClick={() => toggleImport()} aria-expanded={importOpen}>{importOpen ? '收起' : '展开'}导入面板</Button>}
      >
        {importOpen && (canImport ? (
          <>
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
              <Button variant="primary" onClick={runImport} busy={importBusy}>
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
                    { label: '导入', value: formatNumber(importReport.imported.length) },
                    { label: '跳过', value: formatNumber(importReport.skipped.length) },
                    { label: '失败', value: formatNumber(importReport.failed.length) },
                  ]}
                />
                {importReport.skipped.length > 0 && (
                  <Panel title="跳过明细" flush>
                    <Table minWidth={520}>
                      <thead><tr><th>#</th><th>名称</th><th>原因</th></tr></thead>
                      <tbody>
                        {importReport.skipped.map((item) => (
                          <tr key={`skip-${item.index}-${item.reason}`}>
                            <td>{item.index}</td>
                            <td>{item.name ?? '—'}</td>
                            <td>{item.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </Panel>
                )}
                {importReport.failed.length > 0 && (
                  <Notice tone="danger">
                    失败：{importReport.failed.map((item) => `${item.name ?? `#${item.index}`}（${item.error}）`).join('；')}
                  </Notice>
                )}
                {importReport.imported.length > 0 && (
                  <Panel title={importDryRun ? '预演结果（未写入）' : '已导入角色'} flush>
                    <Table minWidth={520}>
                      <thead><tr><th>ID</th><th>名称</th><th>提示词长度</th></tr></thead>
                      <tbody>
                        {importReport.imported.map((record) => (
                          <tr key={record.id}>
                            <td className="mono">{record.id}</td>
                            <td>{record.name || record.id}</td>
                            <td>{record.promptLength == null ? formatNumber((record.prompt ?? '').length) : formatNumber(record.promptLength)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </Panel>
                )}
              </div>
            )}
          </>
        ) : (
          <EmptyState title="只读" detail="缺少 characters.import 权限，无法执行批量导入。" />
        ))}
      </Panel>

      <Panel
        title="角色互聊沙盒"
        description="选择至少 2 个角色，围绕一个主题进行离线角色扮演对话。"
        action={<Button onClick={() => toggleCross()} aria-expanded={crossOpen}>{crossOpen ? '收起' : '展开'}互聊面板</Button>}
      >
        {crossOpen && (canCrossChat ? (
          <>
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
              <span className="field-hint">已选择 {crossIds.length} 个角色</span>
            </div>
            <div className="form-grid">
              <Field label="主题" hint="最多 500 字符">
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
                  {characters.filter((record) => crossIds.includes(record.id)).map((record) => (
                    <option key={record.id} value={record.id}>{record.name || record.id}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button variant="primary" onClick={runCrossChat} busy={crossBusy} disabled={crossIds.length < 2 || !crossTopic.trim()}>
              <MessagesSquare size={15} /> 开始互聊
            </Button>
            {crossError && <div className="inline-error">{crossError}</div>}
            {crossResult && (
              <div className="mt-2">
                <Descriptions
                  columns={3}
                  items={[
                    { label: '结束原因', value: <Pill tone={crossResult.stopReason === 'completed' ? 'success' : crossResult.stopReason === 'error' ? 'danger' : 'info'}>{crossResult.stopReason}</Pill> },
                    { label: '轮次', value: formatNumber(crossTurns.length) },
                    { label: '耗时', value: `${formatNumber(crossResult.totalMs)} ms` },
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
                  <EmptyState title="没有产生对话" detail="服务端返回了空对话记录。" />
                )}
                <details className="schema-details">
                  <summary>原始结果</summary>
                  <pre className="json-view mono">{prettyJson(crossResult)}</pre>
                </details>
              </div>
            )}
          </>
        ) : (
          <EmptyState title="只读" detail="缺少 characters.crosschat 权限，无法启动角色互聊。" />
        ))}
      </Panel>

      <Modal
        open={editorOpen}
        onClose={closeEditor}
        title={editing ? '编辑角色' : '创建角色'}
        description={editing
          ? `保存时将提交 revision ${truncateMiddle(String(editing.revision ?? ''), 14) || '—'} 以检测冲突。`
          : '创建新的角色档案文件。'}
        width={720}
        footer={<>
          <Button onClick={closeEditor} disabled={saving}>取消</Button>
          <Button variant="primary" onClick={() => { void submitEditor(); }} busy={saving} disabled={editorLoading}><Save size={15} /> 保存</Button>
        </>}
      >
        <Field label="名称" hint="用于生成角色 ID，必填">
          <TextInput value={formName} onChange={(event) => setFormName(event.target.value)} aria-label="角色名称" />
        </Field>
        <Field label="提示词" hint={`至少 ${MIN_PROMPT_LENGTH} 个字符，将写入 data/characters`}>
          <TextArea rows={12} value={formPrompt} onChange={(event) => setFormPrompt(event.target.value)} aria-label="角色提示词" />
        </Field>
        <Field label="来源（可选）" hint="记录该角色的出处，便于审计">
          <TextInput value={formSource} onChange={(event) => setFormSource(event.target.value)} aria-label="角色来源" />
        </Field>
        {editing && (
          <p className="dim mono">expectedRevision: {REVISION_PATTERN.test(String(editing.revision ?? '')) ? String(editing.revision) : '缺失（需要刷新详情）'}</p>
        )}
        {formError && <div className="inline-error">{formError}</div>}
      </Modal>
    </>
  );
}
