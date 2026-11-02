import { useEffect, useMemo, useRef, useState } from 'react';
import { type AgentThread, type CodeWorkspaceCapability, type MeetingAvatarSession, type MeetingCapabilities, type MeetingRecord, type MeetingTranscriptChunk, type ModelCatalog } from '../shared/contracts';
import {
  meetingDigitalHumanProfile,
  meetingUsesLocalWakeAgent,
  readDesktopExperiencePreference,
  resolveMeetingDigitalHumanProfileId,
} from '../shared/desktop-experience-catalog';
import { MeetingAudioRecorder } from './audio-recorder';
import { hasStructuredMeetingSummary, meetingSummaryChunks, meetingSummaryPrompt, needsMeetingTitleSummary, parseMeetingSummary, prepareMeetingSummaryLines, type MeetingSummary } from './meeting-summary';
import { isUnusableMeetingReply, parseMeetingAnswer, type MeetingAnswer, type MeetingAnswerMedia, type MeetingAnswerSource, type MeetingProposedAction } from './meeting-answer';
import { isParticipantTranscript, meetingEmptyReplyRecoveryPrompt, meetingQuestionPrompt, transcriptCompletesWakeQuestion, WakeSession } from './wake-session';
import {
  FALLBACK_MEETING_CAPABILITIES,
  isMeetingWeatherQuestion,
  isMeetingSelfIntroduction,
  localMeetingSpokenReply,
  MEETING_SELF_INTRODUCTION,
  meetingAvatarStatus,
  meetingEmptySpokenFallback,
  meetingDirectionStatus,
  meetingWakeKeywordAllowed,
} from './meeting-speech';
import type { MeetingDirectionMode } from './audio-recorder';
import { voiceActionDecision } from './voice-action-confirmation';
import { localMeetingActionIntent } from './voice-action-intent';
import {
  MEETING_ASSISTANT_PROMPT,
  MEETING_SKILLS,
  resolveMeetingSkills,
  type MeetingSkillId,
} from './meeting-skills';
import { MeetingCharacter } from './MeetingCharacter';
import type { MeetingCharacterPlayback } from './MeetingCharacter';
import { MeetingAudioSources } from './meeting-audio-sources';
import type { SpeakerDirection } from './speaker-direction';
import './meeting-assistant.css';

import { MeetingRunClient, MeetingTurnQueue } from './meeting-turns';
import { MeetingDialogContexts, prepareMeetingContext, runMeetingSummaryTurn } from './meeting-context';
import { localActionAvailable, MEETING_DEFAULT_SKILLS, meetingSkillAvailable } from './meeting-availability';
import { meetingErrorMessage } from './meeting-error';
import { drainMeetingBeforeClose } from './meeting-close';
import { meetingEvidenceText, meetingReferenceKind, meetingReferenceLabel, referencedMeetings } from './meeting-retrieval';
import { meetingDurationLabel, meetingHistoryMatches, meetingHistoryMeta, type MeetingHistoryFilter } from './meeting-history';
import { enforceHistoricalAttribution } from './meeting-memory-answer';

type AssistantStatus = 'setup' | 'idle' | 'starting' | 'listening' | 'armed' | 'confirming' | 'thinking' | 'speaking' | 'error';
type PresentationItem =
  | { kind: 'text'; title: string; body: string; bullets: readonly string[]; sources?: readonly MeetingAnswerSource[]; media?: readonly MeetingAnswerMedia[] }
  | { kind: 'image'; title: string; src?: string; caption: string; sourceUrl?: string }
  | { kind: 'video'; title: string; poster?: string; src?: string; sourceUrl?: string; caption?: string };

const SUMMARY_PRESENTATION: PresentationItem = {
  kind: 'text',
  title: 'Meeting Agent',
  body: '开始记录后，可用“会议助手”唤醒会议助手。会议录音与记录保存在本项目中。',
  bullets: ['录音与本地转写', '会议问答与结构化纪要', '本地历史检索与录音导出'],
};
const EMPTY_AUDIO_SPECTRUM = Object.freeze(Array.from({ length: 24 }, () => 0));
const MEETING_AGENT_RETRY_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000] as const;

function statusLabel(status: AssistantStatus): string {
  return { setup: '等待开始', idle: '会议已暂停', starting: '正在启动麦克风', listening: '正在聆听', armed: '会议助手已唤醒，请继续说', confirming: '等待口头确认', thinking: '正在执行语音指令', speaking: '正在为你讲解', error: '需要处理' }[status];
}

function proposedActionLabel(action: MeetingProposedAction): string {
  return {
    end_meeting: '结束并归档当前会议',
    open_audio_folder: '打开当前会议录音文件夹',
    play_audio: '播放当前会议完整录音',
  }[action.kind];
}
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const remainder = (seconds % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${remainder}`;
}
function knowledgeStatusLabel(_meeting: MeetingRecord | undefined): string { return '本地会议纪要'; }

export function MeetingAssistant({ active = true, onRecordingChange }: { active?: boolean; onRecordingChange?: (recording: boolean) => void } = {}) {
  const audioRecorder = useMemo(() => new MeetingAudioRecorder(), []);
  const dialogContexts = useRef(new MeetingDialogContexts());
  const [stageOpen, setStageOpen] = useState(true);
  const [status, setStatus] = useState<AssistantStatus>('setup');
  const [recordingActive, setRecordingActive] = useState(false);
  useEffect(() => { onRecordingChange?.(recordingActive); }, [onRecordingChange, recordingActive]);
  useEffect(() => () => { onRecordingChange?.(false); }, [onRecordingChange]);
  const [workspaceLabel, setWorkspaceLabel] = useState('');
  const [thread, setThread] = useState<AgentThread | null>(null);
  const [capability, setCapability] = useState<CodeWorkspaceCapability | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [interim, setInterim] = useState('');
  const [transcript, setTranscript] = useState<MeetingTranscriptChunk[]>([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [structuredAnswer, setStructuredAnswer] = useState<MeetingAnswer | null>(null);
  const [error, setError] = useState('');
  const [speechEnabled, setSpeechEnabled] = useState(true);
  const [videoCharacterEnabled, setVideoCharacterEnabled] = useState(true);
  const [digitalHumanId, setDigitalHumanId] = useState(() => (
    resolveMeetingDigitalHumanProfileId(readDesktopExperiencePreference(window.localStorage))
  ));
  const digitalHumanIdRef = useRef(digitalHumanId);
  digitalHumanIdRef.current = digitalHumanId;
  const wakeSession = useMemo(
    () => new WakeSession(),
    [digitalHumanId],
  );
  const [chromeOpen, setChromeOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [presentation, setPresentation] = useState<PresentationItem>(SUMMARY_PRESENTATION);
  const [meetingHistory, setMeetingHistory] = useState<MeetingRecord[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyFilter, setHistoryFilter] = useState<MeetingHistoryFilter>('all');
  const [historySelectionId, setHistorySelectionId] = useState<string | null>(null);
  const [summaryJobId, setSummaryJobId] = useState<string | null>(null);
  const [activeMeetingId, setActiveMeetingId] = useState<string | null>(null);
  const [presentedMeetingId, setPresentedMeetingId] = useState<string | null>(null);
  const [memoryStatus, setMemoryStatus] = useState('正在读取会议记忆');
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioSpectrum, setAudioSpectrum] = useState<readonly number[]>(EMPTY_AUDIO_SPECTRUM);
  const [meetingCapabilities, setMeetingCapabilities] = useState<MeetingCapabilities | null>(null);
  const [transcriptionMode, setTranscriptionMode] = useState<'unknown' | 'local' | 'none'>('unknown');
  const [speakerDirection, setSpeakerDirection] = useState<SpeakerDirection>('center');
  const [characterSpeaking, setCharacterSpeaking] = useState(false);
  const characterPlayback = useRef<MeetingCharacterPlayback | null>(null);
  const [directionMode, setDirectionMode] = useState<'unknown' | MeetingDirectionMode>('unknown');
  const [avatarSession, setAvatarSession] = useState<MeetingAvatarSession | null>(null);
  const [avatarFrameReady, setAvatarFrameReady] = useState(false);
  const [enabledSkillIds, setEnabledSkillIds] = useState<MeetingSkillId[]>([...MEETING_DEFAULT_SKILLS]);
  const [meetingPromptAddon, setMeetingPromptAddon] = useState('');
  const [pendingAction, setPendingAction] = useState<MeetingProposedAction | null>(null);
  const [agentConnecting, setAgentConnecting] = useState(false);
  const activeRequestId = useRef('');
  const turns = useMemo(() => new MeetingTurnQueue(), []);
  const runClient = useMemo(() => new MeetingRunClient(window.meetingAgent.agent), []);
  const summaryTurns = useMemo(() => new MeetingTurnQueue(), []);
  const summaryRunClient = useMemo(() => new MeetingRunClient(window.meetingAgent.agent), []);
  const completing = useRef(false);
  const programWrites = useRef(new Set<Promise<void>>());
  const summaryRecoveryAttempted = useRef(new Set<string>());
  const summaryRecoveryActive = useRef(false);
  const lastAskedQuestion = useRef('');
  const activeMeetingIdRef = useRef<string | null>(null);
  const desiredListening = useRef(false);
  const startingListening = useRef(false);
  const recordingStartup = useRef<Promise<void> | null>(null);
  const preparingClose = useRef(false);
  const prepareCloseTask = useRef<Promise<void> | null>(null);
  const currentWakeSession = useRef(wakeSession);
  currentWakeSession.current = wakeSession;
  const localAsrListening = useRef(false);
  const lastAsrTranscriptSequence = useRef(0);
  const wakeFlushTimer = useRef<number | null>(null);
  const assistantSpeaking = useRef(false);
  const lastAssistantSpeechAt = useRef(-Infinity);
  const neuralSpeechGeneration = useRef(0);
  const neuralSource = useRef<AudioBufferSourceNode | null>(null);
  const neuralWatchdogTimer = useRef<number | null>(null);
  const pendingActionRef = useRef<MeetingProposedAction | null>(null);
  const avatarAudioContext = useRef<AudioContext | null>(null);
  const avatarPlayhead = useRef(0);
  const avatarSources = useRef(new MeetingAudioSources());
  const avatarGeneration = useRef(0);
  const avatarStreamActive = useRef(false);
  const avatarStreamEnded = useRef(false);
  const avatarVisualStarted = useRef(false);
  const avatarPendingAudio = useRef(Promise.resolve());
  const avatarWatchdogTimer = useRef<number | null>(null);
  const avatarFinishTimer = useRef<number | null>(null);
  const avatarAudioReceived = useRef(false);
  const chromeHideTimer = useRef<number | null>(null);
  const chromeHovering = useRef(false);
  const settingsOpen = useRef(false);
  const stageRef = useRef<HTMLElement | null>(null);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const historyDialogRef = useRef<HTMLElement | null>(null);
  const agentInitializationGeneration = useRef(0);

  function activeAvatarAudioContext(): AudioContext {
    const current = avatarAudioContext.current;
    if (current && current.state !== 'closed') return current;
    const replacement = new AudioContext();
    avatarAudioContext.current = replacement;
    avatarPlayhead.current = 0;
    return replacement;
  }
  const busy = status === 'starting' || status === 'thinking' || status === 'speaking';
  const visibleTranscript = transcript;
  const hasLiveTranscript = visibleTranscript.length > 0 || Boolean(interim);
  const meetingSkillSelection = useMemo(
    () => resolveMeetingSkills(enabledSkillIds),
    [enabledSkillIds],
  );

  function toggleMeetingSkill(skillId: MeetingSkillId, enabled: boolean): void {
    if (skillId === 'actions' && !enabled) {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
    setEnabledSkillIds((current) => enabled
      ? [...new Set([...current, skillId])]
      : current.filter((item) => item !== skillId));
  }

  function clearChromeHide() {
    if (chromeHideTimer.current === null) return;
    window.clearTimeout(chromeHideTimer.current);
    chromeHideTimer.current = null;
  }
  function chromeShouldStay() {
    const avatarOverlay = avatarSession?.provider === 'disabled'
      && (avatarSession.state === 'connecting' || avatarSession.state === 'live');
    return chromeHovering.current || settingsOpen.current || historyOpen || Boolean(pendingActionRef.current)
      || Boolean(avatarOverlay)
      || Boolean(stageRef.current?.querySelector('.meeting-stage__topbar :focus-visible, .meeting-dock :focus-visible, .meeting-digital-human-switch :focus-visible'));
  }
  function scheduleChromeHide() {
    clearChromeHide();
    chromeHideTimer.current = window.setTimeout(() => {
      chromeHideTimer.current = null;
      if (!chromeShouldStay()) setChromeOpen(false);
    }, 700);
  }
  function revealChrome() {
    setChromeOpen(true);
    if (!chromeShouldStay()) scheduleChromeHide();
  }
  function syncChromePin() {
    if (chromeShouldStay()) {
      clearChromeHide();
      setChromeOpen(true);
      return;
    }
    scheduleChromeHide();
  }
  function openHistory(): void {
    setHistorySelectionId(presentedMeetingId ?? meetingHistory[0]?.id ?? null);
    setHistoryOpen(true);
  }
  function closeHistory(): void {
    setHistoryOpen(false);
    window.requestAnimationFrame(() => historyButtonRef.current?.focus());
  }
  function trapHistoryFocus(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Tab') return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  useEffect(() => window.meetingHost.onPrepareClose(async () => {
    if (prepareCloseTask.current) return prepareCloseTask.current;
    preparingClose.current = true;
    desiredListening.current = false;
    localAsrListening.current = false;
    currentWakeSession.current.reset();
    activeRequestId.current = '';
    turns.clear();
    summaryTurns.clear();
    if (wakeFlushTimer.current !== null) window.clearTimeout(wakeFlushTimer.current);
    wakeFlushTimer.current = null;
    cancelNeuralSpeech();
    prepareCloseTask.current = drainMeetingBeforeClose({
      waitForStart: () => recordingStartup.current ?? Promise.resolve(),
      cancelRuns: [() => runClient.cancel(), () => summaryRunClient.cancel()],
      stopRecording: async () => {
        // Startup may have resumed capture after the close request. Stop only
        // once it settles, and keep its last ASR/archive callbacks from waking.
        desiredListening.current = false;
        localAsrListening.current = false;
        await audioRecorder.stop();
      },
      programWrites: programWrites.current,
    });
    return prepareCloseTask.current;
  }), [audioRecorder, runClient, summaryRunClient, turns, summaryTurns]);

  useEffect(() => () => {
    turns.clear();
    void runClient.cancel().catch(() => {});
    summaryTurns.clear();
    void summaryRunClient.cancel().catch(() => {});
    void audioRecorder.stop();
    void window.meetingAgent.meetings.interruptAvatar().catch(() => {});
    cancelNeuralSpeech();
    if (avatarWatchdogTimer.current !== null) window.clearTimeout(avatarWatchdogTimer.current);
    if (avatarFinishTimer.current !== null) window.clearTimeout(avatarFinishTimer.current);
    const context = avatarAudioContext.current;
    avatarAudioContext.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
    clearChromeHide();
  }, [audioRecorder]);
  const selectedDigitalHuman = meetingDigitalHumanProfile(digitalHumanId);
  useEffect(() => {
    if (!active) return;
    chromeHovering.current = false;
    if (stageOpen) {
      setChromeOpen(settingsOpen.current || Boolean(pendingActionRef.current));
      stageRef.current?.focus({ preventScroll: true });
    } else {
      settingsOpen.current = false;
      launcherRef.current?.focus({ preventScroll: true });
    }
    return () => clearChromeHide();
  }, [active, stageOpen]);
  useEffect(() => {
    syncChromePin();
  }, [pendingAction, historyOpen, avatarSession?.state]);
  useEffect(() => {
    let active = true;
    void window.meetingAgent.meetings.list(50).then(async (records) => {
      const refreshed = records;
      if (!active) return;
      setMeetingHistory(refreshed);
      setPresentedMeetingId((current) => current ?? refreshed[0]?.id ?? null);
      setMemoryStatus(refreshed.length ? `已载入 ${refreshed.length} 次会议` : '尚无历史会议');
      const recording = refreshed.find((record) => record.status === 'recording');
      if (recording) {
        setActiveMeetingId(recording.id);
        activeMeetingIdRef.current = recording.id;
        lastAsrTranscriptSequence.current = recording.transcript.at(-1)?.sequence ?? 0;
      }
    }).catch(() => {
      if (active) setMemoryStatus('会议记忆暂不可用');
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!thread || !catalog || !capability || activeMeetingId || summaryJobId || busy) return;
    const pending = meetingHistory.find((meeting) => (
      meeting.status === 'completed'
      && (meeting.summaryStatus === 'pending' || needsMeetingTitleSummary(meeting))
      && !summaryRecoveryAttempted.current.has(meeting.id)
    ));
    if (!pending) return;
    void regenerateHistoricalMeeting(pending);
  }, [activeMeetingId, busy, capability, catalog, meetingHistory, summaryJobId, thread, summaryTurns]);

  async function regenerateHistoricalMeeting(pending: MeetingRecord): Promise<void> {
    if (activeMeetingIdRef.current || summaryRecoveryActive.current || busy || !thread || !catalog) return;
    summaryRecoveryAttempted.current.add(pending.id);
    summaryRecoveryActive.current = true;
    setSummaryJobId(pending.id);
    const revision = summaryTurns.revision;
    const assertActive = () => { if (revision !== summaryTurns.revision) throw new Error('MEETING_TURN_CANCELLED'); };
    setMemoryStatus(`正在补充整理《${pending.title}》`);
    setError('');
    await summaryTurns.enqueue(async () => {
      const source = await readStoredMeetingTranscript(pending.id);
      assertActive();
      const summary = await generateAgentMeetingSummary(source, assertActive, (message) => {
        assertActive();
        setMemoryStatus(message);
      }, summaryRunClient);
      assertActive();
      const completed = await window.meetingAgent.meetings.complete({ meetingId: pending.id, ...summary });
      assertActive();
      setMeetingHistory((current) => [completed, ...current.filter((item) => item.id !== completed.id)]);
      setMemoryStatus(`《${completed.title}》纪要已补充完成`);
    }).catch((caught) => {
      if (revision !== summaryTurns.revision || String(caught).includes('MEETING_TURN_CANCELLED')) return;
      setMemoryStatus(`《${pending.title}》仍待总结，下次打开后会继续重试`);
      setError(meetingErrorMessage(caught));
    }).finally(() => {
      if (revision !== summaryTurns.revision) return;
      summaryRecoveryActive.current = false;
      setSummaryJobId(null);
    });
  }
  function pauseHistoricalSummary(): void {
    if (!summaryRecoveryActive.current) return;
    summaryTurns.clear();
    summaryRecoveryActive.current = false;
    setSummaryJobId(null);
    void summaryRunClient.cancel().catch(() => {});
  }
  useEffect(() => {
    let active = true;
    let retryTimer: number | null = null;
    const load = (attempt: number) => {
      void window.meetingAgent.meetings.getCapabilities()
        .then((capabilities) => {
          if (active) setMeetingCapabilities(capabilities);
        })
        .catch((error: unknown) => {
          console.error('[meeting-tts] capabilities', error instanceof Error ? error.message : error);
          if (!active) return;
          if (attempt < 3) {
            retryTimer = window.setTimeout(() => load(attempt + 1), 400 * attempt);
            return;
          }
          setMeetingCapabilities(FALLBACK_MEETING_CAPABILITIES);
        });
    };
    load(1);
    const stopSession = window.meetingAgent.meetings.onAvatarSession((session) => {
      if (active) setAvatarSession(session);
    });
    void window.meetingAgent.meetings.getAvatarSession().then((session) => {
      if (active) setAvatarSession(session);
    }).catch(() => {});
    return () => {
      active = false;
      stopSession();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, []);
  useEffect(() => {
    const playStreamedSpeech = (chunk: Parameters<Parameters<typeof window.meetingAgent.meetings.onAvatarAudio>[0]>[0]) => {
      if (!assistantSpeaking.current || !speechEnabled || !avatarStreamActive.current) return;
      const generation = avatarGeneration.current;
      avatarAudioReceived.current = true;
      // Preserve packet order while the first video frame/context is being prepared.
      avatarPendingAudio.current = avatarPendingAudio.current.then(async () => {
        if (generation !== avatarGeneration.current || avatarStreamEnded.current) return;
        const context = activeAvatarAudioContext();
        await context.resume();
        if (generation !== avatarGeneration.current) return;
        const finishIfDrained = () => {
          if (generation !== avatarGeneration.current || avatarSources.current.size) return;
          characterPlayback.current?.stopSpeech();
          setCharacterSpeaking(false);
          avatarVisualStarted.current = false;
          if (!avatarStreamEnded.current) return;
          if (neuralWatchdogTimer.current !== null) {
            window.clearTimeout(neuralWatchdogTimer.current);
            neuralWatchdogTimer.current = null;
          }
          cancelStreamedSpeech();
          finishAssistantSpeech();
          resumeListeningIfDesired();
        };
        const frames = Math.floor(chunk.data.byteLength / (2 * chunk.channels));
        if (frames > 0) {
          const samples = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
          const buffer = context.createBuffer(chunk.channels, frames, chunk.sampleRate);
          for (let channel = 0; channel < chunk.channels; channel += 1) {
            const output = buffer.getChannelData(channel);
            for (let frame = 0; frame < frames; frame += 1) output[frame] = samples.getInt16((frame * chunk.channels + channel) * 2, true) / 32768;
          }
          if (!avatarVisualStarted.current) {
            setCharacterSpeaking(true);
            const ready = await characterPlayback.current?.startSpeech();
            if (generation !== avatarGeneration.current) return;
            setCharacterSpeaking(Boolean(ready));
            avatarVisualStarted.current = true;
          }
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          avatarSources.current.add(source, finishIfDrained);
          const startAt = Math.max(context.currentTime + 0.02, avatarPlayhead.current);
          source.start(startAt);
          avatarPlayhead.current = startAt + buffer.duration;
        }
        avatarStreamEnded.current = chunk.endOfSpeech;
        if (avatarWatchdogTimer.current !== null) window.clearTimeout(avatarWatchdogTimer.current);
        // Also bound a stream that sends one packet then loses EOS. Never cut queued audio early.
        avatarWatchdogTimer.current = window.setTimeout(() => {
          if (generation !== avatarGeneration.current) return;
          cancelStreamedSpeech();
          finishAssistantSpeech();
          resumeListeningIfDesired();
        }, Math.max(15_000, (avatarPlayhead.current - context.currentTime) * 1_000 + 2_000));
        if (chunk.endOfSpeech) finishIfDrained();
      }).catch(() => {
        if (generation !== avatarGeneration.current) return;
        cancelStreamedSpeech();
        finishAssistantSpeech();
        resumeListeningIfDesired();
        setError('语音流播放中断，回答已保留为文字。');
      });
    };
    const stopAvatar = window.meetingAgent.meetings.onAvatarAudio(playStreamedSpeech);
    return () => {
      stopAvatar();
    };
  }, [speechEnabled]);
  async function connectMeetingAgent(reset = false): Promise<void> {
    if (reset) {
      turns.clear();
      await runClient.cancel().catch(() => {});
      dialogContexts.current.reset();
    }
    const generation = agentInitializationGeneration.current + 1;
    agentInitializationGeneration.current = generation;
    setAgentConnecting(true);
    setError('');
    setMemoryStatus('正在连接会议 Agent');
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MEETING_AGENT_RETRY_DELAYS_MS.length; attempt += 1) {
      const delay = MEETING_AGENT_RETRY_DELAYS_MS[attempt] ?? 0;
      if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
      if (generation !== agentInitializationGeneration.current) return;
      try {
        const [nextCatalog, nextThread] = await Promise.all([
          window.meetingAgent.agent.listModels(),
          window.meetingAgent.agent.ensureConversationThread({
            surface: 'dialog',
            contextId: dialogContexts.current.context(activeMeetingIdRef.current ?? presentedMeetingId),
          }),
        ]);
        const nextCapability = await window.meetingAgent.agent.getCodeWorkspaceCapability(nextThread.id);
        if (generation !== agentInitializationGeneration.current) return;
        setCatalog(nextCatalog);
        setThread(nextThread);
        setCapability(nextCapability);
        setAgentConnecting(false);
        setError('');
        setStatus((current) => current === 'setup' ? 'idle' : current);
        setMemoryStatus(reset ? '模型对话历史已重置；录音和逐字稿已保留' : '会议 Agent 已连接');
        return;
      } catch (caught: unknown) {
        if (generation !== agentInitializationGeneration.current) return;
        lastError = caught;
        console.error(
          '[meeting-agent] initialization failed',
          { attempt: attempt + 1, error: caught instanceof Error ? `${caught.name}: ${caught.message}` : caught },
        );
      }
    }
    if (generation !== agentInitializationGeneration.current) return;
    setAgentConnecting(false);
    setMemoryStatus('会议 Agent 尚未连接。录音可用，点“重新连接会议 Agent”重试');
    if (lastError) {
      console.error('[meeting-agent] initialization exhausted', lastError);
      setError('会议 Agent 暂时未连接，请点击“重新连接会议 Agent”重试');
    }
  }

  useEffect(() => {
    void connectMeetingAgent();
    return () => {
      agentInitializationGeneration.current += 1;
    };
  }, []);
  useEffect(() => {
    if (!recordingActive) return undefined;
    const timer = window.setInterval(() => setElapsed((current) => current + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recordingActive]);
  useEffect(() => window.meetingAgent.agent.onRunEvent((event) => {
    runClient.event(event);
    summaryRunClient.event(event);
  }), [runClient, summaryRunClient]);
  useEffect(() => {
    if (!stageOpen) return undefined;
    const report = () => {
      const stage = stageRef.current;
      const chromeVisible = chromeOpen || historyOpen;
      const topbar = stage?.querySelector('.meeting-stage__topbar');
      const dock = stage?.querySelector('.meeting-dock');
      const top = chromeVisible && topbar
        ? Math.max(0, Math.ceil(topbar.getBoundingClientRect().bottom))
        : 0;
      const dockTop = dock?.getBoundingClientRect().top;
      const bottom = chromeVisible && typeof dockTop === 'number' && dockTop > 0
        ? Math.max(0, Math.ceil(window.innerHeight - dockTop))
        : 0;
      void window.meetingAgent.meetings.setAvatarLayout({
        width: Math.round(window.innerWidth),
        height: Math.round(window.innerHeight),
        top,
        bottom,
      }).catch(() => {});
    };
    report();
    window.addEventListener('resize', report);
    return () => window.removeEventListener('resize', report);
  }, [stageOpen, chromeOpen, historyOpen, avatarSession?.state, avatarSession?.videoAttached]);

  async function presentMeetingAnswer(parsed: MeetingAnswer, askedQuestion = lastAskedQuestion.current): Promise<void> {
    setAnswer(parsed.spokenAnswer);
    setStructuredAnswer(parsed);
    setPresentation({ kind: 'text', title: parsed.title, body: parsed.spokenAnswer, bullets: parsed.bullets, sources: parsed.sources, media: parsed.media });
    const proposedAction = enabledSkillIds.includes('actions') ? parsed.action : null;
    if (proposedAction && !localActionAvailable(proposedAction)) {
      setError("当前仅支持本地会议动作，此操作不可用。");
    }
    if (proposedAction && localActionAvailable(proposedAction)) {
      pendingActionRef.current = proposedAction;
      setPendingAction(proposedAction);
    }
    // Start speech before persisting the program record. The record is durable
    // bookkeeping and can finish in parallel; it should not delay the first
    // audible response after the model has already answered.
    speakReply(parsed.spokenAnswer);
    const meetingId = activeMeetingIdRef.current;
    if (meetingId) {
      const fullText = [
        '提问：' + askedQuestion,
        '回答：' + (parsed.fullAnswer || parsed.spokenAnswer),
        ...parsed.bullets,
        ...parsed.sources.map((source) => '引用：' + source.title + ' ' + source.url),
        ...parsed.media.map((medium) => '媒体：' + medium.title + ' ' + medium.url),
      ].join('\n');
      try {
        for (let offset = 0; offset < fullText.length; offset += 3800) {
          await appendProgramRecord(fullText.slice(offset, offset + 3800));
        }
        setMemoryStatus('助理问答、要点与来源已直接写入会议记录');
      } catch { setMemoryStatus('助理回答显示正常，但写入会议记录失败'); }
    }
  }

  function stopCharacterSpeech(): void {
    characterPlayback.current?.stopSpeech();
    setCharacterSpeaking(false);
    avatarVisualStarted.current = false;
  }

  function localWakeAgentActive(): boolean {
    return meetingUsesLocalWakeAgent(digitalHumanIdRef.current);
  }
  function finishAssistantSpeech(): void {
    if (assistantSpeaking.current) lastAssistantSpeechAt.current = performance.now();
    assistantSpeaking.current = false;
  }
  function interruptSpeech(): void {
    void window.meetingAgent.meetings.interruptAvatar().catch(() => {});
    cancelNeuralSpeech();
    finishAssistantSpeech();
    if (avatarWatchdogTimer.current !== null) {
      window.clearTimeout(avatarWatchdogTimer.current);
      avatarWatchdogTimer.current = null;
    }
  }

  function speakReply(reply: string): void {
    if (!speechEnabled) { finishAssistantSpeech(); resumeListeningIfDesired(); return; }
    primeAvatarAudio();
    lastAssistantSpeechAt.current = performance.now();
    assistantSpeaking.current = true;
    setStatus('speaking');
    if (meetingCapabilities?.tts.provider === 'local' && meetingCapabilities.tts.available) {
      void speakWithNeural(reply);
      return;
    }
    speakWithNeuralOrText(reply);
  }

  function speakWithNeuralOrText(text: string): void {
    if (meetingCapabilities?.tts.available) {
      void speakWithNeural(text);
      return;
    }
    finishUnavailableSpeech();
  }

  function cancelNeuralSpeech(): void {
    cancelStreamedSpeech();
    stopCharacterSpeech();
    neuralSpeechGeneration.current += 1;
    if (neuralWatchdogTimer.current !== null) {
      window.clearTimeout(neuralWatchdogTimer.current);
      neuralWatchdogTimer.current = null;
    }
    const source = neuralSource.current;
    neuralSource.current = null;
    try { source?.stop(); } catch { /* already stopped */ }
    source?.disconnect();
  }

  function cancelStreamedSpeech(): void {
    avatarGeneration.current += 1;
    avatarStreamActive.current = false;
    avatarStreamEnded.current = false;
    avatarVisualStarted.current = false;
    avatarPendingAudio.current = Promise.resolve();
    avatarSources.current.stop();
    avatarPlayhead.current = 0;
    if (avatarWatchdogTimer.current !== null) window.clearTimeout(avatarWatchdogTimer.current);
    avatarWatchdogTimer.current = null;
  }

  async function speakWithNeural(text: string): Promise<void> {
    cancelStreamedSpeech();
    const generation = ++neuralSpeechGeneration.current;
    stopCharacterSpeech();
    if (neuralWatchdogTimer.current !== null) {
      window.clearTimeout(neuralWatchdogTimer.current);
      neuralWatchdogTimer.current = null;
    }
    const source = neuralSource.current;
    neuralSource.current = null;
    try { source?.stop(); } catch { /* already stopped */ }
    source?.disconnect();
    try {
      let audio: Awaited<ReturnType<typeof window.meetingAgent.meetings.synthesizeSpeech>> | null = null;
      let lastFailure: unknown = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          audio = await window.meetingAgent.meetings.synthesizeSpeech({
            text,
            ...(activeMeetingIdRef.current ? { meetingId: activeMeetingIdRef.current } : {}),
          });
          break;
        } catch (caught) {
          lastFailure = caught;
          console.warn('[meeting-tts] renderer synthesis failed', {
            attempt,
            error: caught instanceof Error ? `${caught.name}:${caught.message}` : 'unknown',
          });
          if (generation !== neuralSpeechGeneration.current) return;
          if (attempt === 1) {
            setMemoryStatus('语音连接有波动，正在自动重试…');
            await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
          }
        }
      }
      if (!audio) throw lastFailure ?? new Error('MEETING_TTS_UNAVAILABLE');
      if (generation !== neuralSpeechGeneration.current) return;
      const context = activeAvatarAudioContext();
      await context.resume();
      const buffer = await context.decodeAudioData(audio.data.slice().buffer);
      if (generation !== neuralSpeechGeneration.current) return;
      setCharacterSpeaking(true);
      const ready = await characterPlayback.current?.startSpeech();
      if (generation !== neuralSpeechGeneration.current) return;
      setCharacterSpeaking(Boolean(ready));
      const playback = context.createBufferSource();
      playback.buffer = buffer;
      playback.connect(context.destination);
      neuralSource.current = playback;
      playback.onended = () => {
        if (generation !== neuralSpeechGeneration.current) return;
        neuralSource.current = null;
        finishAssistantSpeech();
        resumeListeningIfDesired();
      };
      playback.start();
      setError((current) => current === '这次语音没有播出来，文字回答仍可查看。' ? '' : current);
      setMemoryStatus('正在语音播报');
      neuralWatchdogTimer.current = window.setTimeout(() => {
        if (generation !== neuralSpeechGeneration.current) return;
        cancelNeuralSpeech();
        finishAssistantSpeech();
        resumeListeningIfDesired();
      }, Math.max(8_000, buffer.duration * 1_000 + 2_000));
    } catch (caught) {
      if (generation !== neuralSpeechGeneration.current) return;
      console.warn('[meeting-tts] playback unavailable after retry', {
        error: caught instanceof Error ? `${caught.name}:${caught.message}` : 'unknown',
      });
      finishUnavailableSpeech();
    }
  }

  function finishUnavailableSpeech(): void {
    finishAssistantSpeech();
    setError('这次语音没有播出来，文字回答仍可查看。');
    setMemoryStatus('本次已转为文字；下一次回答会自动重试语音');
    resumeListeningIfDesired();
  }
  function setSpeechPreference(enabled: boolean): void {
    setSpeechEnabled(enabled);
    if (enabled) return;
    void window.meetingAgent.meetings.interruptAvatar().catch(() => {});
    cancelNeuralSpeech();
    finishAssistantSpeech();
    resumeListeningIfDesired();
  }
  function presentActionResult(title: string, result: string): void {
    setStructuredAnswer(null);
    setPresentation({ kind: 'text', title, body: result, bullets: [] });
    setMemoryStatus(result);
    speakReply(result);
  }

  async function connectWorkspace(): Promise<void> {
    desiredListening.current = false; localAsrListening.current = false; wakeSession.reset(); pendingActionRef.current = null; setPendingAction(null); setError('');
    try {
      const grant = await window.meetingAgent.agent.pickWorkspace();
      if (!grant) return;
      const [nextCatalog, nextThread] = await Promise.all([
        window.meetingAgent.agent.listModels(), window.meetingAgent.agent.createThread(grant.workspaceGrantId, 'basic'),
      ]);
      const nextCapability = await window.meetingAgent.agent.getCodeWorkspaceCapability(nextThread.id);
      setWorkspaceLabel(grant.label); setCatalog(nextCatalog); setThread(nextThread); setCapability(nextCapability); setStatus('idle');
    } catch (caught) { setStatus('error'); setError(meetingErrorMessage(caught)); }
  }
  function resumeListeningIfDesired(): void {
    stopCharacterSpeech();
    if (!desiredListening.current) { setStatus('idle'); return; }
    setStatus(pendingActionRef.current ? 'confirming' : 'listening');
  }
  function primeAvatarAudio(): void {
    if (!speechEnabled || !(meetingCapabilities?.avatar.available || meetingCapabilities?.tts.available)) return;
    const context = activeAvatarAudioContext();
    void context.resume().catch(() => {});
  }
  async function speakWeather(questionValue: string, preserveAcknowledgement = false): Promise<void> {
    const trimmed = questionValue.trim();
    if (!trimmed || status === 'starting') return;
    primeAvatarAudio();
    if (!preserveAcknowledgement) interruptSpeech();
    setQuestion(trimmed);
    setAnswer('');
    setStructuredAnswer(null);
    setError('');
    setInterim('');
    setStatus('thinking');
    setMemoryStatus('正在查天气');
    lastAskedQuestion.current = trimmed;
    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    try {
      const weather = await window.meetingAgent.meetings.lookupWeather({ question: trimmed });
      if (activeRequestId.current !== requestId) return;
      activeRequestId.current = '';
      setAnswer(weather.spokenAnswer);
      setPresentation({
        kind: 'text',
        title: weather.title,
        body: weather.spokenAnswer,
        bullets: [...weather.bullets],
      });
      setMemoryStatus(weather.spokenAnswer);
      await appendProgramRecord('提问：' + trimmed + '\n回答：' + weather.spokenAnswer);
      speakReply(weather.spokenAnswer);
    } catch (caught) {
      if (activeRequestId.current !== requestId) return;
      activeRequestId.current = '';
      const code = caught instanceof Error ? caught.message : '';
      const spoken = code.includes('LOCATION_NEEDED') || code.includes('PLACE_UNKNOWN')
        ? '你说下城市就行，比如会议助手，上海今天天气怎么样。'
        : '天气这一会儿没查到。过几秒再说一遍会议助手，或者带上城市。';
      setAnswer(spoken);
      setPresentation({ kind: 'text', title: '天气', body: spoken, bullets: [] });
      setMemoryStatus(spoken);
      speakReply(spoken);
    }
  }

  async function askAgent(
    questionValue: string,
    contextValue?: string,
    preserveAcknowledgement = false,
  ): Promise<void> {
    if (completing.current || preparingClose.current) return;
    if (questionValue.length > 2000) { setError('问题过长，请分成几个问题；本次没有执行任何指令。'); return; }
    pauseHistoricalSummary();
    if (activeRequestId.current) setMemoryStatus('已收到新问题，正在排队回答');
    await turns.enqueue(() => answerQuestion(questionValue, contextValue, preserveAcknowledgement)).catch((caught) => {
      if (String(caught).includes('MEETING_TURN_CANCELLED')) return;
      setError(meetingErrorMessage(caught));
    });
  }

  async function answerQuestion(
    questionValue: string,
    contextValue?: string,
    preserveAcknowledgement = false,
  ): Promise<void> {
    const revision = turns.revision;
    const assertActive = () => { if (revision !== turns.revision) throw new Error('MEETING_TURN_CANCELLED'); };
    const trimmed = questionValue.trim();
    if (!trimmed || status === 'starting') return;
    if (isMeetingWeatherQuestion(trimmed)) {
      await speakWeather(trimmed, preserveAcknowledgement);
      return;
    }
    if (!thread || !catalog || !capability) {
      const message = '我听到了。会议问答服务还没连上，录音还在记。你稍后再叫我一声会议助手。';
      setStatus('error');
      setError(message);
      setMemoryStatus('语音问题未送出：会议 Agent 尚未连接');
      setPresentation({ kind: 'text', title: '需要连接会议 Agent', body: message, bullets: [] });
      speakReply(message);
      return;
    }
    primeAvatarAudio();
    if (!preserveAcknowledgement) interruptSpeech();
    setQuestion(trimmed); setAnswer(''); setStructuredAnswer(null); setError(''); setInterim(''); setStatus('thinking');
    lastAskedQuestion.current = trimmed;
    const requestId = crypto.randomUUID(); activeRequestId.current = requestId;
    try {
      const currentId = activeMeetingIdRef.current ?? presentedMeetingId;
      const referenceKind = meetingReferenceKind(trimmed);
      const explicitMemories = referencedMeetings(trimmed, meetingHistory, currentId);
      // A history lookup is only useful for vague cross-meeting references.
      // Ordinary questions and explicit dates already have their answer scope,
      // so avoid an unnecessary database round-trip before starting the Agent.
      const { thread: requestThread, capability: requestCapability } = await prepareMeetingContext(
        window.meetingAgent.agent, dialogContexts.current.context(currentId),
      );
      assertActive();
      const searchedMemories = referenceKind === 'vague'
        ? await window.meetingAgent.meetings.search({ query: trimmed.slice(0, 500), limit: 4, ...(currentId ? { excludeMeetingId: currentId } : {}) })
        : [];
      const memories = referenceKind === 'precise'
        ? explicitMemories
        : referenceKind === 'vague'
          ? [...new Map([...searchedMemories, ...explicitMemories].map((meeting) => [meeting.id, meeting])).values()].slice(0, 6)
          : searchedMemories;
      const historicalContext = memories.map((meeting, index) => {
        const evidence = meetingEvidenceText(meeting, trimmed);
        return `【历史会议 ${index + 1}｜${meetingReferenceLabel(meeting.startedAt)}｜《${meeting.title}》｜与当前会议分开】\n${evidence}`;
      }).join('\n\n').slice(-12_000);
      const currentMeeting = meetingHistory.find((meeting) => meeting.id === (activeMeetingIdRef.current ?? presentedMeetingId));
      const recordingContext = [
        '本场会议确定性信息（由桌面应用提供，无需调用工具核实）：',
        '录音保存在当前项目 .local-data/recordings 下的本场会议独立目录。',
        '可通过“播放完整录音.html”播放；只有单段归档或音频合并成功后才有独立完整音频，不能假定它已生成。',
        currentMeeting ? `当前会议：${currentMeeting.title}；已保存 ${currentMeeting.audio.length} 个 WebM/Opus 分片。` : '',
        '如果用户询问录音位置或格式，直接依据本段回答，不要声称无法确认。',
      ].filter(Boolean).join('\n');
      const referenceDirective = referenceKind
        ? memories.length
          ? `用户正在询问历史会议。候选共 ${memories.length} 场；回答时必须点明所用会议的日期和标题。`
          : '用户正在询问历史会议，但没有找到符合该时间指代的会议。必须明确说没有找到，不得改用当前会议内容回答。'
        : '用户没有明确使用跨会议时间指代；只有确实使用下方历史证据时才需要说明历史来源。';
      const combinedContext = [recordingContext, `【会议边界说明】\n${referenceDirective}`, '【当前会议｜只包含本场近期发言】\n' + (contextValue ?? wakeSession.recentContext()).slice(-6000), '【历史会议证据｜每个标题块都是一场独立会议，不得当作当前会议连续上文】\n' + (historicalContext || '（没有历史会议命中）')]
        .filter(Boolean).join('\n\n');
      const request = {
        requestId,
        threadId: requestThread.id,
        message: meetingQuestionPrompt(
          trimmed,
          combinedContext,
          undefined,
          MEETING_ASSISTANT_PROMPT,
          meetingSkillSelection.prompt,
          meetingPromptAddon,
        ),
        modelProfileId: catalog.defaultProfileId,
        thinking: { enabled: false as const },
        catalogRevision: catalog.revision,
        capabilityRevision: requestCapability.revision,
        accessMode: 'read_only' as const,
        mcpTools: meetingSkillSelection.mcpTools,
      };
      assertActive();
      let reply = await runClient.run(request);
      assertActive();
      if (isUnusableMeetingReply(reply)) {
        const retryId = crypto.randomUUID();
        activeRequestId.current = retryId;
        reply = await runClient.run({ ...request, requestId: retryId, message: meetingEmptyReplyRecoveryPrompt(trimmed, wakeSession.recentContext()) });
      }
      assertActive();
      const parsed = parseMeetingAnswer(reply, trimmed, runClient.evidenceUrls);
      await presentMeetingAnswer(enforceHistoricalAttribution(parsed, referenceKind, memories), trimmed);
      activeRequestId.current = '';
    } catch (caught) {
      activeRequestId.current = '';
      if (String(caught).includes('MEETING_TURN_CANCELLED')) return;
      const message = meetingErrorMessage(caught);
      setStatus('error');
      setError(message);
      setMemoryStatus(`问题没送出去：${message}`);
      speakReply('这个问题我这边没接住，你再说一遍会议助手就行。');
    }
  }
  function acceptTranscript(text: string, alreadyStored = false): void {
    const normalized = text.trim(); if (!normalized) return;
    if (activeMeetingIdRef.current && !alreadyStored) {
      void window.meetingAgent.meetings.appendTranscript({
        meetingId: activeMeetingIdRef.current,
        speaker: '会议发言人',
        text: normalized,
        capturedAt: new Date().toISOString(),
      }).then((record) => {
        setMeetingHistory((current) => [record, ...current.filter((item) => item.id !== record.id)]);
        setTranscript(record.transcript.slice(-12));
        setMemoryStatus('逐字稿已写入长期记忆');
      }).catch(() => setMemoryStatus('逐字稿保存失败'));
    }
    processWakeTranscript(normalized);
  }
  function processWakeTranscript(text: string, partial = false): void {
    const result = partial ? wakeSession.ingestPartial(text) : wakeSession.ingest(text);
    processWakeResult(result);
  }
  function processWakeResult(result: ReturnType<WakeSession['ingest']>): void {
    if (completing.current) return;
    if (result.kind !== 'question') {
      if (result.kind === 'armed' && !activeRequestId.current) setStatus('armed');
      else if (!activeRequestId.current && !assistantSpeaking.current) setStatus('listening');
      return;
    }
    if (assistantSpeaking.current) interruptSpeech();
    if (result.question.length > 2000) { setError('问题过长，请分成几个问题；本次没有执行任何指令。'); return; }
    primeAvatarAudio();
    void window.meetingAgent.meetings.warmAnswer().catch(() => {});
    if (activeRequestId.current) { void askAgent(result.question, result.recentContext); return; }
    if (result.kind === 'question' && pendingActionRef.current) {
      const decision = voiceActionDecision(result.question);
      if (decision === 'confirm') void executePendingAction();
      else if (decision === 'cancel') cancelPendingAction();
      else {
        setStatus('confirming');
        setMemoryStatus('已有待确认行动；请说“会议助手，确认执行”或“会议助手，取消”');
      }
    }
    else if (result.kind === 'question') {
      lastAskedQuestion.current = result.question;
      console.info('[meeting-wake] question', result.question.slice(0, 80));
      if (isMeetingWeatherQuestion(result.question)) {
        speakReply('好的，我马上看一下。');
        void askAgent(result.question, result.recentContext, true);
        return;
      }
      const localAction = enabledSkillIds.includes('actions')
        ? localMeetingActionIntent(result.question)
        : null;
      if (localAction && !localActionAvailable(localAction)) {
        presentActionResult("服务未接入", "此操作不可用，仅支持本地会议动作。");
        return;
      }
      if (localAction) {
        pendingActionRef.current = localAction;
        setPendingAction(localAction);
        setStatus('confirming');
        const proposal = `我想帮你${proposedActionLabel(localAction)}。你说确认，或者取消，就行。`;
        setMemoryStatus(proposal);
        setPresentation({ kind: 'text', title: '等待行动确认', body: proposal, bullets: [] });
        void appendProgramRecord(`行动提案：${proposedActionLabel(localAction)}（等待用户确认）`).catch(() => {});
        speakReply(proposal);
      } else {
        const spoken = localMeetingSpokenReply(result.question, {
          liveFactsAvailable: false,
        });
        if (spoken) {
          const intro = isMeetingSelfIntroduction(result.question) ? MEETING_SELF_INTRODUCTION : null;
          setStatus('speaking');
          setAnswer(spoken);
          setMemoryStatus(spoken);
          setPresentation({
            kind: 'text',
            title: intro?.title ?? '会议助手',
            body: spoken,
            bullets: intro?.bullets ?? [],
          });
          void appendProgramRecord('提问：' + result.question + '\n回答：' + spoken).catch(() => {});
          speakReply(spoken);
        } else {
          // Give an immediate acknowledgement while the Agent and any enabled
          // read-only tools are working. This is intentionally not persisted as
          // the answer; the final model response replaces it when ready.
          speakReply('好的，我马上看一下。');
          void askAgent(result.question, result.recentContext, true);
        }
      }
    }
  }
  function cancelPendingAction(): void {
    pendingActionRef.current = null;
    setPendingAction(null);
    setMemoryStatus('已取消待执行行动');
    speakReply('好，已经取消啦，这件事我不会做。');
  }
  async function appendProgramRecord(text: string): Promise<void> {
    const meetingId = activeMeetingIdRef.current;
    if (!meetingId) return;
    const write = window.meetingAgent.meetings.appendTranscript({
      meetingId,
      speaker: '会议助手助理（程序记录）',
      text,
      capturedAt: new Date().toISOString(),
    }).then((record) => {
      setMeetingHistory((current) => [record, ...current.filter((item) => item.id !== record.id)]);
      setTranscript(record.transcript.slice(-12));
    });
    programWrites.current.add(write);
    try { await write; }
    catch (caught) { setError('助理程序记录保存失败：' + meetingErrorMessage(caught)); throw caught; }
    finally { programWrites.current.delete(write); }
  }
  async function executePendingAction(): Promise<void> {
    const action = pendingActionRef.current;
    if (!action) return;
    if (!localActionAvailable(action)) {
      cancelPendingAction();
      setError("当前验证项目未接入此服务，此操作不可用。");
      return;
    }
    void window.meetingAgent.meetings.interruptAvatar().catch(() => {});
    cancelNeuralSpeech();
    finishAssistantSpeech();
    pendingActionRef.current = null;
    setPendingAction(null);
    setStatus('thinking');
    setError('');
    setMemoryStatus(`正在执行：${proposedActionLabel(action)}`);
    try {
      if (action.kind === 'end_meeting') {
        if (!activeMeetingIdRef.current) throw new Error('当前没有正在进行的会议');
        await appendProgramRecord('用户已口头确认结束并归档会议。');
        await completeMeeting();
        return;
      }
      const meetingId = presentedMeetingId
        ?? activeMeetingIdRef.current
        ?? meetingHistory.find((meeting) => meeting.status === 'completed' && meeting.audio.length > 0)?.id
        ?? meetingHistory.find((meeting) => meeting.status === 'completed')?.id;
      if (!meetingId) throw new Error('当前没有可操作的会议');
      if (action.kind === 'open_audio_folder') {
        await window.meetingAgent.meetings.openAudioFolder(meetingId);
        presentActionResult('录音文件夹', '已经打开本次会议的录音文件夹。');
        return;
      }
      if (action.kind === 'play_audio') {
        await window.meetingAgent.meetings.playAudio(meetingId);
        presentActionResult('完整录音', '已经打开完整录音播放器。');
        return;
      }
    } catch (caught) {
      const message = meetingErrorMessage(caught);
      setError(message);
      setMemoryStatus(`行动执行失败：${message}`);
      speakReply(`这项操作没有执行成功：${message}`);
    }
  }
  async function startListening(): Promise<void> {
    if (preparingClose.current || busy || startingListening.current) return;
    if (audioRecorder.isRecording() && desiredListening.current) {
      desiredListening.current = true;
      setRecordingActive(true);
      setError('');
      setStatus('listening');
      setMemoryStatus('会议记录已经在进行中');
      return;
    }
    if (!microphoneEnabled) {
      setStatus('error');
      setError('开始记录需要打开麦克风。会议助手的回答会写入文字稿，不从扬声器回录。');
      return;
    }
    startingListening.current = true;
    let finishStartup!: () => void;
    recordingStartup.current = new Promise<void>((resolve) => { finishStartup = resolve; });
    pauseHistoricalSummary();
    setError('');
    setStatus('starting');
    setMemoryStatus('正在启动麦克风与录音存档');
    try {
      const nextCapabilities = await window.meetingAgent.meetings.getCapabilities()
        .catch((error: unknown): MeetingCapabilities => {
          console.error('[meeting-tts] capabilities', error instanceof Error ? error.message : error);
          return FALLBACK_MEETING_CAPABILITIES;
        });
      setMeetingCapabilities(nextCapabilities);
      void window.meetingAgent.meetings.warmAnswer().catch(() => {});
      if (nextCapabilities.avatar.available || nextCapabilities.tts.available) {
        await activeAvatarAudioContext().resume().catch(() => {});
      }
      if (!MeetingAudioRecorder.available()) throw new Error('MEETING_AUDIO_UNAVAILABLE');
      const shouldUseLocalAsr = nextCapabilities.localAsr;
      setTranscriptionMode(shouldUseLocalAsr ? 'local' : 'none');
      if (!shouldUseLocalAsr) setError(meetingErrorMessage(new Error('MEETING_ASR_UNAVAILABLE')));
      localAsrListening.current = shouldUseLocalAsr;
      // Re-read local records before recording to avoid reusing a completed meeting.
      const currentMeetings = await window.meetingAgent.meetings.list(50);
      const preferredMeetingId = activeMeetingIdRef.current ?? activeMeetingId;
      const recording = (
        preferredMeetingId
          ? currentMeetings.find((meeting) => (
              meeting.id === preferredMeetingId && meeting.status === 'recording'
            ))
          : undefined
      ) ?? currentMeetings.find((meeting) => meeting.status === 'recording');
      let meetingId = recording?.id ?? null;
      if (!meetingId) {
        const record = await window.meetingAgent.meetings.create({
          title: `会议 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        });
        meetingId = record.id;
        setElapsed(0);
        setActiveMeetingId(record.id);
        activeMeetingIdRef.current = record.id;
        setMeetingHistory([record, ...currentMeetings]);
        setTranscript([]);
        lastAsrTranscriptSequence.current = 0;
      } else {
        setActiveMeetingId(meetingId);
        activeMeetingIdRef.current = meetingId;
        setMeetingHistory(currentMeetings);
        setTranscript(recording?.transcript.slice(-12) ?? []);
        lastAsrTranscriptSequence.current = recording?.transcript.at(-1)?.sequence ?? 0;
      }
      desiredListening.current = true;
      if (MeetingAudioRecorder.available()) {
        await audioRecorder.start({
          microphone: microphoneEnabled,
          onCaptureStopped: () => {
            setRecordingActive(false);
            desiredListening.current = false;
            localAsrListening.current = false;
            wakeSession.reset();
            setStatus('error');
          },
          onLevel: setAudioLevel,
          onSpectrum: setAudioSpectrum,
          onDirection: setSpeakerDirection,
          onDirectionMode: setDirectionMode,
          shouldSkipTranscription: () => assistantSpeaking.current,
          onError: (message) => {
            wakeSession.reset();
            if (message.includes('MEETING_ASR_UNAVAILABLE') || message.includes('MEETING_ASR_TRANSCRIPTION_FAILED')) {
              localAsrListening.current = false;
              setTranscriptionMode('none');
            }
            setError(`录音/转写处理提示：${meetingErrorMessage(new Error(message))}`);
            setMemoryStatus('录音或转写处理异常，请查看提示');
          },
          onArchiveChunk: async (data, archive) => {
            await window.meetingAgent.meetings.appendArchiveAudio({
              meetingId: meetingId!,
              ...archive,
              data,
            });
          },
          onPcmFrame: nextCapabilities.voiceActivation ? async (data, sampleRate) => {
            const speakingAtCapture = assistantSpeaking.current;
            const activation = await window.meetingAgent.meetings.analyzeVoice({ data, sampleRate });
            // A keyword spotter also hears the assistant say its own name over
            // the speakers. Keep recording, but never treat that as a new turn.
            const wakeAllowed = meetingWakeKeywordAllowed(
              speakingAtCapture,
              assistantSpeaking.current,
              lastAssistantSpeechAt.current,
              performance.now(),
            );
            if (activation.keyword && desiredListening.current && wakeAllowed) {
              if (localWakeAgentActive()) {
                processWakeTranscript('会议助手', true);
                setMemoryStatus('已听到唤醒词“会议助手”，请继续说');
              }
            } else if (activation.keyword && !wakeAllowed) {
              console.info('[meeting-wake] ignored keyword during assistant playback');
            }
            return activation;
          } : undefined,
          onChunk: async (data, mimeType, utteranceEnd, capture) => {
            const updated = await window.meetingAgent.meetings.appendAudio({
              meetingId: meetingId!,
              mimeType,
              data: new Uint8Array(data),
              capturedAt: capture.capturedAt,
              ...(capture.pcm ? { pcm: capture.pcm } : {}),
              skipTranscription: capture.skipTranscription || !localAsrListening.current,
            });
            setMeetingHistory((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
            if (shouldUseLocalAsr) {
              const newChunks = updated.transcript.filter((chunk) => chunk.sequence > lastAsrTranscriptSequence.current);
              lastAsrTranscriptSequence.current = updated.transcript.at(-1)?.sequence ?? lastAsrTranscriptSequence.current;
              setTranscript(updated.transcript.slice(-12));
              if (desiredListening.current && !assistantSpeaking.current) {
                newChunks.filter((chunk) => isParticipantTranscript(chunk.speaker)).forEach((chunk) => {
                  const complete = transcriptCompletesWakeQuestion(chunk.text);
                  processWakeTranscript(chunk.text, !complete);
                  if (complete) {
                    if (wakeFlushTimer.current !== null) {
                      window.clearTimeout(wakeFlushTimer.current);
                      wakeFlushTimer.current = null;
                    }
                    return;
                  }
                  if (!wakeSession.hasPendingQuestion()) return;
                  if (wakeFlushTimer.current !== null) window.clearTimeout(wakeFlushTimer.current);
                  wakeFlushTimer.current = window.setTimeout(() => {
                    wakeFlushTimer.current = null;
                    if (desiredListening.current && !assistantSpeaking.current) {
                      processWakeResult(wakeSession.endUtterance());
                    }
                  }, 1_800);
                });
                if (utteranceEnd || (capture.skipTranscription && wakeSession.hasPendingQuestion())) {
                  if (wakeFlushTimer.current !== null) {
                    window.clearTimeout(wakeFlushTimer.current);
                    wakeFlushTimer.current = null;
                  }
                  processWakeResult(wakeSession.endUtterance());
                }
              }
            }
            setMemoryStatus(localAsrListening.current
              ? `本地 ASR 已接收 · 录音 ${updated.audio.length} 个分片`
              : `录音已保存 ${updated.audio.length} 个分片`);
          },
        });
      }
      setRecordingActive(audioRecorder.isRecording());
      setStatus('listening');
      setMemoryStatus(shouldUseLocalAsr
          ? '会议记录与本地转写已开始'
          : '本地 ASR 失败，录音仍在保存；可以在下方输入问题');
    }
    catch (caught) {
      localAsrListening.current = false;
      if (!audioRecorder.isRecording()) await audioRecorder.stop();
      setRecordingActive(audioRecorder.isRecording());
      setAudioLevel(0);
      setAudioSpectrum(EMPTY_AUDIO_SPECTRUM);
      setStatus('error');
      setError(meetingErrorMessage(caught));
    } finally {
      startingListening.current = false;
      finishStartup();
      recordingStartup.current = null;
    }
  }
  function hangupAvatar(): void {
    void window.meetingAgent.meetings.releaseAvatar().then(setAvatarSession).catch(() => {});
  }
  function stopListening(): void {
    setRecordingActive(false);
    if (wakeFlushTimer.current !== null) { window.clearTimeout(wakeFlushTimer.current); wakeFlushTimer.current = null; }
    turns.clear();
    void runClient.cancel().catch((caught) => setError(meetingErrorMessage(caught)));
    activeRequestId.current = '';
    desiredListening.current = false;
    localAsrListening.current = false;
    finishAssistantSpeech();
    pendingActionRef.current = null;
    setPendingAction(null);
    wakeSession.reset();
    if (localWakeAgentActive()) hangupAvatar();
    cancelNeuralSpeech();
    void audioRecorder.stop();
    setAudioLevel(0);
    setAudioSpectrum(EMPTY_AUDIO_SPECTRUM);
    setInterim('');
    setSpeakerDirection('center');
    setDirectionMode('unknown');
    setStatus(thread ? 'idle' : 'setup');
  }
  function enterStage(): void {
    setStageOpen(true);
  }
  function exitStage(): void {
    setStageOpen(false);
  }
  async function readStoredMeetingTranscript(meetingId: string): Promise<string[]> {
    const storedTranscript: string[] = [];
    let afterSequence = 0;
    for (;;) {
      const page = await window.meetingAgent.meetings.readTranscript(meetingId, afterSequence);
      if (!page.transcript.length) break;
      storedTranscript.push(...page.transcript.map((chunk) => chunk.speaker + '：' + chunk.text));
      afterSequence = page.transcript.at(-1)!.sequence;
    }
    return storedTranscript.length ? storedTranscript : ['本次会议暂无可保存的逐字稿。'];
  }
  async function generateAgentMeetingSummary(
    source: readonly string[],
    assertActive: () => void,
    progress: (message: string) => void,
    client: MeetingRunClient = runClient,
  ): Promise<MeetingSummary> {
    if (!thread || !catalog) throw new Error('MEETING_AGENT_UNAVAILABLE');
    let chunks = meetingSummaryChunks(prepareMeetingSummaryLines(source));
    while (chunks.length > 1) {
      const partials: string[] = [];
      for (const [index, chunk] of chunks.entries()) {
        assertActive();
        progress('正在整理会议分段 ' + (index + 1) + '/' + chunks.length);
        const reply = await runMeetingSummaryTurn(window.meetingAgent.agent, client, catalog,
          meetingSummaryPrompt(chunk), assertActive);
        assertActive();
        if (!hasStructuredMeetingSummary(reply)) throw new Error('MEETING_SUMMARY_FORMAT_INVALID');
        const part = parseMeetingSummary(reply, chunk);
        partials.push(JSON.stringify(part));
      }
      const next = meetingSummaryChunks(partials);
      if (next.length >= chunks.length) throw new Error('MEETING_SUMMARY_NOT_COMPRESSING');
      chunks = next;
    }
    assertActive();
    progress('正在生成结构化会议纪要');
    const reply = await runMeetingSummaryTurn(window.meetingAgent.agent, client, catalog,
      meetingSummaryPrompt(chunks[0]!), assertActive);
    assertActive();
    if (!hasStructuredMeetingSummary(reply)) throw new Error('MEETING_SUMMARY_FORMAT_INVALID');
    return parseMeetingSummary(reply, source);
  }
  async function completeMeeting(): Promise<void> {
    if (completing.current) return;
    completing.current = true;
    desiredListening.current = false;
    setRecordingActive(false);
    wakeSession.reset();
    await audioRecorder.stop();
    await turns.enqueue(() => completeMeetingAfterTurns()).catch((caught) => {
      setStatus('error'); setError(meetingErrorMessage(caught));
    }).finally(() => { completing.current = false; });
  }
  async function completeMeetingAfterTurns(): Promise<void> {
    const revision = turns.revision;
    const assertActive = () => { if (revision !== turns.revision) throw new Error('MEETING_TURN_CANCELLED'); };
    const meetingId = activeMeetingIdRef.current;
    if (!meetingId) return;
    desiredListening.current = false;
    localAsrListening.current = false;
    await audioRecorder.stop();
    await Promise.all([...programWrites.current]);
    setAudioLevel(0);
    setAudioSpectrum(EMPTY_AUDIO_SPECTRUM);
    const storedTranscript = await readStoredMeetingTranscript(meetingId);
    const source = storedTranscript[0] === '本次会议暂无可保存的逐字稿。' && transcript.length
      ? transcript.map((chunk) => `${chunk.speaker}：${chunk.text}`)
      : storedTranscript;
    setError('');
    if (!thread || !catalog || !capability) {
      const fallback = parseMeetingSummary('', source);
      await persistCompletedMeeting(meetingId, fallback.title, fallback.summary, fallback.actionItems);
      return;
    }
    setStatus('thinking');
    setMemoryStatus('正在由 Agent 生成结构化会议纪要');
    try {
      const summary = await generateAgentMeetingSummary(source, assertActive, (message) => setMemoryStatus(message));
      assertActive();
      await persistCompletedMeeting(meetingId, summary.title, summary.summary, summary.actionItems);
      activeRequestId.current = '';
    } catch (caught) {
      activeRequestId.current = '';
      if (String(caught).includes('MEETING_TURN_CANCELLED')) return;
      const fallback = parseMeetingSummary('', source);
      setError(`Agent 纪要生成失败，已使用逐字稿归档：${meetingErrorMessage(caught)}`);
      await persistCompletedMeeting(meetingId, fallback.title, fallback.summary, fallback.actionItems);
    }
  }
  async function persistCompletedMeeting(meetingId: string, title: string, summary: string, actionItems: string[]): Promise<void> {
    try {
      void window.meetingAgent.meetings.releaseAvatar().then(setAvatarSession).catch(() => {});
      const completed = await window.meetingAgent.meetings.complete({ meetingId, title, summary, actionItems });
      setMeetingHistory((current) => [completed, ...current.filter((item) => item.id !== completed.id)]);
      setActiveMeetingId(null);
      activeMeetingIdRef.current = null;
      setStatus('idle');
      setMemoryStatus('会议与纪要已保存到本地');
      setPresentation({ kind: 'text', title: `${completed.title} · 会议纪要`, body: completed.summary, bullets: completed.actionItems });
      setPresentedMeetingId(completed.id);
    } catch (caught) { setStatus('error'); setError(meetingErrorMessage(caught)); }
  }


  async function openAudioFolder(): Promise<void> {
    const meetingId = activeMeetingId ?? presentedMeetingId;
    if (!meetingId) return;
    try {
      await window.meetingAgent.meetings.openAudioFolder(meetingId);
      setMemoryStatus('已打开本次会议的录音文件夹');
    } catch {
      setMemoryStatus('本次会议暂时还没有录音文件');
    }
  }
  async function playAudio(): Promise<void> {
    const meetingId = presentedMeetingId ?? activeMeetingId;
    if (!meetingId) return;
    try { await window.meetingAgent.meetings.playAudio(meetingId); }
    catch (caught) { setError(meetingErrorMessage(caught)); }
  }
  async function exportMarkdown(): Promise<void> {
    if (!presentedMeetingId) return;
    try {
      const result = await window.meetingHost.exportMarkdown(presentedMeetingId);
      setMemoryStatus(result.exported ? '纪要已导出' : '已取消纪要导出');
    } catch (caught) { setError(meetingErrorMessage(caught)); }
  }
  async function exportAudio(): Promise<void> {
    const meetingId = activeMeetingId ?? presentedMeetingId;
    if (!meetingId) return;
    setMemoryStatus('请选择录音导出位置');
    try {
      const exported = await window.meetingAgent.meetings.exportAudio(meetingId);
      setMemoryStatus(exported ? `已导出 ${exported.fileCount} 个录音分片` : '已取消录音导出');
    } catch (caught) {
      setMemoryStatus('录音导出失败');
      setError(meetingErrorMessage(caught));
    }
  }

  const presentedMeeting = meetingHistory.find((meeting) => meeting.id === presentedMeetingId);
  const knowledgeAlreadySubmitted = presentedMeeting?.knowledgeStatus === 'reviewing' || presentedMeeting?.knowledgeStatus === 'approved';
  const knowledgeSummaryPending = presentedMeeting?.summaryStatus === 'pending';
  const filteredHistory = meetingHistory.filter((meeting) => meetingHistoryMatches(meeting, historyQuery, historyFilter));
  const historySelection = filteredHistory.find((meeting) => meeting.id === historySelectionId)
    ?? filteredHistory[0]
    ?? null;
  const historyFilterOptions = [
    ['all', '全部', meetingHistory.length],
    ['actionable', '有待办', meetingHistory.filter((meeting) => meeting.actionItems.length > 0).length],
    ['recording', '进行中', meetingHistory.filter((meeting) => meeting.status === 'recording').length],
    ['audio', '有录音', meetingHistory.filter((meeting) => meeting.audio.length > 0).length],
  ] as const;
  const historyTotalActions = meetingHistory.reduce((total, meeting) => total + meeting.actionItems.length, 0);

  if (!stageOpen) return (
    <section className="meeting-launcher">
      <span aria-hidden="true">◉</span><h1>会议助手已收起</h1>
      <p role="status">{recordingActive ? '会议正在后台记录。切换页面或退出全屏不会停止记录。' : '当前未在录音。进入全屏会议后可开始或继续记录。'}</p>
      <button ref={launcherRef} type="button" onClick={enterStage}>进入全屏会议</button>
      {recordingActive ? <button type="button" onClick={stopListening}>暂停记录</button> : null}
      {activeMeetingId ? <button type="button" disabled={busy} onClick={() => void completeMeeting()}>结束会议</button> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );

  return (
    <section
      ref={stageRef}
      tabIndex={-1}
      className={`meeting-stage ${videoCharacterEnabled ? '' : 'is-video-off'} ${avatarSession?.videoAttached ? 'is-digital-human' : ''} ${chromeOpen || historyOpen ? '' : 'is-chrome-collapsed'} ${status === 'thinking' ? 'is-thinking' : ''}`}
      aria-label="全屏会议助手"
      onPointerMove={(event) => {
        if (event.pointerType === 'touch') return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const overControls = (event.target as Element).closest('.meeting-stage__topbar, .meeting-live-panel, .meeting-dock, .meeting-digital-human-switch, .meeting-history-library');
        const nearEdge = event.clientY <= bounds.top + 64 || event.clientY >= bounds.bottom - 150;
        const hovering = Boolean(overControls) || nearEdge;
        if (hovering !== chromeHovering.current) {
          chromeHovering.current = hovering;
          syncChromePin();
        }
      }}
      onPointerLeave={() => { chromeHovering.current = false; syncChromePin(); }}
      onPointerDown={(event) => { if (event.pointerType === 'touch') revealChrome(); }}
      onFocusCapture={(event) => { if (event.target !== event.currentTarget) revealChrome(); }}
      onBlurCapture={scheduleChromeHide}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (historyOpen) { closeHistory(); return; }
          void exitStage();
        }
      }}
    >
      {videoCharacterEnabled ? <MeetingCharacter playbackRef={characterPlayback} active={active} speaking={characterSpeaking} direction={status === 'listening' || status === 'armed' || status === 'confirming' ? speakerDirection : 'center'} /> : null}
      {status === 'thinking' ? <div className="meeting-thinking-cue" role="status" aria-live="polite"><strong>会议助手正在准备回答</strong><span aria-hidden="true"><i /><i /><i /></span></div> : null}
      <header className="meeting-stage__topbar">
        <h1>会议助手</h1>
        <div className={`meeting-recording is-${status}`} role="status"><i aria-hidden="true" /><span>{statusLabel(status)} · 参会者同意后可开始录制</span></div>
        <div className="meeting-stage__actions"><button ref={historyButtonRef} type="button" aria-expanded={historyOpen} title={summaryJobId ? memoryStatus : undefined} onClick={openHistory}>{summaryJobId ? '历史会议 · 整理中' : '历史会议'}</button><time>{formatDuration(elapsed)}</time><button type="button" onClick={() => void exitStage()}>退出全屏</button></div>
      </header>
      {historyOpen ? <section ref={historyDialogRef} className="meeting-history-library" role="dialog" aria-modal="true" aria-labelledby="meeting-history-title" onKeyDown={trapHistoryFocus}>
        <header>
          <div className="meeting-history-library__heading">
            <span className="meeting-history-library__eyebrow"><i aria-hidden="true" />会议记忆</span>
            <h2 id="meeting-history-title">历史会议库</h2>
            <p>把讨论、决定和待办整理在一起，需要时快速找回。</p>
          </div>
          <div className="meeting-history-library__stats" aria-label="会议历史概览">
            <div><strong>{meetingHistory.length}</strong><span>场会议</span></div>
            <div><strong>{historyTotalActions}</strong><span>项待办</span></div>
            <div><strong>{meetingHistory.filter((meeting) => meeting.audio.length > 0).length}</strong><span>有录音</span></div>
          </div>
          <button className="meeting-history-library__close" type="button" aria-label="关闭历史会议库" onClick={closeHistory}>关闭</button>
        </header>
        <div className="meeting-history-library__toolbar">
          <label className="meeting-history-library__search"><span aria-hidden="true">⌕</span><input autoFocus aria-label="搜索历史会议" value={historyQuery} onChange={(event) => setHistoryQuery(event.currentTarget.value)} placeholder="搜索标题、结论、待办、发言人……" /><em>{filteredHistory.length} 场结果</em></label>
          <div className="meeting-history-library__filters" role="group" aria-label="筛选历史会议">{historyFilterOptions.map(([value, label, count]) => <button key={value} type="button" aria-label={label} aria-pressed={historyFilter === value} onClick={() => setHistoryFilter(value)}><span>{label}</span><b>{count}</b></button>)}</div>
        </div>
        <div className="meeting-history-library__body">
          <div className="meeting-history-library__list">
            <div className="meeting-history-library__list-heading"><strong>会议列表</strong><span>{historyQuery || historyFilter !== 'all' ? '筛选结果' : '按最近活动排序'}</span></div>
            <nav aria-label="历史会议列表">{filteredHistory.length ? filteredHistory.map((meeting) => {
              const selected = historySelection?.id === meeting.id;
              const status = meeting.status === 'recording' ? '进行中' : meeting.summaryStatus === 'pending' ? '待整理' : '已结束';
              return <button key={meeting.id} type="button" aria-current={selected ? 'true' : undefined} onClick={() => setHistorySelectionId(meeting.id)}>
                <div className="meeting-history-library__card-meta"><time>{new Date(meeting.startedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time><span className={`is-${meeting.status}`}><i aria-hidden="true" />{status}</span></div>
                <strong>{meeting.title}</strong>
                <span>{meeting.summary || meeting.transcript.at(-1)?.text || '会议尚未生成摘要'}</span>
                <small>{meetingHistoryMeta(meeting).map((item) => <b key={item}>{item}</b>)}</small>
              </button>;
            }) : <div className="meeting-history-library__empty"><strong>没有找到会议</strong><span>换个关键词或筛选条件试试。</span></div>}</nav>
          </div>
          <article>{historySelection ? <>
            <header className="meeting-history-library__detail-header"><div><div className="meeting-history-library__detail-kicker"><span>会议详情</span><time>{new Date(historySelection.startedAt).toLocaleString('zh-CN')}</time></div><h3>{historySelection.title}</h3></div><span className={`meeting-history-library__status is-${historySelection.status}`}><i aria-hidden="true" />{historySelection.status === 'recording' ? '进行中' : historySelection.summaryStatus === 'pending' ? '待整理' : '已结束'}</span></header>
            <div className="meeting-history-library__detail-stats"><div><span>会议时长</span><strong>{meetingDurationLabel(historySelection) || '—'}</strong></div><div><span>行动项</span><strong>{historySelection.actionItems.length} 项</strong></div><div><span>录音</span><strong>{historySelection.audio.length ? '已保存' : '暂无录音'}</strong></div></div>
            <section><h4><i aria-hidden="true">✦</i>会议摘要</h4><p>{historySelection.summary || '这场会议还没有生成摘要。'}</p>{summaryJobId === historySelection.id ? <p role="status">正在重新总结完整会议内容…</p> : null}{error ? <p role="alert">{meetingErrorMessage(new Error(error))}</p> : null}</section>
            <section><h4><i aria-hidden="true">✓</i>行动项 <span>{historySelection.actionItems.length}</span></h4>{historySelection.actionItems.length ? <ol>{historySelection.actionItems.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol> : <p className="is-muted">没有识别到明确待办。</p>}</section>
            <section><h4><i aria-hidden="true">☷</i>最近记录 <span className="meeting-history-library__section-note">显示最近 8 条</span></h4>{historySelection.transcript.length ? <div className="meeting-history-library__transcript">{historySelection.transcript.slice(-8).map((item) => <p key={item.sequence}><time dateTime={item.capturedAt}>{new Date(item.capturedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time><strong>{item.speaker}</strong><span>{item.text}</span></p>)}</div> : <p className="is-muted">没有可用逐字稿。</p>}</section>
            <footer><button className="is-primary" type="button" onClick={() => { setPresentedMeetingId(historySelection.id); setPresentation({ kind: 'text', title: historySelection.title, body: historySelection.summary || historySelection.transcript.at(-1)?.text || '会议记录中', bullets: historySelection.actionItems }); closeHistory(); }}>在会议舞台中查看</button><button type="button" disabled={historySelection.status !== 'completed' || !historySelection.transcript.length || Boolean(activeMeetingId) || Boolean(summaryJobId) || busy || !thread || !catalog} onClick={() => void regenerateHistoricalMeeting(historySelection)}>{summaryJobId === historySelection.id ? '正在重新总结' : '重新总结'}</button><button type="button" disabled={!historySelection.audio.length} onClick={() => void window.meetingAgent.meetings.playAudio(historySelection.id)}>播放录音</button></footer>
          </> : <div className="meeting-history-library__empty"><strong>还没有历史会议</strong><span>结束第一场会议后，摘要、待办和录音会出现在这里。</span></div>}</article>
        </div>
      </section> : null}
      <section className="meeting-live-panel meeting-live-panel--sidebar" aria-label="当前发言与麦克风频率" aria-live="polite">
        <header className="meeting-live-panel__header">
          <div>
            <span className="meeting-live-panel__eyebrow"><i aria-hidden="true" />实时转译</span>
            <strong>{statusLabel(status)}</strong>
          </div>
          <span className="meeting-live-panel__hint">{interim ? '正在识别当前发言' : '等待新的语音片段'}</span>
        </header>
        <div className="meeting-live-panel__transcript">
          <span>当前发言</span>
          <div className="meeting-live-panel__lines">{hasLiveTranscript ? <>
            {visibleTranscript.map((chunk) => <p key={chunk.sequence}><time dateTime={chunk.capturedAt}>{new Date(chunk.capturedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time><strong>{chunk.speaker}</strong><span>{chunk.text}</span></p>)}
            {interim ? <p className="is-interim"><time>识别中</time><span>{interim}</span></p> : null}
          </> : <p className="is-placeholder">开始记录后，实时转译会出现在这里</p>}</div>
        </div>
        <details className="meeting-live-panel__meter">
          <summary className="meeting-live-panel__meter-label"><span>麦克风频谱</span><strong>电平 {Math.round(audioLevel * 100)}%</strong></summary>
          <div className="meeting-live-panel__spectrum" aria-label="麦克风实时频谱">
            {audioSpectrum.map((value, index) => <i key={index} aria-hidden="true" style={{ transform: `scaleY(${Math.max(.06, value)})` }} />)}
          </div>
          <div className="meeting-audio-level" aria-label={`麦克风电平 ${Math.round(audioLevel * 100)}%`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(audioLevel * 100)}><span style={{ width: `${Math.max(2, audioLevel * 100)}%` }} /></div>
        </details>
      </section>
      <section className="meeting-dock">
        <div className="meeting-dock__main">
          <div className="meeting-dock__status">
            <strong>{statusLabel(status)}</strong>
            <span title="录音保存在.local-data/recordings/本场会议目录">{selectedDigitalHuman.displayName} · 唤醒词：会议助手 · {transcriptionMode === 'local' ? '本地转写' : transcriptionMode === 'none' ? '本地 ASR 未就绪' : '转写检测中'} · {meetingCapabilities?.tts.available ? '语音可用' : '语音未配置'}</span>
          </div>
          <div className="meeting-dock__actions">
            {!recordingActive ? <button className="meeting-dock__primary" type="button" disabled={busy} onClick={() => void startListening()}>开始记录</button> : null}
            {recordingActive ? <button className="meeting-dock__primary" type="button" onClick={stopListening}>暂停记录</button> : null}
            {status === 'speaking' ? <button className="meeting-dock__ghost" type="button" onClick={() => { interruptSpeech(); resumeListeningIfDesired(); }}>停止播报</button> : null}
            <button className="meeting-dock__ghost" type="button" disabled={busy || presentation.kind !== "text" || !presentation.body} onClick={() => { if (presentation.kind === "text") speakReply(presentation.body); }}>重播回答</button>
          </div>
        </div>
        <details className="meeting-settings" onToggle={(event) => {
          settingsOpen.current = event.currentTarget.open;
          syncChromePin();
        }}>
          <summary>会议设置与技能</summary>
          <div className="meeting-settings__scope">
            <label className="meeting-dock__toggle"><input type="checkbox" checked={microphoneEnabled} disabled={recordingActive || busy} onChange={(event) => setMicrophoneEnabled(event.currentTarget.checked)} />麦克风</label>
            <label className="meeting-dock__toggle"><input type="checkbox" checked={videoCharacterEnabled} onChange={(event) => {
              const enabled = event.currentTarget.checked;
              setVideoCharacterEnabled(enabled);
              if (!enabled) void window.meetingAgent.meetings.releaseAvatar().then(setAvatarSession).catch(() => {});
            }} />状态视觉</label>
            <span role="status">{meetingCapabilities?.tts.available ? "语音播报已配置" : "语音未配置，回答以文字显示"}</span>
            <span>录音保存到：.local-data/recordings/本场会议目录</span>
            <span>云文档集成可后续选配；当前使用本地导出。</span>
            {presentedMeetingId ? <button type="button" onClick={() => void exportMarkdown()}>导出 Markdown 纪要</button> : null}
            <button type="button" disabled={agentConnecting || busy} title="重置模型对话历史，保留录音和逐字稿" onClick={() => void connectMeetingAgent(true)}>{agentConnecting ? '正在连接会议 Agent…' : '重新连接会议 Agent'}</button>
            <span>重新连接会重置模型对话历史；录音和逐字稿会保留。</span>
            {activeMeetingId ? <button className="is-danger" type="button" onClick={() => void completeMeeting()}>结束会议</button> : null}
            {activeMeetingId || presentedMeetingId ? <button type="button" onClick={() => void openAudioFolder()}>打开本场录音目录</button> : null}
            {activeMeetingId || presentedMeetingId ? <button type="button" onClick={() => void playAudio()}>播放完整录音</button> : null}
            {activeMeetingId || presentedMeetingId ? <button type="button" onClick={() => void exportAudio()}>导出录音</button> : null}
          </div>
          <div className="meeting-skillbar">
            <p className="meeting-direction-status">{meetingDirectionStatus(directionMode)}</p>
            <div className="meeting-skillbar__choices" aria-label="会议助手技能">
              <strong>会议技能</strong>
              {MEETING_SKILLS.map((skill) => {
                const unavailable = !meetingSkillAvailable(skill.id);
                return <label key={skill.id} title={unavailable ? "当前验证项目尚未接入此服务" : skill.description}>
                  <input type="checkbox" checked={enabledSkillIds.includes(skill.id)} disabled={unavailable} onChange={(event) => toggleMeetingSkill(skill.id, event.currentTarget.checked)} />
                  {skill.label}{unavailable ? "（未接入）" : ""}
                </label>;
              })}
            </div>
            <input aria-label="本场会议专有提示词" maxLength={1_000} value={meetingPromptAddon} onChange={(event) => setMeetingPromptAddon(event.currentTarget.value)} placeholder="本场会议专有提示词（可选）" />
          </div>
        </details>
          {presentation !== SUMMARY_PRESENTATION && presentation.kind === 'text' ? (
            <section className="meeting-answer-card" aria-live="polite" aria-label="会议助手最新回答">
              <header>
                <div>
                  <span>会议助手回答</span>
                  <strong>{presentation.title}</strong>
                </div>
                <button type="button" disabled={busy} onClick={() => speakReply(presentation.body)}>重播</button>
              </header>
              <p>{presentation.body}</p>
              {presentation.bullets.length ? <ul>{presentation.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul> : null}
            </section>
          ) : null}
          <form onSubmit={(event) => { event.preventDefault(); acceptTranscript(question); setQuestion(""); }}><input value={question} onChange={(event) => setQuestion(event.currentTarget.value)} placeholder="直接说：会议助手，请总结刚才的讨论" /><button type="submit" disabled={status === 'starting' || !question.trim()}>送入转写</button></form>
          {error ? <p className="meeting-transcript__error">{error}</p> : null}
        {pendingAction ? <div className="meeting-action-confirmation" role="alert">
          <div><strong>等待确认</strong><span>{proposedActionLabel(pendingAction)}</span><small>请说“会议助手，确认执行”或“会议助手，取消”</small></div>
          <button type="button" onClick={() => void executePendingAction()}>确认执行</button>
          <button type="button" onClick={cancelPendingAction}>取消</button>
        </div> : null}
      </section>
    </section>
  );

}
