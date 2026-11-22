<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">日志</h1>
      <v-spacer />
      <v-select v-model="level" :items="levelItems" label="级别" variant="outlined" density="compact" hide-details class="mr-2" style="max-width: 140px" />
      <v-text-field v-model="component" label="组件过滤" variant="outlined" density="compact" hide-details class="mr-2" style="max-width: 180px" />
      <v-switch v-model="autoRefresh" label="自动刷新" color="primary" hide-details class="mr-2" />
      <v-btn variant="tonal" @click="exportLogs">导出 NDJSON</v-btn>
      <v-btn class="ml-2" variant="tonal" :loading="loading" @click="load">刷新</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>

    <v-card>
      <v-card-text>
        <div class="log-list">
          <div v-for="log in logs" :key="logKey(log)" class="log-line">
            <span class="text-medium-emphasis">{{ formatTime(log.ts ?? log.at) }}</span>
            <v-chip size="x-small" :color="levelColor(log.level)" class="mx-2">{{ log.level ?? 'info' }}</v-chip>
            <span v-if="log.component" class="text-medium-emphasis">[{{ log.component }}]</span>
            <span class="ml-2">{{ log.msg ?? log.message ?? '' }}</span>
          </div>
          <p v-if="!logs.length && !loading" class="text-medium-emphasis">暂无日志。</p>
        </div>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { mohoApi } from '@/api/moho';

interface LogRow {
  id?: string | number; ts?: string | number; at?: string; level?: string;
  component?: string; msg?: string; message?: string;
  [key: string]: unknown;
}

const LOG_LIMIT = 200;
const loading = ref(false);
const error = ref('');
const level = ref('');
const component = ref('');
const autoRefresh = ref(true);
const logs = ref<LogRow[]>([]);
const lastTs = ref<number | undefined>(undefined);
let timer: ReturnType<typeof setInterval> | undefined;

const levelItems = [
  { title: '全部', value: '' },
  { title: 'trace', value: 'trace' },
  { title: 'debug', value: 'debug' },
  { title: 'info', value: 'info' },
  { title: 'warn', value: 'warn' },
  { title: 'error', value: 'error' },
  { title: 'fatal', value: 'fatal' },
];

function levelColor(l?: string): string {
  if (l === 'error' || l === 'fatal') return 'error';
  if (l === 'warn') return 'warning';
  if (l === 'debug' || l === 'trace') return 'default';
  return 'info';
}
function formatTime(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n)) return new Date(n < 1e12 ? n * 1000 : n).toLocaleTimeString();
  return typeof v === 'string' ? v : '—';
}
function logKey(log: LogRow): string {
  return String(log.id ?? `${log.ts ?? log.at}-${log.msg ?? log.message ?? ''}`);
}
function toTs(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const query: Record<string, unknown> = { limit: LOG_LIMIT };
    if (level.value) query.level = level.value;
    if (component.value.trim()) query.component = component.value.trim();
    const res = await mohoApi.logsRead({ query: query as never });
    const d = (res.data ?? {}) as Record<string, unknown>;
    const items = Array.isArray(d.logs) ? d.logs as LogRow[] : [];
    logs.value = items;
    const last = items[items.length - 1];
    lastTs.value = last ? toTs(last.ts ?? last.at) : undefined;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取日志失败';
  } finally {
    loading.value = false;
  }
}

async function poll() {
  if (!autoRefresh.value || document.hidden) return;
  try {
    const query: Record<string, unknown> = { limit: LOG_LIMIT };
    if (level.value) query.level = level.value;
    if (component.value.trim()) query.component = component.value.trim();
    if (lastTs.value !== undefined) query.after = lastTs.value;
    const res = await mohoApi.logsRead({ query: query as never });
    const d = (res.data ?? {}) as Record<string, unknown>;
    const items = Array.isArray(d.logs) ? d.logs as LogRow[] : [];
    if (items.length) {
      logs.value = [...logs.value, ...items].slice(-LOG_LIMIT);
      const last = items[items.length - 1];
      lastTs.value = toTs(last.ts ?? last.at) ?? lastTs.value;
    }
  } catch (e) {
    console.error('Failed to poll logs:', e);
  }
}

function exportLogs() {
  const lines = logs.value.map((l) => JSON.stringify(l)).join('\n');
  const blob = new Blob([lines], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mohobot-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.ndjson`;
  a.click();
  URL.revokeObjectURL(url);
}

watch([level, component], () => { lastTs.value = undefined; void load(); });

onMounted(() => {
  void load();
  timer = setInterval(() => { void poll(); }, 5000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.log-list { max-height: calc(100dvh - 220px); overflow-y: auto; font-family: monospace; font-size: 13px; }
.log-line { padding: 2px 0; word-break: break-all; }
</style>
