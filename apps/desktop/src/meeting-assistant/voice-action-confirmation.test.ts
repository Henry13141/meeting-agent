import { describe, expect, it } from 'vitest';
import { voiceActionDecision } from './voice-action-confirmation';

describe('voiceActionDecision', () => {
  it.each(['确认执行', '可以执行', '执行吧', '就这么办'])(
    'recognizes confirmation phrase %s',
    (phrase) => expect(voiceActionDecision(phrase)).toBe('confirm'),
  );

  it.each(['取消', '不要执行', '先不要', '算了'])(
    'recognizes cancellation phrase %s',
    (phrase) => expect(voiceActionDecision(phrase)).toBe('cancel'),
  );

  it('does not treat an unrelated answer as authorization', () => {
    expect(voiceActionDecision('继续介绍刚才的方案')).toBe('unknown');
    expect(voiceActionDecision('还没有确认')).toBe('unknown');
    expect(voiceActionDecision('不确认执行')).toBe('cancel');
  });
});
