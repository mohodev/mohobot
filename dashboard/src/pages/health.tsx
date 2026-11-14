import { PageTitle, Panel, EmptyState } from '../components/ui';
import type { PageProps } from '../lib/types';

export function Health({}: PageProps) {
  return (
    <>
      <PageTitle eyebrow="SERVICE HEALTH" title="服务健康" description="此页面正在实现中。" />
      <Panel><EmptyState title="正在实现" detail="该模块正在迁移到 React Dashboard。" /></Panel>
    </>
  );
}
