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
  model?: string;
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
  baseUrlConfigured?: boolean;
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

/* ------------------------------------------------------------------ *
 * Shared domain types (frozen contract).
 *
 * Pages import these instead of re-declaring inline interfaces, so the
 * whole dashboard agrees on API response shapes. Optional fields reflect
 * records that the Admin API may omit or that older builds may not send.
 * ------------------------------------------------------------------ */

/** Envelope returned by the authenticated Admin API for JSON GET endpoints. */
export interface BotsResponse { bots?: BotSnapshot[]; }
export interface StatusResponse { now?: string; bots?: BotSnapshot[]; }

export interface OpsPage<T> { items: T[]; limit: number; offset: number; hasMore: boolean; }

export interface OpsSession {
  id: string;
  botId: string;
  channelId: string;
  userId?: string;
  updatedAt: number;
  messageCount: number;
  deletedCount: number;
  contentLength: number;
  summaryHash: string;
}

export interface OpsAudit {
  id: string;
  at: string;
  actor: string;
  action: string;
  outcome: 'allowed' | 'denied';
  detail: string;
  method: string;
  path: string;
  status: number;
}

export interface OpsTask {
  id: string;
  name: string;
  kind: string;
  state: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  runs: number;
  errors: number;
  lastRunMs?: number;
  lastErrorCode?: string;
}

export interface HealthSnapshot {
  runtime?: string;
  bots?: number;
  [key: string]: unknown;
}

export interface ConfigPublication {
  revision?: string;
  publishedAt?: string;
  publishedBy?: string;
  status?: string;
  active?: boolean;
  [key: string]: unknown;
}

export interface ActivationReceipt {
  scope?: string;
  revision?: string;
  acknowledgedAt?: string;
  [key: string]: unknown;
}

export interface WorldEvent { id: string; type: string; text: string; at: string; }

export interface ScheduledWorldEvent {
  id: string;
  at: number;
  type: string;
  text?: string;
  trust?: 'candidate' | 'confirmed' | 'rejected';
  [key: string]: unknown;
}

export interface WorldState {
  clock: string;
  weather: string;
  location: string;
  activity: string;
  mood: Record<string, number>;
  events: WorldEvent[];
  schedule: ScheduledWorldEvent[];
  appliedPhases: string[];
}

export type NetworkState = 'wifi' | 'cellular' | 'weak' | 'offline';
export type DeviceActivity = 'idle' | 'browsing' | 'chatting' | 'gaming' | 'sleeping' | 'charging';

export interface DeviceHabits {
  checksPhoneWhileCharging: boolean;
  chargeBelow: number;
  ignoresNotificationsWhile: DeviceActivity[];
  delayedReplyProbability: number;
}

export interface DeviceState {
  battery: number;
  charging: boolean;
  network: NetworkState;
  screen: 'on' | 'off';
  doNotDisturb: boolean;
  activity: DeviceActivity;
  lastSeenAt: string;
  notificationCount: number;
  habits: DeviceHabits;
}

export interface AffinityRecord {
  botId: string;
  userId: string;
  score: number;
  interactions: number;
  lastReason: string;
  updatedAt: string;
  notes: string[];
}

export interface AdminUser {
  username: string;
  role: string;
  enabled: boolean;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export interface TemporaryToken {
  id: string;
  label?: string;
  role: string;
  createdBy?: string;
  createdAt?: number;
  expiresAt?: number;
  [key: string]: unknown;
}

export interface AdminSession {
  id: string;
  username?: string;
  role?: string;
  createdAt?: number;
  lastSeenAt?: number;
  current?: boolean;
  [key: string]: unknown;
}

export interface FutureTask {
  id: string;
  type: string;
  status: string;
  owner: string;
  scheduledAt: number;
  attempts?: number;
  maxRetries?: number;
  lastError?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PluginRecord { id: string; state: string; errors: number; [key: string]: unknown; }

export interface CharacterRecord {
  id: string;
  name?: string;
  description?: string;
  promptLength?: number;
  prompt?: string;
  tags?: string[];
  enabled?: boolean;
  revision?: string;
  [key: string]: unknown;
}

export interface KnowledgeBase { id: string; name?: string; description?: string; [key: string]: unknown; }
export interface KnowledgeDocument { id: string; baseId?: string; name?: string; textLength?: number; [key: string]: unknown; }
export interface KnowledgeBinding { baseId?: string; targetType: 'bot' | 'character' | string; targetId: string; [key: string]: unknown; }

export interface McpRule { pattern: string; minRole: string; }
export interface McpServer { id: string; transport: string; initialized: boolean; toolCount: number; error?: string; }
export interface McpTool { server: string; name: string; description?: string; inputSchema?: Record<string, unknown>; }
export interface McpAuditEntry { id: string; at: string; tool: string; caller: string; outcome: string; detail: string; argsRedacted: string; }
export interface McpCallResult { content?: Array<{ type: string; text?: string; [key: string]: unknown }>; isError?: boolean; [key: string]: unknown; }

export interface MemoryRecord {
  id?: string;
  botId?: string;
  userId?: string;
  channelId?: string;
  scope?: string;
  kind?: string;
  summary?: string;
  updatedAt?: number | string;
  [key: string]: unknown;
}

export interface ModelRecord { id?: string; name?: string; provider?: string; contextLength?: number; [key: string]: unknown; }

/**
 * Props every dashboard page receives from the shell. Pages must export a
 * component matching `export function Name({ permissions }: PageProps)`.
 * `permissions` is the authenticated principal's permission list, used only to
 * show or hide controls; the server always re-authorises every request.
 */
export interface PageProps { permissions: string[] }
