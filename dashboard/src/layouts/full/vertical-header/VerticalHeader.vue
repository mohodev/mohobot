<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useChatHeaderStore } from "@/stores/chatHeader";
import { useHeaderContextStore } from "@/stores/headerContext";
import { useMobileDrawerStore } from "@/stores/mobileDrawer";
import { useCustomizerStore } from "@/stores/customizer";
import axios from "axios";
import Logo from "@/components/shared/Logo.vue";
import { useAuthStore } from "@/stores/auth";
import { useCommonStore } from "@/stores/common";
import { MarkdownRender, enableKatex, enableMermaid } from "markstream-vue";
import "markstream-vue/index.css";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";
import { useI18n, useModuleI18n } from "@/i18n/composables";
import { router } from "@/router";
import { useRoute } from "vue-router";
import { useDisplay, useTheme } from "vuetify";
import StyledMenu from "@/components/shared/StyledMenu.vue";
import { Menu } from "@lucide/vue";
import { Minus, Square, X } from "@lucide/vue";
import { useLanguageSwitcher } from "@/i18n/composables";
import type { Locale } from "@/i18n/types";
import { authApi } from "@/api/v1";
import { mohoApi } from "@/api/moho";

enableKatex();
enableMermaid();

const customizer = useCustomizerStore();
const commonStore = useCommonStore();
const authStore = useAuthStore();
const chatHeader = useChatHeaderStore();
const headerContext = useHeaderContextStore();
const mobileDrawer = useMobileDrawerStore();

/** Windows hides the native title bar, so the header draws its own caption buttons. */
const isWindowsDesktop = ref(false);
const astrbotDesktop = computed(() => window.astrbotDesktop);
const theme = useTheme();
const { smAndDown } = useDisplay();
const { t } = useI18n();
const { tm } = useModuleI18n("features/chat");
const route = useRoute();
const LAST_BOT_ROUTE_KEY = "astrbot:last_bot_route";
const LAST_CHAT_ROUTE_KEY = "astrbot:last_chat_route";
let dialog = ref(false);
let accountWarning = ref(false);
let accountWarningMd5 = ref(false);
let accountWarningUpgrade = ref(false);
const username = localStorage.getItem("user");
let password = ref("");
let newPassword = ref("");
let confirmPassword = ref("");
let newUsername = ref("");
let status = ref("");
let restartWaiting = ref(false);
let restartStartTime = ref<number | string | null>(null);
let restartPollTimer: ReturnType<typeof setInterval> | null = null;
let restartCompleted = ref(false);
let restartReloadCountdown = ref(3);
let restartReloadTimer: ReturnType<typeof setInterval> | null = null;
const RESTART_FEEDBACK_DELAY_SECONDS = 3;
const RESTART_START_TIME_POLL_INTERVAL_MS = 2000;
const isChatPath = computed(
  () => route.path === "/chat" || route.path.startsWith("/chat/"),
);
const isDarkTheme = computed(
  () => theme.global.current.value.dark || customizer.uiTheme.includes("Dark"),
);
const chatHeaderStyle = computed(() => {
  if (!isChatPath.value) return undefined;
  const sidebarWidth = smAndDown.value
    ? 0
    : customizer.chatSidebarCollapsed
      ? 56
      : 245;
  return {
    // The chat toolbar is window chrome, so it must paint the full window. The
    // sidebar width remains available to contextual content through this CSS
    // variable, but must not offset the toolbar itself and expose the native
    // window material in the top-left corner.
    left: "0px",
    width: "100%",
    "--astrbot-chat-sidebar-width": `${sidebarWidth + (!smAndDown.value && customizer.chatNavigationInSidebar ? 56 : 0)}px`,
    "--astrbot-workbench-preferred-width": chatHeader.workbenchWidth ? `${chatHeader.workbenchWidth}px` : undefined,
  };
});
// Form validation
const formValid = ref(true);
const passwordRules = computed(() => [
  (v: string) =>
    !!v || t("core.header.accountDialog.validation.passwordRequired"),
  (v: string) =>
    v.length >= 8 ||
    t("core.header.accountDialog.validation.passwordMinLength"),
  (v: string) =>
    /[A-Z]/.test(v) ||
    t("core.header.accountDialog.validation.passwordUppercase"),
  (v: string) =>
    /[a-z]/.test(v) ||
    t("core.header.accountDialog.validation.passwordLowercase"),
  (v: string) =>
    /\d/.test(v) || t("core.header.accountDialog.validation.passwordDigit"),
]);
const confirmPasswordRules = computed(() => [
  (v: string) =>
    !newPassword.value ||
    !!v ||
    t("core.header.accountDialog.validation.passwordRequired"),
  (v: string) =>
    !newPassword.value ||
    v === newPassword.value ||
    t("core.header.accountDialog.validation.passwordMatch"),
]);
const usernameRules = computed(() => [
  (v: string) =>
    !v ||
    v.length >= 3 ||
    t("core.header.accountDialog.validation.usernameMinLength"),
]);

// 显示密码相关
const showPassword = ref(false);
const showNewPassword = ref(false);
const showConfirmPassword = ref(false);
const currentPasswordInput = ref();
const newPasswordInput = ref();
const confirmPasswordInput = ref();
const newUsernameInput = ref();

// 账户修改状态
const accountEditStatus = ref({
  loading: false,
  success: false,
  error: false,
  message: "",
});

// 账户修改
function accountEdit() {
  accountEditStatus.value.loading = true;
  accountEditStatus.value.error = false;
  accountEditStatus.value.success = false;

  const currentPasswordValue = password.value ? password.value : "";
  const newPasswordValue = newPassword.value ? newPassword.value : "";
  const confirmPasswordValue = confirmPassword.value
    ? confirmPassword.value
    : "";

  authApi
    .updateAccount({
      password: currentPasswordValue,
      new_password: newPasswordValue,
      confirm_password: confirmPasswordValue,
      new_username: newUsername.value || username || undefined,
    })
    .then((res) => {
      if (res.data.status == "error") {
        accountEditStatus.value.error = true;
        accountEditStatus.value.message = res.data.message || "";
        password.value = "";
        newPassword.value = "";
        confirmPassword.value = "";
        return;
      }
      accountEditStatus.value.success = true;
      accountEditStatus.value.message = res.data.message || "";
      setTimeout(() => {
        dialog.value = !dialog.value;
        authStore.logout();
      }, 2000);
    })
    .catch((err) => {
      console.log(err);
      accountEditStatus.value.error = true;
      accountEditStatus.value.message =
        typeof err === "string"
          ? err
          : t("core.header.accountDialog.messages.updateFailed");
      password.value = "";
      newPassword.value = "";
      confirmPassword.value = "";
    })
    .finally(() => {
      accountEditStatus.value.loading = false;
    });
}

function initPasswordWarningFromStorage() {
  const hasChangePwdHint = localStorage.getItem("change_pwd_hint") === "true";
  const hasMd5PwdHint =
    localStorage.getItem("md5_pwd_hint") === "true";
  const hasPasswordUpgradeRequired =
    localStorage.getItem("password_upgrade_required") === "true";
  if (hasChangePwdHint || hasMd5PwdHint || hasPasswordUpgradeRequired) {
    dialog.value = true;
    accountWarning.value = true;
    accountWarningUpgrade.value = hasPasswordUpgradeRequired;
    accountWarningMd5.value =
      hasMd5PwdHint && !hasPasswordUpgradeRequired;
  }
}

function stopRestartPolling() {
  if (restartPollTimer) {
    clearInterval(restartPollTimer);
    restartPollTimer = null;
  }
}

function stopRestartReloadTimer() {
  if (restartReloadTimer) {
    clearInterval(restartReloadTimer);
    restartReloadTimer = null;
  }
}

function resetRestartFeedbackState() {
  stopRestartReloadTimer();
  stopRestartPolling();
  restartCompleted.value = false;
  restartReloadCountdown.value = RESTART_FEEDBACK_DELAY_SECONDS;
  restartWaiting.value = false;
}

// MohoBot has no start-time endpoint: restart detection probes liveness
// (GET /api/status) instead. Returns true while the backend answers.
async function fetchMohoBackendAlive() {
  try {
    await mohoApi.runtimeStatus();
    return true;
  } catch (_error) {
    return false;
  }
}

function reloadAfterUpdate() {
  stopRestartReloadTimer();
  reloadWithCacheBuster();
}

function reloadWithCacheBuster() {
  const url = new URL(window.location.href);
  url.searchParams.set("_r", Date.now().toString());
  window.location.replace(url.toString());
}

function showRestartCompleted() {
  if (restartCompleted.value) {
    return;
  }
  stopRestartReloadTimer();
  restartWaiting.value = false;
  restartCompleted.value = true;
  restartReloadCountdown.value = RESTART_FEEDBACK_DELAY_SECONDS;
  restartReloadTimer = setInterval(() => {
    if (restartReloadCountdown.value <= 1) {
      reloadAfterUpdate();
      return;
    }
    restartReloadCountdown.value -= 1;
  }, 1000);
}

function waitForAstrBotRestart(
  initialStartTime: number | string | null,
  showWaiting = true,
) {
  if (restartCompleted.value) {
    return;
  }
  if (showWaiting && !restartWaiting.value) {
    restartWaiting.value = true;
    restartStartTime.value = initialStartTime;
  }
  if (restartPollTimer) {
    return;
  }

  restartStartTime.value = initialStartTime;

  // Restart is done once the backend answers again after having been
  // down, or after 10 successful polls for restarts too fast to observe.
  let restartBackendWasDown = false;
  let restartAlivePolls = 0;
  const poll = async () => {
    const alive = await fetchMohoBackendAlive();
    if (alive) {
      restartAlivePolls += 1;
      if (restartBackendWasDown || restartAlivePolls >= 10) {
        stopRestartPolling();
        showRestartCompleted();
      }
    } else {
      restartBackendWasDown = true;
      restartAlivePolls = 0;
    }
  };

  void poll();
  restartPollTimer = setInterval(() => {
    void poll();
  }, RESTART_START_TIME_POLL_INTERVAL_MS);
}

// 主题选项配置
const themeOptions = [
  { mode: 'light' as const,  icon: 'mdi-white-balance-sunny', labelKey: 'core.header.buttons.theme.light'  },
  { mode: 'dark'  as const,  icon: 'mdi-weather-night',       labelKey: 'core.header.buttons.theme.dark'   },
  { mode: 'system' as const, icon: 'mdi-sync',                labelKey: 'core.header.buttons.theme.system' },
] as const;

function setThemeMode(mode: 'light' | 'dark' | 'system') {
  customizer.SET_THEME_MODE(mode);
  theme.global.name.value = customizer.uiTheme;
}

initPasswordWarningFromStorage();

commonStore.getStartTime();

onUnmounted(() => {
  stopRestartPolling();
  stopRestartReloadTimer();
});

// 视图模式切换
onMounted(() => {
  isWindowsDesktop.value =
    document.documentElement.dataset.astrbotDesktopPlatform === "windows";
  // 初次加載時保存當前路由
  if (typeof window !== "undefined") {
    if (isChatPath.value) {
      // 保存 chat ID
      const parts = route.fullPath.split("/");
      const sessionId = parts[2];
      if (sessionId) {
        sessionStorage.setItem(LAST_CHAT_ROUTE_KEY, sessionId);
        console.log("Initial save chat ID:", sessionId);
      }
    } else {
      // 保存 bot 路由（非 chat 頁面）
      sessionStorage.setItem(LAST_BOT_ROUTE_KEY, route.fullPath);
      console.log("Initial save bot route:", route.fullPath);
    }
  }
});

// 监听 viewMode 变化，切换到 bot 模式时跳转到首页
// 保存 bot 模式的最後路由
// 監聽 route 變化，保存最後一次 bot 路由
watch(
  () => route.fullPath,
  (newPath) => {
    if (typeof window === "undefined") return;
    console.log("Route changed:", {
      newPath,
      isChat: isChatPath.value,
      currentChatId: route.params.id,
    });
    try {
      // 使用現有的 isChatPath 計算屬性來避免名稱衝突
      const isChat = isChatPath.value; // 這裡使用已經計算好的 isChatPath

      // ✅ bot：只存「非 chat 頁」
      if (!isChat) {
        sessionStorage.setItem(LAST_BOT_ROUTE_KEY, newPath);
      }

      // ✅ chat：只存 sessionId
      if (isChat) {
        const parts = newPath.split("/");
        const sessionId = parts[2];

        if (sessionId) {
          sessionStorage.setItem(LAST_CHAT_ROUTE_KEY, sessionId);
        }
      }
    } catch (e) {
      console.error("Failed to save route:", e);
    }
  },
);

const currentMode = computed({
  get: () => (isChatPath.value ? "chat" : "bot"),
  set: (val: "chat" | "bot") => {
    try {
      // 檢查 window 和 sessionStorage 是否存在
      if (
        typeof window === "undefined" ||
        typeof sessionStorage === "undefined"
      ) {
        // 如果在非瀏覽器環境中，不做任何 sessionStorage 操作
        console.warn("sessionStorage is not available in this environment");
        return;
      }

      if (val === "chat") {
        const lastSessionId = sessionStorage.getItem(LAST_CHAT_ROUTE_KEY);
        router.push(lastSessionId ? `/chat/${lastSessionId}` : "/chat");
      } else {
        let lastBotRoute = sessionStorage.getItem(LAST_BOT_ROUTE_KEY) || "/";
        if (lastBotRoute.startsWith("/chat")) {
          lastBotRoute = "/";
        }
        router.push(lastBotRoute);
      }
    } catch (e) {
      // 在受限隱私模式等環境中，sessionStorage 操作可能會拋出 SecurityError
      console.warn("Failed to access sessionStorage in currentMode setter:", e);
    }
  },
});

const mainMenuOpen = ref(false);
const nextMode = computed<"chat" | "bot">(() =>
  isChatPath.value ? "bot" : "chat",
);

function switchMode() {
  currentMode.value = nextMode.value;
  mainMenuOpen.value = false;
}

// 语言切换相关
const { languageOptions, currentLanguage, switchLanguage, locale } =
  useLanguageSwitcher();
const languages = computed(() =>
  languageOptions.value.map((lang) => ({
    code: lang.value,
    name: lang.label,
    flag: lang.flag,
  })),
);
const currentLocale = computed(() => locale.value);
const changeLanguage = async (langCode: string) => {
  await switchLanguage(langCode as Locale);
  mainMenuOpen.value = false;
};

</script>

<template>
  <v-app-bar
    elevation="0"
    height="42"
    data-tauri-drag-region
    class="top-header"
    :class="{
      'chat-mode-header': isChatPath,
      'chat-mode-header--dark': isChatPath && isDarkTheme,
    }"
    :absolute="isChatPath"
    :style="chatHeaderStyle"
  >
    <!-- Mobile: open the navigation drawer (sidebars become temporary overlays). -->
    <v-btn
      v-if="$vuetify.display.smAndDown"
      class="header-menu-btn"
      icon
      rounded="lg"
      variant="text"
      :ripple="false"
      :aria-label="t('core.navigation.options')"
      @click="mobileDrawer.TOGGLE"
    >
      <Menu :size="20" />
    </v-btn>

    <!-- Pages register their contextual toolbar content through the
         headerContext store (e.g. the chat page's model selector and title). -->
    <div class="app-header-context">
      <component :is="headerContext.component" v-if="headerContext.component" />
    </div>

    <v-spacer />

    <div class="header-actions" :class="{ 'chat-header-actions': isChatPath }">
      <v-btn
        v-if="isChatPath && chatHeader.projectId"
        class="chat-action-btn workspace-files-trigger"
        :class="{
          'workspace-files-trigger--active': chatHeader.workspaceFilesOpen,
        }"
        variant="text"
        size="small"
        rounded="sm"
        icon
        :title="tm('workspaceFiles.open')"
        @click="chatHeader.TOGGLE_WORKSPACE_FILES"
      >
        <v-icon size="20">
          {{
            chatHeader.workspaceFilesOpen
              ? "mdi-folder-open-outline"
              : "mdi-folder-outline"
          }}
        </v-icon>
      </v-btn>

      <!-- Bot/Chat mode switch - single button, hidden in chat mobile menu -->
      <v-btn
        v-if="!customizer.chatNavigationInSidebar && (!isChatPath || !$vuetify.display.smAndDown)"
        class="mode-switch-btn"
        :class="{ 'mr-4 hidden-xs': !isChatPath }"
        variant="text"
        size="small"
        rounded="sm"
        :ripple="false"
        @click="switchMode"
      >
        <v-icon start>{{ nextMode === "bot" ? "mdi-robot" : "mdi-chat" }}</v-icon>
        <span class="mode-switch-label">{{
          nextMode === "bot" ? t("core.navigation.botMode") : t("core.navigation.chat")
        }}</span>
      </v-btn>

      <!-- 功能菜单 -->
      <StyledMenu v-model="mainMenuOpen" offset="12" location="bottom end">
        <template v-slot:activator="{ props: activatorProps }">
          <v-btn
            v-bind="activatorProps"
            size="small"
            :class="[
              'action-btn',
              isChatPath ? 'chat-action-btn' : 'mr-4',
            ]"
            :color="isChatPath ? undefined : 'var(--v-theme-surface)'"
            :variant="isChatPath ? 'text' : 'flat'"
            rounded="sm"
            icon
            :ripple="false"
          >
            <v-icon>mdi-dots-vertical</v-icon>
            <span class="header-toolbar-label">{{ t("core.navigation.options") }}</span>
          </v-btn>
        </template>

        <!-- Bot/Chat 模式切换 - 仅在手机端显示 -->
        <template
          v-if="
            !customizer.chatNavigationInSidebar && (
              (isChatPath && $vuetify.display.smAndDown) ||
              (!isChatPath && $vuetify.display.xs)
            )
          "
        >
          <div class="mobile-mode-switch-wrapper">
            <v-btn
              class="mobile-mode-switch-btn"
              variant="text"
              block
              @click="switchMode"
            >
              <v-icon start>{{
                nextMode === "bot" ? "mdi-robot" : "mdi-chat"
              }}</v-icon>
              {{
                nextMode === "bot"
                  ? t("core.navigation.botMode")
                  : t("core.navigation.chat")
              }}
            </v-btn>
          </div>
          <v-divider class="my-1" />
        </template>

        <!-- 语言切换分组 -->
        <v-menu
          open-on-click
          :open-on-hover="!$vuetify.display.xs"
          :open-delay="!$vuetify.display.xs ? 60 : 0"
          :close-delay="!$vuetify.display.xs ? 120 : 0"
          :location="$vuetify.display.xs ? 'bottom' : 'start center'"
          offset="8"
        >
          <template v-slot:activator="{ props: languageMenuProps }">
            <v-list-item
              v-bind="languageMenuProps"
              @click.stop
              class="styled-menu-item language-group-trigger"
              rounded="md"
            >
              <template v-slot:prepend>
                <v-icon>mdi-translate</v-icon>
              </template>
              <v-list-item-title>{{
                t("core.common.language")
              }}</v-list-item-title>
              <template v-slot:append>
                <span class="language-group-current">{{
                  currentLanguage?.flag
                }}</span>
                <v-icon size="18" class="language-group-arrow"
                  >mdi-chevron-right</v-icon
                >
              </template>
            </v-list-item>
          </template>

          <v-card
            class="styled-menu-card"
            style="min-width: 180px"
            elevation="8"
            rounded="lg"
          >
            <v-list density="compact" class="styled-menu-list pa-1">
              <v-list-item
                v-for="lang in languages"
                :key="lang.code"
                :value="lang.code"
                @click="changeLanguage(lang.code)"
                :class="{
                  'styled-menu-item-active': currentLocale === lang.code,
                }"
                class="styled-menu-item"
                rounded="md"
              >
                <template v-slot:prepend>
                  <span class="language-flag">{{ lang.flag }}</span>
                </template>
                <v-list-item-title>{{ lang.name }}</v-list-item-title>
              </v-list-item>
            </v-list>
          </v-card>
        </v-menu>

      <!-- 主题切换分组 -->
      <v-menu
        open-on-click
        :open-on-hover="!$vuetify.display.xs"
        :open-delay="!$vuetify.display.xs ? 60 : 0"
        :close-delay="!$vuetify.display.xs ? 120 : 0"
        :location="$vuetify.display.xs ? 'bottom' : 'start center'"
        offset="8"
      >
        <template v-slot:activator="{ props: themeMenuProps }">
          <v-list-item
            v-bind="themeMenuProps"
            @click.stop
            class="styled-menu-item theme-group-trigger"
            rounded="md"
          >
            <template v-slot:prepend>
              <v-icon>mdi-brightness-6</v-icon>
            </template>
            <v-list-item-title>{{
              t("core.header.buttons.theme.title")
            }}</v-list-item-title>
            <template v-slot:append>
              <span class="theme-group-current">
                <v-icon size="16">{{
                  customizer.themeMode === 'dark'
                    ? 'mdi-weather-night'
                    : customizer.themeMode === 'system'
                      ? 'mdi-theme-light-dark'
                      : 'mdi-white-balance-sunny'
                }}</v-icon>
              </span>
              <v-icon size="18" class="language-group-arrow">mdi-chevron-right</v-icon>
            </template>
          </v-list-item>
        </template>

        <v-card
          class="styled-menu-card"
          style="min-width: 170px"
          elevation="8"
          rounded="lg"
        >
          <v-list density="compact" class="styled-menu-list pa-1">
            <v-list-item
              v-for="option in themeOptions"
              :key="option.mode"
              @click="setThemeMode(option.mode)"
              :class="{
                'styled-menu-item-active': customizer.themeMode === option.mode,
              }"
              class="styled-menu-item"
              rounded="md"
            >
              <template v-slot:prepend>
                <v-icon size="18" class="theme-option-icon">{{ option.icon }}</v-icon>
              </template>
              <v-list-item-title>{{ t(option.labelKey) }}</v-list-item-title>
            </v-list-item>
          </v-list>
        </v-card>
      </v-menu>

      <!-- 账户按钮 -->
      <v-list-item @click="dialog = true" class="styled-menu-item" rounded="md">
        <template v-slot:prepend>
          <v-icon>mdi-account</v-icon>
        </template>
        <v-list-item-title>{{
          t("core.header.accountDialog.title")
        }}</v-list-item-title>
      </v-list-item>

      <v-divider class="my-1" />

      <v-list-item
        @click="authStore.logout()"
        class="styled-menu-item text-error"
        prepend-icon="mdi-logout"
        rounded="md"
      >
        <v-list-item-title>
          {{ t("core.header.buttons.logout") }}
        </v-list-item-title>
      </v-list-item>
      </StyledMenu>
      <!-- Keep the Teleport destination mounted while ChatUI leaves or re-enters. -->
      <div v-show="isChatPath" id="chat-workbench-header" />
      <!-- Custom caption buttons on Windows, where the native title bar is disabled. -->
      <div v-if="isWindowsDesktop" class="header-caption-btns">
        <v-btn
          class="caption-btn"
          variant="text"
          :ripple="false"
          aria-label="Minimize"
          @click="astrbotDesktop?.minimizeWindow?.()"
        >
          <Minus :size="16" />
        </v-btn>
        <v-btn
          class="caption-btn"
          variant="text"
          :ripple="false"
          aria-label="Maximize"
          @click="astrbotDesktop?.toggleMaximizeWindow?.()"
        >
          <Square :size="14" />
        </v-btn>
        <v-btn
          class="caption-btn caption-btn--close"
          variant="text"
          :ripple="false"
          aria-label="Close"
          @click="astrbotDesktop?.closeWindow?.()"
        >
          <X :size="16" />
        </v-btn>
      </div>
    </div>

    <!-- 账户对话框 -->
    <v-dialog
      v-model="dialog"
      persistent
      :max-width="$vuetify.display.xs ? '90%' : '500'"
    >
      <v-card class="account-dialog">
        <v-card-text class="py-6">
          <div class="d-flex flex-column align-start mb-6">
            <logo
              :title="t('core.header.logoTitle')"
              :subtitle="t('core.header.accountDialog.title')"
            ></logo>
          </div>
          <v-alert
            v-if="accountWarning"
            type="warning"
            variant="tonal"
            border="start"
            class="mb-4"
          >
            <strong>{{
              t(
                accountWarningUpgrade
                  ? "core.header.accountDialog.securityWarningUpgrade"
                  : accountWarningMd5
                  ? "core.header.accountDialog.securityWarningMd5"
                  : "core.header.accountDialog.securityWarning",
              )
            }}</strong>
          </v-alert>

          <v-alert
            v-if="accountEditStatus.success"
            type="success"
            variant="tonal"
            border="start"
            class="mb-4"
          >
            {{ accountEditStatus.message }}
          </v-alert>

          <v-alert
            v-if="accountEditStatus.error"
            type="error"
            variant="tonal"
            border="start"
            class="mb-4"
          >
            {{ accountEditStatus.message }}
          </v-alert>

          <v-form v-model="formValid" @submit.prevent="accountEdit">
            <v-text-field
              ref="currentPasswordInput"
              v-model="password"
              :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
              :type="showPassword ? 'text' : 'password'"
              :label="t('core.header.accountDialog.form.currentPassword')"
              variant="outlined"
              required
              clearable
              @click:append-inner="showPassword = !showPassword"
              @keydown.tab.exact.prevent="newPasswordInput?.focus()"
              prepend-inner-icon="mdi-lock-outline"
              hide-details="auto"
              class="mb-4"
            ></v-text-field>

            <v-text-field
              ref="newPasswordInput"
              v-model="newPassword"
              :append-inner-icon="showNewPassword ? 'mdi-eye-off' : 'mdi-eye'"
              :type="showNewPassword ? 'text' : 'password'"
              :rules="passwordRules"
              :label="t('core.header.accountDialog.form.newPassword')"
              variant="outlined"
              clearable
              @click:append-inner="showNewPassword = !showNewPassword"
              @keydown.tab.shift.prevent="currentPasswordInput?.focus()"
              @keydown.tab.exact.prevent="confirmPasswordInput?.focus()"
              prepend-inner-icon="mdi-lock-plus-outline"
              :hint="t('core.header.accountDialog.form.passwordHint')"
              persistent-hint
              class="mb-4"
            ></v-text-field>

            <v-text-field
              ref="confirmPasswordInput"
              v-model="confirmPassword"
              :append-inner-icon="
                showConfirmPassword ? 'mdi-eye-off' : 'mdi-eye'
              "
              :type="showConfirmPassword ? 'text' : 'password'"
              :rules="confirmPasswordRules"
              :label="t('core.header.accountDialog.form.confirmPassword')"
              variant="outlined"
              clearable
              @click:append-inner="showConfirmPassword = !showConfirmPassword"
              @keydown.tab.shift.prevent="newPasswordInput?.focus()"
              @keydown.tab.exact.prevent="newUsernameInput?.focus()"
              prepend-inner-icon="mdi-lock-check-outline"
              :hint="t('core.header.accountDialog.form.confirmPasswordHint')"
              persistent-hint
              class="mb-4"
            ></v-text-field>

            <v-text-field
              ref="newUsernameInput"
              v-model="newUsername"
              :rules="usernameRules"
              :label="t('core.header.accountDialog.form.newUsername')"
              variant="outlined"
              clearable
              @keydown.tab.shift.prevent="confirmPasswordInput?.focus()"
              prepend-inner-icon="mdi-account-edit-outline"
              :hint="t('core.header.accountDialog.form.usernameHint')"
              persistent-hint
              class="mb-3"
            ></v-text-field>
          </v-form>

          <div class="text-caption text-medium-emphasis mt-2">
            {{ t("core.header.accountDialog.form.defaultCredentials") }}
          </div>
        </v-card-text>

        <v-card-actions class="pa-4">
          <v-spacer></v-spacer>
          <v-btn
            v-if="!accountWarning"
            variant="tonal"
            color="secondary"
            @click="dialog = false"
            :disabled="accountEditStatus.loading"
          >
            {{ t("core.header.accountDialog.actions.cancel") }}
          </v-btn>
          <v-btn
            color="primary"
            variant="tonal"
            @click="accountEdit"
            :loading="accountEditStatus.loading"
            :disabled="!formValid"
            prepend-icon="mdi-content-save"
          >
            {{ t("core.header.accountDialog.actions.save") }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

  </v-app-bar>
</template>

<style>
.markdown-content h1 {
  font-size: 1.3em;
}

.markdown-content ol {
  padding-left: 24px;
  /* Adds indentation to ordered lists */
  margin-top: 8px;
  margin-bottom: 8px;
}

.markdown-content ul {
  padding-left: 24px;
  /* Adds indentation to unordered lists */
  margin-top: 8px;
  margin-bottom: 8px;
}

.account-dialog .v-card-text {
  padding-top: 24px;
  padding-bottom: 24px;
}

.account-dialog .v-alert {
  margin-bottom: 20px;
}

.account-dialog .v-btn {
  text-transform: none;
  font-weight: 500;
  border-radius: 8px;
}

.account-dialog .v-avatar {
  transition: transform 0.3s ease;
}

.account-dialog .v-avatar:hover {
  transform: scale(1.05);
}

.account-dialog-header {
  .theme-toggle-btn {
    opacity: 0.85;

    &:hover {
      opacity: 1;
    }
  }
}

.theme-toggle-btn {
  margin-left: 0;
}

.release-table-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.release-prerelease-switch {
  flex: 0 1 auto;
}

.top-header.chat-mode-header {
  background: var(--astrbot-chrome-bg, #fdfcfc) !important;
  border-bottom: 0;
  box-shadow: none !important;
}

.top-header.chat-mode-header .v-toolbar__content {
  padding: 0 16px 0 20px;
  background: transparent !important;
}

.chat-mobile-sidebar-toggle {
  width: 32px !important;
  height: 32px !important;
  min-width: 32px !important;
  flex: 0 0 32px;
  margin-right: 10px;
  padding: 0 !important;
  color: rgb(var(--v-theme-on-surface));
  border-radius: 8px !important;
  background: transparent !important;
}

.chat-mobile-sidebar-toggle .v-btn__content {
  height: 32px;
  align-items: center;
}

.chat-mobile-sidebar-toggle .v-btn__overlay {
  opacity: 0;
}

.chat-header-context {
  min-width: 0;
  max-width: clamp(180px, calc(100vw - 600px), 460px);
  align-self: stretch;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 5px 18px 5px 0;
  overflow: hidden;
}

.chat-header-context .provider-trigger--header {
  max-width: 100%;
}

.chat-header-context .provider-trigger-copy {
  max-width: 100%;
}

.chat-header-context .provider-trigger-title {
  min-width: 0;
  max-width: min(300px, 52vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-header-context .provider-trigger-meta {
  max-width: 150px;
}

.chat-header-subtitle {
  min-width: 0;
  margin-top: 2px;
  overflow: hidden;
  color: rgba(var(--v-theme-on-surface), 0.5);
  font-size: 11px;
  font-weight: 500;
  line-height: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.chat-header-actions {
  gap: 10px;
  margin-right: 0;
}

.workspace-files-trigger {
  color: rgb(var(--v-theme-on-surface));
}

.workspace-files-trigger--active {
  background: rgba(var(--v-theme-on-surface), 0.08) !important;
}

.mode-switch-btn {
  margin: 0;
  border: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  box-shadow: none;
}

.mode-switch-btn {
  min-width: 62px;
  background: transparent !important;
  padding: 0 6px;
}

.mode-switch-btn .v-btn__overlay {
  opacity: 0 !important;
}

.mode-switch-btn .v-icon {
  font-size: 19px;
}

.chat-action-btn {
  margin-right: 0;
  color: rgb(var(--v-theme-on-surface));
}

.action-btn {
  margin-right: 6px;
}

.language-flag {
  font-size: 16px;
  margin-right: 8px;
}

.language-group-trigger :deep(.v-list-item__append) {
  display: flex;
  align-items: center;
  gap: 6px;
}

.language-group-current {
  font-size: 16px;
  line-height: 1;
}

.language-group-arrow {
  opacity: 0.7;
}

.language-submenu-card {
  min-width: 180px;
}

.theme-group-trigger :deep(.v-list-item__append) {
  display: flex;
  align-items: center;
  gap: 6px;
}

.theme-group-current {
  display: flex;
  align-items: center;
  opacity: 0.75;
}

.theme-option-icon {
  margin-right: 8px;
  opacity: 0.85;
}

.mobile-mode-switch-wrapper {
  display: flex;
  justify-content: center;
  padding: 8px 12px 4px;
}

.mobile-mode-switch-btn {
  width: 100%;
  justify-content: flex-start;
  color: rgb(var(--v-theme-on-surface));
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}

.mobile-mode-switch-btn .v-icon {
  font-size: 19px;
}

.mobile-mode-switch-btn .v-btn__overlay {
  opacity: 0 !important;
}

/* 移动端对话框标题样式 */
.mobile-card-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.update-summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.update-progress-panel,
.dashboard-update-banner,
.release-message-preview {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  padding: 16px;
}

.update-progress-panel {
  overflow: hidden;
  position: relative;
  transition:
    border-color 0.9s ease,
    box-shadow 0.9s ease;
}

.update-progress-panel::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    135deg,
    rgba(var(--v-theme-success), 0.16),
    rgba(var(--v-theme-success), 0.07)
  );
  opacity: 0;
  pointer-events: none;
  transition: opacity 1.1s ease;
}

.update-progress-panel > * {
  position: relative;
  z-index: 1;
}

.release-message-preview {
  max-height: 220px;
  overflow: hidden;
  position: relative;
}

.release-message-preview::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 56px;
  background: linear-gradient(
    to bottom,
    rgba(var(--v-theme-surface), 0),
    rgb(var(--v-theme-surface))
  );
  pointer-events: none;
}

.dashboard-update-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.update-progress-panel--success {
  border-color: rgba(var(--v-theme-success), 0.48);
  box-shadow: inset 0 0 0 1px rgba(var(--v-theme-success), 0.08);
}

.update-progress-panel--success::before {
  animation: update-success-green-in 1.2s ease-out;
  opacity: 1;
}

.update-feedback-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 150px;
  padding: 18px 0 22px;
  text-align: center;
}

.update-feedback-panel--success {
  animation: update-success-content-in 0.45s ease-out both;
}

@keyframes update-success-green-in {
  from {
    opacity: 0;
    transform: scale(1.04);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes update-success-content-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.advanced-settings-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  font: inherit;
  font-weight: 500;
  padding: 8px 0;
  text-align: left;
}

.advanced-settings-toggle:hover {
  color: rgb(var(--v-theme-primary));
}

.update-stage-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.update-stage-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.update-stage-content {
  flex: 1;
  min-width: 0;
}

.update-stage-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 6px;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 12px;
}

/* 移动端样式优化 */
@media (max-width: 600px) {
  .action-btn {
    margin-right: 4px;
    min-width: 32px !important;
    width: 32px;
  }

  .v-card-title {
    padding: 12px 16px;
  }

  .v-card-text {
    padding: 16px;
  }

  .v-tabs .v-tab {
    padding: 0 10px;
    font-size: 0.9rem;
  }

  /* 移动端模式切换按钮样式 */
  .v-btn-toggle {
    margin-right: 8px;
  }

  .v-btn-toggle .v-btn {
    font-size: 0.75rem;
    padding: 0 8px;
  }

  .v-btn-toggle .v-icon {
    font-size: 16px;
  }

  .chat-header-actions .chat-action-btn,
  .chat-header-actions .mode-switch-btn {
    margin-right: 0;
  }

  .top-header.chat-mode-header .v-toolbar__content {
    padding: 0 12px 0 14px;
  }

  .chat-header-context {
    max-width: calc(100vw - 92px);
    padding-right: 8px;
  }

  .update-summary,
  .dashboard-update-banner {
    align-items: stretch;
    flex-direction: column;
  }
}

/* The header doubles as a slim toolbar, so its actions follow the provider tab
   styling. On macOS desktop it also becomes the draggable window chrome.
   This style block is NOT scoped, so plain selectors are already global here. */
.top-header {
  user-select: none;
}

.top-header .update-notice {
  cursor: pointer;
}

.top-header .update-notice:hover {
  text-decoration: underline;
}

/* Mount point for page-contextual toolbar content (see the template note). */
.app-header-context {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 100%;
  min-width: 0;
}

/* The toolbar background spans the window, while page-specific context starts
   where the permanent chat sidebar ends. Keeping this offset on the content
   mount point avoids moving the toolbar itself and keeps the sidebar brand
   unobstructed. */
.top-header.chat-mode-header .app-header-context {
  margin-left: var(--astrbot-chat-sidebar-width, 0px);
}

html {
  /* Keep in sync with the app bar height above. */
  --astrbot-toolbar-height: 42px;
}

.top-header,
.top-header.chat-mode-header,
.top-header.chat-mode-header.chat-mode-header--dark {
  background: var(--astrbot-chrome-bg, #f2f2f7) !important;
  border-bottom: 0 !important;
  box-shadow: none !important;
}

html[data-astrbot-desktop-platform='macos'] .top-header,
html[data-astrbot-desktop-platform='macos'] .top-header.chat-mode-header,
html[data-astrbot-desktop-platform='macos'] .top-header.chat-mode-header.chat-mode-header--dark {
  background: var(--astrbot-vibrancy-tint, transparent) !important;
}

/* Keep the toolbar in the normal flow so the content area sits below it instead of
   scrolling underneath a floating bar. */
.top-header {
  position: relative !important;
  top: 0 !important;
  /* Vuetify's app-bar layout writes the drawer offset as inline left/width
     values. The toolbar is shared window chrome, so it must cover that area
     too; otherwise a transparent macOS window exposes its native material as
     a visible block above the sidebar. */
  left: 0 !important;
  right: auto !important;
  width: 100% !important;
}


.top-header .v-toolbar__content {
  padding-inline-end: 24px !important;
}

/* On macOS the traffic lights sit over the toolbar's left zone once the sidebar
   is no longer permanent, so the menu button must clear them. */
@media (max-width: 959.98px) {
  html[data-astrbot-desktop-platform='macos'] .top-header .v-toolbar__content {
    padding-inline-start: 74px !important;
  }
}

.top-header .header-menu-btn {
  width: 36px;
  height: 36px;
  border-radius: 8px !important;
  color: rgba(var(--v-theme-on-surface), 0.58);
}

.top-header .header-menu-btn:hover {
  color: rgba(var(--v-theme-on-surface), 0.9);
}

.top-header .v-toolbar__content > .header-menu-btn--browser:first-child {
  margin-inline-start: -12px;
  margin-inline-end: 12px;
}

.header-toolbar-label {
  display: inline;
  margin-inline-start: 6px;
}

.top-header .header-actions .v-btn {
  height: 34px;
  padding: 0 12px;
  border-radius: 8px;
  background: transparent !important;
  box-shadow: none !important;
  color: rgba(var(--v-theme-on-surface), 0.58);
  font-size: 0.8125rem;
  font-weight: 500;
  letter-spacing: normal;
  text-transform: none;
}

.top-header .header-actions .v-btn .v-btn__overlay {
  opacity: 0 !important;
}

/* Hover keeps a text-only affordance: no background, just a stronger label color. */
.top-header .header-actions .v-btn:hover {
  color: rgba(var(--v-theme-on-surface), 0.9);
}

/* Normalize header action contents: identical font size and unit line-height so
   icon+label stay mutually centered across platform font metrics (Windows
   otherwise shows a 1-2px optical offset between the buttons). */
.top-header .header-actions .v-btn {
  font-size: 0.8125rem;
}

.top-header .header-actions .v-btn .v-btn__content {
  display: inline-flex;
  align-items: center;
  line-height: 1;
}

.top-header .header-actions .v-btn .v-icon {
  display: inline-flex;
  align-items: center;
  line-height: 1;
}

.top-header .header-actions .v-btn .mode-switch-label,
.top-header .header-actions .v-btn .header-toolbar-label {
  display: inline-flex;
  align-items: center;
  line-height: 1;
}

/* Keep the two header variants on the same right edge. The bot view used a
   Vuetify mr-4 utility while chat used the action button's 6px margin, which
   made the same controls shift by a few pixels between panels. */
.top-header .header-actions .mode-switch-btn,
.top-header .header-actions .action-btn {
  margin-right: 0 !important;
}

.top-header .header-actions .mode-switch-btn {
  width: 66px;
  min-width: 66px;
}

.top-header .header-actions .action-btn {
  width: 74px !important;
  min-width: 74px !important;
  justify-content: center;
}

.header-caption-btns {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-inline-start: 8px;
}

.top-header .header-caption-btns .caption-btn {
  width: 40px;
  min-width: 40px;
  height: 34px;
  padding: 0;
  border-radius: 8px;
  background: transparent !important;
  box-shadow: none !important;
  color: rgba(var(--v-theme-on-surface), 0.58);
}

.top-header .header-caption-btns .caption-btn:hover {
  background: rgba(var(--v-theme-on-surface), 0.08) !important;
  color: rgba(var(--v-theme-on-surface), 0.9);
}

/* Windows convention: the close button turns red on hover. */
.top-header .header-caption-btns .caption-btn--close:hover {
  background: rgba(232, 17, 35, 0.9) !important;
  color: #fff;
}

</style>

<style>
#chat-workbench-header:empty {
  display: none;
}
#chat-workbench-header {
  min-width: 0;
  flex-shrink: 0;
}
#chat-workbench-header:has(.workbench-launcher) {
  display: flex;
  align-items: center;
  padding: 0 8px;
  height: var(--astrbot-toolbar-height);
}
#chat-workbench-header:has(.workbench-header) {
  width: calc(var(--astrbot-workbench-width) - var(--workbench-caption-width, 0px));
  border-left: 1px solid rgba(var(--v-theme-on-surface), 0.1);
}
.top-header:has(#chat-workbench-header .workbench-header) {
  --astrbot-active-workbench-width: var(--astrbot-workbench-width);
}
.top-header:has(#chat-workbench-header:not(:empty)) .header-actions {
  margin-right: -18px;
}
.top-header:has(.header-caption-btns) {
  --workbench-caption-width: 132px;
}
@media (min-width: 960px) and (max-width: 1400px) {
  .top-header:has(#chat-workbench-header .workbench-header) .chat-toolbar-context-title {
    display: none;
  }
}
</style>
