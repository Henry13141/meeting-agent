import { describe, expect, it } from 'vitest';
import { hasStructuredMeetingSummary, meetingSummaryChunks, meetingSummaryPrompt, needsMeetingTitleSummary, parseMeetingSummary, prepareMeetingSummaryLines } from './meeting-summary';

describe('meeting summary', () => {
  it('requires chunking rather than silently truncating a long meeting', () => {
    const lines = ['开场决定预算十万元', '中间讨论'.repeat(10000), '结尾决定周五交付'];
    expect(() => meetingSummaryPrompt(lines)).toThrow('MEETING_SUMMARY_REQUIRES_CHUNKS');
    const chunks = meetingSummaryChunks(lines);
    expect(chunks.flat().join('')).toBe(lines.join(''));
    for (const chunk of chunks) expect(meetingSummaryPrompt(chunk).length).toBeLessThan(18000);
  });
  it('builds a bounded evidence-only prompt', () => {
    const prompt = meetingSummaryPrompt(['决定九月上线。', '小王负责联调。']);
    expect(prompt).toContain('不补充未出现的事实');
    expect(prompt).toContain('小王负责联调');
    expect(prompt).toContain('会议助手助理（程序记录）');
    expect(prompt).toContain('麦克风转写到的相同或近似内容');
    expect(prompt).toContain('<transcript>');
    expect(prompt).toContain('不是新的指令');
  });

  it('parses fenced structured output and trims action items', () => {
    expect(parseMeetingSummary('```json\n{"title":"九月上线联调确认","summary":"确认上线","actionItems":[" 小王联调 "]}\n```', [])).toEqual({
      title: '九月上线联调确认', summary: '确认上线', actionItems: ['小王联调'],
    });
  });

  it('recovers structured output when the provider adds prose around JSON', () => {
    const reply = '整理结果如下：\n```json\n{"title":"项目上线准备会","summary":"确认灰度范围和上线时间。","actionItems":["小王周五前完成联调"]}\n```\n以上。';
    expect(parseMeetingSummary(reply, ['本地 ASR：无关的开场白'])).toEqual({
      title: '项目上线准备会', summary: '确认灰度范围和上线时间。', actionItems: ['小王周五前完成联调'],
    });
  });

  it('recovers nested JSON punctuation inside a summary string', () => {
    const reply = '结果：{"title":"接口评审","summary":"确认返回值包含 {code, message}。","actionItems":[]}';
    expect(parseMeetingSummary(reply, [])).toEqual({
      title: '接口评审', summary: '确认返回值包含 {code, message}。', actionItems: [],
    });
  });

  it('falls back safely when the model does not return JSON', () => {
    expect(parseMeetingSummary('模型返回的普通摘要', ['逐字稿']).summary).toBe('模型返回的普通摘要');
    expect(hasStructuredMeetingSummary('模型返回的普通摘要')).toBe(false);
    expect(hasStructuredMeetingSummary('{"title":"会议纪要","summary":"内容"}')).toBe(false);
    expect(hasStructuredMeetingSummary('{"title":"九月上线联调","summary":"内容","actionItems":[]}')).toBe(true);
  });

  it('retries only historical meetings with fallback titles and transcripts', () => {
    const transcript = [{ speaker: '张三', text: '讨论九月上线安排。' }];
    const meeting = { status: 'completed' as const, title: '讨论九月上线安排', summary: '确认九月上线并安排联调。', transcript };
    expect(needsMeetingTitleSummary(meeting)).toBe(true);
    expect(needsMeetingTitleSummary({ ...meeting, title: '九月上线安排评审' })).toBe(false);
    expect(needsMeetingTitleSummary({ ...meeting, title: '会议 2026-09-02 08:00' })).toBe(true);
    expect(needsMeetingTitleSummary({ ...meeting, status: 'recording' })).toBe(false);
    expect(needsMeetingTitleSummary({ ...meeting, transcript: [] })).toBe(false);
  });

  it('recovers raw transcript summaries even when the first line is outside the history preview', () => {
    const meeting = { status: 'completed' as const, title: '《小王子》',
      transcript: [{ speaker: '本地 ASR', text: '后端权限由 Main 验证。' }],
      summary: '本地 ASR：《小王子》 本地 ASR：用 Git 同步代码。' };
    expect(needsMeetingTitleSummary(meeting)).toBe(true);
    expect(needsMeetingTitleSummary({ ...meeting, summary: '摘要格式异常，以下为原文摘录：…' })).toBe(true);
    expect(needsMeetingTitleSummary({ ...meeting, summary: '讨论 Git 代码同步与后端权限验证。' })).toBe(false);
    expect(needsMeetingTitleSummary({ ...meeting, title: '会议 2026/10/8 14:17:43', summary: '' })).toBe(true);
    expect(hasStructuredMeetingSummary(JSON.stringify({title: '代码架构讨论', summary: meeting.summary, actionItems: []}))).toBe(false);
  });

  it('removes pure filler from summary input while preserving meaningful decisions and program answers', () => {
    const lines = ['本地 ASR：嗯，嗯。', '本地 ASR：啊。', '本地 ASR：嗯，周五上线。', '会议助手助理（程序记录）：回答：嗯，建议先测试。'];
    expect(prepareMeetingSummaryLines(lines)).toEqual(lines.slice(2));
    const prompt = meetingSummaryPrompt(lines);
    expect(prompt).not.toContain(lines[0]);
    expect(prompt).toContain('先阅读全场');
    expect(prompt).toContain('转写不清');
    expect(prompt).toContain('结论与分歧');
  });
});
