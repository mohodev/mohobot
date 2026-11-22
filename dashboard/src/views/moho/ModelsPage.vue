<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">模型</h1>
      <v-spacer />
      <v-btn variant="tonal" :loading="loading" @click="loadAll">刷新</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>

    <v-row>
      <v-col cols="12" md="6">
        <v-card class="mb-4">
          <v-card-title>模型总览</v-card-title>
          <v-card-text>
            <pre v-if="dashboard" class="text-body-2" style="white-space: pre-wrap">{{ JSON.stringify(dashboard, null, 2) }}</pre>
            <p v-else class="text-medium-emphasis">暂无数据。</p>
          </v-card-text>
        </v-card>
        <v-card>
          <v-card-title>模型健康</v-card-title>
          <v-card-text>
            <pre v-if="health" class="text-body-2" style="white-space: pre-wrap">{{ JSON.stringify(health, null, 2) }}</pre>
            <p v-else class="text-medium-emphasis">暂无数据。</p>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="6">
        <v-card class="mb-4">
          <v-card-title>模型列表</v-card-title>
          <v-data-table :headers="modelHeaders" :items="models" :loading="loading" density="compact" :items-per-page="20">
            <template #item.actions="{ item }">
              <v-btn size="small" variant="text" @click="showProviderHealth(item)">供应商健康</v-btn>
              <v-btn size="small" variant="text" @click="showUsage(item)">用量</v-btn>
            </template>
          </v-data-table>
        </v-card>
        <v-card v-if="detail">
          <v-card-title>{{ detailTitle }}</v-card-title>
          <v-card-text>
            <pre class="text-body-2" style="white-space: pre-wrap">{{ JSON.stringify(detail, null, 2) }}</pre>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { mohoApi } from '@/api/moho';

const loading = ref(false);
const error = ref('');
const models = ref<Record<string, unknown>[]>([]);
const dashboard = ref<unknown>(null);
const health = ref<unknown>(null);
const detail = ref<unknown>(null);
const detailTitle = ref('');

const modelHeaders = [
  { title: 'ID', key: 'id' },
  { title: '名称', key: 'name' },
  { title: '供应商', key: 'provider' },
  { title: '上下文长度', key: 'contextLength' },
  { title: '操作', key: 'actions', sortable: false },
];

async function loadAll() {
  loading.value = true;
  error.value = '';
  try {
    const [m, d, h] = await Promise.all([
      mohoApi.modelsRead(),
      mohoApi.modelsDashboard(),
      mohoApi.modelsHealth(),
    ]);
    const md = (m.data ?? {}) as Record<string, unknown>;
    const dd = (d.data ?? {}) as Record<string, unknown>;
    const hd = (h.data ?? {}) as Record<string, unknown>;
    models.value = Array.isArray(md.models) ? md.models : [];
    dashboard.value = dd.dashboard ?? dd;
    health.value = hd.health ?? hd;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取模型数据失败';
  } finally {
    loading.value = false;
  }
}

async function showProviderHealth(model: Record<string, unknown>) {
  const providerId = String(model.provider ?? model.providerId ?? '');
  if (!providerId) { error.value = '该模型没有供应商信息。'; return; }
  try {
    const res = await mohoApi.modelsProviderHealth({ path: { providerId } });
    const d = (res.data ?? {}) as Record<string, unknown>;
    detail.value = d.health ?? d;
    detailTitle.value = `供应商健康：${providerId}`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取供应商健康失败';
  }
}

async function showUsage(model: Record<string, unknown>) {
  const botId = String(model.botId ?? model.id ?? '');
  if (!botId) { error.value = '无法确定用量查询的 Bot。'; return; }
  try {
    const res = await mohoApi.modelsUsage({ path: { botId } });
    const d = (res.data ?? {}) as Record<string, unknown>;
    detail.value = d.usage ?? d;
    detailTitle.value = `用量：${botId}`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取用量失败';
  }
}

onMounted(loadAll);
</script>
