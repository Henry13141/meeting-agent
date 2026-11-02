import { describe, expect, it } from 'vitest';
import type { MeetingRecord } from '../shared/contracts';
import { meetingDurationLabel, meetingHistoryMatches, meetingHistoryMeta } from './meeting-history';

const meeting: MeetingRecord = {
  schemaVersion: 1,
  id: '11111111-1111-4111-8111-111111111111',
  title: '产品路线评审',
  status: 'completed',
  startedAt: '2026-09-12T01:00:00.000Z',
  endedAt: '2026-09-12T02:15:00.000Z',
  summaryStatus: 'completed',
  summary: '决定先上线搜索能力。',
  actionItems: ['王明周五前完成验收'],
  archiveDocumentUrl: null,
  knowledgeArticleId: 'article-1',
  knowledgeStatus: 'approved',
  knowledgeProjectName: '会议助手',
  knowledgeScopeProjectId: 'project-1',
  knowledgeScopeProjectName: '会议助手',
  transcript: [{ sequence: 1, speaker: '李华', text: '关注启动速度', capturedAt: '2026-09-12T01:10:00.000Z' }],
  audio: [{ sequence: 1, mimeType: 'audio/webm', byteLength: 10, capturedAt: '2026-09-12T01:10:00.000Z' }],
};

describe('meeting history projection', () => {
  it('shows a compact duration and useful scan metadata', () => {
    expect(meetingDurationLabel(meeting)).toBe('1 小时 15 分钟');
    expect(meetingHistoryMeta(meeting)).toEqual(['1 小时 15 分钟', '1 项待办', '有录音', '范围：会议助手', '知识库已审核']);
  });

  it('marks an automatically archived meeting as pending summary', () => {
    expect(meetingHistoryMeta({ ...meeting, summaryStatus: 'pending' })).toContain('待生成纪要');
  });

  it('searches title, summary, actions, project and transcript', () => {
    for (const query of ['路线', '搜索能力', '王明', '会议助手', '启动速度']) {
      expect(meetingHistoryMatches(meeting, query, 'all')).toBe(true);
    }
    expect(meetingHistoryMatches(meeting, '财务预算', 'all')).toBe(false);
  });

  it('applies task, audio and knowledge filters', () => {
    expect(meetingHistoryMatches(meeting, '', 'actionable')).toBe(true);
    expect(meetingHistoryMatches(meeting, '', 'audio')).toBe(true);
    expect(meetingHistoryMatches(meeting, '', 'knowledge')).toBe(true);
    expect(meetingHistoryMatches(meeting, '', 'recording')).toBe(false);
  });
});
