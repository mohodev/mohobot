import { useCallback, useEffect, useMemo, useState } from 'react';
import { currentAdmin, getSessionToken, setSessionToken, setUnauthorizedHandler, api } from './lib/api';
import type { AdminMe } from './lib/types';
import { principalOf } from './lib/types';
import { Login } from './components/login';
import { Shell, type ViewId } from './components/shell';
import { Loading } from './components/ui';
import { Overview } from './pages/overview';
import { Bots } from './pages/bots';
import { Providers } from './pages/providers';
import { Models } from './pages/models';
import { Logs } from './pages/logs';
import { Characters } from './pages/characters';
import { Memory } from './pages/memory';
import { Plugins } from './pages/plugins';
import { Mcp } from './pages/mcp';
import { LegacyFeature } from './pages/legacy';

const validViews: ViewId[] = ['overview', 'bots', 'providers', 'models', 'logs', 'characters', 'memory', 'plugins', 'mcp', 'world', 'device', 'tasks', 'users', 'settings', 'health', 'debug'];
const titles: Record<ViewId, string> = {
  overview: '运行总览', bots: '机器人', providers: '模型供应商', models: '模型运营',
  logs: '实时日志', characters: '角色档案', memory: '长期记忆', plugins: '插件管理',
  mcp: 'MCP 工具', world: '世界模拟', device: '设备与关系', tasks: '任务队列',
  users: '管理员', settings: '配置发布', health: '服务健康', debug: '调试工作台',
};

function initialView(): ViewId {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return validViews.includes(hash as ViewId) ? hash as ViewId : 'overview';
}

export function App() {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState(Boolean(getSessionToken()));
  const [view, setViewState] = useState<ViewId>(initialView);

  const logout = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* local token is cleared either way */ }
    setSessionToken('');
    sessionStorage.removeItem('moho-admin-permissions');
    setMe(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      sessionStorage.removeItem('moho-admin-permissions');
      setMe(null);
    });
    if (!getSessionToken()) {
      setLoading(false);
      return () => setUnauthorizedHandler(undefined);
    }
    void currentAdmin()
      .then((result) => {
        setMe(result);
        sessionStorage.setItem('moho-admin-permissions', JSON.stringify(result.permissions ?? []));
      })
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
    return () => setUnauthorizedHandler(undefined);
  }, []);

  const setView = useCallback((next: ViewId) => {
    setViewState(next);
    window.location.hash = `#/${next}`;
  }, []);

  useEffect(() => {
    const onHashChange = () => setViewState(initialView());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const permissions = useMemo(() => me?.permissions ?? [], [me]);
  const principal = principalOf(me ?? {});

  if (loading) return <div className="boot-screen"><Loading label="正在验证管理员会话" /></div>;
  if (!me) return <Login onLoggedIn={(result) => {
    setMe(result);
    sessionStorage.setItem('moho-admin-permissions', JSON.stringify(result.permissions ?? []));
  }} />;

  const content = (() => {
    switch (view) {
      case 'overview': return <Overview />;
      case 'bots': return <Bots />;
      case 'providers': return <Providers />;
      case 'models': return <Models />;
      case 'logs': return <Logs />;
      case 'characters': return <Characters />;
      case 'memory': return <Memory />;
      case 'plugins': return <Plugins permissions={permissions} />;
      case 'mcp': return <Mcp permissions={permissions} />;
      default: return <LegacyFeature view={view} title={titles[view]} />;
    }
  })();

  const allowed = validViews.some((candidate) => {
    const permissionByView: Record<ViewId, string> = {
      overview: 'status.read', bots: 'status.read', providers: 'providers.read', models: 'models.read',
      logs: 'logs.read', characters: 'characters.read', memory: 'memory.metadata.read',
      plugins: 'plugin.read', mcp: 'mcp.read', world: 'world.read', device: 'device.read',
      tasks: 'tasks.read', users: 'users.read', settings: 'config.publish', health: 'status.read', debug: 'debug.chat',
    };
    return candidate === view && permissions.includes(permissionByView[candidate]);
  });

  if (!allowed) return <div className="boot-screen"><div className="access-denied"><strong>当前账号没有访问此页面的权限</strong><button className="button button-primary" onClick={() => setView('overview')}>返回总览</button></div></div>;

  return <Shell view={view} setView={setView} principal={principal} permissions={permissions} onLogout={() => void logout()}>{content}</Shell>;
}
