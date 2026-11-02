import { modelCatalogSchema, type ModelCatalog, type ModelProfile } from './contracts';

export const MEETING_LOCAL_PROFILE_ID = 'local-meeting';
export const MEETING_LOCAL_PROFILE: ModelProfile = {
  id: MEETING_LOCAL_PROFILE_ID,
  displayName: '会议助手',
  description: '本地状态视觉配合会议问答；语音服务未配置时以文字展示。',
  compatibilityFamily: 'meeting-agent-local', latencyTier: 'standard', costTier: 'low', enabled: true,
  capabilities: { toolCalling: false, streaming: false, structuredOutput: false, thinkingEfforts: [] },
};
export const MEETING_DIGITAL_HUMAN_PROFILES: readonly ModelProfile[] = [MEETING_LOCAL_PROFILE];
export function isDesktopExperienceProfile(profileId: string): boolean { return profileId === MEETING_LOCAL_PROFILE_ID; }
export function meetingUsesLocalWakeAgent(_profileId?: string): boolean { return true; }
export function resolveMeetingDigitalHumanProfileId(_profileId?: string): string { return MEETING_LOCAL_PROFILE_ID; }
export function meetingDigitalHumanProfile(_profileId?: string): ModelProfile { return MEETING_LOCAL_PROFILE; }
export function meetingDigitalHumanSwitchLabel(_profileId: string): string { return '本地状态视觉'; }
export function mergeDesktopExperienceCatalog(catalog: ModelCatalog): ModelCatalog {
  return modelCatalogSchema.parse({ ...catalog, profiles: [...catalog.profiles.filter(p => !isDesktopExperienceProfile(p.id)), MEETING_LOCAL_PROFILE] });
}
export function desktopExperienceRunError(profileId: string): string | null { return isDesktopExperienceProfile(profileId) ? 'DESKTOP_EXPERIENCE_NOT_RUNNABLE' : null; }
const EXPERIENCE_PREFERENCE_KEY = 'meeting-agent.meeting-experience.v1';
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function readDesktopExperiencePreference(storage: StorageAccess): string | undefined {
  try { const value = storage.getItem(EXPERIENCE_PREFERENCE_KEY)?.trim() ?? ''; return isDesktopExperienceProfile(value) ? value : undefined; } catch { return undefined; }
}
export function saveDesktopExperiencePreference(storage: StorageAccess, profileId: string): void {
  try { if (!isDesktopExperienceProfile(profileId)) storage.removeItem(EXPERIENCE_PREFERENCE_KEY); else storage.setItem(EXPERIENCE_PREFERENCE_KEY, profileId); } catch { /* UI preference only. */ }
}
