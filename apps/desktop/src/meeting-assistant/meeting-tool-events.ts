export type MeetingToolApproval = Readonly<{
  requestId: string; threadId: string; runId: string; approvalId: string; callId?: string;
  toolName: string; serverId: string; description: string;
  arguments: Record<string, unknown>; submitting: boolean; expiresAt: number;
}>;
export type MeetingToolProgress = Readonly<{
  toolName: string; serverId: string; phase: 'approval' | 'allowed' | 'denied' | 'running' | 'result'; status?: string;
}>;

const boundedText = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit;

/** Validate an approval against the accepted run, never a model reply or a prior event. */
export function parseMeetingToolApproval(
  requestId: string, threadId: string, runId: string, data: Record<string, unknown>,
): MeetingToolApproval | null {
  if (data.threadId !== threadId || data.runId !== runId
    || !boundedText(data.approvalId, 256) || !boundedText(data.toolName, 256)
    || !boundedText(data.serverId, 256) || typeof data.description !== 'string' || data.description.length > 16_384
    || !data.arguments || typeof data.arguments !== 'object' || Array.isArray(data.arguments)) return null;
  if (data.callId !== undefined && !boundedText(data.callId, 256)) return null;
  const expiresAt = data.expiresAt === undefined ? Date.now() + 120_000 : data.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)
    || expiresAt > Date.now() + 1_800_000) return null;
  // Main/Runtime bound and redact the full object. Never truncate confirmation parameters.
  try { JSON.stringify(data.arguments); } catch { return null; }
  return { requestId, threadId, runId, approvalId: data.approvalId, toolName: data.toolName,
    serverId: data.serverId, description: data.description, arguments: data.arguments as Record<string, unknown>, submitting: false, expiresAt, ...(typeof data.callId === 'string' ? { callId: data.callId } : {}) };
}

export function meetingToolProgressText(progress: MeetingToolProgress): string {
  const labels = { approval: '等待本次操作确认', allowed: '已允许本次请求，等待执行结果', denied: '已拒绝本次操作，等待模型说明', running: '工具正在执行', result: '已收到工具回执，等待模型整理' };
  const result = progress.phase === 'result'
    ? ['failed', 'error'].includes(progress.status ?? '') ? '工具报告失败，请核对实际结果'
      : progress.status === 'denied' ? '本次操作已拒绝，未提交工具执行' : labels[progress.phase]
    : labels[progress.phase];
  return `${result}：${progress.toolName}（${progress.serverId}）`;
}
