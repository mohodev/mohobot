<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">用户与访问</h1>
      <v-spacer />
      <v-btn variant="tonal" :loading="loading" @click="loadAll">刷新</v-btn>
      <v-btn class="ml-2" color="primary" @click="createDialog = true">创建管理员账号</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-4">{{ notice }}</v-alert>

    <v-tabs v-model="tab" class="mb-4">
      <v-tab value="users">管理员账号</v-tab>
      <v-tab value="sessions">登录会话</v-tab>
      <v-tab value="tokens">临时令牌</v-tab>
    </v-tabs>

    <v-window v-model="tab">
      <v-window-item value="users">
        <v-card>
          <v-data-table :headers="userHeaders" :items="users" :loading="loading" density="compact" :items-per-page="20">
            <template #item.enabled="{ item }">
              <v-chip size="small" :color="item.enabled ? 'success' : 'default'">{{ item.enabled ? '启用' : '停用' }}</v-chip>
            </template>
            <template #item.createdAt="{ item }">{{ formatTime(item.createdAt) }}</template>
            <template #item.actions="{ item }">
              <v-btn size="small" variant="text" @click="toggleUser(item)">{{ item.enabled ? '停用' : '启用' }}</v-btn>
              <v-btn size="small" variant="text" @click="openRotate(item)">重置密码</v-btn>
            </template>
          </v-data-table>
        </v-card>
      </v-window-item>
      <v-window-item value="sessions">
        <v-card>
          <v-data-table :headers="sessionHeaders" :items="authSessions" :loading="loading" density="compact" :items-per-page="20">
            <template #item.createdAt="{ item }">{{ formatTime(item.createdAt) }}</template>
            <template #item.lastSeenAt="{ item }">{{ formatTime(item.lastSeenAt) }}</template>
            <template #item.actions="{ item }">
              <v-btn size="small" variant="text" color="error" @click="revokeSession(item)">撤销</v-btn>
            </template>
          </v-data-table>
        </v-card>
      </v-window-item>
      <v-window-item value="tokens">
        <v-card>
          <v-data-table :headers="tokenHeaders" :items="tokens" :loading="loading" density="compact" :items-per-page="20">
            <template #item.expiresAt="{ item }">{{ formatTime(item.expiresAt) }}</template>
          </v-data-table>
        </v-card>
      </v-window-item>
    </v-window>

    <v-dialog v-model="createDialog" max-width="480">
      <v-card>
        <v-card-title class="text-h6">创建管理员账号</v-card-title>
        <v-card-text>
          <v-text-field v-model="createForm.username" label="用户名" variant="outlined" density="compact" />
          <v-text-field v-model="createForm.password" label="密码" type="password" variant="outlined" density="compact" />
          <v-select v-model="createForm.role" :items="['admin', 'developer', 'operator', 'viewer']" label="角色" variant="outlined" density="compact" />
          <v-alert v-if="formError" type="error" variant="tonal" density="compact">{{ formError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="createDialog = false">取消</v-btn>
          <v-btn color="primary" variant="tonal" :loading="submitting" @click="submitCreate">创建</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="rotateDialog" max-width="480">
      <v-card>
        <v-card-title class="text-h6">重置密码：{{ rotateTarget?.username }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="rotatePassword" label="新密码" type="password" variant="outlined" density="compact" />
          <v-alert v-if="formError" type="error" variant="tonal" density="compact">{{ formError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="rotateDialog = false">取消</v-btn>
          <v-btn color="primary" variant="tonal" :loading="submitting" @click="submitRotate">重置</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { confirmed, mohoApi } from '@/api/moho';

interface UserRow { username: string; role?: string; enabled?: boolean; createdAt?: number; [key: string]: unknown; }
interface SessionRow { id: string; username?: string; role?: string; createdAt?: number; lastSeenAt?: number; current?: boolean; [key: string]: unknown; }
interface TokenRow { id: string; label?: string; role?: string; createdBy?: string; createdAt?: number; expiresAt?: number; [key: string]: unknown; }

const loading = ref(false);
const submitting = ref(false);
const error = ref('');
const notice = ref('');
const formError = ref('');
const tab = ref('users');
const createDialog = ref(false);
const rotateDialog = ref(false);
const rotateTarget = ref<UserRow | null>(null);
const rotatePassword = ref('');
const users = ref<UserRow[]>([]);
const authSessions = ref<SessionRow[]>([]);
const tokens = ref<TokenRow[]>([]);
const createForm = reactive({ username: '', password: '', role: 'viewer' });

const userHeaders = [
  { title: '用户名', key: 'username' },
  { title: '角色', key: 'role' },
  { title: '状态', key: 'enabled' },
  { title: '创建时间', key: 'createdAt' },
  { title: '操作', key: 'actions', sortable: false },
];
const sessionHeaders = [
  { title: 'ID', key: 'id' },
  { title: '用户', key: 'username' },
  { title: '角色', key: 'role' },
  { title: '创建时间', key: 'createdAt' },
  { title: '最后活跃', key: 'lastSeenAt' },
  { title: '当前会话', key: 'current' },
  { title: '操作', key: 'actions', sortable: false },
];
const tokenHeaders = [
  { title: 'ID', key: 'id' },
  { title: '标签', key: 'label' },
  { title: '角色', key: 'role' },
  { title: '创建者', key: 'createdBy' },
  { title: '过期时间', key: 'expiresAt' },
];

function formatTime(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  return new Date(n < 1e12 ? n * 1000 : n).toLocaleString();
}

async function loadAll() {
  loading.value = true;
  error.value = '';
  try {
    const [u, s, t] = await Promise.all([
      mohoApi.usersList(),
      mohoApi.sessionsList(),
      mohoApi.tokensList(),
    ]);
    const ud = (u.data ?? {}) as Record<string, unknown>;
    const sd = (s.data ?? {}) as Record<string, unknown>;
    const td = (t.data ?? {}) as Record<string, unknown>;
    users.value = Array.isArray(ud.users) ? ud.users : [];
    authSessions.value = Array.isArray(sd.sessions) ? sd.sessions : [];
    tokens.value = Array.isArray(td.tokens) ? td.tokens : [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取用户数据失败';
  } finally {
    loading.value = false;
  }
}

async function submitCreate() {
  const payload = { username: createForm.username.trim(), password: createForm.password, role: createForm.role };
  if (!payload.username || !payload.password) { formError.value = '用户名和密码必填。'; return; }
  submitting.value = true;
  formError.value = '';
  try {
    await confirmed(
      `创建管理员账号 ${payload.username}`,
      'POST',
      '/api/admin/users',
      payload,
      (h) => mohoApi.usersCreate({ body: payload, headers: h }),
    );
    notice.value = '管理员账号已创建。';
    createDialog.value = false;
    createForm.username = '';
    createForm.password = '';
    await loadAll();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    formError.value = e instanceof Error ? e.message : '创建失败。';
  } finally {
    submitting.value = false;
  }
}

async function toggleUser(row: UserRow) {
  const payload = { enabled: !row.enabled };
  try {
    await confirmed(
      `${row.enabled ? '停用' : '启用'}管理员账号 ${row.username}`,
      'PATCH',
      `/api/admin/users/${encodeURIComponent(row.username)}`,
      payload,
      (h) => mohoApi.usersUpdate({ path: { userId: row.username }, body: payload, headers: h }),
    );
    notice.value = '已更新。';
    await loadAll();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    error.value = e instanceof Error ? e.message : '更新失败';
  }
}

function openRotate(row: UserRow) {
  rotateTarget.value = row;
  rotatePassword.value = '';
  formError.value = '';
  rotateDialog.value = true;
}

async function submitRotate() {
  const target = rotateTarget.value;
  if (!target) return;
  if (rotatePassword.value.length < 10) { formError.value = '密码至少 10 个字符。'; return; }
  const payload = { password: rotatePassword.value };
  submitting.value = true;
  formError.value = '';
  try {
    await confirmed(
      `重置管理员账号 ${target.username} 的密码`,
      'POST',
      `/api/admin/users/${encodeURIComponent(target.username)}/password`,
      payload,
      (h) => mohoApi.usersPasswordRotate({ path: { userId: target.username }, body: payload, headers: h }),
    );
    notice.value = '密码已重置。';
    rotateDialog.value = false;
    await loadAll();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    formError.value = e instanceof Error ? e.message : '重置失败。';
  } finally {
    submitting.value = false;
  }
}

async function revokeSession(row: SessionRow) {
  try {
    await confirmed(
      `撤销登录会话 ${row.id}`,
      'DELETE',
      `/api/auth/sessions/${encodeURIComponent(row.id)}`,
      {},
      (h) => mohoApi.sessionsRevoke({ path: { sessionId: row.id }, headers: h }),
    );
    notice.value = '会话已撤销。';
    await loadAll();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    error.value = e instanceof Error ? e.message : '撤销失败';
  }
}

onMounted(loadAll);
</script>
