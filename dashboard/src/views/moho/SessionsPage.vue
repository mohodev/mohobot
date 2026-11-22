<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">会话</h1>
      <v-spacer />
      <v-btn variant="tonal" :loading="loading" @click="loadAll">刷新</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-4">{{ notice }}</v-alert>

    <v-tabs v-model="tab" class="mb-4">
      <v-tab value="sessions">会话</v-tab>
      <v-tab value="chatlog">聊天记录</v-tab>
      <v-tab value="discord">Discord 记录</v-tab>
      <v-tab value="audit">管理审计</v-tab>
      <v-tab value="disclosure">披露审计</v-tab>
      <v-tab value="operator">Operator 审计</v-tab>
    </v-tabs>

    <v-window v-model="tab">
      <v-window-item value="sessions">
        <v-card>
          <v-data-table :headers="sessionHeaders" :items="sessions" :loading="loading" density="compact" :items-per-page="20">
            <template #item.updatedAt="{ item }">{{ formatTime(item.updatedAt) }}</template>
            <template #item.actions="{ item }">
              <v-btn size="small" variant="text" color="error" @click="deleteSession(item)">删除</v-btn>
            </template>
          </v-data-table>
        </v-card>
      </v-window-item>
      <v-window-item value="chatlog">
        <v-card><v-data-table :headers="chatHeaders" :items="chatLog" :loading="loading" density="compact" :items-per-page="20" /></v-card>
      </v-window-item>
      <v-window-item value="discord">
        <v-card><v-data-table :headers="discordHeaders" :items="discordLog" :loading="loading" density="compact" :items-per-page="20" /></v-card>
      </v-window-item>
      <v-window-item value="audit">
        <v-card><v-data-table :headers="auditHeaders" :items="audit" :loading="loading" density="compact" :items-per-page="20" /></v-card>
      </v-window-item>
      <v-window-item value="disclosure">
        <v-card><v-data-table :headers="disclosureHeaders" :items="disclosure" :loading="loading" density="compact" :items-per-page="20" /></v-card>
      </v-window-item>
      <v-window-item value="operator">
        <v-card><v-data-table :headers="operatorHeaders" :items="operatorAudit" :loading="loading" density="compact" :items-per-page="20" /></v-card>
      </v-window-item>
    </v-window>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { confirmed, mohoApi } from '@/api/moho';

const loading = ref(false);
const error = ref('');
const notice = ref('');
const tab = ref('sessions');
const sessions = ref<Record<string, unknown>[]>([]);
const chatLog = ref<Record<string, unknown>[]>([]);
const discordLog = ref<Record<string, unknown>[]>([]);
const audit = ref<Record<string, unknown>[]>([]);
const disclosure = ref<Record<string, unknown>[]>([]);
const operatorAudit = ref<Record<string, unknown>[]>([]);

const sessionHeaders = [
  { title: 'ID', key: 'id' },
  { title: 'Bot', key: 'botId' },
  { title: '频道', key: 'channelId' },
  { title: '用户', key: 'userId' },
  { title: '消息数', key: 'messageCount' },
  { title: '更新时间', key: 'updatedAt' },
  { title: '操作', key: 'actions', sortable: false },
];
const chatHeaders = [
  { title: '时间', key: 'at' },
  { title: 'Bot', key: 'botId' },
  { title: '频道', key: 'channelId' },
  { title: '角色', key: 'role' },
  { title: '内容', key: 'content' },
];
const discordHeaders = [
  { title: '时间', key: 'at' },
  { title: '频道', key: 'channelId' },
  { title: '作者', key: 'author' },
  { title: '内容', key: 'content' },
];
const auditHeaders = [
  { title: '时间', key: 'at' },
  { title: '操作人', key: 'actor' },
  { title: '操作', key: 'action' },
  { title: '结果', key: 'outcome' },
  { title: '方法', key: 'method' },
  { title: '状态', key: 'status' },
];
const disclosureHeaders = [
  { title: '时间', key: 'at' },
  { title: '类型', key: 'kind' },
  { title: '详情', key: 'detail' },
];
const operatorHeaders = [
  { title: '时间', key: 'at' },
  { title: '操作', key: 'action' },
  { title: '结果', key: 'outcome' },
  { title: '详情', key: 'detail' },
];

function formatTime(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return typeof v === 'string' ? v : '—';
  return new Date(n < 1e12 ? n * 1000 : n).toLocaleString();
}
function pageItems(d: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const page = d[key];
  if (Array.isArray(page)) return page;
  const items = (page as Record<string, unknown> | undefined)?.items;
  return Array.isArray(items) ? items as Record<string, unknown>[] : [];
}

async function loadAll() {
  loading.value = true;
  error.value = '';
  try {
    const [s, c, dc, a, dis, op] = await Promise.all([
      mohoApi.opsSessionsRead({ query: { limit: 50 } }),
      mohoApi.opsChatLogRead({ query: { limit: 50 } as never }),
      mohoApi.opsDiscordChatLogRead({ query: { limit: 50 } }),
      mohoApi.auditRead({ query: { limit: 50 } as never }),
      mohoApi.socialDisclosureAuditRead({ query: { limit: 50 } }),
      mohoApi.opsOperatorAuditRead({ query: { limit: 50 } as never }),
    ]);
    sessions.value = pageItems((s.data ?? {}) as Record<string, unknown>, 'sessions');
    chatLog.value = pageItems((c.data ?? {}) as Record<string, unknown>, 'messages');
    discordLog.value = pageItems((dc.data ?? {}) as Record<string, unknown>, 'messages');
    audit.value = pageItems((a.data ?? {}) as Record<string, unknown>, 'audit');
    disclosure.value = pageItems((dis.data ?? {}) as Record<string, unknown>, 'entries');
    operatorAudit.value = pageItems((op.data ?? {}) as Record<string, unknown>, 'entries');
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取会话数据失败';
  } finally {
    loading.value = false;
  }
}

async function deleteSession(row: Record<string, unknown>) {
  const key = String(row.key ?? row.id ?? '');
  if (!key) return;
  try {
    await confirmed(
      `删除会话 ${key}`,
      'DELETE',
      `/api/ops/sessions/${encodeURIComponent(key)}`,
      {},
      (h) => mohoApi.opsSessionsDelete({ path: { sessionKey: key }, headers: h }),
    );
    notice.value = '会话已删除。';
    await loadAll();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    error.value = e instanceof Error ? e.message : '删除会话失败';
  }
}

onMounted(loadAll);
</script>
