<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">记忆</h1>
      <v-spacer />
      <v-text-field v-model="botId" label="Bot ID" variant="outlined" density="compact" hide-details class="mr-2" style="max-width: 180px" />
      <v-text-field v-model="userId" label="用户 ID" variant="outlined" density="compact" hide-details class="mr-2" style="max-width: 180px" />
      <v-select v-model="scope" :items="['', 'user', 'channel', 'global']" label="范围" variant="outlined" density="compact" hide-details class="mr-2" style="max-width: 140px" />
      <v-btn variant="tonal" :loading="loading" @click="load">刷新</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-4">{{ notice }}</v-alert>

    <v-card>
      <v-data-table :headers="headers" :items="rows" :loading="loading" density="compact" :items-per-page="20">
        <template #item.updatedAt="{ item }">{{ formatTime(item.updatedAt) }}</template>
        <template #item.actions="{ item }">
          <v-btn size="small" variant="text" @click="showDetail(item)">详情</v-btn>
          <v-btn size="small" variant="text" color="error" @click="remove(item)">删除</v-btn>
        </template>
      </v-data-table>
    </v-card>

    <v-dialog v-model="detailDialog" max-width="640">
      <v-card>
        <v-card-title class="text-h6">记忆详情</v-card-title>
        <v-card-text>
          <pre class="text-body-2" style="white-space: pre-wrap">{{ JSON.stringify(detail, null, 2) }}</pre>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn variant="text" @click="detailDialog = false">关闭</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { confirmed, mohoApi } from '@/api/moho';

interface MemoryRow {
  id?: string; key?: string; botId?: string; userId?: string; channelId?: string;
  scope?: string; kind?: string; summary?: string; updatedAt?: number | string;
  [key: string]: unknown;
}

const loading = ref(false);
const error = ref('');
const notice = ref('');
const detailDialog = ref(false);
const detail = ref<unknown>(null);
const botId = ref('');
const userId = ref('');
const scope = ref('');
const rows = ref<MemoryRow[]>([]);

const headers = [
  { title: 'ID / Key', key: 'id' },
  { title: 'Bot', key: 'botId' },
  { title: '用户', key: 'userId' },
  { title: '范围', key: 'scope' },
  { title: '类型', key: 'kind' },
  { title: '摘要', key: 'summary' },
  { title: '更新时间', key: 'updatedAt' },
  { title: '操作', key: 'actions', sortable: false },
];

function formatTime(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return typeof v === 'string' ? v : '—';
  return new Date(n < 1e12 ? n * 1000 : n).toLocaleString();
}
function rowKey(row: MemoryRow): string {
  return String(row.key ?? row.id ?? '');
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const query: Record<string, unknown> = { limit: 50 };
    if (botId.value.trim()) query.botId = botId.value.trim();
    if (userId.value.trim()) query.userId = userId.value.trim();
    if (scope.value) query.scope = scope.value;
    const res = await mohoApi.memoryList({ query: query as never });
    const d = (res.data ?? {}) as Record<string, unknown>;
    rows.value = Array.isArray(d.memories) ? d.memories : [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取记忆失败';
  } finally {
    loading.value = false;
  }
}

async function showDetail(row: MemoryRow) {
  const key = rowKey(row);
  if (!key) { detail.value = row; detailDialog.value = true; return; }
  try {
    const res = await mohoApi.memoryGet({ path: { memoryKey: key } });
    const d = (res.data ?? {}) as Record<string, unknown>;
    detail.value = d.memory ?? d;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取记忆详情失败';
    return;
  }
  detailDialog.value = true;
}

async function remove(row: MemoryRow) {
  const key = rowKey(row);
  if (!key) return;
  try {
    await confirmed(
      `删除记忆 ${key}`,
      'DELETE',
      `/api/memory/${encodeURIComponent(key)}`,
      {},
      (h) => mohoApi.memoryDelete({ path: { memoryKey: key }, headers: h }),
    );
    notice.value = '记忆已删除。';
    await load();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    error.value = e instanceof Error ? e.message : '删除记忆失败';
  }
}

onMounted(load);
</script>
