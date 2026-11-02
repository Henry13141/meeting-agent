import { z } from 'zod';
import { agentRunRecordSchema, runCancelResultSchema } from '../shared/contracts';

/** Validate the durable meeting record before forwarding it to Renderer. */
export function projectMeetingRun(value: unknown) {
  const record = z.record(z.string(), z.unknown()).parse(value);
  return agentRunRecordSchema.parse({
    id: record.id, requestId: record.requestId, threadId: record.threadId,
    status: record.status, model: record.model, accessMode: record.accessMode,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  });
}

export function projectMeetingCancellation(value: unknown) {
  const result = z.object({ cancelled: z.boolean(), run: z.unknown(), event: z.unknown() }).parse(value);
  return runCancelResultSchema.parse({ ...result, run: projectMeetingRun(result.run) });
}
