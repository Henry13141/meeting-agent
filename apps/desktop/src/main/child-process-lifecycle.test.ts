import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasChildExited,
  terminateChildProcess,
  type TerminableChildProcess,
} from './child-process-lifecycle';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  constructor(
    private readonly exitOn: NodeJS.Signals | null,
    readonly pid = 42,
  ) {
    super();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (signal === this.exitOn) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit('exit', null, signal));
    }
    return true;
  }
}

function terminable(child: FakeChild): TerminableChildProcess {
  return child as unknown as Pick<
    ChildProcess,
    'exitCode' | 'signalCode' | 'kill' | 'once' | 'removeListener' | 'pid'
  >;
}

afterEach(() => vi.useRealTimers());

describe('child process lifecycle', () => {
  it('recognizes both exit codes and terminating signals', () => {
    const child = new FakeChild(null);
    expect(hasChildExited(terminable(child))).toBe(false);
    child.exitCode = 0;
    expect(hasChildExited(terminable(child))).toBe(true);
  });

  it('waits for a graceful Runtime exit', async () => {
    const child = new FakeChild('SIGTERM');

    await expect(terminateChildProcess(terminable(child), {
      platform: 'linux',
    })).resolves.toBe(true);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('terminates the entire Windows Runtime process tree', async () => {
    const child = new FakeChild(null, 4242);
    const terminated = vi.fn(async (pid: number) => {
      expect(pid).toBe(4242);
      child.signalCode = 'SIGKILL';
      queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
      return true;
    });

    await expect(terminateChildProcess(terminable(child), {
      platform: 'win32',
      terminateWindowsProcessTree: terminated,
    })).resolves.toBe(true);
    expect(terminated).toHaveBeenCalledOnce();
    expect(child.signals).toEqual([]);
  });

  it('falls back to ending the direct child when Windows tree termination fails', async () => {
    const child = new FakeChild('SIGKILL');

    await expect(terminateChildProcess(terminable(child), {
      platform: 'win32',
      terminateWindowsProcessTree: async () => false,
    })).resolves.toBe(true);
    expect(child.signals).toEqual(['SIGKILL']);
  });

  it('escalates to a forceful stop after the grace period', async () => {
    vi.useFakeTimers();
    const child = new FakeChild('SIGKILL');
    const stopped = terminateChildProcess(terminable(child), {
      gracefulTimeoutMs: 50,
      forcefulTimeoutMs: 50,
      platform: 'linux',
    });

    await vi.runAllTimersAsync();
    await expect(stopped).resolves.toBe(true);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports a process that survives both signals', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(null);
    const stopped = terminateChildProcess(terminable(child), {
      gracefulTimeoutMs: 50,
      forcefulTimeoutMs: 50,
      platform: 'linux',
    });

    await vi.runAllTimersAsync();
    await expect(stopped).resolves.toBe(false);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
