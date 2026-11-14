import { useState, type FormEvent } from 'react';
import { KeyRound, LockKeyhole, Sparkles } from 'lucide-react';
import { ApiError, currentAdmin, loginWithBootstrapToken, loginWithPassword } from '../lib/api';
import type { AdminMe } from '../lib/types';
import { Button } from './ui';

export function Login({ onLoggedIn }: { onLoggedIn: (me: AdminMe) => void }) {
  const [mode, setMode] = useState<'password' | 'token'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'password') await loginWithPassword(username, password);
      else await loginWithBootstrapToken(bootstrapToken);
      onLoggedIn(await currentAdmin());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '登录失败，请检查管理服务状态');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <div className="login-art">
        <div className="login-orbit orbit-one" />
        <div className="login-orbit orbit-two" />
        <div className="login-emblem"><Sparkles size={27} /></div>
        <div className="login-brand">MOHOBOT<span>CONTROL CENTER</span></div>
        <p>让每个角色稳定运行，让每一次管理操作都有迹可循。</p>
        <div className="login-version">MODULAR RUNTIME · SQLITE · ROLE-BASED ACCESS</div>
      </div>
      <form className="login-card" onSubmit={submit}>
        <div className="login-card-icon"><LockKeyhole size={19} /></div>
        <div className="eyebrow">ADMINISTRATOR ACCESS</div>
        <h1>欢迎回来</h1>
        <p className="login-description">登录 MohoBot 管理控制台。</p>
        {mode === 'password' ? (
          <>
            <label className="field-label" htmlFor="username">用户名</label>
            <input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required placeholder="管理员用户名" />
            <label className="field-label" htmlFor="password">密码</label>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="管理员密码" />
          </>
        ) : (
          <>
            <label className="field-label" htmlFor="bootstrap-token">本地初始化令牌</label>
            <input id="bootstrap-token" type="password" autoComplete="off" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} required placeholder="粘贴本地初始化令牌" />
          </>
        )}
        {error && <div className="inline-error">{error}</div>}
        <Button type="submit" variant="primary" busy={busy} disabled={busy} className="login-submit">
          {mode === 'password' ? '安全登录' : '交换会话令牌'}
        </Button>
        <button type="button" className="text-button" onClick={() => { setMode(mode === 'password' ? 'token' : 'password'); setError(''); }}>
          <KeyRound size={14} /> {mode === 'password' ? '使用本地初始化令牌' : '返回账号密码登录'}
        </button>
        <div className="login-footer">首次部署初始化仍可从 <a href="/">经典控制台</a> 进入。</div>
      </form>
    </main>
  );
}
