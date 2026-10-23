/**
 * 从 api-contract 的 openapi.json 生成类型安全 API 类型。
 *
 * openapi-typescript 7.x 的 Node API 返回 TypeScript AST，需经 astToString 转为源码；
 * 使用基于 import.meta.url 的绝对路径，不依赖运行时的当前工作目录。
 */
import openapiTS, { astToString } from 'openapi-typescript';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultOutput = resolve(here, '../src/generated/api.ts');
const defaultInput = new URL('../../api-contract/openapi.json', import.meta.url);

/** 生成当前契约类型；检查模式只比较原文件，不创建目录或写入生成结果。 */
export async function generateApiClientTypes({ check = false, input = defaultInput, output = defaultOutput } = {}) {
  const code = astToString(await openapiTS(input));
  if (check) {
    // 按 UTF-8 原始字节比较，换行、编码、注释和类型表达的变化都不能静默放行。
    const current = await readFile(output);
    if (!current.equals(Buffer.from(code, 'utf8'))) {
      throw new Error(
        'API Client 类型与当前契约生成结果不一致，请运行 pnpm --filter @sesame-notes/api-client generate 并审阅差异。',
      );
    }
  } else {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, code, 'utf8');
  }
  return { output, characters: code.length, checked: check };
}

/** 仅接受默认生成或只读检查，错误摘要与完整原因一起输出供本地和 CI 诊断。 */
async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
      throw new Error('用法：node scripts/generate.mjs [--check]');
    }
    const result = await generateApiClientTypes({ check: args[0] === '--check' });
    console.log(
      result.checked
        ? `API Client 生成一致性检查通过（${result.characters} 字符）。`
        : `已生成 ${result.output}（${result.characters} 字符）。`,
    );
  } catch (error) {
    console.error('API Client 类型处理未完成，请检查契约、生成文件及下方详细错误。', error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
