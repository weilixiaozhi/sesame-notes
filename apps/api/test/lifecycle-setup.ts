import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { lifecycleSetupBudgetMs, haltLifecycleRun } from './lifecycle-test-database.js';

const runFile = promisify(execFile);

/** Run only this lease's migration process; timeouts terminate its owned Windows process tree. */
export async function runLifecycleSetup(url: string, setup: string, cwd: string): Promise<void> {
  const budget = lifecycleSetupBudgetMs(url, process.env);
  if (budget <= 0) {
    haltLifecycleRun(process.env, 'Migration case exhausted its shared setup deadline.');
    throw new Error('Migration case exhausted its shared setup deadline.');
  }
  if (process.platform !== 'win32') throw new Error('This approved lifecycle runner requires Windows.');
  const child = spawn(process.execPath, [setup], {
    cwd,
    env: { ...process.env, DATABASE_URL: url },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let childError: Error | undefined;
  let termination: Promise<void> | undefined;
  let rejectTermination: (error: Error) => void = () => undefined;
  const terminationFailed = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject;
  });
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-1_000_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      childError = error;
    });
    child.once('close', (code) => resolve(code));
  });
  const timer = setTimeout(() => {
    termination = (async () => {
      try {
        haltLifecycleRun(process.env, 'Migration process exceeded its eighty-second deadline.');
      } catch {
        /* The active lease stays persisted; owned process termination must still proceed. */
      }
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        try {
          haltLifecycleRun(process.env, 'Migration root exited without confirmed process-tree closure.', true);
        } catch {
          /* The local cleanup block is already set. */
        }
        throw new Error('Migration root exited before its process-tree closure could be confirmed.');
      }
      try {
        await runFile(
          join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 15_000 },
        );
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closed,
            new Promise<never>((_resolve, reject) => {
              closeTimer = setTimeout(() => reject(new Error('Owned process-tree close was not confirmed.')), 3_000);
            }),
          ]);
        } finally {
          clearTimeout(closeTimer);
        }
      } catch {
        try {
          haltLifecycleRun(process.env, 'Owned migration process tree termination could not be confirmed.', true);
        } catch {
          /* The in-process cleanup block is set before attempting to persist it. */
        }
        throw new Error('Migration process cleanup is uncertain; this run must stop.');
      }
    })();
    // The rejection is observed below after the child closes; avoid an early unhandled rejection.
    void termination.catch((error: Error) => {
      rejectTermination(error);
    });
  }, budget);
  let code: number | null;
  try {
    code = await Promise.race([closed, terminationFailed]);
    await termination;
  } finally {
    clearTimeout(timer);
  }
  if (termination || childError || code !== 0) {
    const parsed = new URL(url);
    let safeOutput = output.replaceAll(url, '[temporary database URL]');
    if (parsed.password)
      safeOutput = safeOutput
        .replaceAll(parsed.password, '[redacted]')
        .replaceAll(decodeURIComponent(parsed.password), '[redacted]');
    throw Object.assign(new Error(`Lifecycle migration process failed (exit ${code ?? 'none'}).\n${safeOutput}`), {
      stdout: safeOutput,
      stderr: '',
    });
  }
}
