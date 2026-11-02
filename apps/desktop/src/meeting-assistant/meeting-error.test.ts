import { describe, expect, it } from 'vitest';
import { meetingErrorMessage } from './meeting-error';

describe('meeting IPC error messages', () => {
  it.each(['MODEL_NOT_CONFIGURED', 'MODEL_CREDENTIAL_REQUIRED', 'MODEL_CREDENTIAL_EXPIRED'])('explains %s in Chinese without IPC internals', code => {
    const message = meetingErrorMessage(new Error(`Error invoking remote method 'meeting:start-run': Error: ${code}`));
    expect(message).toMatch(/配置模型接口后重启/);
    expect(message).not.toMatch(/Error invoking|MODEL_|meeting:start-run/);
    expect(message).toMatch(/录音|记录/);
  });
  it('preserves useful native audio errors while removing the transport wrapper', () => {
    expect(meetingErrorMessage(new Error("Error invoking remote method 'meeting:start': Error: MEETING_AUDIO_UNAVAILABLE"))).toContain('检查麦克风');
  });
});

it('explains context overflow and an explicit reset while preserving recording data', () => {
  const message = meetingErrorMessage(new Error('CONTEXT_LIMIT_EXCEEDED'));
  expect(message).toContain('上下文上限');
  expect(message).toContain('重新连接会议 Agent');
  expect(message).toContain('录音和逐字稿会保留');
});

it.each(['EXTENSION_CONFIG_INVALID', 'SKILL_NOT_FOUND', 'SKILL_UNAVAILABLE', 'TOOL_NOT_ALLOWED', 'TOOL_ARGUMENTS_INVALID', 'TOOL_CALL_LIMIT_EXCEEDED', 'TOOL_TIMEOUT', 'TOOL_APPROVAL_TIMEOUT', 'TOOL_APPROVAL_DENIED', 'MCP_SERVER_UNAVAILABLE', 'MCP_TOOL_FAILED', 'TOOL_RESULT_TOO_LARGE', 'SKILL_TOO_LARGE', 'EXTENSION_LIMIT_EXCEEDED', 'MODEL_RESPONSE_TOO_LARGE', 'MEETING_RUN_IDLE_TIMEOUT', 'TOOL_APPROVAL_RESOLUTION_FAILED'])(
  'explains fixed extension errors without exposing provider payloads: %s', code => {
    const message = meetingErrorMessage(new Error(code));
    expect(message).toMatch(/[\u4e00-\u9fff]/);
    expect(message).not.toContain(code);
  },
);
