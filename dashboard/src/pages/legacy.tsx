import { ArrowUpRight, Construction } from 'lucide-react';
import { PageTitle, Panel } from '../components/ui';

const oldTabs: Record<string, string> = {
  plugins: 'plugins',
  mcp: 'mcp',
  world: 'world',
  device: 'device',
  tasks: 'operations',
  users: 'users',
  settings: 'config',
  debug: 'debugchat',
  health: 'health',
};

const descriptions: Record<string, string> = {
  plugins: '插件启停、配置和热重载。',
  mcp: 'MCP Server、工具权限、调用审计与受控测试。',
  world: '世界事件、日程、状态演化和回放。',
  device: '设备状态、用户关系和好感度管理。',
  tasks: 'Future Task 队列、执行状态和重试控制。',
  users: '管理员账号、角色权限和临时令牌。',
  settings: '配置版本发布、确认、激活回执与回滚。',
  debug: '受控调试聊天、行为 dry-run 和开发诊断。',
  health: '服务健康、运行指标和可用性检查。',
};

export function LegacyFeature({ view, title }: { view: string; title: string }) {
  const tab = oldTabs[view];
  return (
    <>
      <PageTitle eyebrow="MIGRATION IN PROGRESS" title={title} description={descriptions[view] ?? '该模块正在迁移到新的管理前端。'} />
      <Panel className="migration-panel">
        <div className="migration-icon"><Construction size={22} /></div>
        <h2>模块迁移中</h2>
        <p>此功能仍由当前稳定的经典控制台提供。新界面尚未替换它的完整管理流程，因此不会用静态按钮冒充已经迁移。</p>
        <a className="button button-primary link-button-action" href={tab ? `/#${tab}` : '/'}>在经典控制台打开 <ArrowUpRight size={15} /></a>
      </Panel>
    </>
  );
}
