export interface AdminPrincipal {
  id?: string;
  username?: string;
  role?: 'viewer' | 'operator' | 'admin' | 'developer' | string;
  enabled?: boolean;
}

export interface AdminMe {
  ok?: boolean;
  auth?: {
    principal?: AdminPrincipal;
    user?: { username?: string };
  };
  principal?: AdminPrincipal;
  permissions?: string[];
}

export interface ApiPayload {
  ok?: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export interface BotSnapshot {
  id: string;
  name?: string;
  adapter?: string;
  provider?: string;
  running?: boolean;
  state?: string;
  sessions?: number;
  gateway?: {
    connected?: boolean;
    ping?: number;
    reconnects?: number;
  };
}

export interface ProviderRecord {
  botId: string;
  provider: string;
  model: string;
  apiKeyConfigured?: boolean;
  taskRoutes?: Record<string, string>;
}

export interface LogRecord {
  id?: string | number;
  ts?: string | number;
  at?: string;
  level?: string;
  component?: string;
  msg?: string;
  message?: string;
  [key: string]: unknown;
}

export function principalOf(me: AdminMe): AdminPrincipal {
  return me.auth?.principal ?? me.principal ?? {};
}

export function usernameOf(me: AdminMe): string {
  return me.auth?.user?.username ?? principalOf(me).username ?? principalOf(me).id ?? '管理员';
}
