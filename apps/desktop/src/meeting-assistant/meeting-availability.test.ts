// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MeetingAssistant } from './MeetingAssistant';
import { localActionAvailable, MEETING_DEFAULT_SKILLS, meetingSkillAvailable } from './meeting-availability';
import { resolveMeetingSkills } from './meeting-skills';
import { MEETING_DIGITAL_HUMAN_PROFILES, MEETING_LOCAL_PROFILE_ID, resolveMeetingDigitalHumanProfileId } from '../shared/desktop-experience-catalog';
import { runRequestSchema, type MeetingDesktopApi } from '../shared/contracts';

describe('independent meeting availability', () => {
  it('starts with local skills and never requests unavailable MCP tools', () => {
    expect(resolveMeetingSkills(MEETING_DEFAULT_SKILLS).mcpTools).toEqual([]);
    expect(MEETING_DEFAULT_SKILLS).toEqual(['decision', 'facilitator', 'actions']);
  });
  it('refuses external actions while retaining the oral-confirmed local actions', () => {
    for (const kind of ['end_meeting', 'open_audio_folder', 'play_audio'] as const) expect(localActionAvailable({ kind })).toBe(true);
  });
  it('uses the local presenter even when an old 远程角色 preference is supplied', () => {
    expect(resolveMeetingDigitalHumanProfileId('unknown-profile')).toBe(MEETING_LOCAL_PROFILE_ID);
    expect(MEETING_DIGITAL_HUMAN_PROFILES).toHaveLength(1);
  });
  it('renders only local controls and explains the local recording location', () => {
    window.meetingAgent = { agent: {} } as MeetingDesktopApi;
    const view = document.createElement('div');
    view.innerHTML = renderToStaticMarkup(createElement(MeetingAssistant));
    expect(view.querySelector('img, webview')).toBeNull();
    expect(view.querySelectorAll('video')).toHaveLength(3);
    expect(view.querySelector('canvas.meeting-stage__canvas')).not.toBeNull();
    expect(view.textContent).toContain('角色动画');
    expect(view.textContent).not.toContain('（未接入）');
    expect(view.textContent).toContain('.local-data/recordings/本场会议目录');
    expect(view.textContent).toContain('语音未配置');
    expect(view.textContent).not.toContain('桌面 › 录音');
  });
  it('rejects privileged or external tool execution at the bridge request schema', () => {
    const request = {
      requestId: 'b2603385-20ef-45ca-8970-560059dc90cd', threadId: 'a89c3347-72ce-4cb3-ad91-f78bf3606da2',
      message: '总结刚才的讨论', modelProfileId: 'meeting', thinking: { enabled: false },
      catalogRevision: '1', capabilityRevision: 'a'.repeat(64), accessMode: 'read_only', mcpTools: [],
    };
    expect(runRequestSchema.safeParse(request).success).toBe(true);
    expect(runRequestSchema.safeParse({ ...request, fullAccess: true }).success).toBe(false);
    expect(runRequestSchema.safeParse({ ...request, accessMode: 'workspace' }).success).toBe(false);
    expect(runRequestSchema.safeParse({ ...request, mcpTools: ['external/write'] }).success).toBe(false);
  });
});
