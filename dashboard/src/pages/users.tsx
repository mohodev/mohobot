import { useCallback, useState } from 'react';
import { KeyRound, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { ApiError, api, body, confirmedRequest } from '../lib/api';
import type { AdminSession, AdminUser, PageProps, TemporaryToken } from '../lib/types';
import { formatDateTime, formatRelative } from '../lib/format';
import { useAsync, useToggle } from '../lib/hooks';
import {
  Button, CopyButton, DataState, Descriptions, Field, Modal, Notice, PageTitle, Panel, Pill, Select, Switch, Table, Tabs, TextInput,
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
 */
export function Users({ permissions }: PageProps) {
  const [tab, setTab] = useState<AccessTab>('users');
  const [notice, setNotice] = useState('');
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
  const [formError, setFormError] = useState('');

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
    try {
      await confirmedRequest('/admin/users', { method: 'POST', body: body(payload) }, payload, `创建管理员账号 ${payload.username}`);
      setCreateOpen(false);
      setNotice('');
      reload();
    } catch (cause) {
      if (isCancelled(cause)) return;
      setCreateError(describeFailure(cause));
    }
  }, [createUsername, createPassword, createRole, createEnabled, setCreateOpen, reload]);

  const [editing, setEditing] = useState<UserRow | null>(null);
  const [editUsername, setEditUsername] = useState('');
  const [editRole, setEditRole] = useState<AdminRoleValue>('viewer');
  const [editEnabled, setEditEnabled] = useState(true);

  const openEdit = useCallback((user: UserRow) => {
    setEditing(user);
    setEditUsername(user.username);
    setEditRole(user.role);
    setEditEnabled(user.enabled);
    setFormError('');
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    const user = editing;
    const payload: { username?: string; role?: AdminRoleValue; enabled?: boolean } = {};
    if (editUsername.trim() && editUsername.trim() !== user.username) payload.username = editUsername.trim();
    if (canAssignRole && editRole !== user.role) payload.role = editRole;
    if (canToggleEnabled && editEnabled !== user.enabled) payload.enabled = editEnabled;
    if (Object.keys(payload).length === 0) { setFormError('没有需要保存的更改。'); return; }
    setFormError('');
    try {
      await confirmedRequest(
        `/admin/users/${encodeURIComponent(user.id)}`,
        { method: 'PATCH', body: body(payload) },
        payload,
        `更新管理员账号 ${user.username}`,
      );
      setEditing(null);
      setNotice('');
      reload();
    } catch (cause) {
      if (isCancelled(cause)) return;
      setFormError(describeFailure(cause));
    }
  }, [editing, editUsername, editRole, editEnabled, canAssignRole, canToggleEnabled, reload]);

  const [rotating, setRotating] = useState<UserRow | null>(null);
  const [rotatePassword, setRotatePassword] = useState('');

  const openRotate = useCallback((user: UserRow) => {
    setRotating(user);
    setRotatePassword('');
    setFormError('');
  }, []);

  const rotateUserPassword = useCallback(async () => {
    if (!rotating) return;
    const user = rotating;
    if (rotatePassword.length < 10) { setFormError('密码至少需要 10 个字符。'); return; }
    setFormError('');
    try {
      const payload = { password: rotatePassword };
      await confirmedRequest(
        `/admin/users/${encodeURIComponent(user.id)}/password`,
        { method: 'POST', body: body(payload) },
        payload,
        `重置管理员账号 ${user.username} 的密码`,
      );
      setRotating(null);
      setNotice('');
      reload();
    } catch (cause) {
      if (isCancelled(cause)) return;
      setFormError(describeFailure(cause));
    }
  }, [rotating, rotatePassword, reload]);

  /* ------------------------------------------------------------ *
   * 会话：吊销
   * ------------------------------------------------------------ */
  const canRevokeSession = allowed('sessions.revoke');

  const revokeSession = useCallback(async (session: SessionRow) => {
    try {
      await api(`/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      setNotice('');
      reload();
    } catch (cause) {
      if (isCancelled(cause)) return;
      setNotice(describeFailure(cause));
    }
  }, [reload]);

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
  const [issued, setIssued] = useState<{ token: string; record: TokenRow } | null>(null);

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
      setNotice('');
      reload();
    } catch (cause) {
      if (isCancelled(cause)) return;
      setTokenError(describeFailure(cause));
    }
  }, [tokenLabel, tokenTtl, tokenRole, setTokenFormOpen, reload]);

  const revokeToken = useCallback(async (token: TokenRow) => {
    try {
      await confirmedRequest(
        `/auth/temporary-tokens/${encodeURIComponent(token.id)}`,
        { method: 'DELETE', body: body({}) },
        {},
        `吊销临时令牌 ${token.label ?? token.id}`,
      );
      setNotice('');
      reload();
    } catch (cause) {
      if (isCancelled(cause)) return;
      setNotice(describeFailure(cause));
    }
  }, [reload]);

  const users = active && active.kind === 'users' ? active.users : [];
  const sessions = active && active.kind === 'sessions' ? active.sessions : [];
  const tokens = active && active.kind === 'tokens' ? active.tokens : [];

  return (
    <>
      <PageTitle
        eyebrow="ACCESS CONTROL"
        title="管理员"
        description="管理管理员账号、登录会话与临时访问令牌，所有敏感操作均需服务端确认。"
        actions={<Button onClick={reload} busy={state.loading}><RefreshCw size={15} /> 刷新</Button>}
      />

      <Tabsbar tab={tab} onChange={setTab} data={state.data} />

      {notice && <Notice tone="warning">{notice}</Notice>}

      <DataState
        loading={state.loading}
        error={state.error}
        onRetry={reload}
      >
        {tab === 'users' && (
          <Panel
            title="管理员账号"
            description={`${users.length} 个账号`}
            action={canCreateUser
              ? <Button variant="primary" onClick={openCreate}><Plus size={15} /> 新建账号</Button>
              : <ReadOnlyNote permission="users.create" />}
          >
            <DataState empty={users.length === 0} emptyTitle="暂无管理员账号" emptyDetail="尚无任何管理员账号记录。">
              <Table minWidth={860}>
                <thead><tr><th>用户</th><th>角色</th><th>状态</th><th>最近登录</th><th>创建时间</th><th>操作</th></tr></thead>
                <tbody>{users.map((user) => (
                  <tr key={user.id}>
                    <td><div className="table-primary">{user.username}</div><small className="muted-text mono">{user.id}</small></td>
                    <td><RolePill role={user.role} /></td>
                    <td>{user.enabled ? <Pill tone="success">已启用</Pill> : <Pill tone="danger">已禁用</Pill>}</td>
                    <td>{formatRelative(user.lastLoginAt)}</td>
                    <td>{formatDateTime(user.createdAt)}</td>
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
            </DataState>
          </Panel>
        )}

        {tab === 'sessions' && (
          <Panel
            title="登录会话"
            description={`${sessions.length} 个活跃会话`}
            action={!canRevokeSession ? <ReadOnlyNote permission="sessions.revoke" /> : undefined}
          >
            <DataState empty={sessions.length === 0} emptyTitle="没有活跃会话" emptyDetail="当前没有已登录的管理员会话。">
              <Table minWidth={860}>
                <thead><tr><th>会话 ID</th><th>用户</th><th>创建时间</th><th>最近活跃</th><th>当前</th><th>操作</th></tr></thead>
                <tbody>{sessions.map((session) => (
                  <tr key={session.id}>
                    <td><small className="mono">{session.id}</small></td>
                    <td><div className="table-primary">{session.normalizedUsername ?? session.username ?? '—'}</div>
                      {session.role ? <small className="muted-text">{session.role}</small> : null}</td>
                    <td>{formatRelative(session.createdAt)}</td>
                    <td>{formatRelative(session.lastSeenAt)}</td>
                    <td>{session.current ? <Pill tone="info">当前会话</Pill> : <span className="muted-text">—</span>}</td>
                    <td>{canRevokeSession
                      ? <Button variant="danger" onClick={() => void revokeSession(session)}><Trash2 size={14} /> 吊销</Button>
                      : <span className="muted-text">只读</span>}</td>
                  </tr>
                ))}</tbody>
              </Table>
            </DataState>
          </Panel>
        )}

        {tab === 'tokens' && (
          <Panel
            title="临时令牌"
            description={`${tokens.length} 个令牌`}
            action={canCreateToken
              ? <Button variant="primary" onClick={openTokenForm}><Plus size={15} /> 新建令牌</Button>
              : <ReadOnlyNote permission="tokens.create" />}
          >
            <DataState empty={tokens.length === 0} emptyTitle="暂无临时令牌" emptyDetail="可创建带有效期的临时访问令牌供外部工具使用。">
              <Table minWidth={900}>
                <thead><tr><th>标签</th><th>角色</th><th>创建者</th><th>创建时间</th><th>过期时间</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>{tokens.map((token) => (
                  <tr key={token.id}>
                    <td><div className="table-primary">{token.label || '—'}</div><small className="muted-text mono">{token.id}</small></td>
                    <td><RolePill role={token.role} /></td>
                    <td>{token.createdBy ?? '—'}</td>
                    <td>{formatRelative(token.createdAt)}</td>
                    <td>{formatDateTime(token.expiresAt)}</td>
                    <td>{token.revokedAt ? <Pill tone="danger">已吊销</Pill> : <Pill tone="success">有效</Pill>}</td>
                    <td>{canRevokeToken && !token.revokedAt
                      ? <Button variant="danger" onClick={() => void revokeToken(token)}><Trash2 size={14} /> 吊销</Button>
                      : <span className="muted-text">—</span>}</td>
                  </tr>
                ))}</tbody>
              </Table>
            </DataState>
          </Panel>
        )}
      </DataState>

      {/* 新建账号 */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="新建管理员账号" description="创建后会立即生效，操作需输入“确认”完成服务端确认。">
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
        {createError && <Notice tone="danger">{createError}</Notice>}
        <div className="row row-between">
          <Button onClick={() => setCreateOpen(false)}>取消</Button>
          <Button variant="primary" onClick={() => void createUser()}>创建账号</Button>
        </div>
      </Modal>

      {/* 编辑账号 */}
      <Modal open={editing !== null} onClose={() => setEditing(null)} title="编辑管理员账号" description="只有变更的字段会随请求发送。">
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
            {formError && <Notice tone="danger">{formError}</Notice>}
            <div className="row row-between">
              <Button onClick={() => setEditing(null)}>取消</Button>
              <Button variant="primary" onClick={() => void saveEdit()}>保存更改</Button>
            </div>
          </>
        )}
      </Modal>

      {/* 重置密码 */}
      <Modal open={rotating !== null} onClose={() => setRotating(null)} title="重置密码" description="重置后该账号的既有会话会全部失效。">
        {rotating && (
          <>
            <Field label={`新密码（${rotating.username}）`} hint="至少 10 个字符。">
              <TextInput type="password" value={rotatePassword} onChange={(event) => setRotatePassword(event.target.value)} />
            </Field>
            {formError && <Notice tone="danger">{formError}</Notice>}
            <div className="row row-between">
              <Button onClick={() => setRotating(null)}>取消</Button>
              <Button variant="danger" onClick={() => void rotateUserPassword()}><RotateCcw size={14} /> 重置密码</Button>
            </div>
          </>
        )}
      </Modal>

      {/* 新建临时令牌 */}
      <Modal open={tokenFormOpen} onClose={() => setTokenFormOpen(false)} title="新建临时令牌" description="令牌值只在创建成功后显示一次。">
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
        {tokenError && <Notice tone="danger">{tokenError}</Notice>}
        <div className="row row-between">
          <Button onClick={() => setTokenFormOpen(false)}>取消</Button>
          <Button variant="primary" onClick={() => void createToken()}>创建令牌</Button>
        </div>
      </Modal>

      {/* 令牌一次性展示 */}
      <Modal
        open={issued !== null}
        onClose={() => setIssued(null)}
        title="临时令牌已创建"
        description="令牌仅显示这一次，关闭后无法再次查看，请立即复制到安全位置。"
      >
        {issued && (
          <>
            <Descriptions columns={2} items={[
              { label: '标签', value: issued.record.label || '—' },
              { label: '角色', value: <RolePill role={issued.record.role} /> },
              { label: '创建时间', value: formatDateTime(issued.record.createdAt) },
              { label: '过期时间', value: formatDateTime(issued.record.expiresAt) },
            ]} />
            <p className="mono prewrap">{issued.token}</p>
            <div className="row row-between">
              <CopyButton value={issued.token} label="复制令牌" />
              <Button onClick={() => setIssued(null)}>我已保存，关闭</Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

function Tabsbar({ tab, onChange, data }: { tab: AccessTab; onChange: (tab: AccessTab) => void; data: AccessData | undefined }) {
  return (
    <Tabs
      value={tab}
      ariaLabel="访问控制分区"
      onChange={onChange}
      options={[
        { value: 'users', label: '账号', count: data?.kind === 'users' ? data.users.length : undefined },
        { value: 'sessions', label: '会话', count: data?.kind === 'sessions' ? data.sessions.length : undefined },
        { value: 'tokens', label: '临时令牌', count: data?.kind === 'tokens' ? data.tokens.length : undefined },
      ]}
    />
  );
}
