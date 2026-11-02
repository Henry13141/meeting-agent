const stopWords = new Set(['上次', '这次', '会议', '项目', '多少', '什么', '我们', '你们', '会议助手', '会议助手', '请问', '一下', '最终', '关于', '之前', '怎么', '可以']);

type MeetingMemoryRecord = Readonly<{
  id: string;
  title: string;
  startedAt: string;
  status: 'recording' | 'completed';
}>;

export type MeetingReferenceKind = 'precise' | 'vague' | null;

export function meetingReferenceKind(question: string): MeetingReferenceKind {
  if (/上上次|上上场|前两次|上次|上一场|上一个会|前一次|前天|昨天|昨日/.test(question)) return 'precise';
  if (/之前|以前|此前|过去|前几次|历史上|我们说过|我们聊过/.test(question)) return 'vague';
  return null;
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dateOffset(now: Date, days: number): string {
  const date = new Date(now);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return localDay(date);
}

export function meetingReferenceLabel(startedAt: string, now = new Date()): string {
  const started = new Date(startedAt);
  const absolute = started.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
  const day = localDay(started);
  if (day === localDay(now)) return `今天（${absolute}）`;
  if (day === dateOffset(now, -1)) return `昨天（${absolute}）`;
  if (day === dateOffset(now, -2)) return `前天（${absolute}）`;
  return absolute;
}

/** Resolve explicit cross-meeting references before fuzzy text search. */
export function referencedMeetings<T extends MeetingMemoryRecord>(
  question: string,
  meetings: readonly T[],
  currentMeetingId?: string | null,
  now = new Date(),
): T[] {
  const previous = meetings
    .filter((meeting) => meeting.id !== currentMeetingId)
    .toSorted((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  if (/上上次|上上场|前两次/.test(question)) return previous[1] ? [previous[1]] : [];
  if (/上次|上一场|上一个会|前一次/.test(question)) return previous[0] ? [previous[0]] : [];
  if (/前天/.test(question)) return previous.filter((meeting) => localDay(new Date(meeting.startedAt)) === dateOffset(now, -2));
  if (/昨天|昨日/.test(question)) return previous.filter((meeting) => localDay(new Date(meeting.startedAt)) === dateOffset(now, -1));
  if (/之前|以前|此前|过去|前几次|历史上|我们说过|我们聊过/.test(question)) return previous.slice(0, 4);
  return [];
}

export function meetingSearchTerms(query: string): string[] {
  const segments = new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(query.toLowerCase());
  return [...new Set([...segments].filter((part) => part.isWordLike)
    .map((part) => part.segment).filter((part) => part.length >= 2 && !stopWords.has(part)))].slice(0, 24);
}
export function meetingEvidenceText(meeting: { summary: string; transcript: readonly { speaker: string; text: string }[] }, query: string): string {
  const terms = meetingSearchTerms(query);
  const ranked = meeting.transcript.map((chunk, index) => ({ chunk, index,
    score: terms.reduce((score, term) => score + Number(chunk.text.toLowerCase().includes(term)), 0) }))
    .sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 12).sort((a, b) => a.index - b.index);
  return [meeting.summary.slice(0, 1000), ...ranked.map(({ chunk }) => `${chunk.speaker}：${chunk.text.slice(0, 700)}`)].join('\n').slice(0, 2400);
}
