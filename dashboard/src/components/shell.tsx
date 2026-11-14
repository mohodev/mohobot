import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity, Bot, Brain, Boxes, Cpu, Database, Globe2, GraduationCap, HeartPulse,
  LayoutDashboard, Library, Logs, LogOut, MessageSquare, Plug, Puzzle, ScrollText,
  Search, Settings2, ShieldCheck, Smartphone, Sparkles, Users, Workflow,
} from 'lucide-react';
import type { AdminPrincipal } from '../lib/types';
import { Pill } from './ui';

export type ViewId =
  | 'overview' | 'bots' | 'providers' | 'models' | 'logs' | 'characters'
  | 'memory' | 'jargon' | 'plugins' | 'mcp' | 'knowledge' | 'world' | 'device'
  | 'affinity' | 'tasks' | 'futuretasks' | 'sessions' | 'users' | 'settings'
  | 'health' | 'debug';

interface MenuItem {
  id: ViewId;
  label: string;
  permission: string;
  icon: typeof LayoutDashboard;
  group: string;
  /** Extra permission aliases that may also grant visibility. */
  anyOf?: string[];
}

export const MENU_ITEMS: MenuItem[] = [
  { id: 'overview', label: '运行总览', permission: 'status.read', icon: LayoutDashboard, group: '工作空间' },
  { id: 'bots', label: '机器人', permission: 'gateway.read', anyOf: ['status.read'], icon: Bot, group: '工作空间' },
  { id: 'providers', label: '模型供应商', permission: 'providers.read', icon: Boxes, group: 'AI 基础设施' },
  { id: 'models', label: '模型运营', permission: 'models.read', icon: Cpu, group: 'AI 基础设施' },
  { id: 'characters', label: '角色档案', permission: 'characters.read', icon: Users, group: '人格与记忆' },
  { id: 'memory', label: '语义记忆', permission: 'memory.metadata.read', icon: Brain, group: '人格与记忆' },
  { id: 'jargon', label: '表达与黑话', permission: 'memory.metadata.read', anyOf: ['memory.read'], icon: Sparkles, group: '人格与记忆' },
  { id: 'knowledge', label: '知识库', permission: 'knowledge.read', icon: Library, group: '人格与记忆' },
  { id: 'world', label: '世界模拟', permission: 'world.read', icon: Globe2, group: '自动化与沉浸状态' },
  { id: 'device', label: '设备状态', permission: 'device.read', icon: Smartphone, group: '自动化与沉浸状态' },
  { id: 'affinity', label: '好感度', permission: 'memory.read', icon: Sparkles, group: '自动化与沉浸状态' },
  { id: 'tasks', label: '任务调度', permission: 'tasks.read', icon: Activity, group: '自动化与沉浸状态' },
  { id: 'futuretasks', label: 'Future Tasks', permission: 'tasks.read', icon: Activity, group: '自动化与沉浸状态' },
  { id: 'plugins', label: '插件管理', permission: 'plugin.read', icon: Puzzle, group: '扩展能力' },
  { id: 'mcp', label: 'MCP 工具', permission: 'mcp.read', icon: Workflow, group: '扩展能力' },
  { id: 'logs', label: '实时日志', permission: 'logs.read', icon: Logs, group: '观测与治理' },
  { id: 'health', label: '服务健康', permission: 'status.read', icon: HeartPulse, group: '观测与治理' },
  { id: 'sessions', label: '会话与审计', permission: 'sessions.chat.read', anyOf: ['audit.read'], icon: ScrollText, group: '观测与治理' },
  { id: 'users', label: '管理员', permission: 'users.read', icon: ShieldCheck, group: '系统设置' },
  { id: 'settings', label: '配置发布', permission: 'config.publish', icon: Settings2, group: '系统设置' },
  { id: 'debug', label: '调试工作台', permission: 'debug.chat', icon: MessageSquare, group: '系统设置' },
];

export function visibleItems(permissions: string[]): MenuItem[] {
  const granted = new Set(permissions);
  return MENU_ITEMS.filter((item) => granted.has(item.permission) || item.anyOf?.some((alias) => granted.has(alias)));
}

export function isViewAllowed(view: ViewId, permissions: string[]): boolean {
  const item = MENU_ITEMS.find((candidate) => candidate.id === view);
  if (!item) return false;
  return permissions.includes(item.permission) || Boolean(item.anyOf?.some((alias) => permissions.includes(alias)));
}

/** Navigation grouped by section, preserving the canonical group order. */
export function groupedItems(items: MenuItem[]): Array<{ group: string; items: MenuItem[] }> {
  const order: string[] = [];
  const map = new Map<string, MenuItem[]>();
  for (const item of items) {
    if (!map.has(item.group)) { map.set(item.group, []); order.push(item.group); }
    map.get(item.group)!.push(item);
  }
  return order.map((group) => ({ group, items: map.get(group) ?? [] }));
}

export function Shell({ children, view, setView, principal, permissions, onLogout }: {
  children: ReactNode;
  view: ViewId;
  setView: (view: ViewId) => void;
  principal: AdminPrincipal;
  permissions: string[];
  onLogout: () => void;
}) {
  const visible = visibleItems(permissions);
  const groups = groupedItems(visible);
  const current = MENU_ITEMS.find((item) => item.id === view);
  const name = principal.username ?? principal.id ?? '管理员';
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const matched = needle
    ? visible.filter((item) => item.label.toLowerCase().includes(needle) || item.group.toLowerCase().includes(needle))
    : visible;

  // Reset the search whenever the navigation target changes, so the next open
  // shows the full menu instead of a stale filter.
  useEffect(() => { setQuery(''); }, [view]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-symbol">墨</div>
          <div><strong>MohoBot</strong><span>CONTROL CENTER</span></div>
        </div>
        <div className="sidebar-divider" />
        <div className="workspace-switch"><span className="workspace-dot" /> Main Runtime <span className="workspace-chevron">⌄</span></div>
        <label className="side-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索功能…"
            aria-label="搜索导航"
          />
        </label>
        <nav className="side-nav">
          {matched.length === 0 && <div className="nav-empty">没有匹配的功能</div>}
          {matched.length > 0 && (needle ? [{ group: '搜索结果', items: matched }] : groups).map((section) => (
            <div className="nav-group" key={section.group}>
              <div className="nav-caption">{section.group}</div>
              {section.items.map((item) => {
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
          <div className="topbar-right">
            <a className="topbar-link" href="/" title="打开经典控制台"><Plug size={14} /> 经典控制台</a>
            <span className="topbar-divider" />
            <Pill tone="success"><span className="online-dot" /> 已鉴权</Pill>
            <span className="topbar-divider" />
            <span className="role-label">{principal.role ?? 'admin'}</span>
          </div>
        </header>
        <div className="page-content">{children}</div>
        <footer className="app-footer">
          <span>MOHOBOT RUNTIME</span>
          <span className="footer-legend"><Database size={12} /> SQLite 真相源 · 管理界面仅展示当前账号获准访问的功能</span>
          <span><GraduationCap size={12} /> 高风险操作需服务端确认</span>
        </footer>
      </main>
    </div>
  );
}
