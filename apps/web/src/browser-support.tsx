type BrowserSupportIssue = 'insecure-connection' | 'unsupported-browser';

/** 在加载会话与业务模块前检查浏览器能力，避免提交操作时才因安全上下文缺失而失败。 */
export function getBrowserSupportIssue(): BrowserSupportIssue | null {
  if (!window.isSecureContext) return 'insecure-connection';
  if (typeof window.crypto?.randomUUID !== 'function' || typeof window.crypto?.subtle?.digest !== 'function')
    return 'unsupported-browser';
  return null;
}

/** 为私有 IPv4 的常用开发端口提供本机指引，不猜测站点的 HTTPS 配置。 */
export function localPreviewAddress(): string | null {
  const hostname = window.location.hostname;
  const octets = hostname.split('.').map(Number);
  const privateIp =
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) &&
    octets.every((part) => part >= 0 && part <= 255) &&
    (octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168));
  if (!privateIp || !['4173', '5173'].includes(window.location.port)) return null;
  return `http://127.0.0.1:${window.location.port}`;
}

/** 不安全连接下不显示登录表单，也不初始化会话请求。 */
export function BrowserSupportNotice({ issue }: { issue: BrowserSupportIssue }) {
  const preview = issue === 'insecure-connection' ? localPreviewAddress() : null;
  return (
    <main className="fatal-error">
      <h1>{issue === 'insecure-connection' ? '请使用安全连接' : '当前浏览器暂不支持'}</h1>
      <p>
        {issue === 'insecure-connection'
          ? '请通过本站的 HTTPS 地址访问芝麻记，再登录和编辑数据。'
          : '请更新浏览器后重新打开芝麻记。'}
      </p>
      {preview && (
        <p>
          本地验收请在运行服务的电脑打开 <a href={preview}>{preview}</a>；其他设备需要 HTTPS 地址。
        </p>
      )}
    </main>
  );
}
