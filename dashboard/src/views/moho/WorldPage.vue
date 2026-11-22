<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">世界</h1>
      <v-spacer />
      <v-btn variant="tonal" :loading="loading" @click="load">刷新</v-btn>
      <v-btn class="ml-2" color="primary" variant="tonal" :loading="busy === 'tick'" @click="tick">推进时间</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-4">{{ notice }}</v-alert>

    <v-row>
      <v-col cols="12" md="6">
        <v-card class="mb-4">
          <v-card-title>当前状态</v-card-title>
          <v-card-text>
            <v-table v-if="world" density="compact">
              <tbody>
                <tr><td>时间</td><td>{{ world.clock }}</td></tr>
                <tr><td>天气</td><td>{{ world.weather }}</td></tr>
                <tr><td>地点</td><td>{{ world.location }}</td></tr>
                <tr><td>活动</td><td>{{ world.activity }}</td></tr>
                <tr><td>心情</td><td>{{ moodText }}</td></tr>
                <tr><td>已应用阶段</td><td>{{ (world.appliedPhases || []).join('、') || '—' }}</td></tr>
              </tbody>
            </v-table>
            <p v-else class="text-medium-emphasis">暂无世界状态。</p>
          </v-card-text>
        </v-card>
        <v-card>
          <v-card-title>今日计划</v-card-title>
          <v-card-text>
            <pre v-if="plan" class="text-body-2" style="white-space: pre-wrap">{{ JSON.stringify(plan, null, 2) }}</pre>
            <p v-else class="text-medium-emphasis">暂无今日计划。</p>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="6">
        <v-card class="mb-4">
          <v-card-title>写入事件</v-card-title>
          <v-card-text>
            <v-select v-model="eventType" :items="['note', 'event', 'system']" label="类型" variant="outlined" density="compact" />
            <v-text-field v-model="eventText" label="事件内容" variant="outlined" density="compact" />
            <v-btn color="primary" :loading="busy === 'event'" :disabled="!eventText.trim()" @click="submitEvent">写入事件</v-btn>
          </v-card-text>
        </v-card>
        <v-card>
          <v-card-title>日程</v-card-title>
          <v-data-table :headers="scheduleHeaders" :items="schedule" density="compact" :items-per-page="10">
            <template #item.at="{ item }">{{ formatTime(item.at) }}</template>
            <template #item.trust="{ item }">
              <v-chip size="small" :color="item.trust === 'confirmed' ? 'success' : item.trust === 'rejected' ? 'error' : 'warning'">
                {{ trustLabel(item.trust) }}
              </v-chip>
            </template>
            <template #item.actions="{ item }">
              <v-btn size="small" variant="text" :disabled="item.trust === 'confirmed'" @click="setTrust(item, 'confirmed')">确认</v-btn>
              <v-btn size="small" variant="text" :disabled="item.trust === 'rejected'" @click="setTrust(item, 'rejected')">拒绝</v-btn>
            </template>
          </v-data-table>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { confirmed, mohoApi } from '@/api/moho';

interface WorldState {
  clock?: string; weather?: string; location?: string; activity?: string;
  mood?: Record<string, number>; appliedPhases?: string[];
}
interface ScheduledEvent {
  id: string; at: number; type: string; text?: string;
  trust?: 'candidate' | 'confirmed' | 'rejected';
}

const loading = ref(false);
const busy = ref('');
const error = ref('');
const notice = ref('');
const world = ref<WorldState | null>(null);
const plan = ref<unknown>(null);
const schedule = ref<ScheduledEvent[]>([]);
const eventType = ref('note');
const eventText = ref('');

const scheduleHeaders = [
  { title: '时间', key: 'at' },
  { title: '类型', key: 'type' },
  { title: '内容', key: 'text' },
  { title: '信任', key: 'trust' },
  { title: '操作', key: 'actions', sortable: false },
];

const moodText = computed(() => {
  const mood = world.value?.mood;
  if (!mood) return '—';
  return Object.entries(mood).map(([k, v]) => `${k} ${v}`).join('、');
});

function formatTime(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value ?? '—');
  return new Date(n < 1e12 ? n * 1000 : n).toLocaleString();
}
function trustLabel(trust?: string): string {
  if (trust === 'confirmed') return '已确认';
  if (trust === 'rejected') return '已拒绝';
  return '候选';
}
function fail(e: unknown, fallback: string) {
  error.value = e instanceof Error ? e.message : fallback;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [w, p, s] = await Promise.all([
      mohoApi.worldRead(),
      mohoApi.worldReadDayPlan(),
      mohoApi.worldScheduleRead(),
    ]);
    const wd = (w.data ?? {}) as Record<string, unknown>;
    const pd = (p.data ?? {}) as Record<string, unknown>;
    const sd = (s.data ?? {}) as Record<string, unknown>;
    world.value = (wd.world ?? null) as WorldState | null;
    plan.value = pd.plan ?? null;
    schedule.value = Array.isArray(sd.schedule) ? sd.schedule : [];
  } catch (e) {
    fail(e, '读取世界状态失败');
  } finally {
    loading.value = false;
  }
}

async function tick() {
  busy.value = 'tick';
  error.value = '';
  try {
    await mohoApi.worldWriteTick({ body: {} });
    notice.value = '已推进世界时间。';
    await load();
  } catch (e) {
    fail(e, '推进时间失败');
  } finally {
    busy.value = '';
  }
}

async function submitEvent() {
  busy.value = 'event';
  error.value = '';
  const payload = { type: eventType.value, text: eventText.value.trim() };
  try {
    await mohoApi.worldWriteEvents({ body: payload });
    notice.value = '已写入世界事件。';
    eventText.value = '';
    await load();
  } catch (e) {
    fail(e, '写入事件失败');
  } finally {
    busy.value = '';
  }
}

async function setTrust(event: ScheduledEvent, trust: 'confirmed' | 'rejected') {
  busy.value = `trust:${event.id}`;
  error.value = '';
  const label = trust === 'confirmed' ? '已确认' : '已拒绝';
  try {
    await confirmed(
      `调整日程信任状态为“${label}”`,
      'POST',
      `/world/schedule/${encodeURIComponent(event.id)}/trust`,
      { trust },
      (headers) => mohoApi.worldScheduleConfirm({ path: { scheduleId: event.id }, body: { trust }, headers }),
    );
    notice.value = `已将日程标记为${label}。`;
    await load();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    fail(e, '调整信任状态失败');
  } finally {
    busy.value = '';
  }
}

onMounted(load);
</script>
