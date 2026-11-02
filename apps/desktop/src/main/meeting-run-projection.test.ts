import { describe, expect, it } from 'vitest';
import { projectMeetingRun, projectMeetingCancellation } from './meeting-run-projection';

const record = {
  id: '48144d03-8ef0-4ee0-9355-83537a7bdf49',
  requestId: '49ed0dd5-9c61-4cab-8449-2ca3d6ebc97d',
  threadId: '49519b7d-aaf4-4ed6-ae9d-25d4955e37ca', status: 'completed',
  model: { profileId: 'meeting-model', providerModel: 'configured-model', compatibilityFamily: 'openai-compatible',
    thinking: { enabled: false }, catalogRevision: 'meeting-model-catalog.v1' },
  approvalMode: 'on_request', fullAccess: false, accessMode: 'read_only',
  protection: null, createdAt: 1790000000000, updatedAt: 1790000000100,
};
describe('Runtime record projection for repeated meeting turns', () => {
  it('accepts the complete Runtime wire and projects only meeting fields', () => {
    const projected = projectMeetingRun(record);
    expect(projected.status).toBe('completed');
    expect(projected).not.toHaveProperty('approvalMode');
    expect(projected).not.toHaveProperty('protection');
    expect(projected).not.toHaveProperty('fullAccess');
  });
  it('uses the same projection on cancellation', () => {
    expect(projectMeetingCancellation({ cancelled: true, run: { ...record, status: 'cancelled' }, event: null }))
      .toMatchObject({ cancelled: true, run: { status: 'cancelled' }, event: null });
  });
  it('rejects a workspace execution result instead of treating it as a meeting', () => {
    expect(() => projectMeetingRun({ ...record, accessMode: 'workspace' })).toThrow();
  });
});
