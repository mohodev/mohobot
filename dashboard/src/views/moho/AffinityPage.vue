<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">好感度</h1>
      <v-spacer />
      <v-text-field v-model="botId" label="Bot ID（可选）" variant="outlined" density="compact" hide-details class="mr-2" style="max-width: 220px" />
      <v-btn variant="tonal" :loading="loading" @click="load">刷新</v-btn>
      <v-btn class="ml-2" color="primary" @click="dialog = true">调整好感度</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-4">{{ notice }}</v-alert>

    <v-card>
      <v-data-table :headers="headers" :items="rows" :loading="loading" density="compact" :items-per-page="20">
        <template #item.reason="{ item }">
          <v-chip size="small" :color="reasonColor(item.reason)">{{ reasonLabel(item.reason) }}</v-chip>
        </template>
        <template #item.updatedAt="{ item }">{{ formatTime(item.updatedAt) }}</template>
      </v-data-table>
    </v-card>

    <v-dialog v-model="dialog" max-width="480">
      <v-card>
        <v-card-title class="text-h6">调整好感度</v-card-title>
        <v-card-text>
          <v-text-field v-model="form.userId" label="用户 ID" variant="outlined" density="compact" />
          <v-text-field v-model.number="form.delta" label="变化量（正数为增加）" type="number" variant="outlined" density="compact" />
          <v-select v-model="form.reason" :items="reasonItems" label="原因" variant="outlined" density="compact" />
          <v-text-field v-model="form.note" label="备注（可选）" variant="outlined" density="compact" />
          <v-alert v-if="formError" type="error" variant="tonal" density="compact">{{ formError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog = false">取消</v-btn>
          <v-btn color="primary" variant="tonal" :loading="submitting" @click="submit">提交</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { confirmed, mohoApi } from '@/api/moho';

interface AffinityRow {
  userId?: string; botId?: string; value?: number; score?: number;
  reason?: string; note?: string; updatedAt?: number | string;
}

const loading = ref(false);
const submitting = ref(false);
const error = ref('');
const notice = ref('');
const dialog = ref(false);
const formError = ref('');
const botId = ref('');
const rows = ref<AffinityRow[]>([]);
const form = reactive({ userId: '', delta: 0, reason: 'manual', note: '' });

const headers = [
  { title: '用户', key: 'userId' },
  { title: 'Bot', key: 'botId' },
  { title: '好感度', key: 'value' },
  { title: '原因', key: 'reason' },
  { title: '备注', key: 'note' },
  { title: '更新时间', key: 'updatedAt' },
];
const reasonItems = [
  { title: '有帮助', value: 'helpful' },
  { title: '友善', value: 'kind' },
  { title: '共同兴趣', value: 'shared-interest' },
  { title: '冲突', value: 'conflict' },
  { title: '被忽视', value: 'ignored' },
  { title: '手动调整', value: 'manual' },
];
const reasonLabel = (r?: string) => reasonItems.find((i) => i.value === r)?.title ?? r ?? '—';
const reasonColor = (r?: string) =>
  r === 'helpful' || r === 'kind' ? 'success' : r === 'conflict' ? 'error' : r === 'ignored' ? 'warning' : 'info';

function formatTime(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return typeof v === 'string' ? v : '—';
  return new Date(n < 1e12 ? n * 1000 : n).toLocaleString();
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await mohoApi.affinityRead({ query: botId.value ? { botId: botId.value } : undefined });
    const d = (res.data ?? {}) as Record<string, unknown>;
    rows.value = Array.isArray(d.affinity) ? d.affinity : [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取好感度失败';
  } finally {
    loading.value = false;
  }
}

async function submit() {
  const userId = form.userId.trim();
  if (!userId) { formError.value = '请填写用户 ID。'; return; }
  if (!form.delta) { formError.value = '变化量不能为 0。'; return; }
  const payload: Record<string, unknown> = {
    botId: botId.value.trim() || undefined,
    userId,
    delta: form.delta,
    reason: form.reason,
  };
  if (form.note.trim()) payload.note = form.note.trim();
  submitting.value = true;
  formError.value = '';
  try {
    await confirmed(
      `调整用户 ${userId} 的好感度`,
      'POST',
      '/api/affinity/adjust',
      payload,
      (h) => mohoApi.affinityAdjust({ body: payload, headers: h }),
    );
    dialog.value = false;
    notice.value = '好感度已调整。';
    await load();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    formError.value = e instanceof Error ? e.message : '调整好感度失败。';
  } finally {
    submitting.value = false;
  }
}

onMounted(load);
</script>
