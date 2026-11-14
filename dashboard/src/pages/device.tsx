import { useMemo, useState } from 'react';
import { Activity, BatteryCharging, Bell, RefreshCw, Wifi } from 'lucide-react';
import {
  Button,
  DataState,
  Descriptions,
  EmptyState,
  Field,
  Notice,
  PageTitle,
  Panel,
  Pill,
  Select,
  StatCard,
  Switch,
  TextInput,
} from '../components/ui';
import { ApiError, api, body } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { formatNumber, formatPercent, formatRelative } from '../lib/format';
import type { DeviceActivity, DeviceHabits, DeviceState, NetworkState, PageProps } from '../lib/types';

const NETWORKS: NetworkState[] = ['wifi', 'cellular', 'weak', 'offline'];
const SCREENS: Array<'on' | 'off'> = ['on', 'off'];
const ACTIVITIES: DeviceActivity[] = ['idle', 'browsing', 'chatting', 'gaming', 'sleeping', 'charging'];

const NETWORK_LABEL: Record<NetworkState, string> = {
  wifi: 'WiFi',
  cellular: '蜂窝网络',
  weak: '弱网',
  offline: '离线',
};

/**
 * Metric-rail tint for the connection. `StatCard` only accepts success/warning/
 * danger, so a healthy-but-plain connection (cellular) stays untinted rather
 * than being forced into a status colour.
 */
const NETWORK_STAT_TONE: Record<NetworkState, 'success' | 'warning' | 'danger' | undefined> = {
  wifi: 'success',
  cellular: undefined,
  weak: 'warning',
  offline: 'danger',
};

const ACTIVITY_LABEL: Record<DeviceActivity, string> = {
  idle: '空闲',
  browsing: '浏览',
  chatting: '聊天',
  gaming: '游戏',
  sleeping: '睡眠',
  charging: '充电中',
};

const SCREEN_LABEL: Record<'on' | 'off', string> = {
  on: '亮屏',
  off: '息屏',
};

/** Human-readable names for the patch keys, so the change summary reads in Chinese. */
const FIELD_LABEL: Record<string, string> = {
  battery: '电量',
  charging: '充电',
  network: '网络',
  screen: '屏幕',
  doNotDisturb: '勿扰模式',
  activity: '活动',
  notificationCount: '通知数量',
};

/** Editable draft of the fields `parseDevicePatch` accepts. */
interface Draft {
  battery: string;
  charging: boolean;
  network: NetworkState;
  screen: 'on' | 'off';
  doNotDisturb: boolean;
  activity: DeviceActivity;
  notificationCount: string;
}

const EMPTY_DRAFT: Draft = {
  battery: '',
  charging: false,
  network: 'wifi',
  screen: 'on',
  doNotDisturb: false,
  activity: 'idle',
  notificationCount: '',
};

function draftFrom(device: DeviceState): Draft {
  return {
    battery: String(device.battery),
    charging: device.charging,
    network: device.network,
    screen: device.screen,
    doNotDisturb: device.doNotDisturb,
    activity: device.activity,
    notificationCount: String(device.notificationCount),
  };
}

/** Builds a patch containing only the fields the operator actually changed. */
function buildPatch(draft: Draft, device: DeviceState): Partial<DeviceState> {
  const patch: Partial<DeviceState> = {};
  const battery = Number(draft.battery);
  if (draft.battery.trim() !== '' && Number.isFinite(battery) && Math.round(battery) !== device.battery) {
    patch.battery = Math.round(battery);
  }
  if (draft.charging !== device.charging) patch.charging = draft.charging;
  if (draft.network !== device.network) patch.network = draft.network;
  if (draft.screen !== device.screen) patch.screen = draft.screen;
  if (draft.doNotDisturb !== device.doNotDisturb) patch.doNotDisturb = draft.doNotDisturb;
  if (draft.activity !== device.activity) patch.activity = draft.activity;
  const count = Number(draft.notificationCount);
  if (draft.notificationCount.trim() !== '' && Number.isSafeInteger(count) && count !== device.notificationCount) {
    patch.notificationCount = count;
  }
  return patch;
}

function validateDraft(draft: Draft): string {
  if (draft.battery.trim() !== '') {
    const battery = Number(draft.battery);
    if (!Number.isFinite(battery) || battery < 0 || battery > 100) return '电量必须在 0 到 100 之间。';
  }
  if (draft.notificationCount.trim() !== '') {
    const count = Number(draft.notificationCount);
    if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) {
      return '通知数量必须是 0 到 1000000 之间的整数。';
    }
  }
  return '';
}

function meterTone(battery: number): string {
  if (battery <= 15) return 'meter meter-danger';
  if (battery <= 35) return 'meter meter-warning';
  return 'meter';
}

function batteryTone(battery: number): 'success' | 'warning' | 'danger' | undefined {
  if (battery <= 15) return 'danger';
  if (battery <= 35) return 'warning';
  return undefined;
}

/**
 * Mirrors the server's `DeviceStore.shouldDelay()` gate so the console can
 * explain *why* the device is currently holding replies, instead of only
 * showing the raw habit flags.
 */
function delayReasons(device: DeviceState, habits: DeviceHabits): string[] {
  const reasons: string[] = [];
  if (device.doNotDisturb) reasons.push('勿扰模式已开启');
  if (device.network === 'offline') reasons.push('网络离线');
  if (device.charging && !habits.checksPhoneWhileCharging) reasons.push('充电中且不查看手机');
  const ignored = Array.isArray(habits.ignoresNotificationsWhile) ? habits.ignoresNotificationsWhile : [];
  if (ignored.includes(device.activity)) reasons.push(`当前活动“${ACTIVITY_LABEL[device.activity]}”在忽略通知列表内`);
  return reasons;
}

export function Device({ permissions }: PageProps) {
  const { data, error, loading, reload, setData } = useAsync<{ device?: DeviceState }>(
    () => api<{ device?: DeviceState }>('/device'),
    [],
    '读取设备状态失败',
  );
  const device = data?.device;

  // Render-phase derived-state reset: whenever a new device snapshot arrives we
  // rebuild the draft so a reload after a successful transition shows the
  // server's authoritative values.
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [syncedDevice, setSyncedDevice] = useState<DeviceState | undefined>(device);
  if (device !== syncedDevice) {
    setSyncedDevice(device);
    setDraft(device ? draftFrom(device) : EMPTY_DRAFT);
  }

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');

  const canWrite = permissions.includes('device.write');
  const patch = useMemo(() => (device ? buildPatch(draft, device) : {}), [draft, device]);
  const changedFields = Object.keys(patch);
  const habits = device?.habits;
  const reasons = device && habits ? delayReasons(device, habits) : [];

  async function submit(): Promise<void> {
    setFormError('');
    setNotice('');
    if (!device) return;
    const invalid = validateDraft(draft);
    if (invalid) {
      setFormError(invalid);
      return;
    }
    if (changedFields.length === 0) {
      setFormError('没有需要应用的变更，请先修改至少一个字段。');
      return;
    }
    const currentPatch = buildPatch(draft, device);
    setSubmitting(true);
    try {
      const result = await api<{ device?: DeviceState }>('/device/transition', {
        method: 'POST',
        body: body(currentPatch),
      });
      if (result.device) setData({ device: result.device });
      setNotice(`已应用 ${Object.keys(currentPatch).length} 项变更。`);
      reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 0) return;
      setFormError(cause instanceof Error ? cause.message : '设备状态更新失败。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageTitle
        eyebrow="DEVICE STATE"
        title="设备状态"
        description="模拟手机的电池、网络、屏幕与活动状态，并人工触发状态迁移。"
        actions={<Button onClick={reload} busy={loading}><RefreshCw size={14} /> 刷新</Button>}
      />

      {notice && <Notice tone="info">{notice}</Notice>}
      {formError && !device && <Notice tone="danger">{formError}</Notice>}

      <DataState
        loading={loading}
        error={error}
        empty={!device}
        emptyTitle="暂无设备状态"
        emptyDetail="设备状态尚未初始化，稍后重试或触发一次状态迁移。"
        onRetry={reload}
      >
        {device && (
          <>
            {/* Headline rail: the four facts an operator reads first. Numeric and
                label metrics share one joined strip instead of loose cards. */}
            <div className="stat-grid">
              <StatCard
                label="电量"
                value={`${device.battery}%`}
                note={device.charging ? '充电中' : '未充电'}
                tone={batteryTone(device.battery)}
                icon={<BatteryCharging size={15} />}
              />
              <StatCard
                label="网络"
                value={NETWORK_LABEL[device.network]}
                note="连接状态"
                tone={NETWORK_STAT_TONE[device.network]}
                icon={<Wifi size={15} />}
              />
              <StatCard label="活动" value={ACTIVITY_LABEL[device.activity]} note="当前活动" icon={<Activity size={15} />} />
              <StatCard label="未读通知" value={formatNumber(device.notificationCount)} note="待处理通知" icon={<Bell size={15} />} />
            </div>

            <div className="grid-2">
              <Panel title="当前状态" description={`最后活跃：${formatRelative(device.lastSeenAt)}`}>
                <div className="col">
                  <div className={meterTone(device.battery)}>
                    <span style={{ width: `${device.battery}%` }} />
                  </div>
                  <Descriptions
                    columns={2}
                    items={[
                      {
                        label: '充电',
                        value: <Pill tone={device.charging ? 'success' : 'neutral'}>{device.charging ? '充电中' : '未充电'}</Pill>,
                      },
                      { label: '屏幕', value: SCREEN_LABEL[device.screen] },
                      {
                        label: '勿扰模式',
                        value: (
                          <Switch
                            checked={device.doNotDisturb}
                            onChange={() => undefined}
                            disabled
                            label={device.doNotDisturb ? '已开启' : '已关闭'}
                          />
                        ),
                      },
                      ...(habits
                        ? [{
                          label: '延迟回复',
                          value: (
                            <div className="row row-wrap">
                              <Pill tone={reasons.length ? 'warning' : 'success'}>{reasons.length ? '是' : '否'}</Pill>
                              <span className="muted-text">{reasons.length ? reasons.join('；') : '当前不满足任何延迟条件'}</span>
                            </div>
                          ),
                        }]
                        : []),
                    ]}
                  />
                </div>
              </Panel>

              <Panel title="行为习惯" description="设备模拟使用的启发式规则（只读）。">
                {habits ? (
                  <Descriptions
                    columns={1}
                    items={[
                      { label: '充电时查看手机', value: habits.checksPhoneWhileCharging ? '是' : '否' },
                      { label: '低电量阈值', value: `${formatNumber(habits.chargeBelow)}%` },
                      {
                        label: '忽略通知的活动',
                        value: Array.isArray(habits.ignoresNotificationsWhile) && habits.ignoresNotificationsWhile.length > 0
                          ? habits.ignoresNotificationsWhile.map((item) => ACTIVITY_LABEL[item]).join('、')
                          : '无',
                      },
                      { label: '延迟回复概率', value: formatPercent(habits.delayedReplyProbability) },
                    ]}
                  />
                ) : (
                  <EmptyState title="行为习惯数据不可用" detail="服务端响应缺少 habits 字段，暂时无法展示启发式规则。" />
                )}
              </Panel>
            </div>

            <Panel
              title="状态迁移"
              description={canWrite ? `仅提交已修改的字段（当前 ${changedFields.length} 项）。` : '缺少 device.write 权限，只能查看。'}
            >
              {formError && <Notice tone="danger">{formError}</Notice>}
              {!canWrite && <Notice tone="warning">只读：你的账号没有 device.write 权限，无法触发状态迁移。</Notice>}
              {canWrite && (
                <>
                  <div className="form-grid">
                    <Field label="电量（%）" hint="留空表示不修改，范围 0 - 100">
                      <TextInput
                        type="number"
                        min={0}
                        max={100}
                        value={draft.battery}
                        onChange={(event) => setDraft((current) => ({ ...current, battery: event.target.value }))}
                      />
                    </Field>
                    <Field label="通知数量" hint="留空表示不修改，非负整数">
                      <TextInput
                        type="number"
                        min={0}
                        value={draft.notificationCount}
                        onChange={(event) => setDraft((current) => ({ ...current, notificationCount: event.target.value }))}
                      />
                    </Field>
                    <Field label="网络">
                      <Select
                        value={draft.network}
                        onChange={(event) => setDraft((current) => ({ ...current, network: event.target.value as NetworkState }))}
                      >
                        {NETWORKS.map((value) => (
                          <option key={value} value={value}>{NETWORK_LABEL[value]}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="屏幕">
                      <Select
                        value={draft.screen}
                        onChange={(event) => setDraft((current) => ({ ...current, screen: event.target.value as 'on' | 'off' }))}
                      >
                        {SCREENS.map((value) => (
                          <option key={value} value={value}>{SCREEN_LABEL[value]}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="活动" hint="开启充电时服务端会将活动强制为“充电中”">
                      <Select
                        value={draft.activity}
                        onChange={(event) => setDraft((current) => ({ ...current, activity: event.target.value as DeviceActivity }))}
                      >
                        {ACTIVITIES.map((value) => (
                          <option key={value} value={value}>{ACTIVITY_LABEL[value]}</option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <div className="form-inline mt-3">
                    <div className="field">
                      <span className="field-label">充电</span>
                      <Switch
                        checked={draft.charging}
                        onChange={(next) => setDraft((current) => ({ ...current, charging: next }))}
                        label={draft.charging ? '充电中' : '未充电'}
                      />
                    </div>
                    <div className="field">
                      <span className="field-label">勿扰模式</span>
                      <Switch
                        checked={draft.doNotDisturb}
                        onChange={(next) => setDraft((current) => ({ ...current, doNotDisturb: next }))}
                        label={draft.doNotDisturb ? '已开启' : '已关闭'}
                      />
                    </div>
                  </div>
                  <div className="row row-between mt-3">
                    <span className="muted-text">
                      {changedFields.length > 0
                        ? `变更字段：${changedFields.map((field) => FIELD_LABEL[field] ?? field).join('、')}`
                        : '尚未修改任何字段。'}
                    </span>
                    <Button variant="primary" onClick={() => void submit()} busy={submitting} disabled={changedFields.length === 0}>
                      应用变更
                    </Button>
                  </div>
                </>
              )}
            </Panel>
          </>
        )}
      </DataState>
    </>
  );
}
