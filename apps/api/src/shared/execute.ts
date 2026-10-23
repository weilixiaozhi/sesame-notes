import type { FastifyRequest } from 'fastify';

import { ApiError } from './errors.js';

/**
 * 统一转换路由内部异常并附加动作上下文，日志和响应由全局错误边界处理。
 *
 * 归属 shared（HTTP 基础设施）而非业务模块：它只做错误转换与上下文关联，
 * 不包含任何账务领域知识，被 accounting / imports / sync / sharing / auth 等模块共同使用。
 */
export async function execute<T>(
  request: FastifyRequest,
  action: string,
  operation: () => Promise<T>,
  failureCode = 'DATABASE_OPERATION_FAILED',
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // 为最终错误日志附加业务动作；全局边界负责按状态分类并且只记录一次。
    request.log = request.log.child({ action, user_id: request.auth?.userId });
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, failureCode, `${action}失败，请稍后重试`, undefined, { cause: error });
  }
}

/** 按模块绑定固定的 500 失败码，业务处理共用异常捕获与日志边界。 */
export function executor(failureCode: string) {
  return <T>(request: FastifyRequest, action: string, operation: () => Promise<T>): Promise<T> =>
    execute(request, action, operation, failureCode);
}
