import type { MeetingProposedAction } from './meeting-answer';
import type { MeetingSkillId } from './meeting-skills';

/** Capabilities of this independent verification project, not the source app. */
export const MEETING_DEFAULT_SKILLS: readonly MeetingSkillId[] = ['decision', 'facilitator', 'actions'];
export function meetingSkillAvailable(skill: MeetingSkillId): boolean {
  return MEETING_DEFAULT_SKILLS.includes(skill);
}
export function localActionAvailable(action: MeetingProposedAction): boolean {
  return ['end_meeting', 'open_audio_folder', 'play_audio'].includes(action.kind);
}
