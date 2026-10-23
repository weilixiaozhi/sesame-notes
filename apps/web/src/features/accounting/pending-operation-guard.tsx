import { useDraftClose } from '../../components/use-draft-close';

/** 删除或归档请求提交期间保护页面导航与浏览器刷新，防止结果未知时误重复操作。 */
export function PendingOperationGuard() {
  useDraftClose(false, true, () => undefined);
  return null;
}
