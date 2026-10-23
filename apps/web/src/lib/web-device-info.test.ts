import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectWebDeviceProfile } from './web-device-info';

beforeEach(() => {
  vi.stubGlobal('__WEB_APP_VERSION__', '2.6.1');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Web 真实设备资料', () => {
  it('使用发布构建版本和浏览器返回的真实型号、系统版本', async () => {
    const hints = vi.fn().mockResolvedValue({ platform: 'Android', platformVersion: '14.0.0', model: 'Pixel 8' });
    vi.stubGlobal('navigator', { userAgentData: { platform: 'Android', getHighEntropyValues: hints } });
    expect(await collectWebDeviceProfile()).toEqual({
      platform: 'web',
      app_version: '2.6.1',
      os_version: 'Android 14.0.0',
      device_model: 'Pixel 8',
    });
    expect(hints).toHaveBeenCalledWith(['model', 'platformVersion']);
  });

  it.each([
    undefined,
    { platform: 'Windows' },
    {
      platform: 'Windows',
      getHighEntropyValues: async () => ({ platform: 'Windows', platformVersion: '', model: '' }),
    },
  ])('浏览器不提供资料时省略未知字段，不通过 User-Agent 推测系统或型号', async (userAgentData) => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', userAgentData });
    const profile = await collectWebDeviceProfile();
    expect(profile).toEqual({ platform: 'web', app_version: '2.6.1' });
    expect(Object.hasOwn(profile, 'os_version')).toBe(false);
    expect(Object.hasOwn(profile, 'device_model')).toBe(false);
  });

  it('保留浏览器原始平台版本，不将 Windows 版本编码翻译成推测的系统名称', async () => {
    vi.stubGlobal('navigator', {
      userAgentData: {
        platform: 'Windows',
        getHighEntropyValues: async () => ({ platformVersion: '13.0.0', model: '' }),
      },
    });
    expect(await collectWebDeviceProfile()).toEqual({
      platform: 'web',
      app_version: '2.6.1',
      os_version: 'Windows 13.0.0',
    });
  });

  it('权限拒绝只降级资料采集，版本仍可提交且安全日志没有设备返回内容', async () => {
    vi.stubGlobal('navigator', {
      userAgentData: {
        getHighEntropyValues: vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError')),
      },
    });
    await expect(collectWebDeviceProfile()).resolves.toEqual({ platform: 'web', app_version: '2.6.1' });
    expect(console.warn).toHaveBeenCalledWith(
      '[Web 设备资料] 浏览器资料暂不可用，登录可继续',
      expect.objectContaining({ errorType: 'NotAllowedError' }),
    );
  });

  it('无响应的 Client Hints 有限等待后降级，不阻塞认证', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { userAgentData: { getHighEntropyValues: () => new Promise(() => {}) } });
    const profile = collectWebDeviceProfile();
    await vi.advanceTimersByTimeAsync(500);
    await expect(profile).resolves.toEqual({ platform: 'web', app_version: '2.6.1' });
  });

  it('空白、超长和异常类型字段保持省略，不用无效值覆盖设备资料', async () => {
    vi.stubGlobal('navigator', {
      userAgentData: { getHighEntropyValues: async () => ({ model: 'x'.repeat(129), platformVersion: 14 }) },
    });
    expect(await collectWebDeviceProfile()).toEqual({ platform: 'web', app_version: '2.6.1' });
  });
});
