import { describe, expect, it, vi } from 'vitest';
import type { AgentRunRequest, AgentThread, CodeWorkspaceCapability, ModelCatalog } from '../shared/contracts';
import { MeetingDialogContexts, prepareMeetingContext, runMeetingSummaryTurn } from './meeting-context';

describe('meeting context boundaries', () => {
  it('reuses history only inside one meeting and resets without changing meeting IDs', () => {
    const contexts = new MeetingDialogContexts();
    const first = contexts.context('meeting-a');
    expect(contexts.context('meeting-a')).toBe(first);
    expect(contexts.context('meeting-b')).not.toBe(first);
    expect(contexts.context()).not.toBe(first);
    contexts.reset();
    expect(contexts.context('meeting-a')).not.toBe(first);
    expect(contexts.context('meeting-a')).toMatch(/^meeting-dialog:[0-9a-f-]{36}$/);
  });

  it('uses the capability of the chosen dialog rather than the prior meeting', async () => {
    const api = {
      ensureConversationThread: vi.fn().mockResolvedValue({ id: 'new-thread' } as AgentThread),
      getCodeWorkspaceCapability: vi.fn().mockImplementation(async (id: string) => ({ revision: id + '-capability' } as CodeWorkspaceCapability)),
    };
    expect(await prepareMeetingContext(api, 'meeting-dialog:context')).toEqual({
      thread: { id: 'new-thread' }, capability: { revision: 'new-thread-capability' },
    });
    expect(api.getCodeWorkspaceCapability).toHaveBeenCalledWith('new-thread');
  });

  it('isolates every chunk and the final reduction beyond the old aggregate context limit', async () => {
    const api = {
      ensureConversationThread: vi.fn().mockImplementation(async ({ contextId }: { contextId: string }) => ({ id: contextId } as AgentThread)),
      getCodeWorkspaceCapability: vi.fn().mockImplementation(async (id: string) => ({ revision: id + '-capability' } as CodeWorkspaceCapability)),
    };
    const requests: AgentRunRequest[] = [];
    const client = { run: vi.fn(async (request: AgentRunRequest) => { requests.push(request); return 'summary'; }) };
    const catalog = { defaultProfileId: 'model', revision: 'catalog' } as ModelCatalog;
    for (let i = 0; i < 30; i++) {
      await runMeetingSummaryTurn(api, client, catalog, '甲'.repeat(16_000), () => {});
    }
    await runMeetingSummaryTurn(api, client, catalog, 'final reduction', () => {});
    expect(new Set(requests.map(r => r.threadId)).size).toBe(31);
    for (const request of requests) {
      expect(request.threadId).toMatch(/^meeting-summary:[0-9a-f-]{36}$/);
      expect(request.capabilityRevision).toBe(request.threadId + '-capability');
      expect(request.mcpTools).toEqual([]);
    }
  });
});
