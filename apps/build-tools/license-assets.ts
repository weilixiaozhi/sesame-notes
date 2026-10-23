import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const LICENSE_FILES = [
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt',
  'third_party/exercises-dataset/LICENSE',
  'third_party/exercises-dataset/NOTICE.md',
  'third_party/libphonenumber/LICENSE',
] as const;

type LicenseBuildContext = {
  addWatchFile: (path: string) => void;
  emitFile: (asset: { type: 'asset'; fileName: string; source: Uint8Array }) => string;
  error: (error: Error) => never;
};

/** 将仓库现有许可原文随网页产物发布，保留声明中引用的相对目录。 */
export function licenseAssetsPlugin(repositoryRoot: URL) {
  return {
    name: 'sesame-license-assets',
    apply: 'build' as const,
    /** 在产物写入前读取全部许可；缺失、空文件或读取错误都中止构建。 */
    async buildStart(this: LicenseBuildContext) {
      for (const fileName of LICENSE_FILES) {
        try {
          const sourcePath = fileURLToPath(new URL(fileName, repositoryRoot));
          this.addWatchFile(sourcePath);
          const source = await readFile(sourcePath);
          if (!source.toString('utf8').trim()) throw new Error('LICENSE_FILE_EMPTY');
          // 使用固定文件名，避免内容哈希重命名使总声明中的许可路径失效。
          this.emitFile({ type: 'asset', fileName, source });
        } catch (cause) {
          this.error(new Error(`发布许可读取失败：${fileName}。请恢复仓库内的完整许可文件后重试。`, { cause }));
        }
      }
    },
  };
}
