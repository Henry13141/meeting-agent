import type { AgentRunEvent, AgentRunRequest, MeetingDesktopApi } from '../shared/contracts';
import { parseMeetingToolApproval, type MeetingToolApproval, type MeetingToolProgress } from './meeting-tool-events';

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

const RUNTIME_ERROR_CODES = new Set(['CONTEXT_LIMIT_EXCEEDED', 'TOOLS_UNAVAILABLE', 'MODEL_REPLY_INVALID', 'MODEL_REQUEST_FAILED', 'RUN_INTERRUPTED',
  'EXTENSION_CONFIG_INVALID', 'SKILL_NOT_FOUND', 'SKILL_UNAVAILABLE', 'TOOL_NOT_ALLOWED', 'TOOL_ARGUMENTS_INVALID',
  'TOOL_CALL_LIMIT_EXCEEDED', 'TOOL_TIMEOUT', 'TOOL_APPROVAL_TIMEOUT', 'TOOL_APPROVAL_DENIED',
  'MCP_SERVER_UNAVAILABLE', 'MCP_TOOL_FAILED', 'TOOL_RESULT_TOO_LARGE', 'SKILL_TOO_LARGE', 'EXTENSION_LIMIT_EXCEEDED', 'MODEL_RESPONSE_TOO_LARGE', 'MEETING_RUN_IDLE_TIMEOUT', 'TOOL_APPROVAL_RESOLUTION_FAILED']);

type AgentApi = Pick<MeetingDesktopApi['agent'], 'startRun' | 'cancelRun' | 'getRun' | 'getRunEvents'> & Partial<Pick<MeetingDesktopApi['agent'], 'resolveToolApproval'>>;
type Pending = {
  request: AgentRunRequest;
  runId?: string;
  lastSequence: number;
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
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private approvalTimer: ReturnType<typeof setTimeout> | undefined;
  private approval: MeetingToolApproval | null = null;
  private readonly seenApprovals = new Set<string>();
  private readonly bufferedEvents: AgentRunEvent[] = [];
  constructor(private readonly api: AgentApi, private readonly observer: {
    approval?(approval: MeetingToolApproval | null): void;
    progress?(progress: MeetingToolProgress | null): void;
  } = {}) {}

  private activity(): void {
    if (this.watchdog !== undefined) clearTimeout(this.watchdog);
    if (!this.pending || this.approval) return;
    this.watchdog = setTimeout(() => {
      this.fail(new Error('MEETING_RUN_IDLE_TIMEOUT'));
      void this.cancel().catch(() => undefined);
    }, 180_000);
  }
  private clearApproval(): void {
    if (this.approvalTimer !== undefined) clearTimeout(this.approvalTimer);
    this.approvalTimer = undefined;
    this.approval = null;
    this.observer.approval?.(null);
    this.activity();
  }
  private clearTurn(): void {
    if (this.watchdog !== undefined) clearTimeout(this.watchdog);
    this.watchdog = undefined;
    this.clearApproval();
    this.bufferedEvents.length = 0;
    this.observer.progress?.(null);
  }

  async resolveToolApproval(approval: MeetingToolApproval, decision: 'approve' | 'deny'): Promise<boolean> {
    const current = this.approval;
    if (!current || current.submitting || !this.pending || this.pending.runId !== current.runId
      || this.pending.request.requestId !== current.requestId || approval.requestId !== current.requestId
      || approval.threadId !== current.threadId || approval.runId !== current.runId || approval.approvalId !== current.approvalId) return false;
    this.approval = { ...current, submitting: true };
    this.observer.approval?.(this.approval);
    try {
      if (!this.api.resolveToolApproval) throw new Error('TOOL_APPROVAL_RESOLUTION_FAILED');
      const result = await this.api.resolveToolApproval({ threadId: current.threadId, runId: current.runId,
        approvalId: current.approvalId, decision });
      if (this.approval?.approvalId !== current.approvalId || this.pending?.request.requestId !== current.requestId) return false;
      if (!result.accepted) throw new Error('TOOL_APPROVAL_RESOLUTION_FAILED');
      this.clearApproval();
      this.activity();
      this.observer.progress?.({ toolName: current.toolName, serverId: current.serverId, phase: decision === 'approve' ? 'allowed' : 'denied' });
      return true;
    } catch {
      if (this.pending?.request.requestId === current.requestId) {
        this.fail(new Error('TOOL_APPROVAL_RESOLUTION_FAILED'));
        void this.cancel().catch(() => undefined);
      }
      return false;
    }
  }

  async run(request: AgentRunRequest): Promise<string> {
    if (this.pending) throw new Error('MEETING_RUN_ALREADY_ACTIVE');
    const generation = this.generation;
    // A final SSE projection may precede the persisted terminal status.
    await this.waitForPrevious();
    if (generation !== this.generation) throw new Error('MEETING_TURN_CANCELLED');
    this.evidenceUrls.clear();
    this.seenApprovals.clear();
    this.observer.progress?.(null);
    const reply = new Promise<string>((resolve, reject) => { this.pending = { request, resolve, reject, lastSequence: 0 }; });
    this.accepted = this.api.startRun(request);
    this.last = { request, accepted: this.accepted };
    this.activity();
    void this.accepted.then(({ runId }) => {
      if (this.pending?.request.requestId === request.requestId && generation === this.generation) {
        this.pending.runId = runId;
        for (const event of this.bufferedEvents.splice(0)) this.event(event);
      }
      return this.reconcileEvents(request, runId, generation);
    }).catch((error: unknown) => {
      if (this.pending?.request.requestId === request.requestId && generation === this.generation) this.fail(error);
    });
    return await reply;
  }

  private async reconcileEvents(request: AgentRunRequest, runId: string, generation: number): Promise<void> {
    let after = 0;
    while (this.pending?.request.requestId === request.requestId && generation === this.generation) {
      const page = await this.api.getRunEvents(request.threadId, runId, after, 5000);
      after = page.nextAfter;
      for (const event of page.events) {
        this.event({ requestId: request.requestId, runId, sequence: event.sequence, event: event.event, data: event.data });
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
    const toolEvent = ['tool_approval', 'tool_start', 'tool_result'].includes(event.event);
    // Push delivery may precede startRun acceptance. Buffer without advancing
    // sequence state; replay in delivery order only once the run is known.
    if (!pending.runId && (toolEvent || event.sequence !== undefined || event.runId !== undefined)) {
      if (!toolEvent || data.threadId === pending.request.threadId) this.bufferedEvents.push(event);
      return;
    }
    if (event.runId !== undefined && event.runId !== pending.runId) return;
    if (toolEvent && (data.runId !== pending.runId || data.threadId !== pending.request.threadId)) return;
    if (event.sequence !== undefined) {
      if (!Number.isInteger(event.sequence) || event.sequence <= pending.lastSequence) return;
      pending.lastSequence = event.sequence;
    }
    if (toolEvent) {
      if (!pending.runId) return;
      if (event.event === 'tool_approval') {
        const approval = parseMeetingToolApproval(event.requestId, pending.request.threadId, pending.runId, data);
        if (!approval || this.seenApprovals.has(approval.approvalId) || this.approval) return;
        this.seenApprovals.add(approval.approvalId);
        this.approval = approval;
        this.activity();
        this.observer.approval?.(approval);
        this.observer.progress?.({ toolName: approval.toolName, serverId: approval.serverId, phase: 'approval' });
        this.approvalTimer = setTimeout(() => {
          this.fail(new Error('TOOL_APPROVAL_TIMEOUT'));
          void this.cancel().catch(() => undefined);
        }, Math.max(0, approval.expiresAt - Date.now()));
      } else if (typeof data.toolName === 'string' && typeof data.serverId === 'string') {
        if (this.approval) {
          // Tool names repeat across calls. Only a matching call receipt may
          // clear an approval; legacy receipts cannot replace its progress.
          if (this.approval.callId && data.callId === this.approval.callId) this.clearApproval();
          else return;
        }
        this.activity();
        this.observer.progress?.({ toolName: data.toolName, serverId: data.serverId,
          phase: event.event === 'tool_start' ? 'running' : 'result', status: typeof data.status === 'string' ? data.status : undefined });
      }
      return;
    }
    if (['status', 'values', 'final', 'error', 'interrupt'].includes(event.event)) this.activity();
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
      this.clearTurn();
      pending.resolve(typeof data.reply === 'string' ? data.reply : '');
    } else if (event.event === 'error' || event.event === 'interrupt') {
      this.fail(new Error(event.event === 'interrupt' ? 'MEETING_READ_ONLY_INTERRUPTED' : (typeof data.code === 'string' && RUNTIME_ERROR_CODES.has(data.code) ? data.code : 'MEETING_RUN_FAILED')));
    }
  }

  private fail(error: unknown): void {
    const pending = this.pending;
    this.pending = null;
    this.clearTurn();
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
