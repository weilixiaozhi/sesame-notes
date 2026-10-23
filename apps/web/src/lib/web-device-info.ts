import type { paths } from '@sesame-notes/api-client';

type LoginDevice = paths['/api/v1/auth/browser/login']['post']['requestBody']['content']['application/json']['device'];
type WebDeviceProfile = Pick<LoginDevice, 'app_version' | 'os_version' | 'device_model'> & { platform: 'web' };
type BrowserDeviceHints = {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
};
const HINTS_TIMEOUT_MS = 500;

/** 浏览器未提供的字段保持缺失，超长和非字符串值不能覆盖设备已有资料。 */
function deviceText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= maximum ? text : undefined;
}

/** 登录、注册与刷新共用实际发布版本及浏览器提供的型号、系统版本，不推测硬件或系统名称。 */
export async function collectWebDeviceProfile(): Promise<WebDeviceProfile> {
  const profile: WebDeviceProfile = { platform: 'web' };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const version = typeof __WEB_APP_VERSION__ === 'undefined' ? undefined : deviceText(__WEB_APP_VERSION__, 64);
    if (version) profile.app_version = version;
    const hints = (navigator as Navigator & { userAgentData?: BrowserDeviceHints }).userAgentData;
    if (!hints?.getHighEntropyValues) return profile;
    // 浏览器拒绝、缺少权限或迟迟不返回时，资料采集不能阻止正常认证。
    const values = await Promise.race([
      hints.getHighEntropyValues(['model', 'platformVersion']),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('BROWSER_DEVICE_HINTS_TIMEOUT')), HINTS_TIMEOUT_MS);
      }),
    ]);
    const model = deviceText(values.model, 128);
    const platformVersion = deviceText(values.platformVersion, 64);
    const platform = deviceText(values.platform, 32) ?? deviceText(hints.platform, 32);
    const osVersion = platformVersion
      ? deviceText(platform ? `${platform} ${platformVersion}` : platformVersion, 64)
      : undefined;
    if (model) profile.device_model = model;
    if (osVersion) profile.os_version = osVersion;
    return profile;
  } catch (error) {
    // 不记录完整 User-Agent 或设备返回内容，安全日志只保留失败类型与调用位置。
    console.warn('[Web 设备资料] 浏览器资料暂不可用，登录可继续', {
      errorType: error instanceof Error || error instanceof DOMException ? error.name : typeof error,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return profile;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
