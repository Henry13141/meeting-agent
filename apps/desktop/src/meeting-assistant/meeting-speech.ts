import type { MeetingCapabilities } from '../shared/contracts';

export const FALLBACK_MEETING_CAPABILITIES: MeetingCapabilities = {
  audioRecording: true,
  localAsr: false,
  speakerDiarization: false,
  voiceActivation: false,
  avatar: { provider: 'browser', configured: false, available: false },
  tts: { provider: 'browser', configured: false, available: false },
  webSearch: { provider: 'disabled', configured: false },
};

export function meetingTtsVoiceLabel(_voice: string | undefined): string { return '语音服务'; }

export function meetingWakeKeywordAllowed(
  speakingAtCapture: boolean,
  speakingNow: boolean,
  lastAssistantSpeechAt: number,
  now: number,
): boolean {
  // Acoustic echo cancellation is device-dependent. A keyword heard during
  // playback, or in its short echo tail, is not proof of a new human turn.
  return !speakingAtCapture && !speakingNow && now - lastAssistantSpeechAt >= 1_200;
}

export type MeetingDirectionStatus = 'unknown' | 'stereo' | 'presence' | 'none';

export function meetingDirectionStatus(mode: MeetingDirectionStatus): string {
  if (mode === 'unknown') return '开始记录后检测麦克风。听到说话才会转头。';
  if (mode === 'stereo') return '声音方向：根据左右声道跟随；请将麦克风左右方向与屏幕对应放置。';
  if (mode === 'presence') return '当前麦克风是单声道，听到说话会侧耳倾听，无法区分左右。';
  return '当前无法检测声音方向，角色保持正面聆听。';
}

export function meetingSpeechStatus(
  capabilities: MeetingCapabilities | null,
  options: Readonly<{
    localWakeAgent?: boolean;
    transcriptionMode?: 'unknown' | 'local' | 'browser' | 'none';
  }> = {},
): string {
  if (!capabilities) return '口播：检测中';
  return capabilities.tts.available ? '口播：语音服务' : '口播：语音未配置';
}

export function meetingAvatarStatus(_session: { provider: string; state: string; videoAttached: boolean } | null): string { return ''; }

export function isMeetingWeatherQuestion(question: string): boolean {
  const normalized = question.replace(/[\s，。！？、,.!?：:；;“”"'~～]/g, '');
  // The deterministic shortcut only supports a single place and these dates.
  // Conceptual, historical and comparative questions belong to the Agent.
  if (/为什么|为何|原理|如何形成|预测|预报|比较|相比|和|与|昨天|前天|上周|下周|下个|未来|最近|这周|周[一二三四五六日天]|\d+[月日号天]|影响/.test(normalized)) return false;
  if (/(天气|气温)/.test(normalized)) return true;
  return /(今天|明天|后天|现在|外面).*(下雨|下雪|冷不冷|热不热)|(下雨|下雪|冷不冷|热不热).*(今天|明天|后天|现在|外面)/.test(normalized);
}

export const MEETING_SELF_INTRODUCTION = {
  spoken:
    '嗨，我是会议助手。我是团队身边的数字员工，帮大家开会、办事，把讨论变成后面能跟下去的工作。这场会里，我在旁边听、记要点；你问刚才定了什么、下一步谁来做，直接叫我就行。想让我总结、查一件事，或者记下一条待办，说一声就可以。',
  title: '我是会议助手',
  bullets: [
    '听会、记要点、当场回答',
    '把讨论变成可跟进的工作',
    '叫会议助手就能唤醒',
  ],
} as const;

const SELF_INTRODUCTION_QUESTION =
  /介绍(一下|下)?(你)?自己|自我介绍|你是谁|你叫什么|请介绍(一下|下)?(你自己|自己)?$|^(介绍一下|介绍下)$/;

export function isMeetingSelfIntroduction(question: string): boolean {
  return SELF_INTRODUCTION_QUESTION.test(normalizeMeetingQuestion(question));
}

function normalizeMeetingQuestion(question: string): string {
  return question.replace(/[\s，。！？、,.!?：:；;“”"'~～]/g, '');
}

export function localMeetingSpokenReply(
  question: string,
  options: Readonly<{ liveFactsAvailable?: boolean }> = {},
): string | null {
  const normalized = normalizeMeetingQuestion(question);
  if (SELF_INTRODUCTION_QUESTION.test(normalized)) {
    return MEETING_SELF_INTRODUCTION.spoken;
  }
  if (/你在回什么|你知道我在说什么/.test(normalized)) {
    return '刚才那几句不是正经回答，模型跑完没吐出内容。你再说一遍会议助手，或者让我总结刚才的讨论。';
  }
  if (/^(你好|嗨|在吗|在不在|你好呀|嗨你好)$/.test(normalized)) {
    return '我在呢。叫我一声，再说你想问的就行。';
  }
  if (!options.liveFactsAvailable && isMeetingWeatherQuestion(question)) {
    return '我现在查不了外面的天气。当前只使用本地会议记录，你可以问我刚才会上说的。';
  }
  return null;
}

export function meetingEmptySpokenFallback(question: string): string {
  const normalized = question.replace(/[\s，。！？、,.!?：:；;“”"'~～]/g, '');
  if (/(今天|明天|现在)?(天气|气温)|下雨|下雪|冷不冷|热不热/.test(normalized)) {
    return '天气这一轮没查到可用结果。你再说一遍会议助手问天气，我重新查。';
  }
  return '这一轮我没组织好回答。你再说一遍会议助手，我重新答。';
}
