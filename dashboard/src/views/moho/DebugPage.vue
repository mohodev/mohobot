<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">调试聊天</h1>
      <v-spacer />
      <v-btn variant="tonal" :loading="loading" @click="loadCaps">刷新能力</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>

    <v-card class="mb-4">
      <v-card-title>能力</v-card-title>
      <v-card-text>
        <pre v-if="capabilities" class="text-body-2" style="white-space: pre-wrap">{{ JSON.stringify(capabilities, null, 2) }}</pre>
        <p v-else class="text-medium-emphasis">暂无能力信息。</p>
      </v-card-text>
    </v-card>

    <v-card class="mb-4">
      <v-card-title>发送调试消息</v-card-title>
      <v-card-text>
        <v-row>
          <v-col cols="12" sm="6">
            <v-text-field v-model="botId" label="Bot ID" variant="outlined" density="compact" />
          </v-col>
          <v-col cols="12" sm="6">
            <v-text-field v-model="sessionKey" label="会话 Key（可选）" variant="outlined" density="compact" />
          </v-col>
        </v-row>
        <v-textarea v-model="message" label="消息内容" variant="outlined" density="compact" rows="3" />
        <div class="d-flex ga-2">
          <v-btn color="primary" :loading="sending" :disabled="!message.trim()" @click="send">发送</v-btn>
          <v-btn variant="tonal" :loading="dryRunning" :disabled="!message.trim()" @click="dryRun">行为预演</v-btn>
        </div>
      </v-card-text>
    </v-card>

    <v-card v-if="reply">
      <v-card-title>回复</v-card-title>
      <v-card-text>
        <pre class="text-body-2" style="white-space: pre-wrap">{{ JSON.stringify(reply, null, 2) }}</pre>
      </v-card-text>
    </v-card>
    <v-card v-if="dryRunResult" class="mt-4">
      <v-card-title>预演结果</v-card-title>
      <v-card-text>
        <pre class="text-body-2" style="white-space: pre-wrap">{{ JSON.stringify(dryRunResult, null, 2) }}</pre>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { mohoApi } from '@/api/moho';

const loading = ref(false);
const sending = ref(false);
const dryRunning = ref(false);
const error = ref('');
const capabilities = ref<unknown>(null);
const reply = ref<unknown>(null);
const dryRunResult = ref<unknown>(null);
const botId = ref('');
const sessionKey = ref('');
const message = ref('');

async function loadCaps() {
  loading.value = true;
  error.value = '';
  try {
    const res = await mohoApi.debugChatCapabilities();
    const d = (res.data ?? {}) as Record<string, unknown>;
    capabilities.value = d.capabilities ?? d;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取调试能力失败';
  } finally {
    loading.value = false;
  }
}

function payload(): Record<string, unknown> {
  const p: Record<string, unknown> = { message: message.value.trim() };
  if (botId.value.trim()) p.botId = botId.value.trim();
  if (sessionKey.value.trim()) p.sessionKey = sessionKey.value.trim();
  return p;
}

async function send() {
  sending.value = true;
  error.value = '';
  reply.value = null;
  try {
    const res = await mohoApi.debugChat({ body: payload() });
    const d = (res.data ?? {}) as Record<string, unknown>;
    reply.value = d.reply ?? d;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '发送调试消息失败';
  } finally {
    sending.value = false;
  }
}

async function dryRun() {
  dryRunning.value = true;
  error.value = '';
  dryRunResult.value = null;
  try {
    const res = await mohoApi.behaviorDryRun({ body: payload() });
    const d = (res.data ?? {}) as Record<string, unknown>;
    dryRunResult.value = d.result ?? d;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '行为预演失败';
  } finally {
    dryRunning.value = false;
  }
}

onMounted(loadCaps);
</script>
