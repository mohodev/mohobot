<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">模型提供商</h1>
      <v-spacer />
      <v-text-field v-model="search" label="搜索" variant="outlined" density="compact" hide-details class="mr-2" style="max-width: 240px" prepend-inner-icon="mdi-magnify" />
      <v-select v-model="keyFilter" :items="keyFilterItems" label="密钥" variant="outlined" density="compact" hide-details class="mr-2" style="max-width: 140px" />
      <v-select v-model="probeFilter" :items="probeFilterItems" label="探测" variant="outlined" density="compact" hide-details class="mr-2" style="max-width: 140px" />
      <v-btn variant="tonal" :loading="loading" @click="load">刷新</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert type="info" variant="tonal" class="mb-4">
      MohoBot 的供应商配置来自后端配置文件（config），本页仅展示与探测；新增 / 修改 / 启用 / 删除供应商请通过配置文件完成。
    </v-alert>

    <v-row class="mb-4">
      <v-col v-for="stat in stats" :key="stat.label" cols="6" md="3">
        <v-card><v-card-text>
          <div class="text-caption text-medium-emphasis">{{ stat.label }}</div>
          <div class="text-h5">{{ stat.value }}</div>
        </v-card-text></v-card>
      </v-col>
    </v-row>

    <v-card>
      <v-data-table :headers="headers" :items="filtered" :loading="loading" density="compact" :items-per-page="20">
        <template #item.apiKeyConfigured="{ item }">
          <v-chip size="small" :color="item.apiKeyConfigured ? 'success' : 'warning'">
            {{ item.apiKeyConfigured ? '已配置' : '未配置' }}
          </v-chip>
        </template>
        <template #item.probe="{ item }">
          <v-chip v-if="probeState(item).label" size="small" :color="probeState(item).color">{{ probeState(item).label }}</v-chip>
          <span v-else class="text-medium-emphasis">未探测</span>
        </template>
        <template #item.actions="{ item }">
          <v-btn size="small" variant="text" :loading="probing[item.botId]" @click="probe(item)">探测</v-btn>
          <v-btn size="small" variant="text" @click="showRoutes(item)">任务路由</v-btn>
        </template>
      </v-data-table>
    </v-card>

    <v-dialog v-model="routesDialog" max-width="640">
      <v-card>
        <v-card-title class="text-h6">任务路由：{{ routesTarget?.botId }}</v-card-title>
        <v-card-text>
          <v-table v-if="routeEntries.length" density="compact">
            <tbody>
              <tr v-for="[task, value] in routeEntries" :key="task"><td>{{ task }}</td><td>{{ value }}</td></tr>
            </tbody>
          </v-table>
          <p v-else class="text-medium-emphasis">无任务路由。</p>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn variant="text" @click="routesDialog = false">关闭</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { mohoApi } from '@/api/moho';

interface ProviderRecord {
  botId: string; provider: string; model: string;
  baseUrlConfigured?: boolean; apiKeyConfigured?: boolean;
  taskRoutes?: Record<string, string>;
  [key: string]: unknown;
}
interface ProbeEntry { pending: boolean; probe?: { ok: boolean; detail?: string }; error?: string }

const loading = ref(false);
const error = ref('');
const search = ref('');
const keyFilter = ref('all');
const probeFilter = ref('all');
const routesDialog = ref(false);
const routesTarget = ref<ProviderRecord | null>(null);
const providers = ref<ProviderRecord[]>([]);
const probes = reactive<Record<string, ProbeEntry>>({});
const probing = reactive<Record<string, boolean>>({});

const headers = [
  { title: 'Bot', key: 'botId' },
  { title: '供应商', key: 'provider' },
  { title: '模型', key: 'model' },
  { title: 'Base URL', key: 'baseUrlConfigured' },
  { title: 'API Key', key: 'apiKeyConfigured' },
  { title: '探测', key: 'probe', sortable: false },
  { title: '操作', key: 'actions', sortable: false },
];
const keyFilterItems = [
  { title: '全部', value: 'all' },
  { title: '已配置密钥', value: 'configured' },
  { title: '未配置密钥', value: 'missing' },
];
const probeFilterItems = [
  { title: '全部', value: 'all' },
  { title: '探测通过', value: 'ok' },
  { title: '探测失败', value: 'failed' },
  { title: '未探测', value: 'untested' },
];

const stats = computed(() => [
  { label: '供应商', value: providers.value.length },
  { label: '已配置密钥', value: providers.value.filter((p) => p.apiKeyConfigured).length },
  { label: '探测通过', value: Object.values(probes).filter((p) => p.probe?.ok).length },
  { label: '探测失败', value: Object.values(probes).filter((p) => p.probe && !p.probe.ok).length },
]);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return providers.value.filter((p) => {
    if (keyFilter.value === 'configured' && !p.apiKeyConfigured) return false;
    if (keyFilter.value === 'missing' && p.apiKeyConfigured) return false;
    const ps = probeStatus(probes[p.botId]);
    if (probeFilter.value === 'ok' && ps !== 'ok') return false;
    if (probeFilter.value === 'failed' && ps !== 'failed' && ps !== 'error') return false;
    if (probeFilter.value === 'untested' && ps !== 'idle') return false;
    if (!q) return true;
    return [p.botId, p.provider, p.model, ...Object.keys(p.taskRoutes ?? {})]
      .join(' ').toLowerCase().includes(q);
  });
});
const routeEntries = computed((): Array<[string, string]> => {
  const routes = routesTarget.value?.taskRoutes;
  if (!routes || typeof routes !== 'object') return [];
  return Object.entries(routes).map(([task, value]) => [task, routeLabel(value)]);
});

function routeLabel(value: unknown): string {
  if (typeof value === 'string') return value || '—';
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('，') || '—';
  }
  return value == null ? '—' : String(value);
}
function probeStatus(entry?: ProbeEntry): string {
  if (!entry) return 'idle';
  if (entry.pending) return 'pending';
  if (entry.error) return 'error';
  if (entry.probe) return entry.probe.ok ? 'ok' : 'failed';
  return 'idle';
}
function probeState(item: ProviderRecord): { label: string; color: string } {
  const s = probeStatus(probes[item.botId]);
  if (s === 'pending') return { label: '探测中', color: 'info' };
  if (s === 'ok') return { label: '通过', color: 'success' };
  if (s === 'failed') return { label: '失败', color: 'error' };
  if (s === 'error') return { label: '出错', color: 'error' };
  return { label: '', color: '' };
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await mohoApi.providersList();
    const d = (res.data ?? {}) as Record<string, unknown>;
    providers.value = Array.isArray(d.providers) ? d.providers : [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取模型供应商失败';
  } finally {
    loading.value = false;
  }
}

async function probe(item: ProviderRecord) {
  probes[item.botId] = { pending: true };
  probing[item.botId] = true;
  try {
    const res = await mohoApi.providersProbe({ path: { providerId: item.botId } });
    const d = (res.data ?? {}) as Record<string, unknown>;
    const probe = (d.probe ?? d) as { ok?: boolean; detail?: string };
    probes[item.botId] = { pending: false, probe: { ok: Boolean(probe.ok), detail: typeof probe.detail === 'string' ? probe.detail : undefined } };
  } catch (e) {
    probes[item.botId] = { pending: false, error: e instanceof Error ? e.message : '探测失败' };
  } finally {
    probing[item.botId] = false;
  }
}

function showRoutes(item: ProviderRecord) {
  routesTarget.value = item;
  routesDialog.value = true;
}

onMounted(load);
</script>
