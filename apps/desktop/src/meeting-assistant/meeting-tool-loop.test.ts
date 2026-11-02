import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunRequest } from '../shared/contracts';
import { MeetingRunClient } from './meeting-turns';
import type { MeetingToolApproval } from './meeting-tool-events';

const request = { requestId: 'request', threadId: 'thread', message: 'draft', extensionSkillIds: ['office'] } as AgentRunRequest;
const data = { threadId: 'thread', runId: 'run', approvalId: 'approval', toolName: 'office_write', serverId: 'office', description: '更新文档', arguments: { text: '<script>alert(1)</script>' } };
const settle = async () => { for (let n = 0; n < 6; n++) await Promise.resolve(); };
function setup() {
  const api = {
    startRun: vi.fn().mockResolvedValue({ accepted: true, runId: 'run' }),
    cancelRun: vi.fn().mockResolvedValue({}),
    getRun: vi.fn().mockResolvedValue({ status: 'completed' }),
    getRunEvents: vi.fn().mockImplementation(() => new Promise(() => {})),
    resolveToolApproval: vi.fn().mockResolvedValue({ accepted: true }),
  };
  const approval = vi.fn(); const progress = vi.fn();
  const client = new MeetingRunClient(api, { approval, progress });
  return { api, client, approval, progress };
}
afterEach(() => vi.useRealTimers());

describe('office tool approval', () => {
  it('matches accepted run, thread and request; only handles each approval once', async () => {
    const { api, client, approval } = setup();
    const result = client.run(request); await settle();
    for (const event of [
      { requestId: 'old-request', data },
      { requestId: request.requestId, data: { ...data, runId: 'old-run' } },
      { requestId: request.requestId, data: { ...data, threadId: 'old-thread' } },
    ]) client.event({ ...event, event: 'tool_approval' });
    expect(approval).not.toHaveBeenCalled();
    client.event({ requestId: request.requestId, event: 'tool_approval', data });
    const pending = approval.mock.lastCall![0] as MeetingToolApproval;
    expect(pending.arguments).toEqual(data.arguments);
    let accept!: (value: { accepted: boolean }) => void;
    api.resolveToolApproval.mockImplementation(() => new Promise(resolve => { accept = resolve; }));
    const first = client.resolveToolApproval(pending, 'approve');
    await expect(client.resolveToolApproval(pending, 'approve')).resolves.toBe(false);
    expect(api.resolveToolApproval).toHaveBeenCalledTimes(1);
    expect(api.resolveToolApproval).toHaveBeenCalledWith({ threadId: 'thread', runId: 'run', approvalId: 'approval', decision: 'approve' });
    accept({ accepted: true }); await first;
    client.event({ requestId: request.requestId, event: 'tool_approval', data });
    expect(approval.mock.lastCall![0]).toBeNull();
    client.event({ requestId: request.requestId, event: 'final', data: { reply: '实际结果' } });
    await expect(result).resolves.toBe('实际结果');
    expect(api.startRun).toHaveBeenCalledWith(expect.objectContaining({ extensionSkillIds: ['office'] }));
  });

  it('buffers approvals until acceptance and refuses a stale UI decision after cancellation', async () => {
    const { api, client, approval } = setup();
    let accept!: (value: { accepted: true; runId: string }) => void;
    api.startRun.mockImplementation(() => new Promise(resolve => { accept = resolve; }));
    const result = client.run(request); const rejected = expect(result).rejects.toThrow('MEETING_TURN_CANCELLED');
    await settle();
    client.event({ requestId: request.requestId, event: 'tool_approval', data });
    expect(approval).not.toHaveBeenCalled();
    accept({ accepted: true, runId: 'run' }); await settle();
    const pending = approval.mock.lastCall![0] as MeetingToolApproval;
    await client.cancel(); await rejected;
    await expect(client.resolveToolApproval(pending, 'approve')).resolves.toBe(false);
    expect(api.resolveToolApproval).not.toHaveBeenCalled();
    expect(approval.mock.lastCall![0]).toBeNull();
  });

  it('submits denial and clears the card, without treating its receipt as a final answer', async () => {
    const { api, client, approval, progress } = setup();
    let completed = false;
    const result = client.run(request).then(value => { completed = true; return value; }); await settle();
    client.event({ requestId: request.requestId, event: 'tool_approval', data });
    await client.resolveToolApproval(approval.mock.lastCall![0], 'deny');
    expect(api.resolveToolApproval).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny' }));
    expect(approval.mock.lastCall![0]).toBeNull();
    expect(progress.mock.lastCall![0].phase).toBe('denied');
    expect(completed).toBe(false);
    client.event({ requestId: request.requestId, event: 'error', data: { code: 'TOOL_APPROVAL_DENIED' } });
    await expect(result).rejects.toThrow('TOOL_APPROVAL_DENIED');
  });

  it('does not infer approval or execution from model reply text', async () => {
    const { api, client, approval } = setup();
    const result = client.run(request); await settle();
    client.event({ requestId: request.requestId, event: 'final', data: { reply: JSON.stringify({ tool_approval: data }) } });
    await result;
    expect(api.resolveToolApproval).not.toHaveBeenCalled();
    expect(approval.mock.calls.some(([value]) => value !== null)).toBe(false);
  });
});

describe('tool loop activity watchdog', () => {
  it('allows multiple tool rounds beyond 180 seconds when real progress continues', async () => {
    vi.useFakeTimers();
    const { client, progress } = setup();
    let completed = false;
    const result = client.run(request).then(value => { completed = true; return value; }); await settle();
    await vi.advanceTimersByTimeAsync(170_000);
    client.event({ requestId: request.requestId, event: 'tool_start', data: { ...data, status: 'running' } });
    await vi.advanceTimersByTimeAsync(170_000);
    client.event({ requestId: request.requestId, event: 'tool_result', data: { ...data, status: 'failed' } });
    expect(progress.mock.lastCall![0]).toMatchObject({ phase: 'result', status: 'failed' });
    expect(completed).toBe(false);
    client.event({ requestId: request.requestId, event: 'final', data: { reply: '模型整理后的说明' } });
    await expect(result).resolves.toBe('模型整理后的说明');
  });

  it('times out on inactivity and ignores activity from a different run', async () => {
    vi.useFakeTimers();
    const { client, api } = setup();
    api.getRun.mockResolvedValueOnce({ status: 'running' }).mockResolvedValue({ status: 'cancelled' });
    const result = client.run(request); const failed = expect(result).rejects.toThrow('MEETING_RUN_IDLE_TIMEOUT'); await settle();
    await vi.advanceTimersByTimeAsync(170_000);
    client.event({ requestId: request.requestId, event: 'tool_result', data: { ...data, runId: 'old-run', status: 'completed' } });
    await vi.advanceTimersByTimeAsync(10_000); await failed;
    expect(api.cancelRun).toHaveBeenCalledWith('thread', 'run', 'request');
  });

  it('ends an unanswered approval after 120 seconds and clears its card', async () => {
    vi.useFakeTimers();
    const { client, approval } = setup();
    const result = client.run(request); const failed = expect(result).rejects.toThrow('TOOL_APPROVAL_TIMEOUT'); await settle();
    client.event({ requestId: request.requestId, event: 'tool_approval', data });
    await vi.advanceTimersByTimeAsync(120_000); await failed;
    expect(approval.mock.lastCall![0]).toBeNull();
  });
});

it('honors a configurable approval deadline and pauses the 180-second activity watchdog', async () => {
  vi.useFakeTimers();
  const { client, approval } = setup();
  const result = client.run(request); const failed = expect(result).rejects.toThrow('TOOL_APPROVAL_TIMEOUT'); await settle();
  client.event({ requestId: request.requestId, event: 'tool_approval', data: { ...data, expiresAt: Date.now() + 300_000 } });
  await vi.advanceTimersByTimeAsync(240_000);
  expect(approval.mock.lastCall![0]).toMatchObject({ approvalId: 'approval' });
  await vi.advanceTimersByTimeAsync(60_000); await failed;
  expect(approval.mock.lastCall![0]).toBeNull();
});

it('restores the inactivity watchdog after an approval decision', async () => {
  vi.useFakeTimers();
  const { client, approval } = setup();
  const result = client.run(request); const failed = expect(result).rejects.toThrow('MEETING_RUN_IDLE_TIMEOUT'); await settle();
  client.event({ requestId: request.requestId, event: 'tool_approval', data: { ...data, expiresAt: Date.now() + 600_000 } });
  await vi.advanceTimersByTimeAsync(240_000);
  await client.resolveToolApproval(approval.mock.lastCall![0], 'approve');
  await vi.advanceTimersByTimeAsync(180_000); await failed;
});

describe('push and polling event sequence deduplication', () => {
  it('keeps the next same-name approval when one page is both pushed and returned by polling', async () => {
    const { api, client, approval, progress } = setup();
    let resolvePage!: (value: unknown) => void;
    api.getRunEvents.mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }));
    const result = client.run(request); await settle();
    client.event({ requestId: request.requestId, runId: 'run', sequence: 1, event: 'tool_approval', data: { ...data, callId: 'first-call' } });
    await client.resolveToolApproval(approval.mock.lastCall![0], 'approve');
    const page = {
      events: [
        { sequence: 2, event: 'tool_start', data: { ...data, callId: 'first-call', status: 'running' }, createdAt: 1 },
        { sequence: 3, event: 'tool_result', data: { ...data, callId: 'first-call', status: 'completed' }, createdAt: 2 },
        { sequence: 4, event: 'tool_approval', data: { ...data, callId: 'second-call', approvalId: 'second-approval' }, createdAt: 3 },
      ], status: 'waiting_approval', nextAfter: 4,
    };
    // Main delivers pushes before resolving this same getRunEvents RPC.
    client.event({ requestId: request.requestId, runId: 'run', sequence: 2, event: 'tool_start', data: page.events[0].data });
    client.event({ requestId: request.requestId, runId: 'run', sequence: 3, event: 'tool_result', data: page.events[1].data });
    client.event({ requestId: request.requestId, runId: 'run', sequence: 4, event: 'tool_approval', data: page.events[2].data });
    const next = approval.mock.lastCall![0] as MeetingToolApproval;
    const before = approval.mock.calls.length;
    resolvePage(page);
    await settle();
    expect(approval.mock.calls.length).toBe(before);
    expect(approval.mock.lastCall![0]).toMatchObject({ approvalId: 'second-approval', callId: 'second-call' });
    expect(progress.mock.lastCall![0].phase).toBe('approval');
    // Even legacy/unsequenced receipts for the same tool cannot clear another call's card.
    client.event({ requestId: request.requestId, event: 'tool_result', data: { ...data, status: 'completed' } });
    client.event({ requestId: request.requestId, event: 'tool_result', data: { ...data, callId: 'first-call', status: 'completed' } });
    expect(approval.mock.lastCall![0]).toEqual(next);
    expect(progress.mock.lastCall![0].phase).toBe('approval');
    await client.resolveToolApproval(next, 'deny');
    expect(api.resolveToolApproval).toHaveBeenLastCalledWith(expect.objectContaining({ approvalId: 'second-approval', decision: 'deny' }));
    client.event({ requestId: request.requestId, runId: 'run', sequence: 5, event: 'final', data: { reply: '后一次操作未执行' } });
    await expect(result).resolves.toBe('后一次操作未执行');
  });

  it('buffers sequence-bearing events before acceptance without consuming them early', async () => {
    const { api, client, approval, progress } = setup();
    let accept!: (value: { accepted: true; runId: string }) => void;
    api.startRun.mockImplementation(() => new Promise(resolve => { accept = resolve; }));
    const result = client.run(request); await settle();
    const receipt = { requestId: request.requestId, runId: 'run', sequence: 1, event: 'tool_result', data: { ...data, callId: 'old-call', status: 'completed' } };
    const next = { requestId: request.requestId, runId: 'run', sequence: 2, event: 'tool_approval', data: { ...data, callId: 'next-call' } };
    client.event(receipt); client.event(next); client.event(receipt); client.event(next);
    expect(approval).not.toHaveBeenCalled();
    accept({ accepted: true, runId: 'run' }); await settle();
    expect(approval.mock.calls.filter(([value]) => value !== null)).toHaveLength(1);
    expect(approval.mock.lastCall![0]).toMatchObject({ callId: 'next-call' });
    expect(progress.mock.lastCall![0].phase).toBe('approval');
    // Another run cannot consume this run's sequence high-water mark.
    client.event({ requestId: request.requestId, runId: 'old-run', sequence: 100, event: 'final', data: { reply: 'wrong' } });
    client.event({ requestId: request.requestId, runId: 'run', sequence: 3, event: 'final', data: { reply: 'correct' } });
    await expect(result).resolves.toBe('correct');
  });
});
