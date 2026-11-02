import { describe, expect, it } from 'vitest';
import type { MeetingAnswer } from './meeting-answer';
import { enforceHistoricalAttribution } from './meeting-memory-answer';

const answer: MeetingAnswer = { spokenAnswer: '我们决定先做搜索。', title: '历史结论', bullets: [], sources: [], media: [], action: null };
const now = new Date(2026, 8, 12, 10);
const yesterday = { title: '产品路线评审', startedAt: new Date(2026, 8, 11, 16).toISOString() };

describe('historical meeting attribution', () => {
  it('adds the date and meeting title for one unlabelled historical answer', () => {
    const result = enforceHistoricalAttribution(answer, 'precise', [yesterday], now);
    expect(result.spokenAnswer).toContain('昨天（');
    expect(result.spokenAnswer).toContain('《产品路线评审》');
  });

  it('asks the user to choose when several candidates remain unnamed', () => {
    const result = enforceHistoricalAttribution(answer, 'vague', [
      yesterday,
      { title: '技术方案评审', startedAt: new Date(2026, 8, 10, 9).toISOString() },
    ], now);
    expect(result.title).toBe('请选择历史会议');
    expect(result.spokenAnswer).toContain('你想看哪一场');
    expect(result.bullets).toHaveLength(2);
  });

  it('refuses to substitute the current meeting when no history matches', () => {
    const result = enforceHistoricalAttribution(answer, 'precise', [], now);
    expect(result.spokenAnswer).toContain('不会拿当前会议内容代替');
  });
});
