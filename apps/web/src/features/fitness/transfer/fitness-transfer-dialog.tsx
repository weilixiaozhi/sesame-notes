import { lazy, Suspense } from 'react';
import { Dialog, LoadingState } from '../../../components/ui';
import type { FitnessSpace } from '../fitness-model';

const Content = lazy(async () => ({ default: (await import('./fitness-transfer-content')).FitnessTransferDialog }));

/** 用户打开文件传输时才加载解析与预览界面，不增加健身首页的格式处理依赖。 */
export function FitnessTransferDialog(props: { space: FitnessSpace; onClose: () => void }) {
  return (
    <Suspense
      fallback={
        <Dialog open title="健身数据导入与导出" description={`当前空间：${props.space.name}`} onClose={props.onClose}>
          <LoadingState label="正在加载文件工具…" />
        </Dialog>
      }
    >
      <Content {...props} />
    </Suspense>
  );
}
