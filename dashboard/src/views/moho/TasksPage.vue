<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">任务</h1>
      <v-spacer />
      <v-btn variant="tonal" :loading="loading" @click="loadAll">刷新</v-btn>
      <v-btn class="ml-2" color="primary" @click="scheduleDialog = true">调度未来任务</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-4">{{ notice }}</v-alert>

    <v-tabs v-model="tab" class="mb-4">
      <v-tab value="tasks">任务</v-tab>
      <v-tab value="future">未来任务</v-tab>
    </v-tabs>

    <v-window v-model="tab">
      <v-window-item value="tasks">
        <v-card>
          <v-data-table :headers="taskHeaders" :items="tasks" :loading="loading" density="compact" :items-per-page="20">
            <template #item.state="{ item }">
              <v-chip size="small" :color="item.state === 'failed' ? 'error' : item.state === 'paused' ? 'warning' : item.state === 'running' ? 'success' : 'default'">{{ item.state }}</v-chip>
            </template>
            <template #item.createdAt="{ item }">{{ formatTime(item.createdAt) }}</template>
            <template #item.actions="{ item }">
              <v-btn v-if="canRun(item)" size="small" variant="text" @click="control(item, 'run')">运行</v-btn>
              <v-btn v-if="canPause(item)" size="small" variant="text" @click="control(item, 'pause')">暂停</v-btn>
              <v-btn v-if="item.state === 'paused'" size="small" variant="text" @click="control(item, 'resume')">恢复</v-btn>
            </template>
          </v-data-table>
        </v-card>
      </v-window-item>
      <v-window-item value="future">
        <v-card>
          <v-data-table :headers="futureHeaders" :items="futureTasks" :loading="loading" density="compact" :items-per-page="20">
            <template #item.status="{ item }">
              <v-chip size="small" :color="item.status === 'failed' ? 'error' : item.status === 'completed' ? 'success' : 'warning'">{{ item.status }}</v-chip>
            </template>
            <template #item.scheduledAt="{ item }">{{ formatTime(item.scheduledAt) }}</template>
            <template #item.actions="{ item }">
              <v-btn size="small" variant="text" :loading="reconciling === item.id" @click="reconcile(item)">对账</v-btn>
            </template>
          </v-data-table>
        </v-card>
      </v-window-item>
    </v-window>

    <v-dialog v-model="scheduleDialog" max-width="560">
      <v-card>
        <v-card-title class="text-h6">调度未来任务</v-card-title>
        <v-card-text>
          <v-select v-model="form.type" :items="['world.tick', 'discord.deliver']" label="任务类型" variant="outlined" density="compact" />
          <v-text-field v-model="form.botId" label="目标 Bot ID" variant="outlined" density="compact" />
          <template v-if="form.type === 'discord.deliver'">
            <v-text-field v-model="form.channelId" label="频道 ID（数字）" variant="outlined" density="compact" />
            <v-text-field v-model="form.dedupeKey" label="去重键" variant="outlined" density="compact" />
            <v-textarea v-model="form.content" label="投递内容（最多 2000 字）" variant="outlined" density="compact" />
          </template>
          <v-text-field v-model="form.scheduledAt" label="计划时间（可选，本地时间）" type="datetime-local" variant="outlined" density="compact" />
          <v-text-field v-model.number="form.maxRetries" label="最大重试（0–20，可选）" type="number" variant="outlined" density="compact" />
          <v-alert v-if="formError" type="error" variant="tonal" density="compact">{{ formError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="scheduleDialog = false">取消</v-btn>
          <v-btn color="primary" variant="tonal" :loading="submitting" @click="submitSchedule">提交</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { confirmed, mohoApi } from '@/api/moho';

interface TaskRow {
  id: string; name?: string; kind?: string; state?: string; createdAt?: number;
  startedAt?: number; finishedAt?: number; runs?: number; errors?: number;
  [key: string]: unknown;
}
interface FutureRow {
  id: string; type?: string; status?: string; owner?: string; scheduledAt?: number;
  attempts?: number; maxRetries?: number; lastError?: string;
  [key: string]: unknown;
}

const loading = ref(false);
const submitting = ref(false);
const reconciling = ref('');
const error = ref('');
const notice = ref('');
const tab = ref('tasks');
const scheduleDialog = ref(false);
const formError = ref('');
const tasks = ref<TaskRow[]>([]);
const futureTasks = ref<FutureRow[]>([]);
const form = reactive({
  type: 'world.tick', botId: '', channelId: '', dedupeKey: '', content: '',
  scheduledAt: '', maxRetries: undefined as number | undefined,
});

const taskHeaders = [
  { title: '名称', key: 'name' },
  { title: '类型', key: 'kind' },
  { title: '状态', key: 'state' },
  { title: '运行次数', key: 'runs' },
  { title: '错误', key: 'errors' },
  { title: '创建时间', key: 'createdAt' },
  { title: '操作', key: 'actions', sortable: false },
];
const futureHeaders = [
  { title: 'ID', key: 'id' },
  { title: '类型', key: 'type' },
  { title: '状态', key: 'status' },
  { title: '归属', key: 'owner' },
  { title: '计划时间', key: 'scheduledAt' },
  { title: '尝试', key: 'attempts' },
  { title: '操作', key: 'actions', sortable: false },
];

function formatTime(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  return new Date(n < 1e12 ? n * 1000 : n).toLocaleString();
}
function canRun(t: TaskRow): boolean {
  return t.kind === 'interval' && t.state !== 'paused' && !['cancelled', 'done', 'failed'].includes(t.state ?? '');
}
function canPause(t: TaskRow): boolean {
  return t.kind === 'interval' && t.state !== 'paused' && !['cancelled', 'done', 'failed'].includes(t.state ?? '');
}

async function loadAll() {
  loading.value = true;
  error.value = '';
  try {
    const [t, f] = await Promise.all([mohoApi.tasksRead({ query: { limit: 200 } as never }), mohoApi.futureTasksList({ query: { limit: 200 } })]);
    const td = (t.data ?? {}) as Record<string, unknown>;
    const fd = (f.data ?? {}) as Record<string, unknown>;
    const page = td.tasks;
    tasks.value = Array.isArray(page) ? page : Array.isArray((page as Record<string, unknown>)?.items) ? (page as Record<string, unknown>).items as TaskRow[] : [];
    const fpage = fd.tasks ?? fd.futureTasks;
    futureTasks.value = Array.isArray(fpage) ? fpage : Array.isArray((fpage as Record<string, unknown>)?.items) ? (fpage as Record<string, unknown>).items as FutureRow[] : [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取任务失败';
  } finally {
    loading.value = false;
  }
}

async function control(task: TaskRow, action: 'pause' | 'resume' | 'run') {
  const label = action === 'pause' ? '暂停' : action === 'resume' ? '恢复' : '运行';
  const fn = action === 'pause' ? mohoApi.tasksControlPause : action === 'resume' ? mohoApi.tasksControlResume : mohoApi.tasksControlRun;
  try {
    await confirmed(
      `${label}任务 ${task.name ?? task.id}`,
      'POST',
      `/api/tasks/${encodeURIComponent(task.id)}/${action}`,
      {},
      (h) => fn({ path: { taskId: task.id }, headers: h }),
    );
    notice.value = `已${label}任务。`;
    await loadAll();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    error.value = e instanceof Error ? e.message : `${label}任务失败`;
  }
}

async function submitSchedule() {
  formError.value = '';
  if (!form.type) { formError.value = '请选择任务类型。'; return; }
  if (!form.botId.trim()) { formError.value = '必填：目标 Bot 实例 ID。'; return; }
  if (form.type === 'discord.deliver') {
    if (!/^\d{1,32}$/.test(form.channelId.trim())) { formError.value = '频道 ID 必须是 1~32 位数字。'; return; }
    if (!form.content.trim()) { formError.value = '投递内容不能为空。'; return; }
    if (form.content.length > 2000) { formError.value = '投递内容最多 2000 个字符。'; return; }
  }
  const payload = form.type === 'world.tick'
    ? { botId: form.botId.trim() }
    : { botId: form.botId.trim(), channelId: form.channelId.trim(), dedupeKey: form.dedupeKey.trim(), content: form.content };
  const request: Record<string, unknown> = { type: form.type, payload };
  if (form.scheduledAt.trim()) request.scheduledAt = new Date(form.scheduledAt).getTime();
  if (form.maxRetries !== undefined) request.maxRetries = form.maxRetries;
  submitting.value = true;
  try {
    await confirmed(
      `调度未来任务 ${form.type}`,
      'POST',
      '/api/tasks/future/schedule',
      request,
      (h) => mohoApi.futureTasksSchedule({ body: request, headers: h }),
    );
    notice.value = '未来任务已调度。';
    scheduleDialog.value = false;
    await loadAll();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    formError.value = e instanceof Error ? e.message : '调度未来任务失败。';
  } finally {
    submitting.value = false;
  }
}

async function reconcile(task: FutureRow) {
  reconciling.value = task.id;
  error.value = '';
  try {
    await confirmed(
      `对账未来任务 ${task.id}`,
      'POST',
      `/api/tasks/future/${encodeURIComponent(task.id)}/reconcile`,
      {},
      (h) => mohoApi.futureTasksReconcile({ path: { taskId: task.id }, headers: h }),
    );
    notice.value = '对账完成。';
    await loadAll();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    error.value = e instanceof Error ? e.message : '对账失败。';
  } finally {
    reconciling.value = '';
  }
}

onMounted(loadAll);
</script>
