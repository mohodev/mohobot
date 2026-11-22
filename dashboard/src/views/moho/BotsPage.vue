<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">机器人</h1>
      <v-spacer />
      <v-btn variant="tonal" :loading="loading" @click="load">刷新</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-4">{{ notice }}</v-alert>

    <v-card class="mb-4">
      <v-data-table :headers="botHeaders" :items="bots" :loading="loading" density="compact" :items-per-page="20">
        <template #item.running="{ item }">
          <v-chip size="small" :color="item.running ? 'success' : 'default'">{{ item.running ? '运行中' : '已停止' }}</v-chip>
        </template>
        <template #item.gateway="{ item }">
          <span v-if="item.gateway">{{ item.gateway.connected ? `已连接${item.gateway.ping !== undefined ? ` (${item.gateway.ping}ms)` : ''}` : '未连接' }}</span>
          <span v-else>—</span>
        </template>
        <template #item.actions="{ item }">
          <v-btn size="small" variant="text" @click="showGateway(item)">网关</v-btn>
          <v-btn size="small" variant="text" @click="showPlugins(item)">插件</v-btn>
          <v-btn size="small" variant="text" color="warning" @click="restart(item)">重启</v-btn>
        </template>
      </v-data-table>
    </v-card>

    <v-card v-if="gateway" class="mb-4">
      <v-card-title>网关：{{ gatewayBotId }}</v-card-title>
      <v-card-text>
        <pre class="text-body-2" style="white-space: pre-wrap">{{ JSON.stringify(gateway, null, 2) }}</pre>
      </v-card-text>
    </v-card>

    <v-card v-if="plugins.length">
      <v-card-title>插件：{{ pluginsBotId }}</v-card-title>
      <v-data-table :headers="pluginHeaders" :items="plugins" density="compact" :items-per-page="20">
        <template #item.actions="{ item }">
          <v-btn size="small" variant="text" @click="reloadPlugin(item)">重载</v-btn>
        </template>
      </v-data-table>
    </v-card>

    <v-card class="mt-4">
      <v-card-title>Discord 服务器清单 / 规划</v-card-title>
      <v-card-text>
        <div class="d-flex ga-2 mb-4">
          <v-text-field v-model="guildBotId" label="Bot ID" variant="outlined" density="compact" hide-details style="max-width: 220px" />
          <v-text-field v-model="guildId" label="服务器 ID" variant="outlined" density="compact" hide-details style="max-width: 220px" />
          <v-btn variant="tonal" :loading="guildLoading" @click="loadGuild">加载清单</v-btn>
          <v-btn variant="tonal" :loading="guildLoading" @click="loadGuildPlan">生成规划</v-btn>
        </div>
        <pre v-if="guildData" class="text-body-2" style="white-space: pre-wrap">{{ JSON.stringify(guildData, null, 2) }}</pre>
        <p v-else class="text-medium-emphasis">输入 Bot ID 与服务器 ID 后加载。</p>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { confirmed, mohoApi } from '@/api/moho';

interface BotRow {
  id: string; name?: string; adapter?: string; provider?: string; model?: string;
  running?: boolean; sessions?: number;
  gateway?: { connected?: boolean; ping?: number; reconnects?: number };
  [key: string]: unknown;
}

const loading = ref(false);
const guildLoading = ref(false);
const error = ref('');
const notice = ref('');
const bots = ref<BotRow[]>([]);
const gateway = ref<unknown>(null);
const gatewayBotId = ref('');
const plugins = ref<Record<string, unknown>[]>([]);
const pluginsBotId = ref('');
const guildBotId = ref('');
const guildId = ref('');
const guildData = ref<unknown>(null);

const botHeaders = [
  { title: 'ID', key: 'id' },
  { title: '名称', key: 'name' },
  { title: '适配器', key: 'adapter' },
  { title: '供应商', key: 'provider' },
  { title: '模型', key: 'model' },
  { title: '状态', key: 'running' },
  { title: '网关', key: 'gateway' },
  { title: '会话数', key: 'sessions' },
  { title: '操作', key: 'actions', sortable: false },
];
const pluginHeaders = [
  { title: 'ID', key: 'id' },
  { title: '状态', key: 'state' },
  { title: '错误', key: 'errors' },
  { title: '操作', key: 'actions', sortable: false },
];

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await mohoApi.botsList();
    const d = (res.data ?? {}) as Record<string, unknown>;
    bots.value = Array.isArray(d.bots) ? d.bots : [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取机器人列表失败';
  } finally {
    loading.value = false;
  }
}

async function showGateway(bot: BotRow) {
  error.value = '';
  try {
    const res = await mohoApi.gatewayRead({ path: { botId: bot.id } });
    const d = (res.data ?? {}) as Record<string, unknown>;
    gateway.value = d.gateway ?? d;
    gatewayBotId.value = bot.id;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取网关失败';
  }
}

async function showPlugins(bot: BotRow) {
  error.value = '';
  try {
    const res = await mohoApi.pluginsList({ path: { botId: bot.id } });
    const d = (res.data ?? {}) as Record<string, unknown>;
    plugins.value = Array.isArray(d.plugins) ? d.plugins : [];
    pluginsBotId.value = bot.id;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取插件失败';
  }
}

async function reloadPlugin(plugin: Record<string, unknown>) {
  const botId = pluginsBotId.value;
  const pluginId = String(plugin.id ?? '');
  if (!botId || !pluginId) return;
  try {
    await confirmed(
      `重载插件 ${pluginId}`,
      'POST',
      `/api/bots/${encodeURIComponent(botId)}/plugins/${encodeURIComponent(pluginId)}/reload`,
      {},
      (h) => mohoApi.pluginReload({ path: { botId, pluginId }, headers: h }),
    );
    notice.value = '插件已重载。';
    await showPlugins({ id: botId } as BotRow);
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    error.value = e instanceof Error ? e.message : '重载插件失败';
  }
}

async function restart(bot: BotRow) {
  try {
    await confirmed(
      `重启机器人 ${bot.id}`,
      'POST',
      `/api/bots/${encodeURIComponent(bot.id)}/restart`,
      {},
      (h) => mohoApi.runtimeRestart({ path: { botId: bot.id }, headers: h }),
    );
    notice.value = '机器人重启请求已发送。';
    await load();
  } catch (e) {
    if (e instanceof Error && e.message === '操作已取消') return;
    error.value = e instanceof Error ? e.message : '重启失败';
  }
}

async function loadGuild() {
  if (!guildBotId.value.trim() || !guildId.value.trim()) { error.value = '请填写 Bot ID 与服务器 ID。'; return; }
  guildLoading.value = true;
  error.value = '';
  try {
    const res = await mohoApi.guildInventory({ query: { botId: guildBotId.value.trim(), guildId: guildId.value.trim() } as never });
    const d = (res.data ?? {}) as Record<string, unknown>;
    guildData.value = d.inventory ?? d;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取服务器清单失败';
  } finally {
    guildLoading.value = false;
  }
}

async function loadGuildPlan() {
  if (!guildBotId.value.trim() || !guildId.value.trim()) { error.value = '请填写 Bot ID 与服务器 ID。'; return; }
  guildLoading.value = true;
  error.value = '';
  try {
    const res = await mohoApi.guildPlan({ body: { botId: guildBotId.value.trim(), guildId: guildId.value.trim() } });
    const d = (res.data ?? {}) as Record<string, unknown>;
    guildData.value = d.plan ?? d;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '生成规划失败';
  } finally {
    guildLoading.value = false;
  }
}

onMounted(load);
</script>
