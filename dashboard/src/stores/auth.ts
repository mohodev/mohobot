import { defineStore } from 'pinia';
import { useCustomizerStore } from '@/stores/customizer';
import { chatPreferences } from '@/utils/chatPreferences';
import { router } from '@/router';
import { httpClient, MOHO_SESSION_KEY, MOHO_SESSION_USER_KEY } from '@/api/http';

// MohoBot auth (see docs/openapi.yaml):
//   POST /api/auth/login  { username, password } -> 201 { ok, token, auth }
//   POST /api/setup/init  { username, password } -> { ok, token, masterToken }
//   GET  /api/setup/status -> { initialized, users }
//   POST /api/auth/logout -> { ok }
// There is no TOTP, no password-upgrade flow and no legacy token fallback
// in MohoBot, so the AstrBot-specific branches were removed.

interface MohoSessionData {
  username: string;
  token: string;
  masterToken?: string;
}

function setupStatus(): Promise<{ initialized: boolean; users: number }> {
  return httpClient
    .get('/api/setup/status', { validateStatus: () => true })
    .then((res) => ({
      initialized: res.data?.initialized === true,
      users: Number(res.data?.users ?? 0),
    }));
}

export const useAuthStore = defineStore("auth", {
  state: () => ({
    username: '',
    returnUrl: null as string | null,
    // Shown once after first-run setup; the server only issues it at init.
    masterToken: '',
  }),
  actions: {
    async finishAuthenticatedSession(data: MohoSessionData): Promise<void> {
      this.username = data.username;
      try {
        sessionStorage.setItem(MOHO_SESSION_KEY, data.token);
        sessionStorage.setItem(MOHO_SESSION_USER_KEY, data.username);
        if (data.masterToken) {
          this.masterToken = data.masterToken;
        }
      } catch {
        // Storage failure surfaces on the next authenticated request.
      }
      useCustomizerStore().chatNavigationInSidebar = chatPreferences().global.navigationInSidebar === true;

      const onboardingCompleted = await this.checkOnboardingCompleted();
      this.returnUrl = null;
      if (onboardingCompleted) {
        router.push('/dashboard/default');
      } else {
        router.push('/welcome');
      }
    },
    async login(username: string, password: string): Promise<void> {
      try {
        const res = await httpClient.post(
          '/api/auth/login',
          { username, password },
          { validateStatus: () => true },
        );
        const data = res.data ?? {};
        if (res.status === 409) {
          return Promise.reject('account locked');
        }
        if (res.status !== 201 || data.ok === false || !data.token) {
          return Promise.reject(String(data.error || '登录失败'));
        }
        const sessionUsername =
          String(data.auth?.user?.username || data.auth?.username || username);
        await this.finishAuthenticatedSession({
          username: sessionUsername,
          token: String(data.token),
        });
      } catch (error: any) {
        return Promise.reject(
          error?.response?.data?.error || error?.response?.data?.message || error,
        );
      }
    },
    async setup(
      username: string,
      password: string,
      _confirmPassword: string,
    ): Promise<void> {
      try {
        const res = await httpClient.post(
          '/api/setup/init',
          { username, password },
          { validateStatus: () => true },
        );
        const data = res.data ?? {};
        if (!res.status || res.status >= 400 || data.ok === false || !data.token) {
          return Promise.reject(String(data.error || data.message || '初始化失败'));
        }
        await this.finishAuthenticatedSession({
          username,
          token: String(data.token),
          masterToken: data.masterToken ? String(data.masterToken) : undefined,
        });
      } catch (error: any) {
        return Promise.reject(
          error?.response?.data?.error || error?.response?.data?.message || error,
        );
      }
    },
    async checkOnboardingCompleted(): Promise<boolean> {
      // MohoBot has no AstrBot-style platform/provider onboarding; a
      // deployment counts as onboarded once first-run setup has run.
      try {
        const status = await setupStatus();
        return status.initialized;
      } catch (e) {
        console.error('Failed to check setup status:', e);
        return false;
      }
    },
    logout() {
      this.username = '';
      this.masterToken = '';
      useCustomizerStore().chatNavigationInSidebar = false;
      try {
        sessionStorage.removeItem(MOHO_SESSION_KEY);
        sessionStorage.removeItem(MOHO_SESSION_USER_KEY);
      } catch {
        // Storage availability must not prevent logout or the in-memory reset.
      }
      void httpClient.post('/api/auth/logout').catch(() => undefined);
      router.push('/auth/login');
    },
    has_token(): boolean {
      try {
        return !!sessionStorage.getItem(MOHO_SESSION_KEY);
      } catch {
        return false;
      }
    }
  }
});
