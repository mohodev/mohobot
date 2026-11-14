import { useCallback, useEffect, useMemo, useState } from 'react';
import { currentAdmin, getSessionToken, setSessionToken, setUnauthorizedHandler, api } from './lib/api';
import type { AdminMe } from './lib/types';
import { principalOf } from './lib/types';
import { Login } from './components/login';
import { Shell, MENU_ITEMS, isViewAllowed, type ViewId } from './components/shell';
import { Loading } from './components/ui';
import { Overview } from './pages/overview';
import { Bots } from './pages/bots';
import { Providers } from './pages/providers';
import { Models } from './pages/models';
import { Logs } from './pages/logs';
import { Characters } from './pages/characters';
import { Memory } from './pages/memory';
import { Jargon } from './pages/jargon';
import { Knowledge } from './pages/knowledge';
import { Plugins } from './pages/plugins';
import { Mcp } from './pages/mcp';
import { World } from './pages/world';
import { Device } from './pages/device';
import { Affinity } from './pages/affinity';
import { Tasks } from './pages/tasks';
import { FutureTasks } from './pages/futuretasks';
import { Sessions } from './pages/sessions';
import { Users } from './pages/users';
import { Settings } from './pages/settings';
import { Health } from './pages/health';
import { Debug } from './pages/debug';

const validViews = MENU_ITEMS.map((item) => item.id) as ViewId[];

export function App() {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState(Boolean(getSessionToken()));
  const [view, setViewState] = useState<ViewId>(() => initialView());

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
  const principal = useMemo(() => principalOf(me ?? {}), [me]);

  // Redirect to the first view the principal may actually open.
  useEffect(() => {
    if (!me) return;
    if (!isViewAllowed(view, permissions)) {
      const fallback = validViews.find((candidate) => isViewAllowed(candidate, permissions));
      if (fallback && fallback !== view) setView(fallback);
    }
  }, [me, view, permissions, setView]);

  if (loading) return <div className="boot-screen"><Loading label="正在验证管理员会话" /></div>;
  if (!me) return <Login onLoggedIn={(result) => {
    setMe(result);
    sessionStorage.setItem('moho-admin-permissions', JSON.stringify(result.permissions ?? []));
  }} />;

  const restricted = !isViewAllowed(view, permissions);
  const content = restricted ? <AccessDenied onBack={() => setView(validViews.find((candidate) => isViewAllowed(candidate, permissions)) ?? 'overview')} /> : renderView(view, permissions);

  return <Shell view={view} setView={setView} principal={principal} permissions={permissions} onLogout={() => void logout()}>{content}</Shell>;
}

function renderView(view: ViewId, permissions: string[]) {
  switch (view) {
    case 'overview': return <Overview permissions={permissions} />;
    case 'bots': return <Bots permissions={permissions} />;
    case 'providers': return <Providers permissions={permissions} />;
    case 'models': return <Models permissions={permissions} />;
    case 'characters': return <Characters permissions={permissions} />;
    case 'memory': return <Memory permissions={permissions} />;
    case 'jargon': return <Jargon permissions={permissions} />;
    case 'knowledge': return <Knowledge permissions={permissions} />;
    case 'world': return <World permissions={permissions} />;
    case 'device': return <Device permissions={permissions} />;
    case 'affinity': return <Affinity permissions={permissions} />;
    case 'tasks': return <Tasks permissions={permissions} />;
    case 'futuretasks': return <FutureTasks permissions={permissions} />;
    case 'plugins': return <Plugins permissions={permissions} />;
    case 'mcp': return <Mcp permissions={permissions} />;
    case 'logs': return <Logs permissions={permissions} />;
    case 'health': return <Health permissions={permissions} />;
    case 'sessions': return <Sessions permissions={permissions} />;
    case 'users': return <Users permissions={permissions} />;
    case 'settings': return <Settings permissions={permissions} />;
    case 'debug': return <Debug permissions={permissions} />;
    default: return null;
  }
}

function AccessDenied({ onBack }: { onBack: () => void }) {
  return (
    <div className="boot-screen">
      <div className="access-denied">
        <strong>当前账号没有访问此页面的权限</strong>
        <button className="button button-primary" onClick={onBack}>返回可用页面</button>
      </div>
    </div>
  );
}

function initialView(): ViewId {
  const hash = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return validViews.includes(hash as ViewId) ? hash as ViewId : 'overview';
}
