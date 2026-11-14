import { PageTitle, Panel, EmptyState } from '../components/ui';
import type { PageProps } from '../lib/types';

export function Settings({}: PageProps) {
  return (
    <>
      <PageTitle eyebrow="CONFIG PUBLICATION" title="配置发布" description="此页面正在实现中。" />
      <Panel><EmptyState title="正在实现" detail="该模块正在迁移到 React Dashboard。" /></Panel>
    </>
  );
}
