import type { AgentRunEvent, AgentRunRequest, MeetingDesktopApi } from '../shared/contracts';

/** Serializes complete turns (including persistence), not merely startRun IPC. */
export class MeetingTurnQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  get revision(): number { return this.generation; }
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const next = this.tail.catch(() => undefined).then(() => {
      if (generation !== this.generation) throw new Error('MEETING_TURN_CANCELLED');
      return task();
    });
    this.tail = next;
    return next;
  }
  clear(): void { this.generation += 1; }
}

const RUNTIME_ERROR_CODES = new Set(['CONTEXT_LIMIT_EXCEEDED', 'TOOLS_UNAVAILABLE', 'MODEL_REPLY_INVALID', 'MODEL_REQUEST_FAILED', 'RUN_INTERRUPTED']);

type AgentApi = Pick<MeetingDesktopApi['agent'], 'startRun' | 'cancelRun' | 'getRun' | 'getRunEvents'>;
type Pending = {
  request: AgentRunRequest;
  resolve: (reply: string) => void;
  reject: (error: Error) => void;
};

/** One meeting Run at a time, with terminal-event/acceptance race handling. */
export class MeetingRunClient {
  readonly evidenceUrls = new Set<string>();
  private pending: Pending | null = null;
  private accepted: Promise<{ accepted: true; runId: string }> | null = null;
  private last: { request: AgentRunRequest; accepted: Promise<{ accepted: true; runId: string }> } | null = null;
  private generation = 0;
  constructor(private readonly api: AgentApi) {}

  async run(request: AgentRunRequest): Promise<string> {
    if (this.pending) throw new Error('MEETING_RUN_ALREADY_ACTIVE');
    const generation = this.generation;
    // A final SSE projection may precede the persisted terminal status.
    await this.waitForPrevious();
    if (generation !== this.generation) throw new Error('MEETING_TURN_CANCELLED');
    this.evidenceUrls.clear();
    const reply = new Promise<string>((resolve, reject) => { this.pending = { request, resolve, reject }; });
    this.accepted = this.api.startRun(request);
    this.last = { request, accepted: this.accepted };
    void this.accepted.then(({ runId }) => this.reconcileEvents(request, runId, generation)).catch((error: unknown) => {
      if (this.pending?.request.requestId === request.requestId && generation === this.generation) this.fail(error);
    });
    const timer = setTimeout(() => { void this.cancel().catch(() => undefined); }, 180_000);
    try { return await reply; } finally { clearTimeout(timer); }
  }

  private async reconcileEvents(request: AgentRunRequest, runId: string, generation: number): Promise<void> {
    let after = 0;
    while (this.pending?.request.requestId === request.requestId && generation === this.generation) {
      const page = await this.api.getRunEvents(request.threadId, runId, after, 5000);
      after = page.nextAfter;
      for (const event of page.events) {
        if (event.event === 'final' || event.event === 'error' || event.event === 'interrupt') {
          this.event({ requestId: request.requestId, event: event.event, data: event.data });
        }
      }
      if (!this.pending || generation !== this.generation) return;
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(page.status) && page.events.length === 0) {
        this.fail(new Error('MEETING_RUN_TERMINAL_WITHOUT_EVENT'));
        return;
      }
    }
  }

  event(event: AgentRunEvent): void {
    const pending = this.pending;
    if (!pending || event.requestId !== pending.request.requestId) return;
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    if (event.event === 'values' && Array.isArray(data.messages)) {
      const messages = data.messages as Record<string, unknown>[];
      const start = messages.findLastIndex((message) =>
        ['user', 'human'].includes(String(message.role ?? message.type)) && message.content === pending.request.message);
      if (start >= 0) for (const message of messages.slice(start + 1)) {
        if ((message.role ?? message.type) !== 'tool') continue;
        const content = JSON.stringify(message.content);
        for (const url of content.match(/https:\/\/[^\s"<>\\]+/g) ?? []) this.evidenceUrls.add(url);
      }
    }
    if (event.event === 'final') {
      this.pending = null;
      pending.resolve(typeof data.reply === 'string' ? data.reply : '');
    } else if (event.event === 'error' || event.event === 'interrupt') {
      this.fail(new Error(event.event === 'interrupt' ? 'MEETING_READ_ONLY_INTERRUPTED' : (typeof data.code === 'string' && RUNTIME_ERROR_CODES.has(data.code) ? data.code : 'MEETING_RUN_FAILED')));
    }
  }

  private fail(error: unknown): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error instanceof Error ? error : new Error(String(error)));
  }

  async cancel(): Promise<void> {
    this.generation += 1;
    const last = this.last;
    if (!last) return;
    // Keep subsequent turns behind the previous terminal-state check.
    this.fail(new Error('MEETING_TURN_CANCELLED'));
    const accepted = await last.accepted;
    const status = (await this.api.getRun(last.request.threadId, accepted.runId)).status;
    if (['completed', 'failed', 'cancelled'].includes(status)) { this.last = null; return; }
    await this.api.cancelRun(last.request.threadId, accepted.runId, last.request.requestId);
    await this.waitForPrevious();
  }

  private async waitForPrevious(): Promise<void> {
    const last = this.last;
    if (!last) return;
    let accepted;
    try { accepted = await last.accepted; } catch { this.last = null; return; }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await this.api.getRun(last.request.threadId, accepted.runId);
      if (['completed', 'failed', 'cancelled', 'interrupted', 'waiting_approval'].includes(run.status)) {
        // Interrupted runs must be explicitly cancelled before another run.
        if (run.status === 'interrupted' || run.status === 'waiting_approval') await this.api.cancelRun(last.request.threadId, accepted.runId, last.request.requestId);
        else { this.last = null; return; }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('MEETING_PREVIOUS_RUN_NOT_TERMINAL');
  }
}
