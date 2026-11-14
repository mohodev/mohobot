import { useMemo, useState } from 'react';
import { Activity, ChevronLeft, ChevronRight, ListChecks, Lock, Pause, Play, RefreshCw, Search, TriangleAlert, Zap } from 'lucide-react';
import { ApiError, api, confirmedRequest } from '../lib/api';
import type { OpsPage, OpsTask, PageProps } from '../lib/types';
import { useAsync, useDebouncedValue, useFiltered } from '../lib/hooks';
import { formatDuration, formatNumber, formatRelative } from '../lib/format';
import {
  Button, DataState, Field, Notice, PageTitle, Panel, Pill, Select, StatCard, Table,
} from '../components/ui';

/**
 * 任务调度（Task Scheduler）：运行时任务管理器的只读视图 + 安全控制。
 *
 * - 读取 `GET /api/tasks?limit&offset`。服务端在同一路由上可能返回裸
 *   `{ items: OpsTask[] }`（TaskControlFacade.list()）或完整的
 *   `OpsPage<OpsTask>`（OpsControlFacade.listTasks()）；本页两种形状都兼容，
 *   并仅在服务端返回 OpsPage 元数据时提供分页。
 * - `POST /api/tasks/:id/(pause|resume|run)`（permission `tasks.control`，
 *   route-policy 标记 confirmation=true）→ `{ task }`。控制项按任务状态与
 *   类型（仅 interval 可控制）逐行显示，写入前走服务端 nonce 确认流程。
 */

type PillTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';
type TaskAction = 'pause' | 'resume' | 'run';

/** 与 src/core/task-manager.ts 的 TaskState 一致。 */
const STATE_VALUES = ['pending', 'running', 'done', 'failed', 'cancelled', 'paused'] as const;

const STATE_LABELS: Record<string, string> = {
  pending: '等待中',
  running: '运行中',
  done: '已完成',
  failed: '已失败',
  cancelled: '已取消',
  paused: '已暂停',
};

const ACTION_LABELS: Record<TaskAction, string> = {
  pause: '暂停',
  resume: '恢复',
  run: '立即执行',
};

const LIMIT_OPTIONS = [25, 50, 100];

interface TasksResponse { tasks?: OpsTask[] | OpsPage<OpsTask> }

interface TasksData { items: OpsTask[]; page?: OpsPage<OpsTask> }

async function loadTasks(limit: number, offset: number): Promise<TasksData> {
  const result = await api<TasksResponse>(`/tasks?limit=${limit}&offset=${offset}`);
  const page = result.tasks;
  const items = Array.isArray(page) ? page : page?.items ?? [];
  // 仅当服务端给出真正的 OpsPage 元数据时才提供分页控件。
  const meta = !Array.isArray(page) && page && typeof page.hasMore === 'boolean' ? page : undefined;
  return { items, page: meta };
}

function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

/** 与 `levelTone` 同构的状态到 Pill 色调映射。 */
function stateTone(state: string): PillTone {
  if (state === 'done') return 'success';
  if (state === 'running') return 'info';
  if (state === 'failed') return 'danger';
  if (state === 'cancelled' || state === 'paused') return 'warning';
  return 'neutral';
}

function kindLabel(kind: string): string {
  if (kind === 'interval') return '周期任务';
  if (kind === 'oneshot') return '一次性任务';
  return kind;
}

/** 仅周期任务可控制（服务端 TaskControlFacade 只暴露 interval 任务）。 */
function actionsFor(task: OpsTask): TaskAction[] {
  if (task.kind !== 'interval') return [];
  if (task.state === 'paused') return ['resume'];
  if (task.state === 'cancelled' || task.state === 'done' || task.state === 'failed') return [];
  return task.state === 'running' ? ['pause'] : ['run', 'pause'];
}

function isErrored(task: OpsTask): boolean {
  return task.errors > 0 || task.state === 'failed';
}

/** 模块级字段访问器，保持 `useFiltered` 的记忆化依赖稳定。 */
const taskSearchFields = (task: OpsTask): Array<unknown> => [task.name, task.id];

export function Tasks({ permissions }: PageProps) {
  const canControl = permissions.includes('tasks.control');

  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);
  const state = useAsync(() => loadTasks(limit, offset), [limit, offset], '读取任务列表失败');

  const tasks = state.data?.items ?? [];
  const page = state.data?.page;

  const [stateFilter, setStateFilter] = useState('');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);
  const searched = useFiltered(tasks, debouncedQuery, taskSearchFields);
  const visible = useMemo(
    () => (stateFilter ? searched.filter((task) => task.state === stateFilter) : searched),
    [searched, stateFilter],
  );

  // 统计基于当前加载页，并非服务端全量数据。
  const stats = useMemo(() => ({
    total: tasks.length,
    running: tasks.filter((task) => task.state === 'running').length,
    errored: tasks.filter(isErrored).length,
    paused: tasks.filter((task) => task.state === 'paused').length,
  }), [tasks]);

  const filtersActive = Boolean(stateFilter || debouncedQuery.trim());
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');

  const mutate = async (task: OpsTask, action: TaskAction) => {
    if (!canControl) return;
    setBusy(`${task.id}:${action}`);
    setActionError('');
    setActionNotice('');
    try {
      await confirmedRequest<{ task?: OpsTask }>(
        `/tasks/${encodeURIComponent(task.id)}/${action}`,
        { method: 'POST' },
        {},
        `${ACTION_LABELS[action]}任务 ${task.name || task.id}`,
      );
      setActionNotice(`已对任务 ${task.name || task.id} 执行「${ACTION_LABELS[action]}」。`);
      state.reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 0) return; // 用户取消确认，不提示错误
      setActionError(cause instanceof Error ? cause.message : `执行「${ACTION_LABELS[action]}」失败。`);
    } finally {
      setBusy('');
    }
  };

  const changeLimit = (next: number) => {
    setLimit(next);
    setOffset(0);
  };

  const canPrev = offset > 0;
  const canNext = Boolean(page?.hasMore);

  return (
    <>
      <PageTitle
        eyebrow="TASK SCHEDULER"
        title="任务调度"
        description="查看运行时任务管理器的任务状态、运行次数与耗时，并按权限安全地暂停、恢复或立即执行周期任务。"
        actions={<Button onClick={state.reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      {!canControl && (
        <Notice tone="info" icon={<Lock size={16} />}>
          只读：当前账号没有 tasks.control 权限，无法暂停、恢复或立即执行任务。服务端仍会独立校验授权。
        </Notice>
      )}

      {actionError && <Notice tone="danger">{actionError}</Notice>}
      {actionNotice && <Notice tone="info" icon={<Zap size={16} />}>{actionNotice}</Notice>}

      <DataState loading={state.loading && !state.data} error={state.error} onRetry={state.reload}>
        <div className="stat-grid">
          <StatCard label="任务总数" value={formatNumber(stats.total)} note="当前加载页" icon={<ListChecks size={17} />} />
          <StatCard label="运行中任务" value={formatNumber(stats.running)} note="state = running" icon={<Activity size={17} />} tone={stats.running > 0 ? 'success' : undefined} />
          <StatCard label="有错误任务" value={formatNumber(stats.errored)} note="errors > 0 或已失败" icon={<TriangleAlert size={17} />} tone={stats.errored > 0 ? 'danger' : undefined} />
          <StatCard label="已暂停任务" value={formatNumber(stats.paused)} note="可恢复执行" icon={<Pause size={17} />} tone={stats.paused > 0 ? 'warning' : undefined} />
        </div>

        <Panel title="筛选" description="状态与关键字在已加载的数据内过滤；分页由服务端执行。">
          <div className="filter-row">
            <Field label="状态">
              <Select data-testid="filter-state" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
                <option value="">全部状态</option>
                {STATE_VALUES.map((value) => <option key={value} value={value}>{stateLabel(value)}（{value}）</option>)}
              </Select>
            </Field>
            <div className="search-field">
              <Search size={14} />
              <input
                data-testid="filter-search"
                value={query}
                placeholder="按名称或 ID 搜索…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Field label="每页条数">
              <Select data-testid="filter-limit" value={String(limit)} onChange={(event) => changeLimit(Number(event.target.value) || 25)}>
                {LIMIT_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
              </Select>
            </Field>
          </div>
        </Panel>

        <Panel
          title="任务列表"
          description={filtersActive
            ? `${visible.length} 条匹配（共加载 ${tasks.length} 条）`
            : `共 ${tasks.length} 条任务`}
          action={canNext || canPrev ? (
            <div className="row">
              <Button onClick={() => setOffset(Math.max(0, offset - limit))} disabled={!canPrev}><ChevronLeft size={14} /> 上一页</Button>
              <span className="muted-text nowrap">偏移 {offset}</span>
              <Button onClick={() => setOffset(offset + limit)} disabled={!canNext}><ChevronRight size={14} /> 下一页</Button>
            </div>
          ) : undefined}
        >
          <DataState
            empty={visible.length === 0}
            emptyTitle="没有匹配的任务"
            emptyDetail={filtersActive ? '当前筛选条件下没有匹配记录，可调整状态或搜索关键字。' : '任务管理器尚未注册任何任务。'}
            onRetry={state.reload}
          >
            <Table minWidth={980}>
              <thead>
                <tr>
                  <th>任务</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>运行次数</th>
                  <th>错误</th>
                  <th>最近耗时</th>
                  <th>开始 / 结束</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <div className="table-primary">{task.name || '未命名任务'}</div>
                      <small className="muted-text mono truncate-cell" title={task.id}>{task.id}</small>
                      {task.lastErrorCode && <small className="muted-text mono">错误码 {task.lastErrorCode}</small>}
                    </td>
                    <td className="nowrap">{kindLabel(task.kind)}</td>
                    <td><Pill tone={stateTone(task.state)}>{stateLabel(task.state)}</Pill></td>
                    <td className="nowrap">{formatNumber(task.runs)}</td>
                    <td className="nowrap">{task.errors > 0 ? <span className="mono">{formatNumber(task.errors)}</span> : '0'}</td>
                    <td className="nowrap">{formatDuration(task.lastRunMs)}</td>
                    <td className="nowrap">
                      {task.startedAt === undefined ? '—' : <span title={new Date(task.startedAt).toLocaleString()}>{formatRelative(task.startedAt)} 开始</span>}
                      {task.finishedAt === undefined ? null : <> · <span title={new Date(task.finishedAt).toLocaleString()}>{formatRelative(task.finishedAt)} 结束</span></>}
                    </td>
                    <td className="table-actions">
                      {canControl && actionsFor(task).length > 0 ? actionsFor(task).map((action) => (
                        <Button
                          key={action}
                          variant={action === 'run' ? 'primary' : 'secondary'}
                          busy={busy === `${task.id}:${action}`}
                          onClick={() => void mutate(task, action)}
                        >
                          {action === 'pause' && <><Pause size={14} /> 暂停</>}
                          {action === 'resume' && <><Play size={14} /> 恢复</>}
                          {action === 'run' && <><Zap size={14} /> 立即执行</>}
                        </Button>
                      )) : <span className="muted-text">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </DataState>
        </Panel>
      </DataState>
    </>
  );
}
