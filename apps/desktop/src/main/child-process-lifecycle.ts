import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

export type TerminableChildProcess = Pick<
  ChildProcess,
  'exitCode' | 'signalCode' | 'kill' | 'once' | 'removeListener' | 'pid'
>;

type WindowsProcessTreeTerminator = (pid: number) => Promise<boolean>;

function terminateWindowsProcessTree(pid: number): Promise<boolean> {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
  return new Promise((resolve) => {
    execFile(
      taskkill,
      ['/pid', String(pid), '/t', '/f'],
      { windowsHide: true },
      (error) => resolve(error === null),
    );
  });
}

export function hasChildExited(child: TerminableChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function waitForChildExit(
  child: TerminableChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (hasChildExited(child)) return true;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(hasChildExited(child)), timeoutMs);
    child.once('exit', onExit);
  });
}

export async function terminateChildProcess(
  child: TerminableChildProcess,
  options: Readonly<{
    gracefulTimeoutMs?: number;
    forcefulTimeoutMs?: number;
    platform?: NodeJS.Platform;
    terminateWindowsProcessTree?: WindowsProcessTreeTerminator;
  }> = {},
): Promise<boolean> {
  if (hasChildExited(child)) return true;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5_000;
  const forcefulTimeoutMs = options.forcefulTimeoutMs ?? 1_000;

  if ((options.platform ?? process.platform) === 'win32') {
    const pid = child.pid;
    if (typeof pid === 'number' && pid > 0) {
      const terminateTree = options.terminateWindowsProcessTree ?? terminateWindowsProcessTree;
      const treeTerminated = await terminateTree(pid).catch(() => false);
      if (treeTerminated) return await waitForChildExit(child, forcefulTimeoutMs);
      // Keep the pre-existing direct-child fallback if taskkill itself is unavailable.
      child.kill('SIGKILL');
      return await waitForChildExit(child, forcefulTimeoutMs);
    }
  }

  child.kill('SIGTERM');
  if (await waitForChildExit(child, gracefulTimeoutMs)) return true;

  child.kill('SIGKILL');
  return await waitForChildExit(child, forcefulTimeoutMs);
}
