import { describe, expect, it, vi } from 'vitest';
import type { AgentRunRecord, AgentRunRequest } from '../shared/contracts';
import { MeetingRunClient, MeetingTurnQueue } from './meeting-turns';
const request = { requestId: 'test-request', threadId: 'test-thread', message: '当前问题' } as AgentRunRequest;
function fakeApi() {
  return {
    startRun: vi.fn().mockResolvedValue({ accepted: true, runId: 'test-run' }),
    cancelRun: vi.fn().mockResolvedValue({}),
    getRun: vi.fn().mockResolvedValue({ status: 'completed' } as AgentRunRecord),
    getRunEvents: vi.fn().mockImplementation(() => new Promise(() => undefined)),
  };
}
describe('meeting turns', () => {
  it('allows a live answer while cancellation awaits a background summary acceptance', async () => {
    const api = fakeApi();
    let acceptSummary!: (value: { accepted: true; runId: string }) => void;
    api.startRun.mockImplementation((input: AgentRunRequest) => input.requestId === 'summary-request'
      ? new Promise((resolve) => { acceptSummary = resolve; })
      : Promise.resolve({ accepted: true, runId: 'voice-run' }));
    const summaryClient = new MeetingRunClient(api);
    const voiceClient = new MeetingRunClient(api);
    const summary = summaryClient.run({ ...request, requestId: 'summary-request', threadId: 'summary-thread' });
    const rejected = expect(summary).rejects.toThrow('MEETING_TURN_CANCELLED');
    await vi.waitFor(() => expect(acceptSummary).toBeDefined());
    const cancellation = summaryClient.cancel();
    const answer = voiceClient.run(request);
    await vi.waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(2));
    voiceClient.event({ requestId: request.requestId, event: 'final', data: { reply: '现场回答' } });
    await expect(answer).resolves.toBe('现场回答');
    await rejected;
    acceptSummary({ accepted: true, runId: 'summary-run' });
    await cancellation;
  });
  it('serializes persistence and summary behind the complete question turn', async () => {
    const queue = new MeetingTurnQueue();
    const order: string[] = [];
    let release!: () => void;
    const first = queue.enqueue(async () => { order.push('question'); await new Promise<void>((resolve) => { release = resolve; }); order.push('persist'); });
    const second = queue.enqueue(async () => { order.push('summary'); });
    await vi.waitFor(() => expect(order).toEqual(['question']));
    release(); await Promise.all([first, second]);
    expect(order).toEqual(['question', 'persist', 'summary']);
  });
  it('ignores unrelated events and allows a final before acceptance resolves', async () => {
    const api = fakeApi();
    let accept!: (value: { accepted: true; runId: string }) => void;
    api.startRun.mockReturnValue(new Promise((resolve) => { accept = resolve; }));
    const client = new MeetingRunClient(api);
    const result = client.run(request);
    await vi.waitFor(() => expect(api.startRun).toHaveBeenCalled());
    client.event({ requestId: 'unrelated', event: 'final', data: { reply: 'wrong' } });
    client.event({ requestId: request.requestId, event: 'final', data: { reply: 'correct' } });
    expect(await result).toBe('correct');
    accept({ accepted: true, runId: 'test-run' });
  });
  it('cancels the accepted backend Run rather than only discarding its request id', async () => {
    const api = fakeApi();
    api.getRun.mockResolvedValueOnce({ status: 'running' }).mockResolvedValue({ status: 'cancelled' });
    const client = new MeetingRunClient(api);
    const result = client.run(request);
    const rejected = expect(result).rejects.toThrow('MEETING_TURN_CANCELLED');
    await vi.waitFor(() => expect(api.startRun).toHaveBeenCalled());
    await client.cancel(); await rejected;
    expect(api.cancelRun).toHaveBeenCalledWith('test-thread', 'test-run', request.requestId);
  });
  it('takes URLs only from tool messages after this turn user message', async () => {
    const client = new MeetingRunClient(fakeApi());
    const result = client.run(request);
    await Promise.resolve(); await Promise.resolve();
    client.event({ requestId: request.requestId, event: 'values', data: { messages: [
      { role: 'tool', content: 'https://old.example.com' },
      { role: 'user', content: request.message },
      { role: 'assistant', content: 'https://invented.example.com' },
      { role: 'tool', content: { url: 'https://actual.example.com' } },
    ] } });
    client.event({ requestId: request.requestId, event: 'final', data: { reply: 'done' } });
    await result;
    expect([...client.evidenceUrls]).toEqual(['https://actual.example.com']);
  });
  it('recovers a final event from persisted events when live delivery is missed', async () => {
    const api = fakeApi();
    api.getRunEvents.mockResolvedValue({
      events: [{ sequence: 1, event: 'final', data: { reply: 'recovered answer' }, createdAt: 1 }],
      status: 'completed', nextAfter: 1,
    });
    const client = new MeetingRunClient(api);
    await expect(client.run(request)).resolves.toBe('recovered answer');
    expect(api.getRunEvents).toHaveBeenCalledWith('test-thread', 'test-run', 0, 5000);
  });
});

describe('runtime error contract', () => {
  it.each(['CONTEXT_LIMIT_EXCEEDED', 'TOOLS_UNAVAILABLE', 'MODEL_REPLY_INVALID', 'MODEL_REQUEST_FAILED', 'RUN_INTERRUPTED'])(
    'propagates the fixed runtime error %s', async code => {
      const api = fakeApi();
      api.getRunEvents.mockResolvedValue({ events: [{ sequence: 1, event: 'error', data: { code } }], status: 'failed', nextAfter: 1 });
      await expect(new MeetingRunClient(api).run(request)).rejects.toThrow(code);
    },
  );
  it('does not expose arbitrary provider messages or unrecognized error codes', async () => {
    const api = fakeApi();
    api.getRunEvents.mockResolvedValue({ events: [{ sequence: 1, event: 'error', data: { code: 'raw-secret-code', message: 'raw-private-key' } }], status: 'failed', nextAfter: 1 });
    await expect(new MeetingRunClient(api).run(request)).rejects.toThrow(/^MEETING_RUN_FAILED$/);
  });
});
