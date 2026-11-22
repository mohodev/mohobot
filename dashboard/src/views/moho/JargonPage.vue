<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">黑话</h1>
      <v-spacer />
      <v-btn variant="tonal" :loading="loading" @click="load">刷新</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-4">{{ notice }}</v-alert>

    <v-card>
      <v-data-table :headers="headers" :items="rows" :loading="loading" density="compact" :items-per-page="20">
        <template #item.status="{ item }">
          <v-chip size="small" :color="item.status === 'approved' ? 'success' : item.status === 'rejected' ? 'error' : 'warning'">
            {{ statusLabel(item.status) }}
          </v-chip>
        </template>
        <template #item.actions="{ item }">
          <v-btn size="small" variant="text" color="success" :disabled="item.status === 'approved'" @click="review(item, 'approved')">通过</v-btn>
          <v-btn size="small" variant="text" color="error" :disabled="item.status === 'rejected'" @click="review(item, 'rejected')">拒绝</v-btn>
        </template>
      </v-data-table>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { confirmed, mohoApi } from '@/api/moho';

interface JargonRow {
  id?: string; term?: string; meaning?: string; status?: string;
  botId?: string; userId?: string; updatedAt?: number | string;
  [key: string]: unknown;
}

const loading = ref(false);
const error = ref('');
const notice = ref('');
const rows = ref<JargonRow[]>([]);

const headers = [
  { title: '黑话', key: 'term' },
  { title: '含义', key: 'meaning' },
  { title: '状态', key: 'status' },
  { title: 'Bot', key: 'botId' },
  { title: '提交用户', key: 'userId' },
  { title: '操作', key: 'actions', sortable: false },
];

function statusLabel(s?: string): string {
  if (s === 'approved') return '已通过';
  if (s === 'rejected') return '已拒绝';
  return '待审核';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await mohoApi.jargonList();
    const d = (res.data ?? {}) as Record<string, unknown>;
    rows.value = Array.isArray(d.entries) ? d.entries : [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取黑话失败';
  } finally {
    loading.value = false;
  }
}

async function review(row: JargonRow, status: 'approved' | 'rejected') {
  const id = String(row.id ?? row.term ?? '');
  if (!id) return;
  const label = status === 'approved' ? '通过' : '拒绝';
  try {
    const fn = status === 'approved' ? mohoApi.jargonApprove : mohoApi.jargonReject;
    await confirmed(
      `${label}黑话 ${row.term ?? id}`,
      'POST',
      `/api/memory/jargon/${status === 'approved' ? 'approve' : 'reject'}`,
      { id },
      (h) => fn({ body: { id }, headers: h }),
    );
    notice.value = `黑话已${label}。`;
    await load();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    error.value = e instanceof Error ? e.message : '审核失败';
  }
}

onMounted(load);
</script>
