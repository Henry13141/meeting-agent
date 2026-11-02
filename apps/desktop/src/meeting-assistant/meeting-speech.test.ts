import { describe, expect, it } from 'vitest';
import {
  isMeetingSelfIntroduction,
  isMeetingWeatherQuestion,
  localMeetingSpokenReply,
  MEETING_SELF_INTRODUCTION,
  meetingAvatarStatus,
  meetingDirectionStatus,
  meetingEmptySpokenFallback,
  meetingSpeechStatus,
  meetingWakeKeywordAllowed,
} from './meeting-speech';

describe('meetingWakeKeywordAllowed', () => {
  it('rejects playback echo and an in-flight keyword detected after playback ends', () => {
    expect(meetingWakeKeywordAllowed(true, true, 1_000, 2_000)).toBe(false);
    expect(meetingWakeKeywordAllowed(true, false, 1_000, 3_000)).toBe(false);
    expect(meetingWakeKeywordAllowed(false, true, 1_000, 3_000)).toBe(false);
    expect(meetingWakeKeywordAllowed(false, false, 2_000, 3_199)).toBe(false);
    expect(meetingWakeKeywordAllowed(false, false, 2_000, 3_200)).toBe(true);
  });
});

describe('meetingDirectionStatus', () => {
  it('explains stereo follow and mono listen-aside without claiming localization', () => {
    expect(meetingDirectionStatus('unknown')).toContain('听到说话才会转头');
    expect(meetingDirectionStatus('stereo')).toContain('左右声道');
    expect(meetingDirectionStatus('presence')).toContain('侧耳倾听');
    expect(meetingDirectionStatus('none')).toContain('正面聆听');
  });
});

describe('meetingSpeechStatus', () => {
  it('reports unconfigured speech honestly', () => {
    expect(meetingSpeechStatus(null)).toBe('口播：检测中');
    expect(meetingAvatarStatus(null)).toBe('');
  });
});

describe('localMeetingSpokenReply', () => {
  it('answers identity questions with the prepared self-introduction', () => {
    expect(isMeetingSelfIntroduction('你好，会议助手，介绍一下自己')).toBe(true);
    expect(isMeetingSelfIntroduction('介绍一下自己')).toBe(true);
    expect(localMeetingSpokenReply('介绍一下自己')).toBe(MEETING_SELF_INTRODUCTION.spoken);
    expect(localMeetingSpokenReply('你好，会议助手，介绍一下自己')).toBe(MEETING_SELF_INTRODUCTION.spoken);
    expect(localMeetingSpokenReply('会议助手介绍下自己')).toContain('数字员工');
    expect(localMeetingSpokenReply('请介绍一下')).toContain('会议助手');
    expect(localMeetingSpokenReply('你是谁')).toContain('听、记要点');
    expect(MEETING_SELF_INTRODUCTION.spoken).toMatch(/这场会里/);
    expect(MEETING_SELF_INTRODUCTION.spoken.length).toBeGreaterThan(80);
    expect(MEETING_SELF_INTRODUCTION.bullets.length).toBeGreaterThanOrEqual(3);
  });

  it('answers a short greeting', () => {
    expect(localMeetingSpokenReply('你好')).toContain('我在呢');
  });

  it('explains the previous empty fallback in spoken language', () => {
    expect(localMeetingSpokenReply('你在回什么东西')).toContain('不是正经回答');
  });

  it('leaves ordinary meeting questions to the agent', () => {
    expect(localMeetingSpokenReply('根据刚才的讨论给出结论')).toBeNull();
    expect(localMeetingSpokenReply('请介绍一下这个方案')).toBeNull();
  });

  it('does not pretend to know live weather without research tools', () => {
    expect(localMeetingSpokenReply('今天天气怎么样')).toContain('本地会议记录');
    expect(localMeetingSpokenReply('今天天气怎么样', { liveFactsAvailable: true })).toBeNull();
  });

  it('recognizes weather questions that should use the Main weather lookup', () => {
    expect(isMeetingWeatherQuestion('天气预报为什么会出错？')).toBe(false);
    expect(isMeetingWeatherQuestion('上海昨天的天气怎么样？')).toBe(false);
    expect(isMeetingWeatherQuestion('上海下周天气怎么样？')).toBe(false);
    expect(isMeetingWeatherQuestion('比较上海和北京的天气')).toBe(false);
    expect(isMeetingWeatherQuestion('今天天气怎么样')).toBe(true);
    expect(isMeetingWeatherQuestion('上海明天气温多少')).toBe(true);
    expect(isMeetingWeatherQuestion('外面现在冷不冷')).toBe(true);
    expect(isMeetingWeatherQuestion('根据刚才讨论给出结论')).toBe(false);
    expect(isMeetingWeatherQuestion('这个方案会不会黄')).toBe(false);
  });

  it('names the failed live-fact question instead of pretending not to hear', () => {
    expect(meetingEmptySpokenFallback('今天天气怎么样')).toContain('天气');
    expect(meetingEmptySpokenFallback('总结刚才的方案')).toContain('再说一遍会议助手');
  });
});
