import type { MeetingRecord } from '../shared/contracts';

export type MeetingHistoryFilter = 'all' | 'actionable' | 'recording' | 'audio' | 'knowledge';

export function meetingDurationLabel(meeting: MeetingRecord): string {
  if (!meeting.endedAt) return meeting.status === 'recording' ? '进行中' : '';
  const milliseconds = Date.parse(meeting.endedAt) - Date.parse(meeting.startedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

export function meetingHistoryMatches(
  meeting: MeetingRecord,
  query: string,
  filter: MeetingHistoryFilter,
): boolean {
  if (filter === 'actionable' && meeting.actionItems.length === 0) return false;
  if (filter === 'recording' && meeting.status !== 'recording') return false;
  if (filter === 'audio' && meeting.audio.length === 0) return false;
  if (filter === 'knowledge' && meeting.knowledgeStatus !== 'approved') return false;
  const normalized = query.trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return true;
  return [
    meeting.title,
    meeting.summary,
    meeting.knowledgeProjectName ?? '',
    ...meeting.actionItems,
    ...meeting.transcript.slice(-200).flatMap((item) => [item.speaker, item.text]),
  ].some((value) => value.toLocaleLowerCase('zh-CN').includes(normalized));
}

export function meetingHistoryMeta(meeting: MeetingRecord): string[] {
  return [
    meetingDurationLabel(meeting),
    meeting.summaryStatus === 'pending' ? '待生成纪要' : '',
    meeting.actionItems.length ? `${meeting.actionItems.length} 项待办` : '',
    meeting.audio.length ? '有录音' : '',
    meeting.knowledgeScopeProjectName ? `范围：${meeting.knowledgeScopeProjectName}` : '',
    meeting.knowledgeStatus === 'approved' ? '知识库已审核' : '',
  ].filter(Boolean);
}
