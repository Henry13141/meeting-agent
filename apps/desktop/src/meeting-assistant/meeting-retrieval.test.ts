import { describe, expect, it } from 'vitest';
import { meetingReferenceKind, meetingReferenceLabel, referencedMeetings } from './meeting-retrieval';

const now = new Date(2026, 8, 12, 10, 0, 0);
const meetings = [
  { id: 'current', title: '今天的新会议', startedAt: new Date(2026, 8, 12, 9).toISOString(), status: 'recording' as const },
  { id: 'yesterday-late', title: '昨天评审', startedAt: new Date(2026, 8, 11, 16).toISOString(), status: 'completed' as const },
  { id: 'yesterday-early', title: '昨天晨会', startedAt: new Date(2026, 8, 11, 9).toISOString(), status: 'completed' as const },
  { id: 'older', title: '更早的会议', startedAt: new Date(2026, 8, 10, 15).toISOString(), status: 'completed' as const },
];

describe('cross-meeting references', () => {
  it('resolves yesterday to all meetings on that calendar day', () => {
    expect(referencedMeetings('昨天我们说了什么', meetings, 'current', now).map((item) => item.id))
      .toEqual(['yesterday-late', 'yesterday-early']);
  });

  it('distinguishes the previous and the meeting before that', () => {
    expect(referencedMeetings('上次说了什么', meetings, 'current', now)[0]?.id).toBe('yesterday-late');
    expect(referencedMeetings('上上次说了什么', meetings, 'current', now)[0]?.id).toBe('yesterday-early');
  });

  it('returns several named candidates for an ambiguous historical reference', () => {
    expect(referencedMeetings('我们之前说了什么', meetings, 'current', now)).toHaveLength(3);
    expect(meetingReferenceKind('我们之前说了什么')).toBe('vague');
    expect(meetingReferenceKind('昨天说了什么')).toBe('precise');
  });

  it('labels relative dates together with an absolute date', () => {
    expect(meetingReferenceLabel(meetings[1]!.startedAt, now)).toContain('昨天（');
    expect(meetingReferenceLabel(meetings[3]!.startedAt, now)).toMatch(/^前天（/);
  });
});
