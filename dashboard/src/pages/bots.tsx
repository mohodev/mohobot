import { PageTitle, Panel, EmptyState } from '../components/ui';
import type { PageProps } from '../lib/types';

export function Bots({}: PageProps) {
  return (
    <>
      <PageTitle eyebrow="RUNTIME INSTANCES" title="机器人" description="此页面正在实现中。" />
      <Panel><EmptyState title="正在实现" detail="该模块正在迁移到 React Dashboard。" /></Panel>
    </>
  );
}
