<template>
  <div class="platform-page">
    <v-container fluid class="pa-0">
      <div class="platform-content">
        <div class="platform-workbench">
          <aside class="platform-workbench__sidebar">
            <div class="bot-list-panel">
              <div class="bot-list-panel__head">
                <h3 class="bot-list-panel__title">平台</h3>
                <v-btn
                  color="primary"
                  prepend-icon="mdi-refresh"
                  size="small"
                  variant="text"
                  rounded="xl"
                  :loading="loading"
                  @click="load"
                >
                  刷新
                </v-btn>
                <v-progress-linear
                  v-if="loading"
                  class="bot-list-panel__progress"
                  color="primary"
                  height="2"
                  indeterminate
                />
              </div>

              <div v-if="bots.length" class="bot-list-panel__mobile-controls">
                <v-select
                  v-model="selectedBotId"
                  :items="botOptions"
                  item-title="title"
                  item-value="value"
                  density="compact"
                  variant="solo-filled"
                  flat
                  hide-details
                  placeholder="选择平台"
                >
                  <template #selection="{ item }">
                    <div class="bot-mobile-selection">
                      <img
                        :src="getBotIcon(item.raw.bot)"
                        class="bot-list-icon bot-list-icon--mobile"
                        alt="bot logo"
                      />
                      <span>{{ item.raw.title }}</span>
                    </div>
                  </template>
                  <template #item="{ props: itemProps, item }">
                    <v-list-item
                      v-bind="itemProps"
                      :subtitle="item.raw.subtitle"
                    >
                      <template #prepend>
                        <img
                          :src="getBotIcon(item.raw.bot)"
                          class="bot-list-icon bot-list-icon--mobile me-2"
                          alt="bot logo"
                        />
                      </template>
                    </v-list-item>
                  </template>
                </v-select>
              </div>

              <div v-if="bots.length" class="bot-list">
                <div
                  v-for="bot in bots"
                  :key="bot.id"
                  class="bot-list-item"
                  :class="{
                    'bot-list-item--active': selectedBotId === bot.id,
                  }"
                >
                  <button
                    type="button"
                    class="bot-list-item__main"
                    @click="selectedBotId = bot.id"
                  >
                    <img
                      :src="getBotIcon(bot)"
                      class="bot-list-icon"
                      alt="bot logo"
                    />
                    <div class="bot-list-item__copy">
                      <div class="bot-list-item__title">
                        {{ bot.name || bot.id }}
                      </div>
                      <div class="bot-list-item__subtitle">
                        <span
                          class="bot-list-item__status-dot"
                          :class="getBotStatusClass(bot)"
                        ></span>
                        <span>{{ getBotStatusLabel(bot) }}</span>
                        <span v-if="bot.adapter">· {{ bot.adapter }}</span>
                      </div>
                    </div>
                  </button>
                </div>
              </div>

              <div v-else-if="!loading" class="bot-list-empty">
                <v-icon size="42" color="grey-lighten-1"
                  >mdi-robot-outline</v-icon
                >
                <p>暂无已配置的平台</p>
                <p class="text-caption">
                  平台在配置文件中定义，新增与编辑请走配置发布。
                </p>
              </div>
            </div>
          </aside>

          <div class="platform-workbench__divider"></div>

          <main class="platform-workbench__main">
            <div v-if="selectedBot" class="platform-detail">
              <div class="platform-detail__head">
                <img
                  :src="getBotIcon(selectedBot)"
                  class="platform-detail__icon"
                  alt="bot logo"
                />
                <div class="platform-detail__copy">
                  <h2 class="platform-detail__title">
                    {{ selectedBot.name || selectedBot.id }}
                  </h2>
                  <div class="platform-detail__subtitle">
                    {{ selectedBot.id }} · 适配器 {{ selectedBot.adapter }}
                  </div>
                </div>
                <v-chip
                  size="small"
                  :color="selectedBot.running ? 'success' : 'default'"
                >
                  {{ selectedBot.running ? "运行中" : "已停止" }}
                </v-chip>
                <v-btn
                  size="small"
                  variant="tonal"
                  color="warning"
                  :loading="restarting"
                  @click="restart(selectedBot)"
                >
                  重启
                </v-btn>
              </div>

              <v-alert
                v-if="error"
                type="error"
                variant="tonal"
                class="mb-4"
                closable
                @click:close="error = ''"
              >
                {{ error }}
              </v-alert>

              <v-card variant="outlined" class="mb-4">
                <v-card-title>网关</v-card-title>
                <v-card-text>
                  <v-table density="compact">
                    <tbody>
                      <tr>
                        <td class="text-medium-emphasis">连接状态</td>
                        <td>
                          {{
                            selectedGateway?.connected ? "已连接" : "未连接"
                          }}
                        </td>
                      </tr>
                      <tr>
                        <td class="text-medium-emphasis">延迟</td>
                        <td>
                          {{
                            selectedGateway?.ping !== undefined &&
                            selectedGateway.ping >= 0
                              ? `${selectedGateway.ping} ms`
                              : "—"
                          }}
                        </td>
                      </tr>
                      <tr v-if="selectedGateway?.username">
                        <td class="text-medium-emphasis">用户名</td>
                        <td>{{ selectedGateway.username }}</td>
                      </tr>
                      <tr v-if="selectedGateway?.guilds !== undefined">
                        <td class="text-medium-emphasis">服务器数</td>
                        <td>{{ selectedGateway.guilds }}</td>
                      </tr>
                      <tr>
                        <td class="text-medium-emphasis">重连次数</td>
                        <td>{{ selectedGateway?.reconnects ?? "—" }}</td>
                      </tr>
                    </tbody>
                  </v-table>
                </v-card-text>
              </v-card>

              <v-card
                v-if="selectedBot.plugins?.length"
                variant="outlined"
                class="mb-4"
              >
                <v-card-title>插件</v-card-title>
                <v-data-table
                  :headers="pluginHeaders"
                  :items="selectedBot.plugins"
                  density="compact"
                  :items-per-page="20"
                />
              </v-card>

              <v-card
                v-if="selectedBot.modelHealth !== undefined"
                variant="outlined"
                class="mb-4"
              >
                <v-card-title>模型健康</v-card-title>
                <v-card-text>
                  <pre
                    class="text-body-2"
                    style="white-space: pre-wrap"
                    >{{ JSON.stringify(selectedBot.modelHealth, null, 2) }}</pre
                  >
                </v-card-text>
              </v-card>

              <v-alert type="info" variant="tonal">
                平台的新增、编辑与删除暂无独立接口，通过配置发布管理（见配置页）。
              </v-alert>
            </div>

            <div v-else class="platform-empty-state">
              <v-icon size="48" color="grey-lighten-1"
                >mdi-cursor-default-click</v-icon
              >
              <p>选择一个平台查看网关状态</p>
            </div>
          </main>
        </div>
      </div>
    </v-container>

    <v-snackbar
      v-model="snackbar.show"
      :timeout="3000"
      :color="snackbar.color"
      elevation="6"
      location="top"
    >
      {{ snackbar.message }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { confirmed, mohoApi } from "@/api/moho";
import { getPlatformIcon } from "@/utils/platformUtils";

interface GatewayView {
  connected?: boolean;
  ping?: number;
  username?: string;
  guilds?: number;
  reconnects?: number;
}

interface BotRow {
  id: string;
  name?: string;
  adapter?: string;
  running?: boolean;
  gateway?: GatewayView;
  plugins?: { id: string; state: string; errors: number }[];
  modelHealth?: unknown;
  [key: string]: unknown;
}

const loading = ref(false);
const restarting = ref(false);
const error = ref("");
const bots = ref<BotRow[]>([]);
const selectedBotId = ref<string | null>(null);
const selectedGateway = ref<GatewayView | null>(null);
const snackbar = ref({ show: false, message: "", color: "success" });
let refreshInterval: number | null = null;

const selectedBot = computed(
  () => bots.value.find((bot) => bot.id === selectedBotId.value) || null,
);

const botOptions = computed(() =>
  bots.value.map((bot) => ({
    title: bot.name || bot.id,
    subtitle: `${getBotStatusLabel(bot)} · ${bot.adapter || ""}`,
    value: bot.id,
    bot,
  })),
);

const pluginHeaders = [
  { title: "ID", key: "id" },
  { title: "状态", key: "state" },
  { title: "错误", key: "errors" },
];

onMounted(() => {
  load();
  refreshInterval = window.setInterval(load, 5000);
});

onBeforeUnmount(() => {
  if (refreshInterval) {
    window.clearInterval(refreshInterval);
  }
});

watch(selectedBotId, () => {
  loadGateway();
});

async function load() {
  loading.value = true;
  try {
    const res = await mohoApi.botsList();
    const d = (res.data ?? {}) as Record<string, unknown>;
    const list = Array.isArray(d.bots) ? (d.bots as BotRow[]) : [];
    bots.value = list;
    if (
      selectedBotId.value &&
      !list.some((bot) => bot.id === selectedBotId.value)
    ) {
      selectedBotId.value = null;
    }
    if (!selectedBotId.value && list.length) {
      selectedBotId.value = list[0].id;
    }
    if (selectedBotId.value) {
      await loadGateway();
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "读取平台列表失败";
  } finally {
    loading.value = false;
  }
}

async function loadGateway() {
  const botId = selectedBotId.value;
  if (!botId) {
    selectedGateway.value = null;
    return;
  }
  try {
    const res = await mohoApi.gatewayRead({ path: { botId } });
    const d = (res.data ?? {}) as Record<string, unknown>;
    selectedGateway.value = (d.gateway ?? d) as GatewayView;
  } catch (e) {
    console.warn("Failed to load gateway status:", e);
    selectedGateway.value = selectedBot.value?.gateway ?? null;
  }
}

async function restart(bot: BotRow) {
  restarting.value = true;
  error.value = "";
  try {
    await confirmed(
      `重启机器人 ${bot.name || bot.id}`,
      "POST",
      `/api/bots/${encodeURIComponent(bot.id)}/restart`,
      {},
      (h) => mohoApi.runtimeRestart({ path: { botId: bot.id }, headers: h }),
    );
    showToast("机器人重启请求已发送。", "success");
    await load();
  } catch (e) {
    if (e instanceof Error && e.message === "操作已取消") return;
    error.value = e instanceof Error ? e.message : "重启失败";
  } finally {
    restarting.value = false;
  }
}

function getBotIcon(bot: BotRow | null | undefined) {
  return getPlatformIcon(bot?.adapter || bot?.id || "") || "/favicon.svg";
}

function getBotStatusLabel(bot: BotRow) {
  if (!bot.running) return "已停止";
  return bot.gateway?.connected ? "运行中 · 已连接" : "运行中 · 未连接";
}

function getBotStatusClass(bot: BotRow) {
  if (!bot.running) return "bot-list-item__status-dot--disabled";
  if (bot.gateway?.connected) return "bot-list-item__status-dot--success";
  return "bot-list-item__status-dot--warning";
}

function showToast(message: string, type: "success" | "error") {
  snackbar.value = {
    show: true,
    message,
    color: type === "error" ? "error" : "success",
  };
}
</script>

<style scoped>
.platform-page {
  --platform-border: rgba(var(--v-theme-on-surface), 0.08);
  --platform-surface: rgb(var(--v-theme-surface));
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  width: 100%;
}

.platform-page > .v-container {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.platform-content {
  display: flex;
  flex: 1;
  margin: 0 auto;
  max-width: 1200px;
  min-height: 0;
  padding: 16px 12px 12px;
  width: 100%;
}

.platform-workbench {
  background: var(--platform-surface);
  border: 1px solid var(--platform-border);
  border-radius: 16px;
  display: grid;
  flex: 1;
  grid-template-columns: minmax(280px, 320px) 1px minmax(0, 1fr);
  min-height: 0;
  overflow: hidden;
  width: 100%;
}

.platform-workbench__sidebar,
.platform-workbench__main {
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.platform-workbench__divider {
  background: var(--platform-border);
}

.platform-workbench__main {
  display: flex;
}

.bot-list-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.bot-list-panel__head {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  gap: 12px;
  justify-content: space-between;
  padding: 20px 20px 12px;
  position: relative;
}

.bot-list-panel__progress {
  bottom: 0;
  left: 0;
  position: absolute;
  right: 0;
}

.bot-list-panel__title {
  font-size: 16px;
  font-weight: 650;
  line-height: 1.3;
  margin: 0;
}

.bot-list-panel__mobile-controls {
  align-items: center;
  display: none;
  gap: 8px;
  padding: 0 16px 12px;
}

.bot-list-panel__mobile-controls > .v-select {
  flex: 1;
  min-width: 0;
}

.bot-mobile-selection {
  align-items: center;
  display: flex;
  gap: 8px;
  min-width: 0;
}

.bot-mobile-selection span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px 12px 16px;
}

.bot-list-item {
  align-items: center;
  border-radius: 12px;
  display: flex;
  min-width: 0;
}

.bot-list-item:hover,
.bot-list-item--active {
  background: rgba(var(--v-theme-on-surface), 0.05);
}

.bot-list-item__main {
  align-items: center;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  display: flex;
  flex: 1;
  gap: 10px;
  min-width: 0;
  padding: 10px 4px 10px 12px;
  text-align: left;
}

.bot-list-icon {
  flex: 0 0 auto;
  height: 30px;
  object-fit: contain;
  width: 30px;
}

.bot-list-icon--mobile {
  height: 24px;
  width: 24px;
}

.bot-list-item__copy {
  flex: 1;
  min-width: 0;
}

.bot-list-item__title {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-list-item__subtitle {
  align-items: center;
  color: rgba(var(--v-theme-on-surface), 0.54);
  display: flex;
  font-size: 12px;
  gap: 4px;
  line-height: 1.4;
  margin-top: 4px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-list-item__status-dot {
  background: rgba(var(--v-theme-on-surface), 0.35);
  border-radius: 50%;
  flex: 0 0 auto;
  height: 7px;
  width: 7px;
}

.bot-list-item__status-dot--success {
  background: rgb(var(--v-theme-success));
}

.bot-list-item__status-dot--error {
  background: rgb(var(--v-theme-error));
}

.bot-list-item__status-dot--warning {
  background: rgb(var(--v-theme-warning));
}

.bot-list-empty,
.platform-empty-state {
  align-items: center;
  color: rgba(var(--v-theme-on-surface), 0.56);
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  justify-content: center;
  padding: 24px;
  text-align: center;
}

.bot-list-empty p,
.platform-empty-state p {
  font-size: 13px;
  margin: 0;
}

.platform-empty-state {
  min-height: 420px;
}

.platform-detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 20px;
}

.platform-detail__head {
  align-items: center;
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.platform-detail__icon {
  flex: 0 0 auto;
  height: 36px;
  object-fit: contain;
  width: 36px;
}

.platform-detail__copy {
  flex: 1;
  min-width: 0;
}

.platform-detail__title {
  font-size: 18px;
  font-weight: 650;
  line-height: 1.3;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.platform-detail__subtitle {
  color: rgba(var(--v-theme-on-surface), 0.54);
  font-size: 12px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 960px) {
  .platform-workbench {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1px minmax(0, 1fr);
  }

  .platform-workbench__divider {
    height: 1px;
  }

  .bot-list-panel {
    height: auto;
  }

  .bot-list-panel__head {
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
    padding: 16px 16px 8px;
  }

  .bot-list-panel__head :deep(.v-btn) {
    align-self: flex-start;
  }

  .bot-list-panel__mobile-controls {
    display: flex;
  }

  .bot-list {
    display: none;
  }

  .bot-list-empty {
    min-height: 160px;
  }
}

@media (max-width: 600px) {
  .platform-content {
    padding-inline: 4px;
  }

  .platform-workbench {
    border-radius: 12px;
  }

  .platform-empty-state {
    min-height: 260px;
  }
}
</style>
