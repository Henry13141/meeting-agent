import type { MeetingDesktopApi, ModelCatalog } from '../shared/contracts';
import type { MeetingRunClient } from './meeting-turns';

type ContextApi = Pick<MeetingDesktopApi['agent'], 'ensureConversationThread' | 'getCodeWorkspaceCapability'>;

/** Meeting boundaries and explicit resets never reuse persisted model history. */
export class MeetingDialogContexts {
  private readonly contexts = new Map<string, string>();
  context(meetingId?: string | null): string {
    const key = meetingId ?? 'idle';
    let context = this.contexts.get(key);
    if (!context) { context = `meeting-dialog:${crypto.randomUUID()}`; this.contexts.set(key, context); }
    return context;
  }
  reset(): void { this.contexts.clear(); }
}

export async function prepareMeetingContext(api: ContextApi, contextId: string) {
  const thread = await api.ensureConversationThread({ surface: 'dialog', contextId });
  const capability = await api.getCodeWorkspaceCapability(thread.id);
  return { thread, capability };
}

/** Each chunk and final reduction gets a new context, so history cannot undo chunking. */
export async function runMeetingSummaryTurn(
  api: ContextApi, client: Pick<MeetingRunClient, 'run'>, catalog: ModelCatalog,
  message: string, assertActive: () => void,
): Promise<string> {
  const { thread, capability } = await prepareMeetingContext(api, `meeting-summary:${crypto.randomUUID()}`);
  assertActive();
  return await client.run({
    requestId: crypto.randomUUID(), threadId: thread.id, message,
    modelProfileId: catalog.defaultProfileId, thinking: { enabled: false },
    catalogRevision: catalog.revision, capabilityRevision: capability.revision,
    accessMode: 'read_only', mcpTools: [],
  });
}
