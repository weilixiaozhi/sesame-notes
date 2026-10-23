import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBrowserSupportIssue, localPreviewAddress } from './browser-support';

afterEach(() => vi.unstubAllGlobals());

describe('浏览器访问能力', () => {
  it('普通 HTTP 即使提供部分加密接口也不能进入账号页面', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(getBrowserSupportIssue()).toBe('insecure-connection');
  });

  it('安全连接仍需完整 UUID 和摘要接口，不能只检查 URL', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('crypto', { randomUUID: vi.fn(), subtle: undefined });
    expect(getBrowserSupportIssue()).toBe('unsupported-browser');
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn() } });
    expect(getBrowserSupportIssue()).toBe('unsupported-browser');
  });

  it('本机可信来源或 HTTPS 具备所需能力时可正常启动', () => {
    vi.stubGlobal('isSecureContext', true);
    expect(getBrowserSupportIssue()).toBeNull();
  });

  it.each(['10.20.30.40', '172.20.1.2', '192.168.100.10'])('私有测试主机 %s 提供通用本机预览指引', (hostname) => {
    vi.stubGlobal('location', { hostname, port: '4173' });
    expect(localPreviewAddress()).toBe('http://127.0.0.1:4173');
  });

  it.each([
    ['example.com', '4173'],
    ['203.0.113.10', '4173'],
    ['172.32.1.2', '4173'],
    ['10.20.30.40', '8080'],
  ])('其他主机或端口 %s:%s 不猜测本机预览入口', (hostname, port) => {
    vi.stubGlobal('location', { hostname, port });
    expect(localPreviewAddress()).toBeNull();
  });
});
