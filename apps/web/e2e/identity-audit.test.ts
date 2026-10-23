// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { auditBrowserMutation } from './identity-audit';

/** 模拟导航后浏览器响应缓存失效，但不启动浏览器、网络或数据库。 */
function responseFor(path: string, status = 200, method = 'POST') {
  return {
    url: () => `http://127.0.0.1:5555${path}`,
    ok: () => status >= 200 && status < 300,
    status: () => status,
    headers: () => ({ 'content-type': 'application/json' }),
    json: vi.fn().mockResolvedValue({ id: 'created-id' }),
    request: () => ({
      method: () => method,
      headers: () => ({ 'content-type': 'application/json' }),
      postDataJSON: () => ({ ledger_id: 'ledger-id' }),
    }),
  };
}

describe('浏览器测试身份审计范围', () => {
  it.each([
    '/api/v1/ws/ticket',
    '/api/v1/analytics/events',
    '/api/v1/auth/browser/refresh',
    '/api/v1/auth/browser/login',
    '/api/v1/auth/browser/register',
    '/api/v1/auth/browser/logout',
  ])('%s 不读取可随页面导航失效的临时响应，也不重复登记认证身份', async (path) => {
    const response = responseFor(path);
    response.json.mockRejectedValue(new Error('No resource with given identifier found'));
    const record = vi.fn();
    await expect(auditBrowserMutation(response, record)).resolves.toBeUndefined();
    expect(response.json).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('业务写入同时核对请求与响应身份，读取失败仍使验收失败并指出具体接口', async () => {
    const record = vi.fn();
    await auditBrowserMutation(responseFor('/api/v1/ledgers', 201), record);
    expect(record).toHaveBeenCalledWith('POST', '/api/v1/ledgers', {
      input: { ledger_id: 'ledger-id' },
      body: { id: 'created-id' },
    });
    const navigated = responseFor('/api/v1/ledgers', 201);
    navigated.json.mockRejectedValue(new Error('No resource with given identifier found'));
    await expect(auditBrowserMutation(navigated, record)).rejects.toThrow(
      'POST /api/v1/ledgers；No resource with given identifier found',
    );
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('无正文的删除只登记请求身份，GET 和失败响应不记作成功变更', async () => {
    const record = vi.fn();
    const removed = responseFor('/api/v1/ledgers/ledger-id', 204, 'DELETE');
    await auditBrowserMutation(removed, record);
    expect(removed.json).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith('DELETE', '/api/v1/ledgers/ledger-id', {
      input: { ledger_id: 'ledger-id' },
      body: null,
    });
    await auditBrowserMutation(responseFor('/api/v1/ledgers', 200, 'GET'), record);
    await auditBrowserMutation(responseFor('/api/v1/ledgers', 403), record);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
