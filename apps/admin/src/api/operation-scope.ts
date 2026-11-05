import { ApiError } from '@sesame-notes/api-client';

let operationGeneration = 0;

/** 后台身份、授权或工作区失效时终止旧编辑过程的后续客户端操作。 */
export function invalidateAdminOperationScope(): void {
  operationGeneration += 1;
}

/** 固定编辑器所属的工作区代际，异步返回后也不能转交给新的后台会话。 */
export function captureAdminOperationScope(): () => void {
  const generation = operationGeneration;
  return () => {
    if (generation !== operationGeneration)
      throw new ApiError(409, 'ADMIN_SESSION_CHANGED', '后台登录或权限已变化，请重新打开编辑页面。');
  };
}
