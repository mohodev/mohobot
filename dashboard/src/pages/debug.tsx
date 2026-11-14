import { PageTitle, Panel, EmptyState } from '../components/ui';
import type { PageProps } from '../lib/types';

export function Debug({}: PageProps) {
  return (
    <>
      <PageTitle eyebrow="DEBUG WORKBENCH" title="调试工作台" description="此页面正在实现中。" />
      <Panel><EmptyState title="正在实现" detail="该模块正在迁移到 React Dashboard。" /></Panel>
    </>
  );
}
