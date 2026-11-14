import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Copy, KeyRound, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import { ApiError, currentAdmin, fetchSetupStatus, initializeDeployment, loginWithBootstrapToken, loginWithPassword } from '../lib/api';
import type { AdminMe } from '../lib/types';
import { Button } from './ui';

type Mode = 'password' | 'token';

export function Login({ onLoggedIn }: { onLoggedIn: (me: AdminMe) => void }) {
  const [mode, setMode] = useState<Mode>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [masterToken, setMasterToken] = useState('');

  // Probe deployment state so a fresh install lands on the setup wizard rather
  // than a login form that can never succeed. The pre-setup trust model matches
  // the CLI: whoever reaches the loopback port first owns the deployment.
  useEffect(() => {
    let active = true;
    void fetchSetupStatus()
      .then((status) => { if (active) setNeedsSetup(!status.initialized); })
      .catch(() => { /* older builds without setup routes fall back to login */ })
      .finally(() => { if (active) setCheckingSetup(false); });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (needsSetup) {
        const result = await initializeDeployment(username, password);
        setMasterToken(result.masterToken);
        onLoggedIn(await currentAdmin());
        return;
      }
      if (mode === 'password') await loginWithPassword(username, password);
      else await loginWithBootstrapToken(bootstrapToken);
      onLoggedIn(await currentAdmin());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '登录失败，请检查管理服务状态');
    } finally {
      setBusy(false);
    }
  }

  // After a successful first-run init, reveal the break-glass master token once.
  if (masterToken) {
    return (
      <main className="login-screen">
        <div className="login-art">
          <div className="login-emblem"><ShieldCheck size={27} /></div>
          <div className="login-brand">初始化完成<span>DEPLOYMENT READY</span></div>
          <p>请立即保存下方的部署主令牌；它只在本次初始化时返回一次。</p>
        </div>
        <div className="login-card">
          <div className="login-card-icon"><KeyRound size={19} /></div>
          <h1>保存部署主令牌</h1>
          <p className="login-description">该令牌是破坏性恢复凭据，写入 data/.env.local，不会再次回显。</p>
          <div className="token-reveal">
            <code className="prewrap">{masterToken}</code>
            <button type="button" className="text-button" onClick={() => void navigator.clipboard?.writeText(masterToken)}><Copy size={14} /> 复制令牌</button>
          </div>
          <Button variant="primary" className="login-submit" onClick={() => setMasterToken('')}>我已保存，进入控制台</Button>
        </div>
      </main>
    );
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
        <div className="login-card-icon">{needsSetup ? <ShieldCheck size={19} /> : <LockKeyhole size={19} />}</div>
        <div className="eyebrow">{needsSetup ? 'FIRST-RUN SETUP' : 'ADMINISTRATOR ACCESS'}</div>
        <h1>{needsSetup ? '初始化部署' : '欢迎回来'}</h1>
        <p className="login-description">
          {needsSetup ? '创建第一个管理员账号以完成初始化。此操作只能执行一次。' : '登录 MohoBot 管理控制台。'}
        </p>
        {needsSetup && (
          <div className="inline-warning"><AlertTriangle size={15} /><span>初始化会生成部署主令牌并创建开发者账号；请确认本机即为部署主机。</span></div>
        )}
        <label className="field-label" htmlFor="username">用户名</label>
        <input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required placeholder={needsSetup ? '设置管理员用户名' : '管理员用户名'} />
        {(!needsSetup && mode === 'token') ? (
          <>
            <label className="field-label" htmlFor="bootstrap-token">本地初始化令牌</label>
            <input id="bootstrap-token" type="password" autoComplete="off" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} required placeholder="粘贴本地初始化令牌" />
          </>
        ) : (
          <>
            <label className="field-label" htmlFor="password">密码</label>
            <input id="password" type="password" autoComplete={needsSetup ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} required placeholder={needsSetup ? '至少 10 位密码' : '管理员密码'} />
          </>
        )}
        {error && <div className="inline-error">{error}</div>}
        <Button type="submit" variant="primary" busy={busy} disabled={busy || checkingSetup} className="login-submit">
          {needsSetup ? '创建管理员并初始化' : mode === 'password' ? '安全登录' : '交换会话令牌'}
        </Button>
        {!needsSetup && (
          <button type="button" className="text-button" onClick={() => { setMode(mode === 'password' ? 'token' : 'password'); setError(''); }}>
            <KeyRound size={14} /> {mode === 'password' ? '使用本地初始化令牌' : '返回账号密码登录'}
          </button>
        )}
        <div className="login-footer">经典控制台仍可在 <a href="/">/</a> 使用。</div>
      </form>
    </main>
  );
}
