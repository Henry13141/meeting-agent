import { speakableMeetingText, type MeetingAnswer } from './meeting-answer';
import { meetingReferenceLabel, type MeetingReferenceKind } from './meeting-retrieval';

type HistoricalMeeting = Readonly<{ title: string; startedAt: string }>;

function namedInAnswer(answer: MeetingAnswer, meeting: HistoricalMeeting): boolean {
  const content = [answer.spokenAnswer, answer.title, ...answer.bullets].join('\n');
  const day = new Date(meeting.startedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  return content.includes(meeting.title) && (content.includes(day) || /昨天|前天|上次|上上次/.test(content));
}

export function enforceHistoricalAttribution(
  answer: MeetingAnswer,
  referenceKind: MeetingReferenceKind,
  meetings: readonly HistoricalMeeting[],
  now = new Date(),
): MeetingAnswer {
  if (!referenceKind) return answer;
  if (!meetings.length) {
    return {
      spokenAnswer: '我没有找到符合这个时间指代的历史会议，也不会拿当前会议内容代替。',
      fullAnswer: '我没有找到符合这个时间指代的历史会议，也不会拿当前会议内容代替。',
      title: '未找到对应会议',
      bullets: [], sources: [], media: [], action: null,
    };
  }
  if (meetings.length === 1) {
    const meeting = meetings[0]!;
    if (namedInAnswer(answer, meeting)) return answer;
    const attributed = speakableMeetingText(`在${meetingReferenceLabel(meeting.startedAt, now)}的《${meeting.title}》里，${answer.spokenAnswer}`, 120);
    return { ...answer, spokenAnswer: attributed, fullAnswer: attributed };
  }
  if (meetings.some((meeting) => namedInAnswer(answer, meeting))) return answer;
  const candidates = meetings.slice(0, 3).map((meeting) => `${meetingReferenceLabel(meeting.startedAt, now)}的《${meeting.title}》`);
  const spokenAnswer = speakableMeetingText(`我找到${meetings.length}场可能相关的历史会议：${candidates.join('、')}。你想看哪一场？`, 120);
  return {
    spokenAnswer,
    fullAnswer: spokenAnswer,
    title: '请选择历史会议',
    bullets: candidates,
    sources: [], media: [], action: null,
  };
}
