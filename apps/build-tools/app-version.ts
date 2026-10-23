import { readFile } from 'node:fs/promises';

/** 从各端的发布包元信息读取独立版本，构建无需 Git 或提交历史。 */
export async function readAppVersion(packageUrl: URL, appName: string): Promise<string> {
  try {
    const metadata: unknown = JSON.parse(await readFile(packageUrl, 'utf8'));
    const version = metadata && typeof metadata === 'object' && 'version' in metadata ? metadata.version : undefined;
    if (typeof version !== 'string' || !version.trim() || version.length > 64) throw new Error('APP_VERSION_INVALID');
    return version.trim();
  } catch (cause) {
    throw new Error(`${appName} 发布版本读取失败，请检查 package.json 的 version。`, { cause });
  }
}

/** 将页面使用的同一版本写入静态产物，供发布脚本核验实际提供服务的站点。 */
export function appVersionPlugin(component: 'web' | 'admin', version: string) {
  return {
    name: 'sesame-app-version',
    apply: 'build' as const,
    /** 版本文件与页面一起构建，独立部署时只标识当前端。 */
    buildStart(this: {
      emitFile: (asset: { type: 'asset'; fileName: string; source: string }) => string;
      error: (error: Error) => never;
    }) {
      try {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: `${JSON.stringify({ component, version }, null, 2)}\n`,
        });
      } catch (cause) {
        this.error(new Error('站点版本文件生成失败，请检查构建日志。', { cause }));
      }
    },
  };
}
