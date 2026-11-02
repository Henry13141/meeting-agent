import { describe, expect, it } from 'vitest';
import type { MeetingRecord } from '../shared/contracts';
import { meetingDayPosition } from './meeting-day';

function meeting(id: string, startedAt: string): MeetingRecord {
  return {
    schemaVersion: 1, id, title: '测试', status: 'completed', startedAt, endedAt: startedAt, summaryStatus: 'completed',
    summary: '', actionItems: [], archiveDocumentUrl: null, knowledgeArticleId: null,
    knowledgeStatus: null, knowledgeProjectName: null, knowledgeScopeProjectId: null, knowledgeScopeProjectName: null, transcript: [], audio: [],
  };
}

describe('meetingDayPosition', () => {
  it('counts each start/end session as one ordered meeting on its local day', () => {
    const first = meeting('10000000-0000-4000-8000-000000000001', '2026-09-03T01:00:00.000Z');
    const second = meeting('10000000-0000-4000-8000-000000000002', '2026-09-03T03:00:00.000Z');
    expect(meetingDayPosition(second, [second, first])).toEqual({ sequence: 2, total: 2 });
  });
});
