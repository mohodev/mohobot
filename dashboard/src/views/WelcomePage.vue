<template>
  <div class="welcome-page">
    <header class="overview-header">
      <div>
        <h1 class="overview-greeting">{{ greetingText }} <span>{{ greetingEmoji }}</span></h1>
      </div>
      <OverviewStatus />
    </header>

    <v-alert v-if="statsFailed" type="warning" variant="tonal" class="mb-4">
      {{ tm('metrics.loadFailed') }}
      <template #append><v-btn variant="text" :loading="statsLoading" @click="loadOverview">{{ tm('health.refresh') }}</v-btn></template>
    </v-alert>
    <section class="metrics-grid" :aria-label="tm('metrics.title')" :aria-busy="statsLoading">
      <article v-for="metric in metrics" :key="metric.key" class="metric-card" :class="`metric-card--${metric.tone}`">
        <div class="metric-icon"><v-icon size="24">{{ metric.icon }}</v-icon></div>
        <div class="metric-content">
          <h2 class="metric-label">{{ tm(`metrics.${metric.key}`) }}</h2>
          <div class="metric-value" :title="metric.exact">{{ metric.value }}</div>
          <div class="metric-comparison">
            <span class="text-medium-emphasis">{{ metric.sub }}</span>
          </div>
        </div>
      </article>
    </section>

    <div class="overview-panels">
      <section class="overview-panel">
        <div class="panel-header">
          <div class="panel-icon"><v-icon size="22">mdi-robot-outline</v-icon></div>
          <div class="panel-heading">
            <h2>{{ tm('bots.title') }}</h2>
            <p>{{ tm('bots.subtitle') }}</p>
          </div>
        </div>
        <v-table v-if="bots.length" density="compact">
          <thead>
            <tr><th>{{ tm('bots.name') }}</th><th>{{ tm('bots.adapter') }}</th><th>{{ tm('bots.status') }}</th><th>{{ tm('bots.gateway') }}</th><th>{{ tm('bots.sessions') }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="bot in bots" :key="bot.id">
              <td>{{ bot.name || bot.id }}</td>
              <td>{{ bot.adapter || '—' }}</td>
              <td>
                <v-chip size="small" :color="bot.running ? 'success' : 'default'">
                  {{ bot.running ? tm('bots.running') : tm('bots.stopped') }}
                </v-chip>
              </td>
              <td>{{ bot.gateway?.connected ? tm('bots.connected') + (bot.gateway.ping !== undefined ? ` (${bot.gateway.ping}ms)` : '') : tm('bots.disconnected') }}</td>
              <td>{{ bot.sessions ?? '—' }}</td>
            </tr>
          </tbody>
        </v-table>
        <p v-else class="text-medium-emphasis">{{ tm('bots.empty') }}</p>
        <div class="mt-4">
          <v-btn variant="tonal" to="/bots">{{ tm('bots.manage') }}</v-btn>
          <v-btn variant="tonal" class="ml-2" to="/health">{{ tm('bots.health') }}</v-btn>
        </div>
      </section>

      <section class="overview-panel resources-panel">
        <div class="panel-header">
          <div class="panel-icon"><v-icon size="22">mdi-book-open-outline</v-icon></div>
          <div class="panel-heading">
            <h2>{{ tm('resources.title') }}</h2>
            <p>{{ tm('resources.subtitle') }}</p>
          </div>
        </div>
        <div class="resources-grid">
          <a v-for="resource in resources" :key="resource.key" :href="resource.href" target="_blank" rel="noopener noreferrer"
            class="resource-card" :class="`resource-card--${resource.key}`">
            <v-icon class="resource-external" size="18">mdi-open-in-new</v-icon>
            <v-icon class="resource-icon" size="26">{{ resource.icon }}</v-icon>
            <h3>{{ resource.key === 'github' ? 'GitHub' : tm(`resources.${resource.key}Title`) }}</h3>
            <p>{{ tm(`resources.${resource.key}Desc`) }}</p>
          </a>
        </div>
      </section>
    </div>

  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import OverviewStatus from '@/components/overview/OverviewStatus.vue';
import { mohoApi } from '@/api/moho';
import { useI18n, useModuleI18n } from '@/i18n/composables';

interface BotSnapshot {
  id: string; name?: string; adapter?: string; running?: boolean; sessions?: number;
  gateway?: { connected?: boolean; ping?: number; reconnects?: number };
}

const { tm } = useModuleI18n('features/welcome');
const { locale } = useI18n();

const overview = ref<{ bots: BotSnapshot[]; metrics: Record<string, unknown>; now: string } | null>(null);
const statsLoading = ref(false);
const statsFailed = ref(false);
let overviewTimer: ReturnType<typeof setInterval>;

const bots = computed(() => overview.value?.bots ?? []);
const online = computed(() => bots.value.filter((b) => b.running || b.gateway?.connected).length);
const sessions = computed(() => bots.value.reduce((s, b) => s + Number(b.sessions ?? 0), 0));
const requests = computed(() => {
  const m = overview.value?.metrics ?? {};
  const v = typeof m.requests === 'number' ? m.requests : typeof m.requestCount === 'number' ? m.requestCount : undefined;
  return v;
});
const errors = computed(() => {
  const m = overview.value?.metrics ?? {};
  const v = typeof m.errors === 'number' ? m.errors : typeof m.errorCount === 'number' ? m.errorCount : undefined;
  return v;
});

const metrics = computed(() => [
  {
    key: 'bots' as const, icon: 'mdi-robot-outline', tone: 'primary',
    value: `${online.value}/${bots.value.length}`,
    exact: `${online.value} / ${bots.value.length}`,
    sub: tm('metrics.botsSub'),
  },
  {
    key: 'sessions' as const, icon: 'mdi-account-multiple-outline', tone: 'success',
    value: sessions.value.toLocaleString(locale.value),
    exact: String(sessions.value),
    sub: tm('metrics.sessionsSub'),
  },
  {
    key: 'requests' as const, icon: 'mdi-layers-triple-outline', tone: 'info',
    value: requests.value === undefined ? '—' : requests.value.toLocaleString(locale.value),
    exact: requests.value === undefined ? undefined : String(requests.value),
    sub: tm('metrics.requestsSub'),
  },
  {
    key: 'errors' as const, icon: 'mdi-alert-circle-outline', tone: 'warning',
    value: errors.value === undefined ? '—' : errors.value.toLocaleString(locale.value),
    exact: errors.value === undefined ? undefined : String(errors.value),
    sub: tm('metrics.errorsSub'),
  },
]);

// MohoBot resources: only the project's own repository (no AstrBot links).
const resources = [
  { key: 'github', icon: 'mdi-github', href: 'https://github.com/mohodev/mohobot' },
];

async function loadOverview() {
  if (statsLoading.value) return;
  statsLoading.value = true;
  try {
    const [status, metricsRes] = await Promise.all([
      mohoApi.runtimeStatus(),
      mohoApi.metricsRead(),
    ]);
    const sd = (status.data ?? {}) as Record<string, unknown>;
    const md = (metricsRes.data ?? {}) as Record<string, unknown>;
    overview.value = {
      bots: Array.isArray(sd.bots) ? sd.bots as BotSnapshot[] : [],
      metrics: (md.metrics as Record<string, unknown>) ?? {},
      now: typeof sd.now === 'string' ? sd.now : new Date().toISOString(),
    };
    statsFailed.value = false;
  } catch (error) {
    statsFailed.value = true;
    console.error('Failed to load overview metrics:', error);
  } finally {
    statsLoading.value = false;
  }
}

const springFestivalDates: Record<number, string> = {
  2025: '01-29',
  2026: '02-17',
  2027: '02-06',
  2028: '01-26',
  2029: '02-13',
  2030: '02-03'
}

function isSpringFestival() {
  const now = new Date();
  const year = now.getFullYear();
  const dateStr = springFestivalDates[year];

  if (!dateStr) return false;

  const [month, day] = dateStr.split('-').map(Number);
  const festivalDate = new Date(year, month - 1, day);

  const start = new Date(festivalDate);
  start.setDate(festivalDate.getDate() - 5);

  const end = new Date(festivalDate);
  end.setDate(festivalDate.getDate() + 5);

  // start of day for comparison
  const nowTime = now.setHours(0, 0, 0, 0);
  const startTime = start.setHours(0, 0, 0, 0);
  const endTime = end.setHours(0, 0, 0, 0);

  return nowTime >= startTime && nowTime <= endTime;
}

function isExactSpringFestivalDay() {
  const now = new Date();
  const year = now.getFullYear();
  const dateStr = springFestivalDates[year];

  if (!dateStr) return false;

  const [month, day] = dateStr.split('-').map(Number);
  const festivalDate = new Date(year, month - 1, day);

  const nowTime = new Date(now).setHours(0, 0, 0, 0);
  const festivalTime = festivalDate.setHours(0, 0, 0, 0);

  return nowTime === festivalTime;
}

const greetingEmoji = computed(() => {
  if (isExactSpringFestivalDay()) {
    return '🧨';
  }
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 5) {
    return '😴';
  }
  return '👋';
});

const greetingText = computed(() => {
  if (isSpringFestival()) {
    return tm('greeting.newYear');
  }
  const hour = new Date().getHours();
  if (hour < 12) return tm('greeting.morning');
  if (hour < 18) return tm('greeting.afternoon');
  return tm('greeting.evening');
});

onMounted(async () => {
  void loadOverview();
  overviewTimer = setInterval(() => { if (!document.hidden) void loadOverview(); }, 30000);
});

onUnmounted(() => clearInterval(overviewTimer));
</script>

<style scoped>
.welcome-page { max-width: 1560px; margin: 0 auto; padding: 24px 20px; }
.overview-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.overview-greeting { font-size: clamp(22px, 2vw, 26px); line-height: 1.3; font-weight: 700; letter-spacing: -.4px; overflow-wrap: anywhere; }
.overview-greeting span { display: inline-block; margin-inline-start: 8px; }
.metrics-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 20px; }
.metric-card { --metric-color: var(--v-theme-primary); display: flex; align-items: flex-start; gap: 16px; padding: 20px; border-radius: 18px; background: rgba(var(--metric-color), .07); }
.metric-card--info { --metric-color: var(--v-theme-info); }
.metric-card--success { --metric-color: var(--v-theme-success); }
.metric-card--warning { --metric-color: var(--v-theme-warning); }
.metric-icon, .panel-icon { display: grid; place-items: center; flex-shrink: 0; width: 44px; height: 44px; border-radius: 50%; background: rgba(var(--metric-color, var(--v-theme-primary)), .09); color: rgb(var(--metric-color, var(--v-theme-primary))); }
.metric-content { min-width: 0; }
.metric-label { font-size: 14px; font-weight: 600; line-height: 1.5; }
.metric-value { font-size: clamp(26px, 2.4vw, 30px); line-height: 1.25; font-weight: 700; margin: 6px 0; letter-spacing: -1px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.metric-comparison { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; }
.overview-panels { display: grid; grid-template-columns: 1.08fr 1fr; gap: 20px; }
.overview-panel { min-width: 0; padding: 20px; border: 1px solid rgba(var(--v-theme-primary), .08); border-radius: 18px; background: rgb(var(--v-theme-surface)); box-shadow: 0 3px 16px rgba(var(--v-theme-primary), .025); }
.panel-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.panel-heading { flex: 1; min-width: 0; }
.panel-heading h2 { font-size: 18px; line-height: 1.4; font-weight: 700; }
.panel-heading p, .step-copy p, .resource-card p { color: rgba(var(--v-theme-on-surface), .62); font-size: 13px; line-height: 1.6; margin: 4px 0 0; }
.panel-icon { width: 40px; height: 40px; }
.resources-panel { display: flex; flex-direction: column; }
.resources-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: auto 0; }
.resource-card { position: relative; display: flex; flex-direction: column; align-items: flex-start; padding: 18px 14px; border-radius: 16px; background: rgba(var(--v-theme-primary), .06); color: rgb(var(--v-theme-on-surface)); text-decoration: none; transition: background .2s; }
.resource-card:hover, .resource-card:focus-visible { background: rgba(var(--v-theme-primary), .13); }
.resource-card:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
.resource-card--github { background: rgba(var(--v-theme-info), .06); }
.resource-external { position: absolute; top: 12px; right: 12px; opacity: .65; }
.resource-icon { margin: 6px 0 14px; color: rgb(var(--v-theme-primary)); }
.resource-card--github .resource-icon { color: rgb(var(--v-theme-on-surface)); }
.resource-card h3 { font-size: 15px; font-weight: 600; }
@media (max-width: 1200px) {
  .welcome-page { padding: 24px 16px; }
  .metric-card { padding: 18px; gap: 12px; }
  .metric-icon { width: 40px; height: 40px; }
  .overview-panels { grid-template-columns: 1fr; }
  .resources-grid { margin: 0; }
  .metrics-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 700px) {
  .welcome-page { padding: 20px 4px; }
  .overview-header { flex-direction: column; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
  .metrics-grid { grid-template-columns: 1fr; gap: 12px; margin-bottom: 20px; }
  .metric-card { padding: 16px; border-radius: 16px; }
  .metric-value { margin: 6px 0; }
  .overview-panel { padding: 16px; border-radius: 16px; }
  .panel-header { flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  .panel-heading h2 { font-size: 18px; }
  .resources-grid { grid-template-columns: 1fr; }
  .resource-card { padding: 16px; }
  .resource-icon { margin: 0 0 12px; }
}
</style>
