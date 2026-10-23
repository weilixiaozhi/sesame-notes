import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 读取启动请求并检查字段，参数数组直接传给 Node，不通过 shell 重新解释。 */
function readRequest() {
  try {
    const request = JSON.parse(readFileSync(0, 'utf8'));
    if (
      !Array.isArray(request.arguments) ||
      request.arguments.some((value) => typeof value !== 'string' || value.includes('\0')) ||
      ['directory', 'stdout', 'stderr'].some(
        (key) => typeof request[key] !== 'string' || !path.isAbsolute(request[key]) || request[key].includes('\0'),
      )
    ) {
      throw new Error('启动请求必须包含参数数组以及工作目录和日志文件的绝对路径。');
    }
    return request;
  } catch (error) {
    throw new Error('无法读取独立进程启动请求。', { cause: error });
  }
}

/** 创建独立会话并将日志直接连接文件；启动确认完成后解除父进程对服务的等待。 */
async function startDetached() {
  const descriptors = [];
  let child;
  try {
    const request = readRequest();
    descriptors.push(openSync(request.stdout, 'a'));
    descriptors.push(openSync(request.stderr, 'a'));
    child = spawn(process.execPath, request.arguments, {
      cwd: request.directory,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', ...descriptors],
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    // 回执只包含本次创建的子服务 PID；调用者负责读取真实启动时间并写入身份登记。
    process.stdout.write(`${JSON.stringify({ id: child.pid })}\n`);
    child.unref();
  } catch (error) {
    // 只清理本 helper 持有的 ChildProcess，不接受外部 PID，也不查杀其他监听进程。
    if (child?.pid) {
      try {
        child.kill();
      } catch (cleanupError) {
        console.error('清理本次启动的进程失败：', cleanupError);
      }
    }
    throw new Error('独立测试进程启动失败，请检查 Node、工作目录和日志目录权限。', { cause: error });
  } finally {
    for (const descriptor of descriptors) {
      try {
        closeSync(descriptor);
      } catch (error) {
        console.error('关闭启动日志句柄失败：', error);
      }
    }
  }
}

try {
  await startDetached();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
