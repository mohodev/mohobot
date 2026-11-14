import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, Ban, CheckCircle2, Clock, KeyRound, Plus, RefreshCw, RotateCcw, ScrollText, Search, ShieldCheck, Trash2, UserCheck, Users as UsersIcon, UserX,
} from 'lucide-react';
import { ApiError, api, body, confirmedRequest } from '../lib/api';
import type { AdminSession, AdminUser, PageProps, TemporaryToken } from '../lib/types';
import { formatDateTime, formatRelative } from '../lib/format';
import { useAsync, useDebouncedValue, useFiltered, useToggle } from '../lib/hooks';
import {
  Button, CopyButton, DataState, Descriptions, EmptyState, Field, Modal, Notice, PageTitle, Panel, Pill, Select, StatCard, Switch, Table, Tabs, TextInput,
} from '../components/ui';

const ROLES = ['viewer', 'operator', 'admin', 'developer'] as const;
type AdminRoleValue = (typeof ROLES)[number];
type AccessTab = 'users' | 'sessions' | 'tokens';

const ROLE_LABELS: Record<AdminRoleValue, string> = {
  viewer: '只读 (viewer)',
  operator: '操作员 (operator)',
  admin: '管理员 (admin)',
  developer: '开发者 (developer)',
};

/** Compact role names for the filter rail; the pills keep the verbose label. */
const ROLE_FILTER_LABELS: Record<AdminRoleValue, string> = {
  viewer: '只读',
  operator: '操作员',
  admin: '管理员',
  developer: '开发者',
};

/** Roles that carry elevated reach; surfaced in the directory summary. */
const PRIVILEGED_ROLES = new Set<string>(['admin', 'developer']);

/** A token inside this window is reported as about to expire, not simply valid. */
const TOKEN_EXPIRING_MS = 60 * 60 * 1000;

function roleTone(role: string): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  if (role === 'developer') return 'danger';
  if (role === 'admin') return 'info';
  if (role === 'operator') return 'warning';
  return 'neutral';
}

interface UserRow extends AdminUser {
  id: string;
  username: string;
  role: AdminRoleValue;
  enabled: boolean;
  lastLoginAt?: number;
  createdAt?: number;
}

interface SessionRow extends AdminSession {
  id: string;
  normalizedUsername?: string;
  expiresAt?: number;
}

interface TokenRow extends TemporaryToken {
  id: string;
  label?: string;
  role: string;
  createdBy?: string;
  expiresAt?: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

type AccessData =
  | { kind: 'users'; users: UserRow[] }
  | { kind: 'sessions'; sessions: SessionRow[] }
  | { kind: 'tokens'; tokens: TokenRow[] };

/** Lifecycle of a temporary token, derived so expiry is never disguised as valid. */
type TokenStatus = 'active' | 'expiring' | 'expired' | 'revoked';

const TOKEN_STATUS: Record<TokenStatus, { tone: 'success' | 'warning' | 'danger'; label: string }> = {
  active: { tone: 'success', label: '有效' },
  expiring: { tone: 'warning', label: '即将过期' },
  expired: { tone: 'danger', label: '已过期' },
  revoked: { tone: 'danger', label: '已吊销' },
};

function tokenStatus(token: TokenRow, now: number = Date.now()): TokenStatus {
  if (token.revokedAt) return 'revoked';
  if (typeof token.expiresAt === 'number') {
    if (token.expiresAt <= now) return 'expired';
    if (token.expiresAt - now <= TOKEN_EXPIRING_MS) return 'expiring';
  }
  return 'active';
}

/** Module-level so the `useFiltered` memo dependency stays stable. */
const USER_SEARCH_FIELDS = (row: UserRow): unknown[] => [row.username, row.id, row.role];

function describeFailure(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.statusCode === 403) return '权限不足（403）：无法分配或创建高于当前账号角色的权限。';
    return cause.message || '操作失败';
  }
  return cause instanceof Error && cause.message ? cause.message : '操作失败';
}

function isCancelled(cause: unknown): boolean {
  return cause instanceof ApiError && cause.statusCode === 0;
}

function RolePill({ role }: { role: string }) {
  return <Pill tone={roleTone(role)}>{ROLE_LABELS[role as AdminRoleValue] ?? role}</Pill>;
}

function ReadOnlyNote({ permission }: { permission: string }) {
  return <span className="muted-text">只读：缺少 {permission} 权限</span>;
}

/**
 * 管理员 / ACCESS CONTROL — 管理员目录、登录会话与临时访问令牌。
 *
 * 数据全部来自 Admin API：
 *  - GET /api/admin/users, POST /api/admin/users, PATCH /api/admin/users/:id,
 *    POST /api/admin/users/:id/password
 *  - GET/DELETE /api/auth/sessions/:id
 *  - GET/POST /api/auth/temporary-tokens, DELETE /api/auth/temporary-tokens/:id
 *
 * 三个分区共享一次取数：切到哪个分区就读取哪个端点（不预取未访问分区）。
 * 危险与可逆写操作（创建账号/改角色/重置密码/创建或吊销令牌）全部走
 * `confirmedRequest` 的服务端 nonce 确认；吊销单条会话是 reversible，无二次确认。
 */
export function Users({ permissions }: PageProps) {
  const [tab, setTab] = useState<AccessTab>('users');
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const allowed = useCallback((permission: string) => permissions.includes(permission), [permissions]);

  const state = useAsync(
    (): Promise<AccessData> => {
      if (tab === 'sessions') {
        return api<{ sessions?: SessionRow[] }>('/auth/sessions')
          .then((result) => ({ kind: 'sessions' as const, sessions: result.sessions ?? [] }));
      }
      if (tab === 'tokens') {
        return api<{ tokens?: TokenRow[] }>('/auth/temporary-tokens')
          .then((result) => ({ kind: 'tokens' as const, tokens: result.tokens ?? [] }));
      }
      return api<{ users?: UserRow[] }>('/admin/users')
        .then((result) => ({ kind: 'users' as const, users: result.users ?? [] }));
    },
    [tab],
    '读取访问控制数据失败',
  );
  const reload = state.reload;
  const active = state.data && state.data.kind === tab ? state.data : undefined;

  /* A running total per partition so the tab rail keeps its counts after a
   * switch instead of dropping back to placeholders. */
  const [counts, setCounts] = useState<Partial<Record<AccessTab, number>>>({});
  useEffect(() => {
    const data = state.data;
    if (!data) return;
    const count = data.kind === 'users' ? data.users.length : data.kind === 'sessions' ? data.sessions.length : data.tokens.length;
    setCounts((previous) => (previous[data.kind] === count ? previous : { ...previous, [data.kind]: count }));
  }, [state.data]);

  const reportSuccess = useCallback((message: string) => {
    setActionError('');
    setActionMessage(message);
  }, []);
  const reportFailure = useCallback((cause: unknown) => {
    if (isCancelled(cause)) return;
    setActionMessage('');
    setActionError(describeFailure(cause));
  }, []);

  /* ------------------------------------------------------------ *
   * 账号：创建 / 编辑 / 重置密码
   * ------------------------------------------------------------ */
  const canCreateUser = allowed('users.create');
  const canEditUser = allowed('users.update');
  const canAssignRole = canEditUser && allowed('users.role.assign');
  const canToggleEnabled = canEditUser && allowed('users.disable');
  const canRotatePassword = allowed('users.credentials.rotate');

  const [createOpen, setCreateOpen] = useToggle(false);
  const [createUsername, setCreateUsername] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState<AdminRoleValue>('viewer');
  const [createEnabled, setCreateEnabled] = useState(true);
  const [createError, setCreateError] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const openCreate = useCallback(() => {
    setCreateUsername('');
    setCreatePassword('');
    setCreateRole('viewer');
    setCreateEnabled(true);
    setCreateError('');
    setCreateOpen(true);
  }, [setCreateOpen]);

  const createUser = useCallback(async () => {
    const payload = { username: createUsername.trim(), password: createPassword, role: createRole, enabled: createEnabled };
    if (!payload.username) { setCreateError('请输入用户名。'); return; }
    if (payload.password.length < 10) { setCreateError('密码至少需要 10 个字符。'); return; }
    setCreateError('');
    setCreateBusy(true);
    try {
      await confirmedRequest('/admin/users', { method: 'POST', body: body(payload) }, payload, `创建管理员账号 ${payload.username}`);
      setCreateOpen(false);
      reportSuccess(`已创建管理员账号 ${payload.username}（${ROLE_LABELS[payload.role]}）。`);
      reload();
    } catch (cause) {
      if (isCancelled(cause)) return;
      setCreateError(describeFailure(cause));
    } finally {
      setCreateBusy(false);
    }
  }, [createUsername, createPassword, createRole, createEnabled, setCreateOpen, reload, reportSuccess]);

  const [editing, setEditing] = useState<UserRow | null>(null);
  const [editUsername, setEditUsername] = useState('');
  const [editRole, setEditRole] = useState<AdminRoleValue>('viewer');
  const [editEnabled, setEditEnabled] = useState(true);
  const [editError, setEditError] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  const openEdit = useCallback((user: UserRow) => {
    setEditing(user);
    setEditUsername(user.username);
    setEditRole(user.role);
    setEditEnabled(user.enabled);
    setEditError('');
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    const user = editing;
    const payload: { username?: string; role?: AdminRoleValue; enabled?: boolean } = {};
    if (editUsername.trim() && editUsername.trim() !== user.username) payload.username = editUsername.trim();
    if (canAssignRole && editRole !== user.role) payload.role = editRole;
    if (canToggleEnabled && editEnabled !== user.enabled) payload.enabled = editEnabled;
    if (Object.keys(payload).length === 0) { setEditError('没有需要保存的更改。'); return; }
    setEditError('');
    setEditBusy(true);
    try {
      await confirmedRequest(
        `/admin/users/${encodeURIComponent(user.id)}`,
        { method: 'PATCH', body: body(payload) },
        payload,
        `更新管理员账号 ${user.username}`,
      );
      setEditing(null);
      reportSuccess(`已更新管理员账号 ${user.username}。`);
      reload();
    } catch (cause) {
      if (isCancelled(cause)) return;
      setEditError(describeFailure(cause));
    } finally {
      setEditBusy(false);
    }
  }, [editing, editUsername, editRole, editEnabled, canAssignRole, canToggleEnabled, reload, reportSuccess]);

  const [rotating, setRotating] = useState<UserRow | null>(null);
  const [rotatePassword, setRotatePassword] = useState('');
  const [rotateError, setRotateError] = useState('');
  const [rotateBusy, setRotateBusy] = useState(false);

  const openRotate = useCallback((user: UserRow) => {
    setRotating(user);
    setRotatePassword('');
    setRotateError('');
  }, []);

  const rotateUserPassword = useCallback(async () => {
    if (!rotating) return;
    const user = rotating;
    if (rotatePassword.length < 10) { setRotateError('密码至少需要 10 个字符。'); return; }
    setRotateError('');
    setRotateBusy(true);
    try {
      const payload = { password: rotatePassword };
      await confirmedRequest(
        `/admin/users/${encodeURIComponent(user.id)}/password`,
        { method: 'POST', body: body(payload) },
        payload,
        `重置管理员账号 ${user.username} 的密码`,
      );
      setRotating(null);
      reportSuccess(`已重置 ${user.username} 的密码，该账号的既有会话已失效。`);
      reload();
    } catch (cause) {
      if (isCancelled(cause)) return;
      setRotateError(describeFailure(cause));
    } finally {
      setRotateBusy(false);
    }
  }, [rotating, rotatePassword, reload, reportSuccess]);

  /* ------------------------------------------------------------ *
   * 会话：吊销
   * ------------------------------------------------------------ */
  const canRevokeSession = allowed('sessions.revoke');
  const [revokingSessionId, setRevokingSessionId] = useState('');

  const revokeSession = useCallback(async (session: SessionRow) => {
    setRevokingSessionId(session.id);
    try {
      await api(`/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      reportSuccess(`已吊销会话 ${session.id}。`);
      reload();
    } catch (cause) {
      reportFailure(cause);
    } finally {
      setRevokingSessionId('');
    }
  }, [reload, reportSuccess, reportFailure]);

  /* ------------------------------------------------------------ *
   * 临时令牌：创建 / 吊销
   * ------------------------------------------------------------ */
  const canCreateToken = allowed('tokens.create');
  const canRevokeToken = allowed('tokens.revoke');

  const [tokenFormOpen, setTokenFormOpen] = useToggle(false);
  const [tokenLabel, setTokenLabel] = useState('');
  const [tokenRole, setTokenRole] = useState<AdminRoleValue>('viewer');
  const [tokenTtl, setTokenTtl] = useState('60');
  const [tokenError, setTokenError] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [issued, setIssued] = useState<{ token: string; record: TokenRow } | null>(null);
  const [revokingTokenId, setRevokingTokenId] = useState('');

  const openTokenForm = useCallback(() => {
    setTokenLabel('');
    setTokenRole('viewer');
    setTokenTtl('60');
    setTokenError('');
    setTokenFormOpen(true);
  }, [setTokenFormOpen]);

  const createToken = useCallback(async () => {
    const label = tokenLabel.trim();
    const ttlMinutes = Number(tokenTtl);
    if (!label) { setTokenError('请输入令牌标签。'); return; }
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 10_080) {
      setTokenError('有效期必须是 1 到 10080 之间的分钟数。');
      return;
    }
    setTokenError('');
    setTokenBusy(true);
    const payload = { label, role: tokenRole, ttlMinutes };
    try {
      const result = await confirmedRequest<{ token?: string; record?: TokenRow }>(
        '/auth/temporary-tokens',
        { method: 'POST', body: body(payload) },
        payload,
        `创建临时令牌 ${label}`,
      );
      const token = typeof result.token === 'string' ? result.token : '';
      if (!token) { setTokenError('服务端没有返回令牌值。'); return; }
      setTokenFormOpen(false);
      setIssued({ token, record: result.record ?? { id: '', role: tokenRole, label } });
      reportSuccess(`已创建临时令牌 ${label}（有效期 ${ttlMinutes} 分钟）。`);
      reload();
    } catch (cause) {
      if (isCancelled(cause)) return;
      setTokenError(describeFailure(cause));
    } finally {
      setTokenBusy(false);
    }
  }, [tokenLabel, tokenTtl, tokenRole, setTokenFormOpen, reload, reportSuccess]);

  const revokeToken = useCallback(async (token: TokenRow) => {
    setRevokingTokenId(token.id);
    try {
      await confirmedRequest(
        `/auth/temporary-tokens/${encodeURIComponent(token.id)}`,
        { method: 'DELETE', body: body({}) },
        {},
        `吊销临时令牌 ${token.label ?? token.id}`,
      );
      reportSuccess(`已吊销临时令牌 ${token.label ?? token.id}。`);
      reload();
    } catch (cause) {
      reportFailure(cause);
    } finally {
      setRevokingTokenId('');
    }
  }, [reload, reportSuccess, reportFailure]);

  /* ------------------------------------------------------------ *
   * 分区数据与派生统计
   * ------------------------------------------------------------ */
  const users = active?.kind === 'users' ? active.users : [];
  const sessions = active?.kind === 'sessions' ? active.sessions : [];
  const tokens = active?.kind === 'tokens' ? active.tokens : [];
  const usersLoaded = active?.kind === 'users';
  const sessionsLoaded = active?.kind === 'sessions';
  const tokensLoaded = active?.kind === 'tokens';

  const userStats = useMemo(() => {
    let enabled = 0;
    let disabled = 0;
    let privileged = 0;
    for (const user of users) {
      if (user.enabled) enabled += 1; else disabled += 1;
      if (PRIVILEGED_ROLES.has(user.role)) privileged += 1;
    }
    return { enabled, disabled, privileged };
  }, [users]);

  const sessionStats = useMemo(() => {
    let current = 0;
    const accounts = new Set<string>();
    for (const session of sessions) {
      if (session.current) current += 1;
      const name = session.normalizedUsername ?? session.username;
      if (name) accounts.add(name);
    }
    return { current, accounts: accounts.size };
  }, [sessions]);

  const tokenStats = useMemo(() => {
    let active = 0;
    let attention = 0;
    let revoked = 0;
    for (const token of tokens) {
      const status = tokenStatus(token);
      if (status === 'active') active += 1;
      else if (status === 'revoked') revoked += 1;
      else attention += 1;
    }
    return { active, attention, revoked };
  }, [tokens]);

  /* ---- 账号目录过滤（主要运维工作流：按用户名/ID/角色检索） ---- */
  const [userQuery, setUserQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'' | AdminRoleValue>('');
  const [statusFilter, setStatusFilter] = useState<'' | 'enabled' | 'disabled'>('');
  const debouncedUserQuery = useDebouncedValue(userQuery, 200);
  const searchedUsers = useFiltered(users, debouncedUserQuery, USER_SEARCH_FIELDS);
  const visibleUsers = useMemo(() => searchedUsers.filter((user) => {
    if (roleFilter && user.role !== roleFilter) return false;
    if (statusFilter === 'enabled' && !user.enabled) return false;
    if (statusFilter === 'disabled' && user.enabled) return false;
    return true;
  }), [searchedUsers, roleFilter, statusFilter]);
  const userFiltering = Boolean(debouncedUserQuery) || Boolean(roleFilter) || Boolean(statusFilter);

  const resetUserFilters = useCallback(() => {
    setUserQuery('');
    setRoleFilter('');
    setStatusFilter('');
  }, []);

  const tabOptions = useMemo(() => ([
    { value: 'users' as const, label: '账号', count: counts.users },
    { value: 'sessions' as const, label: '会话', count: counts.sessions },
    { value: 'tokens' as const, label: '临时令牌', count: counts.tokens },
  ]), [counts]);

  return (
    <>
      <PageTitle
        eyebrow="ACCESS CONTROL"
        title="管理员"
        description="管理管理员账号、登录会话与临时访问令牌，所有敏感操作均需服务端确认。"
        actions={<Button onClick={reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      <Tabs value={tab} options={tabOptions} onChange={setTab} ariaLabel="访问控制分区" />

      {actionError && <Notice tone="danger" icon={<AlertCircle size={17} />}>{actionError}</Notice>}
      {actionMessage && <Notice tone="info" icon={<CheckCircle2 size={17} />}>{actionMessage}</Notice>}

      <DataState
        loading={state.loading && active === undefined}
        error={state.error}
        onRetry={reload}
      >
        {tab === 'users' && (
          <>
            {users.length > 0 && (
              <div className="stat-grid">
                <StatCard label="账号总数" value={users.length} note="管理员目录" icon={<UsersIcon size={17} />} />
                <StatCard
                  label="启用账号"
                  value={userStats.enabled}
                  note={`${userStats.disabled} 个已禁用`}
                  icon={<UserCheck size={17} />}
                  tone={userStats.disabled > 0 ? 'warning' : undefined}
                />
                <StatCard
                  label="禁用账号"
                  value={userStats.disabled}
                  note="无法登录"
                  icon={<UserX size={17} />}
                  tone={userStats.disabled > 0 ? 'danger' : undefined}
                />
                <StatCard label="高权限账号" value={userStats.privileged} note="admin / developer" icon={<ShieldCheck size={17} />} />
              </div>
            )}

            <Panel
              title="管理员账号"
              description={`${users.length} 个账号`}
              action={canCreateUser
                ? <Button variant="primary" onClick={openCreate}><Plus size={15} /> 新建账号</Button>
                : <ReadOnlyNote permission="users.create" />}
            >
              <DataState empty={usersLoaded && users.length === 0} emptyTitle="暂无管理员账号" emptyDetail="尚无任何管理员账号记录。">
                <div className="toolbar">
                  <div className="search-field grow">
                    <Search size={14} />
                    <input
                      value={userQuery}
                      placeholder="按用户名、ID 或角色搜索…"
                      aria-label="搜索管理员账号"
                      onChange={(event) => setUserQuery(event.target.value)}
                    />
                  </div>
                  <Field label="角色">
                    <Select
                      aria-label="按角色过滤"
                      value={roleFilter}
                      onChange={(event) => {
                        const value = event.target.value;
                        setRoleFilter(ROLES.includes(value as AdminRoleValue) ? value as AdminRoleValue : '');
                      }}
                    >
                      <option value="">全部角色</option>
                      {ROLES.map((role) => <option key={role} value={role}>{ROLE_FILTER_LABELS[role]}</option>)}
                    </Select>
                  </Field>
                  <Field label="状态">
                    <Select
                      aria-label="按状态过滤"
                      value={statusFilter}
                      onChange={(event) => {
                        const value = event.target.value;
                        setStatusFilter(value === 'enabled' || value === 'disabled' ? value : '');
                      }}
                    >
                      <option value="">全部状态</option>
                      <option value="enabled">仅已启用</option>
                      <option value="disabled">仅已禁用</option>
                    </Select>
                  </Field>
                  <Button onClick={resetUserFilters} disabled={!userQuery && !roleFilter && !statusFilter}>重置过滤</Button>
                </div>

                {visibleUsers.length === 0 ? (
                  <EmptyState
                    title="没有匹配的账号"
                    detail={`当前过滤条件下没有账号；目录共 ${users.length} 个。`}
                    action={<Button onClick={resetUserFilters}>清除过滤</Button>}
                  />
                ) : (
                  <>
                    {userFiltering && (
                      <p className="muted-text">显示 {visibleUsers.length} / {users.length} 个账号</p>
                    )}
                    <Table minWidth={920}>
                      <thead><tr><th>用户</th><th>角色</th><th>状态</th><th>最近登录</th><th>创建时间</th><th>操作</th></tr></thead>
                      <tbody>{visibleUsers.map((user) => (
                        <tr key={user.id}>
                          <td><div className="table-primary">{user.username}</div><small className="muted-text mono">{user.id}</small></td>
                          <td><RolePill role={user.role} /></td>
                          <td>{user.enabled ? <Pill tone="success">已启用</Pill> : <Pill tone="danger">已禁用</Pill>}</td>
                          <td className="nowrap" title={formatDateTime(user.lastLoginAt)}>{formatRelative(user.lastLoginAt)}</td>
                          <td className="nowrap" title={formatDateTime(user.createdAt)}>{formatDateTime(user.createdAt)}</td>
                          <td>
                            <div className="table-actions">
                              {canEditUser && <Button onClick={() => openEdit(user)}>编辑</Button>}
                              {canRotatePassword && <Button onClick={() => openRotate(user)}><KeyRound size={14} /> 重置密码</Button>}
                              {!canEditUser && <span className="muted-text">只读</span>}
                            </div>
                          </td>
                        </tr>
                      ))}</tbody>
                    </Table>
                  </>
                )}
              </DataState>
            </Panel>
          </>
        )}

        {tab === 'sessions' && (
          <>
            {sessions.length > 0 && (
              <div className="stat-grid">
                <StatCard label="活跃会话" value={sessions.length} note="当前已登录" icon={<ScrollText size={17} />} />
                <StatCard
                  label="当前浏览器"
                  value={sessionStats.current}
                  note="本机所在会话"
                  icon={<ShieldCheck size={17} />}
                  tone={sessionStats.current > 0 ? 'success' : undefined}
                />
                <StatCard label="涉及账号" value={sessionStats.accounts} note="去重后的登录账号" icon={<UsersIcon size={17} />} />
              </div>
            )}

            <Panel
              title="登录会话"
              description={`${sessions.length} 个活跃会话`}
              action={!canRevokeSession ? <ReadOnlyNote permission="sessions.revoke" /> : undefined}
              flush
            >
              <DataState empty={sessionsLoaded && sessions.length === 0} emptyTitle="没有活跃会话" emptyDetail="当前没有已登录的管理员会话。">
                <Table minWidth={980}>
                  <thead><tr><th>会话 ID</th><th>用户</th><th>创建时间</th><th>最近活跃</th><th>过期时间</th><th>当前</th><th>操作</th></tr></thead>
                  <tbody>{sessions.map((session) => (
                    <tr key={session.id}>
                      <td><small className="mono">{session.id}</small></td>
                      <td><div className="table-primary">{session.normalizedUsername ?? session.username ?? '—'}</div>
                        {session.role ? <small className="muted-text">{session.role}</small> : null}</td>
                      <td className="nowrap" title={formatDateTime(session.createdAt)}>{formatRelative(session.createdAt)}</td>
                      <td className="nowrap" title={formatDateTime(session.lastSeenAt)}>{formatRelative(session.lastSeenAt)}</td>
                      <td className="nowrap" title={formatDateTime(session.expiresAt)}>{session.expiresAt ? formatDateTime(session.expiresAt) : '—'}</td>
                      <td>{session.current ? <Pill tone="info">当前会话</Pill> : <span className="muted-text">—</span>}</td>
                      <td>{canRevokeSession
                        ? (
                          <Button
                            variant="danger"
                            busy={revokingSessionId === session.id}
                            title={session.current ? '吊销当前会话将立即退出登录' : '吊销该登录会话'}
                            onClick={() => void revokeSession(session)}
                          >
                            <Trash2 size={14} /> 吊销
                          </Button>
                        )
                        : <span className="muted-text">只读</span>}</td>
                    </tr>
                  ))}</tbody>
                </Table>
              </DataState>
            </Panel>
          </>
        )}

        {tab === 'tokens' && (
          <>
            {tokens.length > 0 && (
              <div className="stat-grid">
                <StatCard label="令牌总数" value={tokens.length} note="含已吊销与过期" icon={<KeyRound size={17} />} />
                <StatCard
                  label="当前有效"
                  value={tokenStats.active}
                  note="可立即使用"
                  icon={<CheckCircle2 size={17} />}
                  tone={tokenStats.active > 0 ? 'success' : undefined}
                />
                <StatCard
                  label="临近或已过期"
                  value={tokenStats.attention}
                  note="1 小时内到期或已过期"
                  icon={<Clock size={17} />}
                  tone={tokenStats.attention > 0 ? 'warning' : undefined}
                />
                <StatCard
                  label="已失效吊销"
                  value={tokenStats.revoked}
                  note="已主动吊销"
                  icon={<Ban size={17} />}
                  tone={tokenStats.revoked > 0 ? 'danger' : undefined}
                />
              </div>
            )}

            <Panel
              title="临时令牌"
              description={`${tokens.length} 个令牌`}
              action={canCreateToken
                ? <Button variant="primary" onClick={openTokenForm}><Plus size={15} /> 新建令牌</Button>
                : <ReadOnlyNote permission="tokens.create" />}
              flush
            >
              <DataState empty={tokensLoaded && tokens.length === 0} emptyTitle="暂无临时令牌" emptyDetail="可创建带有效期的临时访问令牌供外部工具使用。">
                <Table minWidth={1000}>
                  <thead><tr><th>标签</th><th>角色</th><th>创建者</th><th>创建时间</th><th>过期时间</th><th>状态</th><th>操作</th></tr></thead>
                  <tbody>{tokens.map((token) => {
                    const status = tokenStatus(token);
                    return (
                      <tr key={token.id}>
                        <td><div className="table-primary">{token.label || '—'}</div><small className="muted-text mono">{token.id}</small></td>
                        <td><RolePill role={token.role} /></td>
                        <td>{token.createdBy ?? '—'}</td>
                        <td className="nowrap" title={formatDateTime(token.createdAt)}>{formatRelative(token.createdAt)}</td>
                        <td className="nowrap" title={formatDateTime(token.expiresAt)}>{formatDateTime(token.expiresAt)}</td>
                        <td><Pill tone={TOKEN_STATUS[status].tone}>{TOKEN_STATUS[status].label}</Pill></td>
                        <td>{canRevokeToken && status !== 'revoked'
                          ? (
                            <Button
                              variant="danger"
                              busy={revokingTokenId === token.id}
                              title="吊销该临时令牌（需要二次确认）"
                              onClick={() => void revokeToken(token)}
                            >
                              <Trash2 size={14} /> 吊销
                            </Button>
                          )
                          : <span className="muted-text">—</span>}</td>
                      </tr>
                    );
                  })}</tbody>
                </Table>
              </DataState>
            </Panel>
          </>
        )}
      </DataState>

      {/* 新建账号 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建管理员账号"
        description="创建后会立即生效，操作需输入“确认”完成服务端确认。"
        footer={<>
          <Button onClick={() => setCreateOpen(false)}>取消</Button>
          <Button variant="primary" busy={createBusy} onClick={() => void createUser()}>创建账号</Button>
        </>}
      >
        <div className="form-grid">
          <Field label="用户名" hint="规范化后用于登录，全局唯一。">
            <TextInput aria-label="用户名" value={createUsername} onChange={(event) => setCreateUsername(event.target.value)} placeholder="例如 ops-alice" />
          </Field>
          <Field label="初始密码" hint="至少 10 个字符。">
            <TextInput aria-label="初始密码" type="password" value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} />
          </Field>
          <Field label="角色" hint="服务端会拒绝创建高于当前账号角色的账号。">
            <Select aria-label="角色" value={createRole} onChange={(event) => setCreateRole(event.target.value as AdminRoleValue)}>
              {ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
            </Select>
          </Field>
          <div className="field">
            <span className="field-label">启用状态</span>
            <Switch checked={createEnabled} onChange={setCreateEnabled} label={createEnabled ? '创建后立即启用' : '创建后保持禁用'} />
          </div>
        </div>
        {createError && <Notice tone="danger" icon={<AlertCircle size={17} />}>{createError}</Notice>}
      </Modal>

      {/* 编辑账号 */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="编辑管理员账号"
        description="只有变更的字段会随请求发送。"
        footer={<>
          <Button onClick={() => setEditing(null)}>取消</Button>
          <Button variant="primary" busy={editBusy} onClick={() => void saveEdit()}>保存更改</Button>
        </>}
      >
        {editing && (
          <>
            <div className="form-grid">
              <Field label="用户名">
                <TextInput value={editUsername} onChange={(event) => setEditUsername(event.target.value)} disabled={!canEditUser} />
              </Field>
              <Field
                label="角色"
                hint={canAssignRole ? '服务端会拒绝分配高于当前账号角色的权限。' : '缺少 users.role.assign 权限，无法变更角色。'}
              >
                <Select value={editRole} onChange={(event) => setEditRole(event.target.value as AdminRoleValue)} disabled={!canAssignRole}>
                  {ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                </Select>
              </Field>
              <div className="field">
                <span className="field-label">启用状态</span>
                <Switch
                  checked={editEnabled}
                  onChange={setEditEnabled}
                  disabled={!canToggleEnabled}
                  label={canToggleEnabled ? (editEnabled ? '已启用' : '已禁用') : '缺少 users.disable 权限'}
                />
              </div>
            </div>
            {editError && <Notice tone="danger" icon={<AlertCircle size={17} />}>{editError}</Notice>}
          </>
        )}
      </Modal>

      {/* 重置密码 */}
      <Modal
        open={rotating !== null}
        onClose={() => setRotating(null)}
        title="重置密码"
        description="重置后该账号的既有会话会全部失效。"
        footer={<>
          <Button onClick={() => setRotating(null)}>取消</Button>
          <Button variant="danger" busy={rotateBusy} onClick={() => void rotateUserPassword()}><RotateCcw size={14} /> 重置密码</Button>
        </>}
      >
        {rotating && (
          <>
            <Field label={`新密码（${rotating.username}）`} hint="至少 10 个字符。">
              <TextInput type="password" value={rotatePassword} onChange={(event) => setRotatePassword(event.target.value)} />
            </Field>
            {rotateError && <Notice tone="danger" icon={<AlertCircle size={17} />}>{rotateError}</Notice>}
          </>
        )}
      </Modal>

      {/* 新建临时令牌 */}
      <Modal
        open={tokenFormOpen}
        onClose={() => setTokenFormOpen(false)}
        title="新建临时令牌"
        description="令牌值只在创建成功后显示一次。"
        footer={<>
          <Button onClick={() => setTokenFormOpen(false)}>取消</Button>
          <Button variant="primary" busy={tokenBusy} onClick={() => void createToken()}>创建令牌</Button>
        </>}
      >
        <div className="form-grid">
          <Field label="标签" hint="便于在列表中辨认用途。">
            <TextInput aria-label="令牌标签" value={tokenLabel} onChange={(event) => setTokenLabel(event.target.value)} placeholder="例如 临时验收" />
          </Field>
          <Field label="角色" hint="服务端会拒绝创建高于当前账号角色的令牌。">
            <Select aria-label="令牌角色" value={tokenRole} onChange={(event) => setTokenRole(event.target.value as AdminRoleValue)}>
              {ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
            </Select>
          </Field>
          <Field label="有效期（分钟）" hint="1 到 10080 分钟（最长 7 天）。">
            <TextInput aria-label="有效期" type="number" min={1} max={10080} value={tokenTtl} onChange={(event) => setTokenTtl(event.target.value)} />
          </Field>
        </div>
        {tokenError && <Notice tone="danger" icon={<AlertCircle size={17} />}>{tokenError}</Notice>}
      </Modal>

      {/* 令牌一次性展示 */}
      <Modal
        open={issued !== null}
        onClose={() => setIssued(null)}
        title="临时令牌已创建"
        description="令牌仅显示这一次，关闭后无法再次查看，请立即复制到安全位置。"
        footer={<Button onClick={() => setIssued(null)}>我已保存，关闭</Button>}
      >
        {issued && (
          <>
            <Descriptions columns={2} items={[
              { label: '标签', value: issued.record.label || '—' },
              { label: '角色', value: <RolePill role={issued.record.role} /> },
              { label: '创建时间', value: formatDateTime(issued.record.createdAt) },
              { label: '过期时间', value: formatDateTime(issued.record.expiresAt) },
            ]} />
            <div className="token-reveal">
              <code className="prewrap">{issued.token}</code>
              <CopyButton value={issued.token} label="复制令牌" />
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
