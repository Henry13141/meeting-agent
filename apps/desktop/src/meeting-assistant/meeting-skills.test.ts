import { describe, expect, it } from 'vitest';
import { MEETING_ASSISTANT_PROMPT, MEETING_SKILLS, resolveMeetingSkills } from './meeting-skills';
describe('meeting skills', () => {
  it('offers only meeting-local prompts and no external tools', () => {
    expect(MEETING_SKILLS.map(s => s.id)).toEqual(['decision', 'facilitator', 'actions']);
    expect(resolveMeetingSkills(['decision', 'facilitator', 'actions']).mcpTools).toEqual([]);
    expect(MEETING_ASSISTANT_PROMPT).toContain('会议助手');
    expect(MEETING_ASSISTANT_PROMPT).toContain('口播和屏幕分开');
  });
  it('requires confirmation for local actions', () => {
    expect(resolveMeetingSkills(['actions']).prompt).toContain('口头确认');
    expect(resolveMeetingSkills(['actions']).prompt).toContain('不得声称提案已经执行');
  });
});
