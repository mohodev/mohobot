import { useMemo, useState } from 'react';
import {
  Activity,
  CalendarPlus,
  Clock,
  CloudSun,
  HeartPulse,
  MapPin,
  Play,
  RefreshCw,
} from 'lucide-react';
import { ApiError, api, body, confirmedRequest } from '../lib/api';
import type { PageProps, ScheduledWorldEvent, WorldState } from '../lib/types';
import { useAsync, useDebouncedValue, useToggle } from '../lib/hooks';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format';
import {
  Button,
  DataState,
  Descriptions,
  Field,
  Modal,
  Notice,
  PageTitle,
  Panel,
  Pill,
  Select,
  StatCard,
  Table,
  TextArea,
  TextInput,
} from '../components/ui';

/* ------------------------------------------------------------------ *
 * Local response shapes (server truth in src/admin/world.ts and
 * src/admin/api-routes/world.ts). Kept page-local so the frozen shared
 * contract stays untouched.
 * ------------------------------------------------------------------ */

interface WorldDomain {
  id: string;
  botId: string;
  channelId?: string;
  strategy: string;
  createdAt: string;
}

interface WorldTraceEntry {
  id: string;
  domainId: string;
  botId: string;
  at: string;
  kind: string;
  phaseKey?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  detail?: string;
}

interface DayPlanItem {
  at: string;
  activity: string;
  location: string;
  reason: string;
  energyCost: number;
}

interface DayPlan {
  date: string;
  items: DayPlanItem[];
  source: string;
}

interface MainData {
  world: WorldState;
  schedule: ScheduledWorldEvent[];
  domains: WorldDomain[];
  plan: DayPlan | undefined;
  failures: string[];
}

type TrustValue = 'candidate' | 'confirmed' | 'rejected';

const TRUST_LABELS: Record<TrustValue, string> = {
  confirmed: '已确认',
  candidate: '候选',
  rejected: '已拒绝',
};

const MOOD_LABELS: Record<string, string> = {
  energy: '能量',
  sociability: '社交',
  curiosity: '好奇',
  stress: '压力',
  happiness: '愉悦',
  fatigue: '疲劳',
};

const WEATHER_LABELS: Record<string, string> = {
  clear: '晴朗',
  sunny: '晴',
  cloudy: '多云',
  overcast: '阴',
  rain: '有雨',
  rainy: '有雨',
  storm: '雷雨',
  thunderstorm: '雷雨',
  snow: '降雪',
  fog: '有雾',
  windy: '有风',
};

const EVENT_TYPES: Array<{ value: string; label: string }> = [
  { value: 'social', label: '社交' },
  { value: 'conflict', label: '冲突' },
  { value: 'rest', label: '休息' },
];

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : '读取失败';
}

function weatherLabel(value: string): string {
  const key = String(value ?? '').toLowerCase();
  return WEATHER_LABELS[key] ?? (value || '未知');
}

function moodLabel(key: string): string {
  return MOOD_LABELS[key] ?? key;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function trustTone(trust: TrustValue): 'success' | 'warning' | 'danger' | 'neutral' {
  if (trust === 'confirmed') return 'success';
  if (trust === 'candidate') return 'warning';
  if (trust === 'rejected') return 'danger';
  return 'neutral';
}

/** Reads the trust from a row, tolerating servers that omit it. */
function trustOf(event: ScheduledWorldEvent): TrustValue {
  const value = event.trust;
  return value === 'confirmed' || value === 'rejected' ? value : 'candidate';
}

/** `at` is the shared-contract field; fall back to the server's `startsAt`. */
function eventAt(event: ScheduledWorldEvent): unknown {
  const row = event as Record<string, unknown>;
  return row.at ?? row.startsAt;
}

function scheduleType(event: ScheduledWorldEvent): string {
  return String(event.type ?? event.kind ?? '—');
}

function scheduleText(event: ScheduledWorldEvent): string {
  return String(event.text ?? event.title ?? '—');
}

function summarize(value: unknown): string {
  if (value === undefined || value === null) return '—';
  try {
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  } catch {
    return String(value);
  }
}

function toInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isoFromInput(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

interface ScheduleForm {
  kind: string;
  title: string;
  location: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  notes: string;
  sourceUrl: string;
}

function defaultForm(): ScheduleForm {
  const start = Date.now() + 60 * 60 * 1000;
  return {
    kind: 'concert',
    title: '',
    location: '',
    timezone: 'Asia/Shanghai',
    startsAt: toInputValue(start),
    endsAt: toInputValue(start + 60 * 60 * 1000),
    notes: '',
    sourceUrl: '',
  };
}

const KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'concert', label: '演出 concert' },
  { value: 'trip', label: '出行 trip' },
  { value: 'rehearsal', label: '排练 rehearsal' },
  { value: 'rest', label: '休息 rest' },
  { value: 'news', label: '情报 news' },
];

async function loadMain(botId: string): Promise<MainData> {
  const query = botId ? `?botId=${encodeURIComponent(botId)}` : '';
  const result = await api<{ world?: WorldState }>(`/world${query}`);
  if (!result.world) throw new ApiError('世界状态响应缺少 world 字段', 500);
  const failures: string[] = [];
  let schedule: ScheduledWorldEvent[] = Array.isArray(result.world.schedule) ? result.world.schedule : [];
  let domains: WorldDomain[] = [];
  let plan: DayPlan | undefined;
  const [scheduleResult, planResult] = await Promise.allSettled([
    api<{ schedule?: ScheduledWorldEvent[]; domains?: WorldDomain[] }>(`/world/schedule${query}`),
    api<{ plan?: DayPlan }>(`/world/day-plan${query}`),
  ]);
  if (scheduleResult.status === 'fulfilled') {
    if (Array.isArray(scheduleResult.value.schedule)) schedule = scheduleResult.value.schedule;
    domains = Array.isArray(scheduleResult.value.domains) ? scheduleResult.value.domains : [];
  } else {
    failures.push(`计划日程：${messageOf(scheduleResult.reason)}`);
  }
  if (planResult.status === 'fulfilled') {
    plan = planResult.value.plan;
  } else {
    failures.push(`日程计划：${messageOf(planResult.reason)}`);
  }
  return { world: result.world, schedule, domains, plan, failures };
}

async function loadTrace(botId: string, domainId: string, limit: number): Promise<WorldTraceEntry[]> {
  const params = new URLSearchParams();
  if (botId) params.set('botId', botId);
  if (domainId) params.set('domainId', domainId);
  params.set('limit', String(limit));
  const result = await api<{ traces?: WorldTraceEntry[] }>(`/world/trace?${params.toString()}`);
  return Array.isArray(result.traces) ? result.traces : [];
}

export function World({ permissions }: PageProps) {
  const canWrite = permissions.includes('world.write');
  const canConfirm = permissions.includes('world.confirm');

  const [botIdDraft, setBotIdDraft] = useState('');
  const [domainDraft, setDomainDraft] = useState('');
  const [limit, setLimit] = useState(50);
  const botId = useDebouncedValue(botIdDraft.trim(), 350);
  const domainId = useDebouncedValue(domainDraft.trim(), 350);

  const main = useAsync(() => loadMain(botId), [botId], '读取世界状态失败');
  const trace = useAsync(() => loadTrace(botId, domainId, limit), [botId, domainId, limit], '读取世界轨迹失败');

  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ tone: 'info' | 'warning' | 'danger'; text: string } | undefined>();
  const [scheduleOpen, toggleSchedule] = useToggle(false);
  const [eventOpen, toggleEvent] = useToggle(false);

  const [form, setForm] = useState<ScheduleForm>(defaultForm);
  const [formError, setFormError] = useState('');
  const [atInput, setAtInput] = useState('');
  const [dryRun, setDryRun] = useState<WorldState | undefined>();
  const [eventType, setEventType] = useState('social');
  const [eventText, setEventText] = useState('');

  const data = main.data;
  const schedule = data?.schedule ?? [];
  const events = data?.world.events ?? [];

  const sortedSchedule = useMemo(
    () => [...schedule].sort((a, b) => Date.parse(String(eventAt(a))) - Date.parse(String(eventAt(b)))),
    [schedule],
  );

  async function run(key: string, action: () => Promise<unknown>, success: string): Promise<void> {
    setBusy(key);
    setNotice(undefined);
    try {
      await action();
      setNotice({ tone: 'info', text: success });
      main.reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 0) return; // user cancelled the confirmation
      setNotice({ tone: 'danger', text: messageOf(cause) });
    } finally {
      setBusy('');
    }
  }

  function openSchedule(): void {
    setForm(defaultForm());
    setFormError('');
    setDryRun(undefined);
    setAtInput('');
    toggleSchedule(true);
  }

  function openEvent(): void {
    setEventType('social');
    setEventText('');
    toggleEvent(true);
  }

  function buildPayload(): Record<string, unknown> | undefined {
    const startsAt = isoFromInput(form.startsAt);
    const endsAt = isoFromInput(form.endsAt);
    if (!form.kind) { setFormError('请选择日程类型。'); return undefined; }
    if (!form.title.trim()) { setFormError('请填写日程标题。'); return undefined; }
    if (!form.location.trim()) { setFormError('请填写日程地点。'); return undefined; }
    if (!startsAt || !endsAt) { setFormError('请填写有效的开始与结束时间。'); return undefined; }
    if (Date.parse(endsAt) <= Date.parse(startsAt)) { setFormError('结束时间必须晚于开始时间。'); return undefined; }
    const payload: Record<string, unknown> = {
      kind: form.kind,
      title: form.title.trim(),
      location: form.location.trim(),
      startsAt,
      endsAt,
    };
    if (form.timezone.trim()) payload.timezone = form.timezone.trim();
    if (form.notes.trim()) payload.notes = form.notes.trim();
    if (form.sourceUrl.trim()) payload.sourceUrl = form.sourceUrl.trim();
    return payload;
  }

  function submitSchedule(): void {
    const payload = buildPayload();
    if (!payload) return;
    void run('schedule', async () => {
      await api('/world/schedule', { method: 'POST', body: body(payload) });
      toggleSchedule(false);
    }, '已创建候选日程，等待确认。');
  }

  function runDryRun(): void {
    const payload = buildPayload();
    if (!payload) return;
    const at = isoFromInput(atInput);
    setBusy('dry-run');
    setFormError('');
    setDryRun(undefined);
    api<{ world?: WorldState }>('/world/schedule/dry-run', {
      method: 'POST',
      body: body(at ? { ...payload, at: Date.parse(at) } : payload),
    })
      .then((result) => {
        if (result.world) setDryRun(result.world);
        else setFormError('预演响应缺少 world 字段。');
      })
      .catch((cause: unknown) => setFormError(messageOf(cause)))
      .finally(() => setBusy(''));
  }

  function submitEvent(): void {
    if (!eventText.trim()) {
      setNotice({ tone: 'danger', text: '请填写事件内容。' });
      return;
    }
    void run('event', async () => {
      await api('/world/events', { method: 'POST', body: body({ type: eventType, text: eventText.trim() }) });
      toggleEvent(false);
      setEventText('');
    }, '已写入世界事件。');
  }

  function setTrust(event: ScheduledWorldEvent, trust: TrustValue): void {
    void run(
      `trust:${event.id}:${trust}`,
      () => confirmedRequest(
        `/world/schedule/${encodeURIComponent(event.id)}/trust`,
        { method: 'POST', body: body({ trust }) },
        { trust },
        `调整日程信任状态为“${TRUST_LABELS[trust]}”`,
      ),
      `已将日程标记为${TRUST_LABELS[trust]}。`,
    );
  }

  function tick(): void {
    void run('tick', () => api('/world/tick', { method: 'POST' }), '已推进世界时间。');
  }

  const tracedRows = trace.data ?? [];

  return (
    <>
      <PageTitle
        eyebrow="WORLD SIMULATION"
        title="世界模拟"
        description="只读查看角色的沉浸式世界状态、计划日程与演化轨迹；写入操作需要相应权限。"
        actions={<>
          <TextInput
            value={botIdDraft}
            onChange={(event) => setBotIdDraft(event.target.value)}
            placeholder="botId（默认实例）"
            aria-label="botId"
            style={{ width: 180 }}
          />
          <Button onClick={() => main.reload()} busy={main.loading}><RefreshCw size={15} /> 刷新</Button>
          {canWrite && <Button onClick={openEvent}>写入事件</Button>}
          {canWrite && <Button variant="primary" onClick={tick} busy={busy === 'tick'}><Play size={15} /> 推进 Tick</Button>}
        </>}
      />

      {notice && <Notice tone={notice.tone} icon={<HeartPulse size={17} />}>{notice.text}</Notice>}
      {data && data.failures.length > 0 && (
        <Notice tone="warning" icon={<HeartPulse size={17} />}>部分数据源不可用：{data.failures.join('；')}</Notice>
      )}
      {!canWrite && <Notice tone="info">当前账号为只读，缺少 world.write 权限，无法修改世界状态。</Notice>}

      <DataState loading={main.loading && !data} error={main.error} onRetry={main.reload}>
        {data && (
          <>
            <div className="stat-grid">
              <StatCard label="世界时钟" value={formatDateTime(data.world.clock)} note={formatRelative(data.world.clock)} icon={<Clock size={17} />} />
              <StatCard label="天气" value={weatherLabel(data.world.weather)} note={data.world.weather} icon={<CloudSun size={17} />} />
              <StatCard label="地点" value={data.world.location || '—'} note="沉浸式模拟地点" icon={<MapPin size={17} />} />
              <StatCard label="当前活动" value={data.world.activity || '—'} note={`${formatNumber(events.length)} 条最近事件`} icon={<Activity size={17} />} />
            </div>

            <div className="detail-split">
              <Panel title="情绪状态" description={`${formatNumber(Object.keys(data.world.mood).length)} 项指标（0–1）`}>
                <div className="col">
                  {Object.entries(data.world.mood).map(([key, value]) => (
                    <div className="row" key={key}>
                      <span className="nowrap" style={{ width: 64 }}>{moodLabel(key)}</span>
                      <div className={`meter grow${key === 'stress' && value > 0.6 ? ' meter-danger' : ''}`}>
                        <span style={{ width: `${Math.round(clamp01(value) * 100)}%` }} />
                      </div>
                      <span className="mono nowrap">{formatNumber(value, 2)}</span>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title="最近事件" description={`${formatNumber(events.length)} 条`}>
                <DataState empty={events.length === 0} emptyTitle="暂无世界事件" emptyDetail="推进 Tick 或写入事件后会出现。">
                  <div className="timeline">
                    {events.slice(0, 20).map((event) => (
                      <div className="timeline-item" key={event.id}>
                        <span className="timeline-marker" />
                        <div className="grow">
                          <div className="row row-between">
                            <strong>{event.type}</strong>
                            <small className="muted-text">{formatDateTime(event.at)}</small>
                          </div>
                          <p className="prewrap">{event.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </DataState>
              </Panel>
            </div>

            <Panel
              title="计划日程"
              description={`${formatNumber(schedule.length)} 条 · ${formatNumber(data.domains.length)} 个世界域`}
              action={canWrite
                ? <Button onClick={openSchedule}><CalendarPlus size={15} /> 新建日程</Button>
                : <span className="muted-text">只读</span>}
            >
              <DataState empty={sortedSchedule.length === 0} emptyTitle="暂无计划日程" emptyDetail="尚未创建任何世界日程。">
                <Table minWidth={860}>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>时间</th>
                      <th>类型</th>
                      <th>内容</th>
                      <th>信任</th>
                      <th className="nowrap">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSchedule.map((event) => {
                      const trust = trustOf(event);
                      return (
                        <tr key={event.id}>
                          <td><span className="mono truncate-cell" title={event.id}>{event.id}</span></td>
                          <td className="nowrap">{formatDateTime(eventAt(event))}</td>
                          <td>{scheduleType(event)}</td>
                          <td className="truncate-cell" title={scheduleText(event)}>{scheduleText(event)}</td>
                          <td><Pill tone={trustTone(trust)}>{TRUST_LABELS[trust]}</Pill></td>
                          <td>
                            {canConfirm ? (
                              <div className="table-actions">
                                <Button
                                  variant="ghost"
                                  disabled={trust === 'confirmed'}
                                  busy={busy === `trust:${event.id}:confirmed`}
                                  onClick={() => setTrust(event, 'confirmed')}
                                >确认</Button>
                                <Button
                                  variant="ghost"
                                  disabled={trust === 'candidate'}
                                  busy={busy === `trust:${event.id}:candidate`}
                                  onClick={() => setTrust(event, 'candidate')}
                                >候选</Button>
                                <Button
                                  variant="ghost"
                                  disabled={trust === 'rejected'}
                                  busy={busy === `trust:${event.id}:rejected`}
                                  onClick={() => setTrust(event, 'rejected')}
                                >拒绝</Button>
                              </div>
                            ) : <span className="muted-text">只读</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </DataState>
            </Panel>

            <div className="grid-2">
              <Panel
                title="当日计划"
                description={data.plan ? `规则/模型来源：${data.plan.source}` : '尚未生成'}
              >
                <DataState empty={!data.plan || data.plan.items.length === 0} emptyTitle="暂无当日计划" emptyDetail="日计划由服务端规则或模型生成。">
                  {data.plan && (
                    <>
                      <Descriptions columns={2} items={[
                        { label: '日期', value: data.plan.date },
                        { label: '来源', value: <Pill tone={data.plan.source === 'model' ? 'info' : 'neutral'}>{data.plan.source}</Pill> },
                      ]} />
                      <Table minWidth={640}>
                        <thead><tr><th>时间</th><th>活动</th><th>地点</th><th>理由</th><th>能量</th></tr></thead>
                        <tbody>
                          {data.plan.items.map((item, index) => (
                            <tr key={`${item.at}:${index}`}>
                              <td className="nowrap">{item.at}</td>
                              <td>{item.activity}</td>
                              <td>{item.location}</td>
                              <td className="truncate-cell" title={item.reason}>{item.reason}</td>
                              <td className="mono">{formatNumber(item.energyCost, 2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </>
                  )}
                </DataState>
              </Panel>

              <Panel title="世界轨迹" description={`${formatNumber(tracedRows.length)} 条 trace`}>
                <div className="filter-row">
                  <TextInput
                    value={domainDraft}
                    onChange={(event) => setDomainDraft(event.target.value)}
                    placeholder="domainId 过滤"
                    aria-label="domainId"
                  />
                  <Select
                    value={String(limit)}
                    onChange={(event) => setLimit(Number(event.target.value))}
                    aria-label="limit"
                  >
                    {[20, 50, 100, 200].map((value) => <option key={value} value={value}>{`最近 ${value} 条`}</option>)}
                  </Select>
                  <Button onClick={() => trace.reload()} busy={trace.loading}>刷新</Button>
                </div>
                <DataState
                  loading={trace.loading && !trace.data}
                  error={trace.error}
                  empty={tracedRows.length === 0}
                  emptyTitle="暂无轨迹"
                  emptyDetail="Tick、日程确认与演化会写入轨迹。"
                  onRetry={() => trace.reload()}
                >
                  <Table minWidth={720}>
                    <thead><tr><th>时间</th><th>类型</th><th>Bot</th><th>域</th><th>变更</th><th>说明</th></tr></thead>
                    <tbody>
                      {tracedRows.map((entry) => (
                        <tr key={entry.id}>
                          <td className="nowrap">{formatDateTime(entry.at)}</td>
                          <td><Pill tone="info">{entry.kind}</Pill></td>
                          <td className="mono">{entry.botId}</td>
                          <td className="mono truncate-cell" title={entry.domainId}>{entry.domainId}</td>
                          <td className="mono truncate-cell" title={summarize(entry.before)}>{summarize(entry.before)} → {summarize(entry.after)}</td>
                          <td className="truncate-cell" title={entry.detail ?? ''}>{entry.detail ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </DataState>
              </Panel>
            </div>
          </>
        )}
      </DataState>

      <Modal
        open={scheduleOpen}
        onClose={() => toggleSchedule(false)}
        title="新建世界日程"
        description="提交后以候选（candidate）状态写入，需 world.write 权限；预演为只读。"
        width={720}
        footer={<>
          <Button onClick={() => toggleSchedule(false)}>取消</Button>
          <Button onClick={runDryRun} busy={busy === 'dry-run'}><Play size={15} /> 预演</Button>
          {canWrite
            ? <Button variant="primary" onClick={submitSchedule} busy={busy === 'schedule'}>创建候选日程</Button>
            : <span className="muted-text">只读：缺少 world.write 权限</span>}
        </>}
      >
        <div className="form-grid">
          <Field label="类型">
            <Select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
              {KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </Field>
          <Field label="标题">
            <TextInput value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="例如：周末线上演出" />
          </Field>
          <Field label="开始时间">
            <TextInput type="datetime-local" value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} />
          </Field>
          <Field label="结束时间">
            <TextInput type="datetime-local" value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} />
          </Field>
          <Field label="地点">
            <TextInput value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} placeholder="例如：上海" />
          </Field>
          <Field label="时区" hint="留空使用默认 Asia/Shanghai">
            <TextInput value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} />
          </Field>
          <Field label="来源链接" hint="可选，仅 http/https">
            <TextInput value={form.sourceUrl} onChange={(event) => setForm({ ...form, sourceUrl: event.target.value })} />
          </Field>
          <Field label="预演时刻" hint="可选，指定后按该时间点推演">
            <TextInput type="datetime-local" value={atInput} onChange={(event) => setAtInput(event.target.value)} />
          </Field>
        </div>
        <Field label="备注">
          <TextArea rows={2} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
        </Field>
        {formError && <p className="inline-error">{formError}</p>}
        {dryRun && (
          <Panel title="预演结果（下一状态）" description="服务端 dry-run 返回的快照，未持久化。">
            <Descriptions columns={2} items={[
              { label: '时钟', value: formatDateTime(dryRun.clock) },
              { label: '天气', value: weatherLabel(dryRun.weather) },
              { label: '地点', value: dryRun.location || '—' },
              { label: '活动', value: dryRun.activity || '—' },
              { label: '情绪', value: Object.entries(dryRun.mood).map(([key, value]) => `${moodLabel(key)} ${formatNumber(value, 2)}`).join('，') || '—' },
              { label: '日程条目', value: formatNumber(dryRun.schedule.length) },
            ]} />
          </Panel>
        )}
      </Modal>

      <Modal
        open={eventOpen}
        onClose={() => toggleEvent(false)}
        title="写入世界事件"
        description="直接向世界状态追加一条事件，需要 world.write 权限。"
        footer={<>
          <Button onClick={() => toggleEvent(false)}>取消</Button>
          {canWrite
            ? <Button variant="primary" onClick={submitEvent} busy={busy === 'event'}>写入事件</Button>
            : <span className="muted-text">只读：缺少 world.write 权限</span>}
        </>}
      >
        <Field label="类型">
          <Select value={eventType} onChange={(event) => setEventType(event.target.value)}>
            {EVENT_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </Field>
        <Field label="内容">
          <TextArea rows={3} value={eventText} onChange={(event) => setEventText(event.target.value)} placeholder="描述发生了什么" />
        </Field>
      </Modal>
    </>
  );
}
