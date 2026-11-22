<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">设备</h1>
      <v-spacer />
      <v-btn variant="tonal" :loading="loading" @click="load">刷新</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-4">{{ notice }}</v-alert>

    <v-card class="mb-4">
      <v-card-title>当前状态</v-card-title>
      <v-card-text>
        <v-table v-if="device" density="compact">
          <tbody>
            <tr><td>电量</td><td>{{ device.battery }}% {{ device.charging ? '(充电中)' : '' }}</td></tr>
            <tr><td>网络</td><td>{{ device.network }}</td></tr>
            <tr><td>屏幕</td><td>{{ device.screen === 'on' ? '亮屏' : '熄屏' }}</td></tr>
            <tr><td>免打扰</td><td>{{ device.doNotDisturb ? '开' : '关' }}</td></tr>
            <tr><td>活动</td><td>{{ device.activity }}</td></tr>
            <tr><td>通知数</td><td>{{ device.notificationCount }}</td></tr>
            <tr><td>最后活跃</td><td>{{ device.lastSeenAt }}</td></tr>
          </tbody>
        </v-table>
        <p v-else class="text-medium-emphasis">暂无设备状态。</p>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-title>状态迁移</v-card-title>
      <v-card-text>
        <p class="text-medium-emphasis mb-4">只填写需要变更的字段，空字段不提交。</p>
        <v-row>
          <v-col cols="12" sm="4">
            <v-text-field v-model.number="draft.battery" label="电量 (%)" type="number" variant="outlined" density="compact" clearable />
          </v-col>
          <v-col cols="12" sm="4">
            <v-select v-model="draft.network" :items="['wifi', 'cellular', 'weak', 'offline']" label="网络" variant="outlined" density="compact" clearable />
          </v-col>
          <v-col cols="12" sm="4">
            <v-select v-model="draft.activity" :items="['idle', 'browsing', 'chatting', 'gaming', 'sleeping', 'charging']" label="活动" variant="outlined" density="compact" clearable />
          </v-col>
          <v-col cols="12" sm="4">
            <v-select v-model="draft.screen" :items="['on', 'off']" label="屏幕" variant="outlined" density="compact" clearable />
          </v-col>
          <v-col cols="12" sm="4">
            <v-switch v-model="draft.charging" label="充电中" color="primary" />
          </v-col>
          <v-col cols="12" sm="4">
            <v-switch v-model="draft.doNotDisturb" label="免打扰" color="primary" />
          </v-col>
        </v-row>
        <v-btn color="primary" :loading="submitting" @click="submit">应用变更</v-btn>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { mohoApi } from '@/api/moho';

interface DeviceState {
  battery?: number; charging?: boolean; network?: string; screen?: string;
  doNotDisturb?: boolean; activity?: string; lastSeenAt?: string; notificationCount?: number;
}

const loading = ref(false);
const submitting = ref(false);
const error = ref('');
const notice = ref('');
const device = ref<DeviceState | null>(null);
const draft = reactive<{
  battery: number | undefined; network: string | undefined; activity: string | undefined;
  screen: string | undefined; charging: boolean | undefined; doNotDisturb: boolean | undefined;
}>({
  battery: undefined, network: undefined, activity: undefined,
  screen: undefined, charging: undefined, doNotDisturb: undefined,
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await mohoApi.deviceRead();
    const d = (res.data ?? {}) as Record<string, unknown>;
    device.value = (d.device ?? null) as DeviceState | null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取设备状态失败';
  } finally {
    loading.value = false;
  }
}

async function submit() {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft)) {
    if (v !== undefined && v !== null && v !== '') patch[k] = v;
  }
  if (Object.keys(patch).length === 0) {
    error.value = '没有需要应用的变更，请先修改至少一个字段。';
    return;
  }
  submitting.value = true;
  error.value = '';
  try {
    const res = await mohoApi.deviceWrite({ body: patch });
    const d = (res.data ?? {}) as Record<string, unknown>;
    if (d.device) device.value = d.device as DeviceState;
    notice.value = `已应用 ${Object.keys(patch).length} 项变更。`;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '应用变更失败';
  } finally {
    submitting.value = false;
  }
}

onMounted(load);
</script>
