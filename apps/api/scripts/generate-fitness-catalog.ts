import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 委托共同目录入口，从本仓版本化输入生成服务端与契约的相同动作身份。 */
function main(): void {
  try {
    const generator = fileURLToPath(new URL('../../../scripts/maintenance/sync-mobile-catalogs.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [generator, 'fitness', ...process.argv.slice(2)], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    if (result.signal) throw new Error(`目录生成进程被信号终止：${result.signal}`);
  } catch (error) {
    console.error('健身目录生成启动失败，请检查 Node 运行环境；错误详情：', error);
    process.exitCode = 1;
  }
}

main();
