import { errorCodes, type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { safeRequestUrl } from './request-logging.js';

export class ApiError extends Error {
  /** 保存稳定响应字段与内部原始原因，原始原因只用于诊断。 */
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApiError';
  }
}

/**
 * 取同步推送前几个变更的身份字段用于定位。
 *
 * 只取 id 类字段，不记录金额、备注等业务内容；不是同步推送或结构不符时返回 null。
 */
function syncPushIdentities(request: FastifyRequest): Array<Record<string, unknown>> | null {
  if (request.url !== '/api/v1/sync/push') return null;
  const body = request.body;
  if (typeof body !== 'object' || body === null) return null;
  const changes = (body as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return null;
  return changes.slice(0, 3).map((change) => {
    const item = (change ?? {}) as Record<string, unknown>;
    return {
      entity_type: item.entity_type,
      entity_id: item.entity_id,
      mutation_id: item.mutation_id,
      ledger_id: item.ledger_id,
      day_book_id: item.day_book_id,
      memo_book_id: item.memo_book_id,
      fitness_space_id: item.fitness_space_id,
    };
  });
}

/** 注册统一错误边界；详细异常写日志，响应只返回稳定错误码和友好信息。 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (error: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply) => {
    try {
      const validation = 'validation' in error && error.validation;
      // 头像上传路由独立 bodyLimit 超限：与业务像素/字节超限返回同一错误码，
      // 页面统一展示「图片过大，请选择较小的图片」
      if (error instanceof errorCodes.FST_ERR_CTP_BODY_TOO_LARGE) {
        request.log.warn({ request_id: request.id, url: safeRequestUrl(request.url) }, '请求体超过路由上限');
        const isAvatarUpload = request.url.startsWith('/api/v1/profile/avatar') && request.method === 'PUT';
        await reply.status(413).send({
          code: isAvatarUpload ? 'AVATAR_TOO_LARGE' : 'PAYLOAD_TOO_LARGE',
          message: isAvatarUpload ? '图片过大，请选择较小的图片' : '请求内容过大',
          request_id: request.id,
        });
        return;
      }
      // 只信任框架解析器的明确错误类型，普通异常携带 statusCode 或同名 code 仍属于内部故障。
      const invalidBody =
        error instanceof errorCodes.FST_ERR_CTP_INVALID_JSON_BODY ||
        error instanceof errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY ||
        error instanceof errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH;
      const unsupportedMedia = error instanceof errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE;
      if (invalidBody || unsupportedMedia) {
        // 正文尚未可信解析，日志仅保留框架错误码与请求编号，不记录原始输入或密码片段。
        request.log.warn({ code: error.code, request_id: request.id }, '请求正文解析失败');
        await reply.status(unsupportedMedia ? 415 : 400).send({
          code: unsupportedMedia ? 'UNSUPPORTED_MEDIA_TYPE' : 'VALIDATION_ERROR',
          message: unsupportedMedia ? '请求内容格式不受支持' : '请求参数不符合接口要求',
          request_id: request.id,
        });
        return;
      }
      if (validation) {
        // 同步请求外壳校验失败时记录前几个变更的身份字段，帮助定位整批拒绝的来源。
        const identities = syncPushIdentities(request);
        request.log.warn(
          { err: error, request_id: request.id, ...(identities === null ? {} : { changes: identities }) },
          '请求参数校验失败',
        );
        await reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: '请求参数不符合接口要求',
          request_id: request.id,
          details: validation,
        });
        return;
      }

      if (error instanceof ApiError) {
        const context = {
          err: error,
          code: error.code,
          request_id: request.id,
          // 后台对两个异常字段分别脱敏，仍保留底层故障代码与源码位置。
          ...(error.cause === undefined ? {} : { original_error: error.cause }),
        };
        if (error.statusCode >= 500) request.log.error(context, '服务端请求失败');
        else request.log.warn(context, '业务请求失败');
        await reply.status(error.statusCode).send({
          code: error.code,
          message: error.message,
          request_id: request.id,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
        return;
      }

      request.log.error({ err: error, request_id: request.id }, '未处理的服务端异常');
      await reply.status(500).send({
        code: 'INTERNAL_ERROR',
        message: '服务暂时不可用，请稍后重试',
        request_id: request.id,
      });
    } catch (handlerError) {
      request.log.error({ err: handlerError, original_error: error, request_id: request.id }, '错误响应发送失败');
      if (!reply.sent) await reply.status(500).send('Internal Server Error');
    }
  });
}
