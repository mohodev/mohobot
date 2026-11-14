import { useMemo, useState } from 'react';
import { RefreshCw, Search, SlidersHorizontal, Sparkles, TrendingDown, TrendingUp, Users } from 'lucide-react';
import { api, ApiError, body, confirmedRequest } from '../lib/api';
import type { AffinityRecord, PageProps } from '../lib/types';
import { useAsync, useDebouncedValue, useToggle } from '../lib/hooks';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format';
import {
  Button,
  DataState,
  Field,
  Modal,
  Notice,
  PageTitle,
  Panel,
  StatCard,
  Table,
  TextArea,
  TextInput,
} from '../components/ui';

/**
 * Display-only labels for the server's `AffinityDeltaReason` value set. The
 * reason is decided by the server (`parseAffinityAdjust` forces `manual`) and is
 * never sent in the adjust request, so this map is used purely for rendering the
 * `lastReason` column.
 */
const REASON_LABEL: Record<string, string> = {
  helpful: '有帮助',
  kind: '友善',
  'shared-interest': '共同兴趣',
  conflict: '冲突',
  ignored: '被忽视',
  manual: '手动调整',
};

/** Bounds enforced by `parseAffinityAdjust` on the server. */
const DELTA_MIN = -10;
const DELTA_MAX = 10;
const NOTE_MAX = 500;

interface Draft {
  botId: string;
  userId: string;
  delta: string;
  note: string;
}

const EMPTY_DRAFT: Draft = { botId: '', userId: '', delta: '', note: '' };

function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
}

/** Magnitude of the score mapped onto the shared `.meter` track (0..100%). */
function meterWidth(score: number): number {
  return Math.max(0, Math.min(100, Math.abs(score)));
}

function meterClass(score: number): string {
  return score < 0 ? 'meter meter-danger' : 'meter';
}

interface AffinityResponse {
  affinity?: AffinityRecord[];
}

export function Affinity({ permissions }: PageProps) {
  const [botIdInput, setBotIdInput] = useState('');
  const botId = useDebouncedValue(botIdInput.trim(), 250);

  const state = useAsync(async () => {
    const query = botId ? `?botId=${encodeURIComponent(botId)}` : '';
    const result = await api<AffinityResponse>(`/affinity${query}`);
    return { rows: Array.isArray(result.affinity) ? result.affinity : [] };
  }, [botId], '读取好感度数据失败');

  const [query, setQuery] = useState('');
  const [modalOpen, toggleModal] = useToggle(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');

  const canWrite = permissions.includes('memory.write');

  // Server already returns score-descending rows; re-sort defensively so the UI
  // order never depends on transport quirks.
  const rows = useMemo(
    () => [...(state.data?.rows ?? [])].sort((a, b) => b.score - a.score),
    [state.data],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => row.userId.toLowerCase().includes(needle));
  }, [rows, query]);

  const averages = useMemo(() => {
    const count = rows.length;
    const total = rows.reduce((sum, row) => sum + Number(row.score ?? 0), 0);
    const positive = rows.filter((row) => row.score > 0).length;
    const negative = rows.filter((row) => row.score < 0).length;
    return { count, average: count ? total / count : 0, positive, negative };
  }, [rows]);

  function openAdjust(row?: AffinityRecord): void {
    setDraft({
      botId: row?.botId ?? botId ?? '',
      userId: row?.userId ?? '',
      delta: '',
      note: '',
    });
    setFormError('');
    setNotice('');
    toggleModal(true);
  }

  async function submit(): Promise<void> {
    setFormError('');
    const trimmedBot = draft.botId.trim();
    const trimmedUser = draft.userId.trim();
    if (!trimmedBot) {
      setFormError('botId 不能为空。');
      return;
    }
    if (!trimmedUser) {
      setFormError('userId 不能为空。');
      return;
    }
    const delta = Number(draft.delta);
    if (draft.delta.trim() === '' || !Number.isFinite(delta)) {
      setFormError('delta 必须是数字。');
      return;
    }
    if (delta < DELTA_MIN || delta > DELTA_MAX) {
      setFormError(`delta 必须在 ${DELTA_MIN} 到 ${DELTA_MAX} 之间。`);
      return;
    }
    const note = draft.note.trim();
    if (note.length > NOTE_MAX) {
      setFormError(`备注最多 ${NOTE_MAX} 个字符。`);
      return;
    }

    const payload: Record<string, unknown> = {
      botId: trimmedBot,
      userId: trimmedUser,
      delta,
    };
    if (note) payload.note = note;

    setSubmitting(true);
    try {
      await confirmedRequest(
        '/affinity/adjust',
        { method: 'POST', body: body(payload) },
        payload,
        `调整用户 ${trimmedUser} 的好感度`,
      );
      toggleModal(false);
      setNotice('好感度已调整。');
      state.reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 0) return; // 用户取消确认，不提示错误
      setFormError(cause instanceof Error ? cause.message : '调整好感度失败。');
    } finally {
      setSubmitting(false);
    }
  }

  const filterNote = botId ? `botId = ${botId}` : '全部 bot';

  return (
    <>
      <PageTitle
        eyebrow="AFFINITY"
        title="好感度"
        description="查看用户与 Bot 之间的好感度分数、互动次数与最近调整原因；具备写权限时可直接调整。"
        actions={
          <div className="toolbar">
            {canWrite && (
              <Button variant="primary" onClick={() => openAdjust()}><SlidersHorizontal size={15} /> 调整好感度</Button>
            )}
            <Button onClick={state.reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>
          </div>
        }
      />

      {notice && <Notice tone="info">{notice}</Notice>}
      {!canWrite && <Notice tone="warning">当前账号缺少 memory.write 权限，好感度页面为只读。</Notice>}

      <DataState loading={state.loading && !state.data} error={state.error} onRetry={state.reload}>
        <div className="stat-grid">
          <StatCard label="用户总数" value={formatNumber(averages.count)} note={filterNote} icon={<Users size={17} />} />
          <StatCard label="平均好感度" value={formatNumber(averages.average, 2)} note="全部记录的平均分" icon={<Sparkles size={17} />} />
          <StatCard label="正向关系" value={formatNumber(averages.positive)} note="score > 0" icon={<TrendingUp size={17} />} tone={averages.positive > 0 ? 'success' : undefined} />
          <StatCard label="负向关系" value={formatNumber(averages.negative)} note="score < 0" icon={<TrendingDown size={17} />} tone={averages.negative > 0 ? 'danger' : undefined} />
        </div>

        <Panel
          title="好感度记录"
          description={`共 ${rows.length} 条记录 · 当前显示 ${filtered.length} 条`}
        >
          <div className="filter-row">
            <label className="search-field">
              <Search size={15} />
              <input
                type="search"
                value={query}
                placeholder="按用户 ID 搜索"
                aria-label="按用户 ID 搜索"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <TextInput
              value={botIdInput}
              placeholder="按 botId 过滤（服务器查询）"
              aria-label="按 botId 过滤"
              onChange={(event) => setBotIdInput(event.target.value)}
            />
          </div>

          <DataState
            empty={rows.length === 0}
            emptyTitle="暂无好感度记录"
            emptyDetail={botId ? `没有匹配 botId = ${botId} 的记录。` : '该系统尚未记录任何用户好感度。'}
          >
            <DataState
              empty={filtered.length === 0}
              emptyTitle="没有匹配的用户"
              emptyDetail="请调整搜索关键字。"
            >
              <Table minWidth={880}>
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>好感度</th>
                    <th>互动次数</th>
                    <th>最近原因</th>
                    <th>更新时间</th>
                    <th>备注</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => {
                    const key = `${row.botId}:${row.userId}`;
                    const notes = row.notes ?? [];
                    const lastNote = notes.length ? notes[notes.length - 1] : '';
                    return (
                      <tr key={key} className="selectable-row">
                        <td>
                          <div className="table-primary mono">{row.userId}</div>
                          <small className="muted-text mono">{row.botId}</small>
                        </td>
                        <td>
                          <div className="row row-between">
                            <span className="mono">{formatNumber(row.score, 2)}</span>
                          </div>
                          <div className={meterClass(row.score)}>
                            <span style={{ width: `${meterWidth(row.score)}%` }} />
                          </div>
                        </td>
                        <td>{formatNumber(row.interactions ?? 0)}</td>
                        <td>{reasonLabel(row.lastReason)}</td>
                        <td title={formatDateTime(row.updatedAt)}>{formatRelative(row.updatedAt)}</td>
                        <td className="truncate-cell">
                          {lastNote || '—'}
                          {notes.length > 1 && <div><small className="muted-text">共 {notes.length} 条备注</small></div>}
                        </td>
                        <td className="table-actions">
                          {canWrite ? (
                            <Button
                              variant="ghost"
                              aria-label={`调整 ${row.userId} 的好感度`}
                              onClick={() => openAdjust(row)}
                            >
                              <SlidersHorizontal size={15} /> 调整
                            </Button>
                          ) : (
                            <span className="muted-text">只读</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </DataState>
          </DataState>
        </Panel>
      </DataState>

      <Modal
        open={modalOpen}
        onClose={() => toggleModal(false)}
        title="调整好感度"
        description="提交 botId、userId、delta 与可选备注；调整原因由服务端记录为 manual，该操作需要二次确认。"
        footer={
          <>
            <Button onClick={() => toggleModal(false)} disabled={submitting}>取消</Button>
            <Button variant="primary" busy={submitting} onClick={() => { void submit(); }}>提交调整</Button>
          </>
        }
      >
        {formError && <Notice tone="danger">{formError}</Notice>}
        <div className="form-grid">
          <Field label="botId">
            <TextInput
              value={draft.botId}
              placeholder="bot 实例 ID"
              onChange={(event) => setDraft({ ...draft, botId: event.target.value })}
            />
          </Field>
          <Field label="userId">
            <TextInput
              value={draft.userId}
              placeholder="目标用户 ID"
              onChange={(event) => setDraft({ ...draft, userId: event.target.value })}
            />
          </Field>
          <Field label="delta" hint={`范围 ${DELTA_MIN} ~ ${DELTA_MAX}，可为小数。`}>
            <TextInput
              type="number"
              step="0.1"
              min={DELTA_MIN}
              max={DELTA_MAX}
              value={draft.delta}
              placeholder="例如 2 或 -1.5"
              onChange={(event) => setDraft({ ...draft, delta: event.target.value })}
            />
          </Field>
          <Field label="备注" hint={`可选，最多 ${NOTE_MAX} 个字符。`}>
            <TextArea
              value={draft.note}
              rows={3}
              maxLength={NOTE_MAX}
              placeholder="可选备注，最多 500 字"
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}
