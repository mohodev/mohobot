<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">服务健康</h1>
      <v-spacer />
      <v-btn variant="tonal" :loading="loading" @click="load">刷新</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>

    <v-row>
      <v-col cols="12" md="6">
        <v-card class="mb-4">
          <v-card-title>运行时状态</v-card-title>
          <v-card-text>
            <v-table v-if="status" density="compact">
              <tbody>
                <tr><td>当前时间</td><td>{{ status.now }}</td></tr>
                <tr><td>Bot 数量</td><td>{{ bots.length }}</td></tr>
                <tr><td>在线</td><td>{{ onlineCount }}</td></tr>
                <tr><td>网关已连接</td><td>{{ connectedCount }}</td></tr>
                <tr><td>会话总数</td><td>{{ totalSessions }}</td></tr>
              </tbody>
            </v-table>
            <p v-else class="text-medium-emphasis">暂无数据。</p>
          </v-card-text>
        </v-card>
        <v-card>
          <v-card-title>依赖健康</v-card-title>
          <v-card-text>
            <pre v-if="health" class="text-body-2" style="white-space: pre-wrap">{{ JSON.stringify(health, null, 2) }}</pre>
            <p v-else class="text-medium-emphasis">暂无数据。</p>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title>运行指标</v-card-title>
          <v-card-text>
            <v-table v-if="scalarMetrics.length" density="compact">
              <tbody>
                <tr v-for="[k, v] in scalarMetrics" :key="k"><td>{{ k }}</td><td>{{ v }}</td></tr>
              </tbody>
            </v-table>
            <p v-else class="text-medium-emphasis">暂无标量指标。</p>
            <pre v-if="structuredMetrics" class="text-body-2 mt-4" style="white-space: pre-wrap">{{ JSON.stringify(structuredMetrics, null, 2) }}</pre>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { mohoApi } from '@/api/moho';

interface BotSnapshot {
  running?: boolean; sessions?: number;
  gateway?: { connected?: boolean; ping?: number };
  [key: string]: unknown;
}

const loading = ref(false);
const error = ref('');
const status = ref<{ now?: string } | null>(null);
const bots = ref<BotSnapshot[]>([]);
const health = ref<unknown>(null);
const metrics = ref<Record<string, unknown>>({});

const onlineCount = computed(() => bots.value.filter((b) => b.running || b.gateway?.connected).length);
const connectedCount = computed(() => bots.value.filter((b) => b.gateway?.connected).length);
const totalSessions = computed(() => bots.value.reduce((s, b) => s + Number(b.sessions ?? 0), 0));
const scalarMetrics = computed(() =>
  Object.entries(metrics.value)
    .filter(([, v]) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')
    .map(([k, v]) => [k, typeof v === 'number' ? v.toLocaleString() : String(v)] as [string, string]),
);
const structuredMetrics = computed(() => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metrics.value)) {
    if (typeof v === 'object' && v !== null) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [s, h, m] = await Promise.all([
      mohoApi.runtimeStatus(),
      mohoApi.runtimeHealth(),
      mohoApi.metricsRead(),
    ]);
    const sd = (s.data ?? {}) as Record<string, unknown>;
    const hd = (h.data ?? {}) as Record<string, unknown>;
    const md = (m.data ?? {}) as Record<string, unknown>;
    status.value = { now: typeof sd.now === 'string' ? sd.now : undefined };
    bots.value = Array.isArray(sd.bots) ? sd.bots : [];
    health.value = hd.health ?? hd;
    metrics.value = (md.metrics as Record<string, unknown>) ?? {};
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取健康数据失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>
