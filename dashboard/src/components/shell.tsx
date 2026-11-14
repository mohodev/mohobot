import type { ReactNode } from 'react';
import {
  Activity, Bot, Brain, Boxes, Cpu, Globe2, HeartPulse, LayoutDashboard, Logs,
  LogOut, MessageSquare, Puzzle, Settings2, ShieldCheck, Smartphone, Users, Workflow,
} from 'lucide-react';
import type { AdminPrincipal } from '../lib/types';
import { Pill } from './ui';

export type ViewId =
  | 'overview' | 'bots' | 'providers' | 'models' | 'logs' | 'characters'
  | 'memory' | 'plugins' | 'mcp' | 'world' | 'device' | 'tasks'
  | 'users' | 'settings' | 'health' | 'debug';

interface MenuItem {
  id: ViewId;
  label: string;
  permission: string;
  icon: typeof LayoutDashboard;
  group: string;
}

const items: MenuItem[] = [
  { id: 'overview', label: '运行总览', permission: 'status.read', icon: LayoutDashboard, group: '工作空间' },
  { id: 'bots', label: '机器人', permission: 'status.read', icon: Bot, group: '工作空间' },
  { id: 'characters', label: '角色档案', permission: 'characters.read', icon: Users, group: '人格与记忆' },
  { id: 'memory', label: '长期记忆', permission: 'memory.metadata.read', icon: Brain, group: '人格与记忆' },
  { id: 'providers', label: '模型供应商', permission: 'providers.read', icon: Boxes, group: 'AI 基础设施' },
  { id: 'models', label: '模型运营', permission: 'models.read', icon: Cpu, group: 'AI 基础设施' },
  { id: 'plugins', label: '插件管理', permission: 'plugin.read', icon: Puzzle, group: '扩展能力' },
  { id: 'mcp', label: 'MCP 工具', permission: 'mcp.read', icon: Workflow, group: '扩展能力' },
  { id: 'logs', label: '实时日志', permission: 'logs.read', icon: Logs, group: '观测与治理' },
  { id: 'health', label: '服务健康', permission: 'status.read', icon: HeartPulse, group: '观测与治理' },
  { id: 'tasks', label: '任务队列', permission: 'tasks.read', icon: Activity, group: '观测与治理' },
  { id: 'world', label: '世界模拟', permission: 'world.read', icon: Globe2, group: '沉浸状态' },
  { id: 'device', label: '设备与关系', permission: 'device.read', icon: Smartphone, group: '沉浸状态' },
  { id: 'users', label: '管理员', permission: 'users.read', icon: ShieldCheck, group: '系统设置' },
  { id: 'settings', label: '配置发布', permission: 'config.publish', icon: Settings2, group: '系统设置' },
  { id: 'debug', label: '调试工作台', permission: 'debug.chat', icon: MessageSquare, group: '系统设置' },
];

export function Shell({ children, view, setView, principal, permissions, onLogout }: {
  children: ReactNode;
  view: ViewId;
  setView: (view: ViewId) => void;
  principal: AdminPrincipal;
  permissions: string[];
  onLogout: () => void;
}) {
  const visible = items.filter((item) => permissions.includes(item.permission));
  const groups = [...new Set(visible.map((item) => item.group))];
  const current = items.find((item) => item.id === view);
  const name = principal.username ?? principal.id ?? '管理员';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-symbol">墨</div>
          <div><strong>MohoBot</strong><span>CONTROL CENTER</span></div>
        </div>
        <div className="sidebar-divider" />
        <div className="workspace-switch"><span className="workspace-dot" /> Main Runtime <span className="workspace-chevron">⌄</span></div>
        <nav className="side-nav">
          {groups.map((group) => (
            <div className="nav-group" key={group}>
              <div className="nav-caption">{group}</div>
              {visible.filter((item) => item.group === group).map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.id} className={view === item.id ? 'nav-item nav-active' : 'nav-item'} onClick={() => setView(item.id)}>
                    <Icon size={17} strokeWidth={1.8} /><span>{item.label}</span>
                    {view === item.id && <span className="nav-indicator" />}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="runtime-mini"><span className="online-dot" /><span>Runtime session</span><Pill tone="success">在线</Pill></div>
          <div className="profile-row">
            <div className="avatar">{String(name).slice(0, 1).toUpperCase()}</div>
            <div className="profile-text"><strong>{name}</strong><span>{principal.role ?? 'admin'}</span></div>
            <button className="icon-button" title="退出登录" onClick={onLogout}><LogOut size={16} /></button>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>MohoBot</span><span className="breadcrumb-sep">/</span><strong>{current?.label ?? '控制台'}</strong></div>
          <div className="topbar-right"><Pill tone="success"><span className="online-dot" /> 已鉴权</Pill><span className="topbar-divider" /><span className="role-label">{principal.role ?? 'admin'}</span></div>
        </header>
        <div className="page-content">{children}</div>
        <footer className="app-footer"><span>MOHOBOT RUNTIME</span><span>管理界面仅展示当前账号获准访问的功能</span></footer>
      </main>
    </div>
  );
}
