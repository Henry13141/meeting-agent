import type { MeetingRecord } from '../shared/contracts';

function localDay(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function meetingDayPosition(meeting: MeetingRecord, meetings: readonly MeetingRecord[]): Readonly<{
  sequence: number;
  total: number;
}> {
  const sameDay = meetings
    .filter((candidate) => localDay(candidate.startedAt) === localDay(meeting.startedAt))
    .toSorted((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  return {
    sequence: Math.max(1, sameDay.findIndex((candidate) => candidate.id === meeting.id) + 1),
    total: Math.max(1, sameDay.length),
  };
}
