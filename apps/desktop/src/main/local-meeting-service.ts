import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  identifierSchema,
  meetingCreateRequestSchema,
  meetingAppendTranscriptRequestSchema,
  meetingAppendAudioRequestSchema,
  meetingAppendArchiveAudioRequestSchema,
  meetingCompleteRequestSchema,
  meetingSearchRequestSchema,
  meetingVoiceFrameRequestSchema,
  type MeetingCreateRequest,
  type MeetingAppendTranscriptRequest,
  type MeetingAppendAudioRequest,
  type MeetingAppendArchiveAudioRequest,
  type MeetingCompleteRequest,
  type MeetingSearchRequest,
  type MeetingVoiceFrameRequest,
  type MeetingCapabilities,
  type MeetingRecord,
} from '../shared/contracts';
import { MeetingStore } from './meeting-store';
import { LOCAL_RUNTIME_IDENTITY } from './runtime-identity';
import { MeetingAsrSupervisor } from './meeting-asr-supervisor';
import { MeetingAsrClient, type MeetingAsrEnvironment, type MeetingSpeechAudio } from './meeting-asr-client';
import { PROJECT_MEETING_WAKE_FILES } from './meeting-asr-project-models';

export type LocalMeetingServiceOptions = Readonly<{
  projectRoot: string;
  dataRoot: string;
  recordingsRoot: string;
  environment?: MeetingAsrEnvironment;
}>;

function configured(environment: MeetingAsrEnvironment, name: string): string | undefined {
  return environment[name]?.trim() || undefined;
}

function errorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  return /^MEETING_[A-Z0-9_]+$/.test(message) ? message : fallback;
}

/** Local meeting data and a separately owned ASR process. No account or external write access. */
export class LocalMeetingService {
  private readonly store: MeetingStore;
  private readonly ready: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly pendingAudio = new Set<Promise<MeetingRecord>>();
  private writeTail: Promise<unknown> = Promise.resolve();
  private clientPromise: Promise<MeetingAsrClient | null> | null = null;
  private supervisor: MeetingAsrSupervisor | null = null;
  private accepting = true;
  private stopping: Promise<void> | null = null;
  private lastAsrError: string | null = null;

  constructor(private readonly options: LocalMeetingServiceOptions) {
    this.store = new MeetingStore(options.dataRoot, LOCAL_RUNTIME_IDENTITY, options.recordingsRoot);
    this.ready = this.store.finalizeRecordingMeetings().then(() => undefined);
    // Keep an early open failure observable by every operation without an unhandled rejection.
    void this.ready.catch(() => undefined);
  }

  /** Fixed diagnostic code only; host paths and credentials never enter capability results. */
  get asrError(): string | null { return this.lastAsrError; }

  private run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('MEETING_SERVICE_STOPPED'));
    const job = this.ready.then(work);
    this.pending.add(job);
    void job.then(() => this.pending.delete(job), () => this.pending.delete(job));
    return job;
  }

  private write<T>(work: () => Promise<T>): Promise<T> {
    const job = this.writeTail.then(work);
    this.writeTail = job.catch(() => undefined);
    return job;
  }

  private client(): Promise<MeetingAsrClient | null> {
    // One startup attempt per app process. UI polling must not repeatedly launch a broken model.
    this.clientPromise ??= this.startAsr().catch((error: unknown) => {
      this.lastAsrError = errorCode(error, 'MEETING_ASR_START_FAILED');
      return null;
    });
    return this.clientPromise;
  }

  private async startAsr(): Promise<MeetingAsrClient | null> {
    const environment = this.options.environment ?? {};
    const modelPath = configured(environment, 'MEETING_AGENT_ASR_MODEL_PATH');
    const python = configured(environment, 'MEETING_AGENT_ASR_PYTHON');
    if (!modelPath || !python) {
      this.lastAsrError = 'MEETING_ASR_NOT_CONFIGURED';
      return null;
    }
    if (!path.isAbsolute(modelPath)
      || !await stat(modelPath).then((value) => value.isDirectory()).catch(() => false)) {
      this.lastAsrError = 'MEETING_ASR_MODEL_UNAVAILABLE';
      return null;
    }
    const wakeDirectory = configured(environment, 'MEETING_AGENT_ASR_WAKE_MODEL_DIR');
    const wakeReady = wakeDirectory && (await Promise.all(PROJECT_MEETING_WAKE_FILES.map((filename) =>
      stat(path.join(wakeDirectory, filename)).then((value) => value.isFile()).catch(() => false),
    ))).every(Boolean);
    const engine = configured(environment, 'MEETING_AGENT_ASR_ENGINE') ?? 'sensevoice';
    const asrEnvironment: Record<string, string | undefined> = {
      PATH: environment.PATH ?? process.env.PATH,
      HOME: os.homedir(),
      SystemRoot: environment.SystemRoot ?? process.env.SystemRoot,
      TEMP: environment.TEMP ?? process.env.TEMP,
      TMP: environment.TMP ?? process.env.TMP,
      MEETING_ASR_ENGINE: engine,
      MEETING_ASR_MODEL: engine === 'qwen' ? 'qwen3-asr' : 'sensevoice',
      MEETING_ASR_MODEL_PATH: modelPath,
      MEETING_ASR_DEVICE: configured(environment, 'MEETING_AGENT_ASR_DEVICE') ?? 'cpu',
      MEETING_ASR_THREADS: configured(environment, 'MEETING_AGENT_ASR_THREADS') ?? '4',
      MEETING_ASR_DIARIZATION: 'false',
      ...(wakeReady ? { MEETING_ASR_WAKE_MODEL_DIR: wakeDirectory } : {}),
    };
    for (const [source, target] of [
      ['MEETING_AGENT_ASR_ALIGNER_MODEL_PATH', 'MEETING_ASR_ALIGNER_MODEL_PATH'],
      ['MEETING_AGENT_ASR_GLOSSARY_PATH', 'MEETING_ASR_GLOSSARY_PATH'],
    ] as const) {
      const value = configured(environment, source);
      if (value) asrEnvironment[target] = value;
    }
    this.supervisor = new MeetingAsrSupervisor({
      environment: asrEnvironment,
      packaged: false,
      appPath: path.join(this.options.projectRoot, 'apps/desktop'),
      resourcesPath: path.join(this.options.projectRoot, 'apps/desktop/resources'),
      homePath: os.homedir(),
      serviceProjectPath: path.join(this.options.projectRoot, 'services/meeting-asr'),
      pythonExecutable: python,
    });
    const client = await this.supervisor.client();
    if (!client) this.lastAsrError = errorCode(
      new Error(this.supervisor.unavailableReason ?? ''), 'MEETING_ASR_START_FAILED',
    );
    return client;
  }

  getCapabilities(): Promise<MeetingCapabilities> {
    return this.run(async () => {
      const client = await this.client();
      const localAsr = client !== null && this.supervisor?.running === true;
      if (client && !localAsr) this.lastAsrError = 'MEETING_ASR_PROCESS_EXITED';
      return {
        audioRecording: true,
        localAsr,
        speakerDiarization: localAsr && client!.speakerDiarization,
        voiceActivation: localAsr && client!.voiceActivation,
        avatar: { provider: 'browser', configured: false, available: false },
        tts: { provider: 'browser', configured: false, available: false },
        webSearch: { provider: 'disabled', configured: false },
      };
    });
  }

  create(request: MeetingCreateRequest): Promise<MeetingRecord> {
    return this.run(() => this.write(() => this.store.create(meetingCreateRequestSchema.parse(request))));
  }

  appendTranscript(request: MeetingAppendTranscriptRequest): Promise<MeetingRecord> {
    return this.run(() => this.write(() => this.store.appendTranscript(meetingAppendTranscriptRequestSchema.parse(request))));
  }

  appendAudio(input: MeetingAppendAudioRequest): Promise<MeetingRecord> {
    const job = this.run(async () => {
      const request = meetingAppendAudioRequestSchema.parse(input);
      const stored = await this.write(() => this.store.appendAudio(request));
      if (request.skipTranscription) return stored;
      const client = await this.client();
      if (!client || !this.supervisor?.running) throw new Error('MEETING_ASR_UNAVAILABLE');
      try {
        const result = await client.transcribeCapture(request.data, request.mimeType, request.pcm);
        const segments = result.segments.length ? result.segments
          : result.text ? [{ text: result.text, speaker: null, startSeconds: null }] : [];
        let updated = stored;
        for (const segment of segments) {
          updated = await this.write(() => this.store.appendAsrTranscript({
            meetingId: request.meetingId,
            speaker: segment.speaker ?? '本地 ASR',
            text: segment.text,
            capturedAt: segment.startSeconds === null ? request.capturedAt
              : new Date(Date.parse(request.capturedAt) + segment.startSeconds * 1_000).toISOString(),
          }));
        }
        return updated;
      } catch (error) {
        this.lastAsrError = errorCode(error, 'MEETING_ASR_TRANSCRIPTION_FAILED');
        throw new Error('MEETING_ASR_TRANSCRIPTION_FAILED', { cause: error });
      }
    });
    this.pendingAudio.add(job);
    void job.then(() => this.pendingAudio.delete(job), () => this.pendingAudio.delete(job));
    return job;
  }

  analyzeVoice(input: MeetingVoiceFrameRequest) {
    return this.run(async () => {
      const request = meetingVoiceFrameRequestSchema.parse(input);
      const client = await this.client();
      if (!client?.voiceActivation || !this.supervisor?.running) throw new Error('MEETING_VOICE_ACTIVATION_UNAVAILABLE');
      return client.analyzeVoice(request.data, request.sampleRate);
    });
  }

  synthesize(text: string): Promise<MeetingSpeechAudio> {
    return this.run(async () => {
      const client = await this.client();
      if (!client || !this.supervisor?.running) throw new Error('MEETING_TTS_UNAVAILABLE');
      return client.synthesize(text);
    });
  }

  appendArchiveAudio(request: MeetingAppendArchiveAudioRequest): Promise<void> {
    return this.run(() => this.write(() => this.store.appendArchiveAudio(meetingAppendArchiveAudioRequestSchema.parse(request))));
  }

  complete(input: MeetingCompleteRequest): Promise<MeetingRecord> {
    const request = meetingCompleteRequestSchema.parse(input);
    const audio = [...this.pendingAudio];
    return this.run(async () => {
      await Promise.allSettled(audio);
      return this.write(() => this.store.complete(request));
    });
  }

  list(limit = 20): Promise<MeetingRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return Promise.reject(new Error('MEETING_LIMIT_INVALID'));
    return this.run(() => this.store.list(limit));
  }
  search(request: MeetingSearchRequest): Promise<MeetingRecord[]> {
    return this.run(() => this.store.search(meetingSearchRequestSchema.parse(request)));
  }
  get(id: string): Promise<MeetingRecord> {
    return this.run(() => this.store.get(identifierSchema.parse(id)));
  }
  readTranscript(id: string, afterSequence: number): Promise<MeetingRecord> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) return Promise.reject(new Error('MEETING_TRANSCRIPT_PAGE_INVALID'));
    return this.run(() => this.store.readTranscript(identifierSchema.parse(id), afterSequence));
  }
  fullTranscript(id: string) {
    return this.run(() => this.store.fullTranscript(identifierSchema.parse(id)));
  }
  getAudioDirectory(id: string): Promise<string> {
    return this.run(() => this.store.getAudioDirectory(identifierSchema.parse(id)));
  }
  getPlayableAudioPath(id: string): Promise<string> {
    return this.run(() => this.write(() => this.store.getPlayableAudioPath(identifierSchema.parse(id))));
  }
  getDayPosition(id: string) {
    return this.run(() => this.store.getDayPosition(identifierSchema.parse(id)));
  }

  /** Main-only paths for its native export dialog; this method neither opens nor copies them. */
  exportAudio(id: string): Promise<{ directory: string; files: string[] }> {
    return this.run(async () => {
      const directory = await this.store.getAudioDirectory(identifierSchema.parse(id));
      const files: string[] = [];
      for (const subdirectory of ['', '分片', '完整录音片段']) {
        const folder = path.join(directory, subdirectory);
        const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.webm')) files.push(path.join(folder, entry.name));
        }
      }
      return { directory, files };
    });
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.accepting = false;
    this.stopping = (async () => {
      try {
        await Promise.allSettled([...this.pending]);
        await this.ready;
        await this.writeTail;
        await this.store.finalizeRecordingMeetings(new Date().toISOString());
      } finally {
        try { await this.supervisor?.stop(); }
        finally { this.store.close(); }
      }
    })();
    return this.stopping;
  }
}
