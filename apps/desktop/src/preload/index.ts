import { contextBridge, ipcRenderer } from 'electron';
import type { MeetingDesktopApi } from '../shared/contracts';
import type { StandaloneApi } from '../shared/standalone-contracts';

const invoke = (channel: string, method: string, args: unknown[]) => ipcRenderer.invoke(channel, method, args);
function methods<T extends object>(channel: string, names: readonly string[]): T {
  return Object.freeze(Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => invoke(channel, name, args)]))) as T;
}
function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const api: MeetingDesktopApi = {
  agent: {
    ...methods<Omit<MeetingDesktopApi['agent'], 'onRunEvent'>>('meeting-agent:agent', ['listModels', 'listExtensions', 'resolveToolApproval', 'getToolCalls', 'ensureConversationThread', 'getCodeWorkspaceCapability', 'startRun', 'getRun', 'getRunEvents', 'cancelRun', 'pickWorkspace', 'createThread']),
    onRunEvent: (listener) => subscribe('meeting-agent:run-event', listener),
  },
  meetings: {
    ...methods<Omit<MeetingDesktopApi['meetings'], 'onAvatarAudio' | 'onAvatarSession'>>('meeting-agent:meetings', ['readTranscript', 'getCapabilities', 'warmAnswer', 'lookupWeather', 'speakAvatar', 'sendAvatarText', 'synthesizeSpeech', 'interruptAvatar', 'prepareAvatar', 'releaseAvatar', 'getAvatarSession', 'setAvatarLayout', 'getAvatarUiUrl', 'create', 'appendTranscript', 'appendAudio', 'analyzeVoice', 'appendArchiveAudio', 'complete', 'list', 'search', 'openAudioFolder', 'playAudio', 'exportAudio', 'exportDocument', 'listKnowledgeProjects', 'publishKnowledge', 'refreshKnowledge']),
    onAvatarAudio: () => () => {},
    onAvatarSession: () => () => {},
  },
};
contextBridge.exposeInMainWorld('meetingAgent', api);
contextBridge.exposeInMainWorld('meetingHost', {
  ...methods<Omit<StandaloneApi, 'onPrepareClose'>>('meeting-agent:standalone', ['status', 'openDataDirectory', 'exportMarkdown']),
  onPrepareClose: (listener: (nonce: string) => Promise<void> | void) => {
    const remove = subscribe<string>('meeting-agent:prepare-close', (nonce) => {
      void Promise.resolve().then(() => listener(nonce)).then(
        () => invoke('meeting-agent:standalone', 'closeFlushed', [nonce, true]),
        () => invoke('meeting-agent:standalone', 'closeFlushed', [nonce, false]),
      ).catch(() => undefined);
    });
    void invoke('meeting-agent:standalone', 'closeListenerReady', []).catch(() => undefined);
    return remove;
  },
} satisfies StandaloneApi);
