import { useMemo, useState } from 'react';
import { Lock, Plus, RefreshCw, RotateCcw } from 'lucide-react';
import { ApiError, api, body, confirmedRequest } from '../lib/api';
import type { FutureTask, PageProps } from '../lib/types';
import { useAsync, useDebouncedValue, useToggle } from '../lib/hooks';
import { formatDateTime, formatRelative, prettyJson, truncateMiddle } from '../lib/format';
import {
  Button, DataState, Descriptions, Field, Modal, Notice, PageTitle, Panel, Pill, Select, Table, TextArea, TextInput,
} from '../components/ui';

/**
 * 未来任务（Future Tasks）：持久化延时调度队列。
 *
 * - 读取 `GET /api/tasks/future?status&type&owner&limit`（服务端仅对 admin /
 *   developer 角色兑现 owner 过滤，本页仍提供输入框）。
 * - `POST /api/tasks/future/schedule`（tasks.control，需确认）按类型引导填写载荷。
 * - `POST /api/tasks/future/:id/reconcile`（tasks.control，需确认）仅对
 *   `uncertain` 状态且类型为 `discord.deliver` 的任务有效。
 */

type PillTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';
type ScheduleType = 'world.tick' | 'discord.deliver';

const STATUS_VALUES = ['pending', 'claimed', 'completed', 'failed', 'expired', 'uncertain'] as const;

const STATUS_LABELS: Record<string, string> = {
  pending: '待执行',
  claimed: '已认领',
  completed: '已完成',
  failed: '已失败',
  expired: '已过期',
  uncertain: '结果未知',
};

const LIMIT_OPTIONS = [50, 100, 200, 500];

const TYPE_OPTIONS: Array<{ value: ScheduleType; label: string }> = [
  { value: 'world.tick', label: 'world.tick · 推进世界时钟' },
  { value: 'discord.deliver', label: 'discord.deliver · Discord 消息投递' },
];

/** 与 src/admin/api-routes/world.ts 中的校验完全一致。 */
const CHANNEL_PATTERN = /^\d{1,32}$/;
const DEDUPE_PATTERN = /^[\w:.\-]{1,160}$/;

interface TasksResponse { tasks?: FutureTask[] }

interface Filters { status: string; type: string; owner: string; limit: number }

function queryOf(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.type.trim()) params.set('type', filters.type.trim());
  if (filters.owner.trim()) params.set('owner', filters.owner.trim());
  params.set('limit', String(filters.limit));
  return `?${params.toString()}`;
}

async function loadTasks(query: string): Promise<{ tasks: FutureTask[] }> {
  const result = await api<TasksResponse>(`/tasks/future${query}`);
  return { tasks: Array.isArray(result.tasks) ? result.tasks : [] };
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function statusTone(status: string): PillTone {
  if (status === 'completed') return 'success';
  if (status === 'pending') return 'info';
  if (status === 'claimed' || status === 'uncertain') return 'warning';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 记录同时可能出现 `attempts`（共享类型）与 `retryCount`（服务端记录字段）。 */
function attemptsOf(task: FutureTask): { attempts?: number; maxRetries?: number } {
  return {
    attempts: numberOr(task.attempts) ?? numberOr(task.retryCount),
    maxRetries: numberOr(task.maxRetries),
  };
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function payloadSummary(task: FutureTask): string {
  const payload = task.payload ?? {};
  if (task.type === 'world.tick') {
    const botId = stringField(payload, 'botId');
    return botId ? `botId: ${botId}` : '缺少 botId 字段';
  }
  if (task.type === 'discord.deliver') {
    const channelId = stringField(payload, 'channelId') ?? '?';
    const dedupeKey = stringField(payload, 'dedupeKey') ?? '?';
    const content = stringField(payload, 'content') ?? '';
    return `#${channelId} · ${truncateMiddle(content, 36)} · ${dedupeKey}`;
  }
  return truncateMiddle(JSON.stringify(payload), 60);
}

function reconciliable(task: FutureTask): boolean {
  return task.status === 'uncertain' && task.type === 'discord.deliver';
}

/** `error` 只存在于服务端记录（索引签名为 unknown），渲染前统一转成文本。 */
function textOf(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string') return value;
  return prettyJson(value);
}

interface ScheduleForm {
  type: ScheduleType;
  botId: string;
  channelId: string;
  dedupeKey: string;
  content: string;
  scheduledAt: string;
  maxRetries: string;
  timeoutMs: string;
}

const EMPTY_FORM: ScheduleForm = {
  type: 'world.tick',
  botId: '',
  channelId: '',
  dedupeKey: '',
  content: '',
  scheduledAt: '',
  maxRetries: '',
  timeoutMs: '',
};

function validate(form: ScheduleForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.botId.trim()) errors.botId = '必填：目标 Bot 实例 ID。';
  if (form.type === 'discord.deliver') {
    if (!CHANNEL_PATTERN.test(form.channelId.trim())) errors.channelId = '必须是 1~32 位数字的频道 ID。';
    if (!DEDUPE_PATTERN.test(form.dedupeKey.trim())) errors.dedupeKey = '仅允许字母、数字、下划线、冒号、点、短横线，长度 1~160。';
    if (!form.content.trim()) errors.content = '投递内容不能为空。';
    else if (form.content.length > 2000) errors.content = '投递内容最多 2000 个字符。';
  }
  if (form.scheduledAt.trim() && !Number.isFinite(new Date(form.scheduledAt).getTime())) errors.scheduledAt = '时间格式无效。';
  if (form.maxRetries.trim()) {
    const value = Number(form.maxRetries);
    if (!Number.isInteger(value) || value < 0 || value > 20) errors.maxRetries = '必须是 0~20 的整数。';
  }
  if (form.timeoutMs.trim()) {
    const value = Number(form.timeoutMs);
    if (!Number.isInteger(value) || value < 1000 || value > 300000) errors.timeoutMs = '必须是 1000~300000 的整数（毫秒）。';
  }
  return errors;
}

function requestOf(form: ScheduleForm): Record<string, unknown> {
  const payload: Record<string, unknown> = form.type === 'world.tick'
    ? { botId: form.botId.trim() }
    : {
      botId: form.botId.trim(),
      channelId: form.channelId.trim(),
      dedupeKey: form.dedupeKey.trim(),
      content: form.content,
    };
  const request: Record<string, unknown> = { type: form.type, payload };
  if (form.scheduledAt.trim()) request.scheduledAt = new Date(form.scheduledAt).getTime();
  if (form.maxRetries.trim()) request.maxRetries = Number(form.maxRetries);
  if (form.timeoutMs.trim()) request.timeoutMs = Number(form.timeoutMs);
  return request;
}

export function FutureTasks({ permissions }: PageProps) {
  const canControl = permissions.includes('tasks.control');

  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [owner, setOwner] = useState('');
  const [limit, setLimit] = useState(200);
  const debouncedType = useDebouncedValue(type, 300);
  const debouncedOwner = useDebouncedValue(owner, 300);

  const query = useMemo(
    () => queryOf({ status, type: debouncedType, owner: debouncedOwner, limit }),
    [status, debouncedType, debouncedOwner, limit],
  );
  const state = useAsync(() => loadTasks(query), [query], '读取未来任务失败');
  const tasks = state.data?.tasks ?? [];
  const filtersActive = Boolean(status || type.trim() || owner.trim());

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const task of tasks) map.set(task.status, (map.get(task.status) ?? 0) + 1);
    return map;
  }, [tasks]);

  const [scheduleOpen, toggleSchedule] = useToggle(false);
  const [form, setForm] = useState<ScheduleForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [scheduled, setScheduled] = useState<FutureTask | undefined>();
  const [reconcilingId, setReconcilingId] = useState('');
  const [reconcileResult, setReconcileResult] = useState<{ task?: FutureTask; record?: unknown } | undefined>();

  const patchForm = (next: Partial<ScheduleForm>) => setForm((current) => ({ ...current, ...next }));

  const openSchedule = () => {
    if (!canControl) return;
    setForm(EMPTY_FORM);
    setErrors({});
    setActionError('');
    toggleSchedule(true);
  };

  const changeType = (next: ScheduleType) => {
    setForm((current) => ({ ...current, type: next, channelId: '', dedupeKey: '', content: '' }));
    setErrors({});
  };

  const submit = async () => {
    if (!canControl) return;
    const nextErrors = validate(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const request = requestOf(form);
    setSubmitting(true);
    setActionError('');
    setScheduled(undefined);
    try {
      const result = await confirmedRequest<{ task?: FutureTask }>(
        '/tasks/future/schedule',
        { method: 'POST', body: body(request) },
        request,
        `调度未来任务 ${form.type}`,
      );
      setScheduled(result.task);
      toggleSchedule(false);
      state.reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 0) return; // 用户取消确认
      setActionError(cause instanceof Error ? cause.message : '调度未来任务失败。');
    } finally {
      setSubmitting(false);
    }
  };

  const reconcile = async (task: FutureTask) => {
    if (!canControl) return;
    setReconcilingId(task.id);
    setActionError('');
    try {
      const result = await confirmedRequest<{ task?: FutureTask; record?: unknown }>(
        `/tasks/future/${encodeURIComponent(task.id)}/reconcile`,
        { method: 'POST' },
        {},
        `对账未来任务 ${task.id}`,
      );
      setReconcileResult(result);
      state.reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 0) return; // 用户取消确认
      setActionError(cause instanceof Error ? cause.message : '对账失败。');
    } finally {
      setReconcilingId('');
    }
  };

  return (
    <>
      <PageTitle
        eyebrow="FUTURE TASKS"
        title="未来任务"
        description="查看 SQLite 持久化的延时调度队列：状态、所有者、计划时间、重试与最近错误。"
        actions={<>
          <Button onClick={state.reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>
          {canControl && <Button variant="primary" onClick={openSchedule}><Plus size={15} /> 调度任务</Button>}
        </>}
      />

      {!canControl && (
        <Notice tone="info" icon={<Lock size={16} />}>
          只读：当前账号没有 tasks.control 权限，无法调度或对账未来任务。服务端仍会独立校验授权。
        </Notice>
      )}

      {actionError && <Notice tone="danger">{actionError}</Notice>}

      {scheduled && (
        <Notice tone="info">
          已调度任务 <span className="mono">{scheduled.id}</span>（类型 {scheduled.type}，状态 {statusLabel(scheduled.status)}）。
        </Notice>
      )}

      <Panel title="筛选" description="owner 过滤仅对 admin / developer 角色生效，其余角色由服务端固定为自己的任务。">
        <div className="filter-row">
          <Field label="状态" hint="服务端枚举过滤">
            <Select data-testid="filter-status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">全部状态</option>
              {STATUS_VALUES.map((value) => <option key={value} value={value}>{statusLabel(value)}（{value}）</option>)}
            </Select>
          </Field>
          <Field label="类型" hint="精确匹配，如 world.tick">
            <TextInput data-testid="filter-type" value={type} placeholder="world.tick" onChange={(event) => setType(event.target.value)} />
          </Field>
          <Field label="所有者" hint="仅 admin / developer 生效">
            <TextInput data-testid="filter-owner" value={owner} placeholder="管理员 ID" onChange={(event) => setOwner(event.target.value)} />
          </Field>
          <Field label="返回条数" hint="服务端上限 500">
            <Select data-testid="filter-limit" value={String(limit)} onChange={(event) => setLimit(Number(event.target.value) || 200)}>
              {LIMIT_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </Select>
          </Field>
        </div>
      </Panel>

      <Panel
        title="任务队列"
        description={`当前返回 ${tasks.length} 条${filtersActive ? '（已应用筛选）' : ''} · limit ${limit}`}
        action={tasks.length > 0 ? (
          <div className="row">
            {STATUS_VALUES.map((value) => {
              const count = counts.get(value) ?? 0;
              if (count === 0) return null;
              return <Pill key={value} tone={statusTone(value)}>{statusLabel(value)} {count}</Pill>;
            })}
          </div>
        ) : undefined}
      >
        <DataState
          loading={state.loading}
          error={state.error}
          empty={!state.loading && !state.error && tasks.length === 0}
          emptyTitle="没有未来任务"
          emptyDetail={filtersActive ? '当前筛选条件下没有匹配记录，可调整状态 / 类型 / 所有者。' : '调度队列为空，尚未安排任何延时任务。'}
          onRetry={state.reload}
        >
          <Table minWidth={1080}>
            <thead>
              <tr>
                <th>任务 ID</th>
                <th>类型</th>
                <th>状态</th>
                <th>所有者</th>
                <th>计划时间</th>
                <th>重试</th>
                <th>最近错误</th>
                <th>载荷摘要</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const { attempts, maxRetries } = attemptsOf(task);
                return (
                  <tr key={task.id}>
                    <td className="mono truncate-cell" title={task.id}>{task.id}</td>
                    <td className="mono nowrap">{task.type}</td>
                    <td><Pill tone={statusTone(task.status)}>{statusLabel(task.status)}</Pill></td>
                    <td className="nowrap">{task.owner || '—'}</td>
                    <td className="nowrap" title={formatDateTime(task.scheduledAt)}>{formatRelative(task.scheduledAt)}</td>
                    <td className="nowrap">{attempts === undefined ? '—' : `${attempts}/${maxRetries ?? '—'}`}</td>
                    <td className="truncate-cell" title={task.lastError ?? ''}>{task.lastError || '—'}</td>
                    <td className="mono truncate-cell" title={payloadSummary(task)}>{payloadSummary(task)}</td>
                    <td className="table-actions">
                      {canControl && reconciliable(task) ? (
                        <Button
                          variant="secondary"
                          busy={reconcilingId === task.id}
                          onClick={() => void reconcile(task)}
                        >
                          <RotateCcw size={14} /> 对账
                        </Button>
                      ) : <span className="muted-text">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </DataState>
      </Panel>

      <Modal
        open={scheduleOpen}
        onClose={() => toggleSchedule(false)}
        title="调度未来任务"
        description="选择任务类型后填写对应载荷；提交前会校验，调度与对账均需二次确认。"
        width={640}
        footer={<>
          <Button onClick={() => toggleSchedule(false)} disabled={submitting}>取消</Button>
          <Button variant="primary" busy={submitting} onClick={() => void submit()}>确认调度</Button>
        </>}
      >
        <div className="form-grid">
          <Field label="任务类型" hint="决定任务载荷字段">
            <Select
              data-testid="schedule-type"
              value={form.type}
              onChange={(event) => changeType(event.target.value as ScheduleType)}
            >
              {TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </Field>

          <Field label="botId" hint="目标 Bot 实例 ID，服务端要求实例存在" error={errors.botId}>
            <TextInput
              data-testid="schedule-botId"
              value={form.botId}
              placeholder="moho"
              onChange={(event) => patchForm({ botId: event.target.value })}
            />
          </Field>

          {form.type === 'discord.deliver' && (
            <>
              <Field label="channelId" hint="1~32 位数字的 Discord 频道 ID" error={errors.channelId}>
                <TextInput
                  data-testid="schedule-channelId"
                  value={form.channelId}
                  placeholder="123456789012345678"
                  onChange={(event) => patchForm({ channelId: event.target.value })}
                />
              </Field>
              <Field label="dedupeKey" hint="幂等键：字母 / 数字 / _ : . -，长度 1~160" error={errors.dedupeKey}>
                <TextInput
                  data-testid="schedule-dedupeKey"
                  value={form.dedupeKey}
                  placeholder="reminder:123:morning"
                  onChange={(event) => patchForm({ dedupeKey: event.target.value })}
                />
              </Field>
              <Field label="content" hint={`投递内容，1~2000 字符（当前 ${form.content.length}）`} error={errors.content}>
                <TextArea
                  data-testid="schedule-content"
                  value={form.content}
                  rows={4}
                  maxLength={2000}
                  onChange={(event) => patchForm({ content: event.target.value })}
                />
              </Field>
            </>
          )}

          <Field label="scheduledAt" hint="留空表示立即执行；按本地时间解析为毫秒时间戳" error={errors.scheduledAt}>
            <TextInput
              data-testid="schedule-scheduledAt"
              type="datetime-local"
              value={form.scheduledAt}
              onChange={(event) => patchForm({ scheduledAt: event.target.value })}
            />
          </Field>
          <Field label="maxRetries" hint="留空使用服务端默认值，范围 0~20" error={errors.maxRetries}>
            <TextInput
              data-testid="schedule-maxRetries"
              inputMode="numeric"
              value={form.maxRetries}
              placeholder="3"
              onChange={(event) => patchForm({ maxRetries: event.target.value })}
            />
          </Field>
          <Field label="timeoutMs" hint="留空使用服务端默认值，范围 1000~300000" error={errors.timeoutMs}>
            <TextInput
              data-testid="schedule-timeoutMs"
              inputMode="numeric"
              value={form.timeoutMs}
              placeholder="30000"
              onChange={(event) => patchForm({ timeoutMs: event.target.value })}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={reconcileResult !== undefined}
        onClose={() => setReconcileResult(undefined)}
        title="对账结果"
        description="依据 Discord 出站记录判定 uncertain 任务的实际投递结果。"
        width={560}
        footer={<Button onClick={() => setReconcileResult(undefined)}>关闭</Button>}
      >
        <Descriptions columns={1} items={[
          { label: '任务 ID', value: <span className="mono">{reconcileResult?.task?.id ?? '—'}</span> },
          { label: '新状态', value: reconcileResult?.task ? <Pill tone={statusTone(reconcileResult.task.status)}>{statusLabel(reconcileResult.task.status)}</Pill> : '—' },
          { label: '最近错误', value: textOf(reconcileResult?.task?.lastError ?? reconcileResult?.task?.error) },
          {
            label: '出站记录',
            value: reconcileResult?.record === undefined || reconcileResult.record === null
              ? '没有对应出站记录，投递结果仍无法确认。'
              : <pre className="json-view mono prewrap">{prettyJson(reconcileResult.record)}</pre>,
          },
        ]} />
      </Modal>
    </>
  );
}
