import { describe, expect, it } from 'vitest';
import { localMeetingActionIntent } from './voice-action-intent';

describe('localMeetingActionIntent', () => {
  it.each([
    ['播放完整录音', 'play_audio'],
    ['请播放本次会议录音文件', 'play_audio'],
    ['打开当前会议录音播放器', 'play_audio'],
    ['打开这次会议录音文件夹', 'open_audio_folder'],
    ['结束会议', 'end_meeting'],
    ['停止本次记录', 'end_meeting'],
  ])('routes %s to %s', (phrase, kind) => {
    expect(localMeetingActionIntent(phrase)?.kind).toBe(kind);
  });

  it.each([
    '录音在哪里？',
    '能不能播放录音？',
    '我们刚才讨论了结束会议后的流程',
    '请搜索最新资料',
    '向外部系统写入任务',
  ])('does not turn an explanation or unsupported action into execution: %s', (phrase) => {
    expect(localMeetingActionIntent(phrase)).toBeNull();
  });
});
