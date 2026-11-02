import { describe, expect, it } from 'vitest';
import { parseMeetingAnswer as parseAnswer } from './meeting-answer';
const parseMeetingAnswer = (reply: string, title: string) => parseAnswer(reply, title, new Set([
  'https://example.com/news', 'https://example.com/image.png',
]));

describe('parseMeetingAnswer', () => {
  it('does not present a model-invented source as retrieved evidence', () => {
    expect(parseAnswer('{"spokenAnswer":"结论","sources":[{"url":"https://example.com/news"}]}', '问题').sources).toEqual([]);
  });
  it.each(['{"spokenAnswer":"预算是十万元",', '{}', '{"sources":[]}'])('terminates on invalid answer envelopes: %s', (reply) => {
    expect(parseMeetingAnswer(reply, '测试').spokenAnswer).toBe('我刚才没组织好答案，请再问我一次。');
  });
  it('projects a structured answer with only HTTPS references', () => {
    const answer = parseMeetingAnswer(JSON.stringify({
      spokenAnswer: '结论是今天有更新。',
      title: '最新进展',
      bullets: ['第一点'],
      sources: [
        { title: '官网', url: 'https://example.com/news', publishedAt: '2026-09-03' },
        { title: '本机', url: 'http://127.0.0.1/private' },
      ],
      media: [
        { kind: 'image', title: '示意图', url: 'https://example.com/image.png' },
        { kind: 'video', title: '坏地址', url: 'javascript:alert(1)' },
      ],
      action: {
        kind: 'unsupported_external_write', title: '完成会议联调',
        description: '根据会议结论完成联调。', priority: 'high',
      },
    }), '回答');
    expect(answer.spokenAnswer).toBe('结论是今天有更新。');
    expect(answer.sources).toHaveLength(1);
    expect(answer.media).toHaveLength(1);
    expect(answer.action).toBeNull();
  });

  it('keeps plain model replies usable', () => {
    expect(parseMeetingAnswer('普通回答', '问题').spokenAnswer).toBe('普通回答');
  });

  it('extracts the final structured answer without exposing provider reasoning', () => {
    const answer = parseMeetingAnswer([
      'Let me inspect the available tools and reason about the result.',
      '{"spokenAnswer":"已找到最新消息。","title":"检索结果","bullets":["已核验"],"sources":[],"media":[],"action":null}',
    ].join('\n'), '问题');
    expect(answer.spokenAnswer).toBe('已找到最新消息。');
    expect(answer.title).toBe('检索结果');
    expect(answer.spokenAnswer).not.toContain('Let me');
  });

  it('extracts structured output even when provider chatter follows it', () => {
    const answer = parseMeetingAnswer([
      'I will now construct the answer.',
      '{"spokenAnswer":"这是最终中文回答。","title":"最终结果","bullets":[],"sources":[],"media":[],"action":null}',
      'I have completed the task.',
    ].join('\n'), '问题');
    expect(answer.spokenAnswer).toBe('这是最终中文回答。');
    expect(answer.title).toBe('最终结果');
  });

  it('does not mistake a nested source object for the answer envelope', () => {
    const answer = parseMeetingAnswer([
      'Provider preface.',
      '{"spokenAnswer":"只显示这句话。","title":"结果","bullets":[],"sources":[{"title":"官网","url":"https://example.com/news"}],"media":[],"action":null}',
      'Provider suffix.',
    ].join('\n'), '问题');
    expect(answer.spokenAnswer).toBe('只显示这句话。');
    expect(answer.title).toBe('结果');
    expect(answer.sources).toHaveLength(1);
  });

  it('deduplicates references, removes tracking data and blocks private hosts', () => {
    const answer = parseMeetingAnswer(JSON.stringify({
      spokenAnswer: '完成',
      sources: [
        { title: '官网', url: 'https://example.com/news?utm_source=test#detail' },
        { title: '重复官网', url: 'https://example.com/news' },
        { title: '内网', url: 'https://192.168.1.10/private' },
      ],
      media: [],
      action: null,
    }), '问题');
    expect(answer.sources).toEqual([{ title: '重复官网', url: 'https://example.com/news' }]);
  });

  it('drops unsupported or incomplete proposed actions', () => {
    expect(parseMeetingAnswer('{"spokenAnswer":"好","action":{"kind":"execute_shell"}}', '问题').action).toBeNull();
    expect(parseMeetingAnswer('{"spokenAnswer":"好","action":{"kind":"unsupported_external_write"}}', '问题').action).toBeNull();
  });

  it('does not speak the empty-run fallback or raw model markup', () => {
    const empty = parseMeetingAnswer('本轮任务已完成，但模型没有返回文字说明。请查看上方工具结果，或重新发送任务。', '问题');
    expect(empty.spokenAnswer).toBe('我刚才没组织好答案，请再问我一次。');
    expect(empty.spokenAnswer).not.toContain('本轮任务');
    const marked = parseMeetingAnswer(JSON.stringify({
      spokenAnswer: '**结论**是今天有更新。https://example.com/news 😔',
      title: '最新进展',
      bullets: ['第一点'],
      sources: [],
      media: [],
      action: null,
    }), '问题');
    expect(marked.spokenAnswer).toBe('结论是今天有更新。');
    expect(marked.spokenAnswer).not.toContain('http');
    expect(marked.spokenAnswer).not.toContain('😔');
  });

  it('keeps screen copy concise, clean and non-repetitive', () => {
    const answer = parseMeetingAnswer(JSON.stringify({
      spokenAnswer: '建议选方案甲。',
      title: '这是一个过长而且不适合会议屏幕展示的标题',
      bullets: [
        '**成本**更低 https://example.com/news',
        '**成本**更低 https://example.com/news',
        '上线周期是两周',
        '主要风险是迁移窗口',
        '负责人待确认',
        '这一条不应该出现',
      ],
      sources: [], media: [], action: null,
    }), '问题');
    expect(answer.title.length).toBeLessThanOrEqual(16);
    expect(answer.bullets).toEqual(['成本更低', '上线周期是两周', '主要风险是迁移窗口', '负责人待确认']);
  });
});
