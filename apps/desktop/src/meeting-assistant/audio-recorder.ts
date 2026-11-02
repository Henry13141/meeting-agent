import { UtteranceBoundary } from './utterance-boundary';
import { openMeetingMicrophone } from './meeting-microphone';
import { StereoSpeakerDirection } from './stereo-speaker-direction';
import { VoicePresenceDirection } from './voice-presence-direction';
import type { SpeakerDirection } from './speaker-direction';
import pcmWorkletUrl from './pcm-worklet.js?url&no-inline';

export type CapturedPcm = Readonly<{ pcm?: Uint8Array<ArrayBuffer>; capturedAt: string; skipTranscription: boolean }>;
export type MeetingDirectionMode = 'stereo' | 'presence' | 'none';

const captureHost = globalThis as typeof globalThis & { __meetingAgentRecorder?: MeetingAudioRecorder };

export type MeetingAudioRecorderOptions = Readonly<{
  microphone: boolean;
  onChunk: (chunk: Uint8Array<ArrayBuffer>, mimeType: 'audio/webm' | 'audio/webm;codecs=opus', utteranceEnd: boolean, capture: CapturedPcm) => Promise<void>;
  onArchiveChunk: (chunk: Uint8Array<ArrayBuffer>, input: Readonly<{
    sessionId: string;
    sequence: number;
    mimeType: 'audio/webm' | 'audio/webm;codecs=opus';
    final: boolean;
  }>) => Promise<void>;
  onPcmFrame?: (frame: Uint8Array<ArrayBuffer>, sampleRate: number) => Promise<{ speechDetected: boolean; keyword: string | null }>;
  onLevel?: (level: number) => void;
  onSpectrum?: (bands: readonly number[]) => void;
  onDirection?: (direction: SpeakerDirection) => void;
  onDirectionAvailable?: (available: boolean) => void;
  onDirectionMode?: (mode: MeetingDirectionMode) => void;
  onError?: (message: string) => void;
  onCaptureStopped?: () => void;
  shouldSkipTranscription?: () => boolean;
}>;

const TRANSCRIPTION_SEGMENT_MS = 10_000;

export class MeetingAudioRecorder {
  private startingPromise: Promise<void> | null = null;
  private recorder: MediaRecorder | null = null;
  private archiveRecorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private destination: MediaStreamAudioDestinationNode | null = null;
  private animationFrame: number | null = null;
  private segmentTimer: number | null = null;
  private segmentDone: Promise<void> | null = null;
  private stopping = false;
  private chunkQueue: Promise<void> = Promise.resolve();
  private archiveQueue: Promise<void> = Promise.resolve();
  private archiveDone: Promise<void> | null = null;
  private voiceProcessor: AudioWorkletNode | null = null;
  private voiceFrameInFlight = false;
  private voiceDone: Promise<void> | null = null;
  private pcmFrames: Uint8Array<ArrayBuffer>[] = [];
  private pcmBytes = 0;
  private voiceFrames: Uint8Array<ArrayBuffer>[] = [];
  private voiceEnabled = false;
  private segmentHasSpeech = false;
  private segmentContainsPlayback = false;
  private segmentCapturedAt = '';
  private pendingChunks = 0;
  private pendingArchiveChunks = 0;
  private flushDone: (() => void) | null = null;
  private stoppingPromise: Promise<void> | null = null;
  private boundary = new UtteranceBoundary();
  private segmentEndsUtterance = false;

  static available(): boolean {
    return Boolean(navigator.mediaDevices && window.MediaRecorder && window.AudioContext);
  }

  async start(options: MeetingAudioRecorderOptions): Promise<void> {
    const previous = captureHost.__meetingAgentRecorder;
    if (previous && previous !== this) await previous.stop();
    captureHost.__meetingAgentRecorder = this;
    const starting = this.startCapture(options);
    this.startingPromise = starting;
    try { await starting; }
    catch (error) {
      if (captureHost.__meetingAgentRecorder === this) delete captureHost.__meetingAgentRecorder;
      throw error;
    }
    finally { this.startingPromise = null; }
  }

  private async startCapture(options: MeetingAudioRecorderOptions): Promise<void> {
    if (this.stoppingPromise) await this.stoppingPromise;
    if (this.recorder) throw new Error('MEETING_AUDIO_ALREADY_RECORDING');
    if (!options.microphone) throw new Error('MEETING_AUDIO_SOURCE_REQUIRED');
    if (!MeetingAudioRecorder.available()) throw new Error('MEETING_AUDIO_UNAVAILABLE');
    this.stopping = false;
    this.pcmFrames = []; this.pcmBytes = 0; this.voiceFrames = [];
    this.pendingChunks = 0;
    this.pendingArchiveChunks = 0;
    this.boundary.reset();
    try {
      const opened = await openMeetingMicrophone((constraints) => navigator.mediaDevices.getUserMedia(constraints));
      this.streams.push(opened.stream);
      this.context = new AudioContext({ sampleRate: 16_000 });
      await this.context.resume().catch(() => undefined);
      this.destination = this.context.createMediaStreamDestination();
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 512;
      analyser.minDecibels = -90;
      analyser.maxDecibels = -20;
      analyser.smoothingTimeConstant = 0.72;
      const mix = this.context.createGain();
      for (const stream of this.streams) {
        const source = this.context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        source.connect(mix);
      }
      const mode: MeetingDirectionMode = opened.stereo ? 'stereo' : options.onDirection ? 'presence' : 'none';
      options.onDirectionAvailable?.(opened.stereo);
      options.onDirectionMode?.(mode);
      options.onDirection?.('center');
      const sampleDirection = !options.onDirection ? undefined
        : opened.stereo ? this.directionSampler(mix, options.onDirection)
          : this.presenceSampler(options.onDirection);
      mix.connect(this.destination);
      mix.connect(analyser);
      await this.startVoiceFrames(mix, options);
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' as const
        : 'audio/webm' as const;
      this.startSegment(options, mimeType);
      this.startArchive(options, mimeType);
      this.monitorLevel(
        analyser,
        options.onLevel ?? (() => {}),
        options.onSpectrum,
        sampleDirection,
      );
    } catch (error) {
      await this.stopCapture();
      if (captureHost.__meetingAgentRecorder === this) delete captureHost.__meetingAgentRecorder;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.startingPromise) await this.startingPromise.catch(() => undefined);
    if (this.stoppingPromise) return this.stoppingPromise;
    this.stoppingPromise = this.stopCapture();
    try { await this.stoppingPromise; }
    finally {
      this.stoppingPromise = null;
      if (captureHost.__meetingAgentRecorder === this) delete captureHost.__meetingAgentRecorder;
    }
  }

  private async stopCapture(): Promise<void> {
    this.stopping = true;
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    if (this.segmentTimer !== null) window.clearTimeout(this.segmentTimer);
    this.segmentTimer = null;
    if (this.voiceProcessor) {
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 500);
        this.flushDone = () => { window.clearTimeout(timeout); resolve(); };
        this.voiceProcessor!.port.postMessage('flush');
      });
      this.voiceProcessor.disconnect();
      this.voiceProcessor.port.onmessage = null;
    }
    const recorder = this.recorder;
    const archiveRecorder = this.archiveRecorder;
    const segmentDone = this.segmentDone;
    const archiveDone = this.archiveDone;
    this.recorder = null;
    this.archiveRecorder = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    if (archiveRecorder && archiveRecorder.state !== 'inactive') archiveRecorder.stop();
    await segmentDone;
    await archiveDone;
    await this.chunkQueue.catch(() => undefined);
    await this.archiveQueue.catch(() => undefined);
    await this.voiceDone;
    this.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    this.streams = [];
    this.destination = null;
    this.voiceProcessor?.disconnect();
    this.voiceProcessor = null;
    this.voiceFrameInFlight = false;
    this.voiceFrames = []; this.pcmFrames = []; this.pcmBytes = 0;
    this.segmentDone = null;
    this.archiveDone = null;
    await this.context?.close().catch(() => undefined);
    this.context = null;
  }

  isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }

  private monitorLevel(
    analyser: AnalyserNode,
    onLevel: (level: number) => void,
    onSpectrum?: (bands: readonly number[]) => void,
    sampleDirection?: (() => void) | ((level: number) => void),
  ): void {
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const frequencies = new Uint8Array(analyser.frequencyBinCount);
    const bandCount = 24;
    let spectrumSampledAt = -Infinity;
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let total = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        total += normalized * normalized;
      }
      const level = Math.min(1, Math.sqrt(total / samples.length) * 3);
      onLevel(level);
      sampleDirection?.(level);
      const now = performance.now();
      if (onSpectrum && now - spectrumSampledAt >= 80) {
        spectrumSampledAt = now;
        analyser.getByteFrequencyData(frequencies);
        const hzPerBin = analyser.context.sampleRate / analyser.fftSize;
        const minimumHz = 80;
        const maximumHz = Math.min(4_000, analyser.context.sampleRate / 2);
        const ratio = maximumHz / minimumHz;
        const bands = Array.from({ length: bandCount }, (_, index) => {
          const startHz = minimumHz * ratio ** (index / bandCount);
          const endHz = minimumHz * ratio ** ((index + 1) / bandCount);
          const start = Math.max(1, Math.floor(startHz / hzPerBin));
          const end = Math.min(frequencies.length, Math.max(start + 1, Math.ceil(endHz / hzPerBin)));
          let totalFrequency = 0;
          for (let bin = start; bin < end; bin += 1) totalFrequency += frequencies[bin] ?? 0;
          return Math.min(1, totalFrequency / Math.max(1, end - start) / 210);
        });
        onSpectrum(bands);
      }
      this.animationFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  private presenceSampler(onDirection: (direction: SpeakerDirection) => void): (level: number) => void {
    const tracker = new VoicePresenceDirection();
    let previous: SpeakerDirection = 'center';
    return (level: number) => {
      const direction = tracker.sample(level, performance.now());
      if (direction !== previous) { previous = direction; onDirection(direction); }
    };
  }

  private directionSampler(source: AudioNode, onDirection: (direction: SpeakerDirection) => void): () => void {
    const context = this.context!;
    const splitter = context.createChannelSplitter(2);
    source.connect(splitter);
    const channels = [0, 1].map(channel => {
      const highPass = context.createBiquadFilter();
      highPass.type = 'highpass'; highPass.frequency.value = 180;
      const lowPass = context.createBiquadFilter();
      lowPass.type = 'lowpass'; lowPass.frequency.value = 3500;
      const analyser = context.createAnalyser(); analyser.fftSize = 1024;
      splitter.connect(highPass, channel); highPass.connect(lowPass); lowPass.connect(analyser);
      return { analyser, samples: new Float32Array(analyser.fftSize) };
    });
    const tracker = new StereoSpeakerDirection();
    let previous: SpeakerDirection = 'center';
    let sampledAt = -Infinity;
    return () => {
      const now = performance.now();
      if (now - sampledAt < 80) return;
      sampledAt = now;
      const levels = channels.map(({ analyser, samples }) => {
        analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((total, value) => total + value * value, 0) / samples.length);
      });
      const direction = tracker.sample(levels[0]!, levels[1]!, now);
      if (direction !== previous) { previous = direction; onDirection(direction); }
    };
  }

  private async startVoiceFrames(
    source: AudioNode,
    options: MeetingAudioRecorderOptions,
  ): Promise<void> {
    if (!this.context) return;
    if (this.context.sampleRate !== 16_000) throw new Error('MEETING_PCM_SAMPLE_RATE_UNSUPPORTED');
    await this.context.audioWorklet.addModule(pcmWorkletUrl);
    const processor = new AudioWorkletNode(this.context, 'meeting-pcm');
    const silentOutput = this.context.createGain();
    silentOutput.gain.value = 0;
    source.connect(processor);
    processor.connect(silentOutput);
    silentOutput.connect(this.context.destination);
    this.voiceEnabled = Boolean(options.onPcmFrame);
    processor.port.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (event.data === 'flushed') { this.flushDone?.(); this.flushDone = null; return; }
      if (!(event.data instanceof ArrayBuffer)) return;
      const pcm = new Uint8Array(event.data);
      this.pcmFrames.push(pcm); this.pcmBytes += pcm.length;
      const samples = new Int16Array(event.data);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / samples.length);
      // Conservative admission: keep short/quiet speech even if neural VAD's
      // minimum duration has not been reached. Audio-clock callbacks also work
      // when requestAnimationFrame is throttled in the background.
      if (rms * 3 >= 0.04) this.segmentHasSpeech = true;
      if (options.shouldSkipTranscription?.()) this.segmentContainsPlayback = true;
      if (!this.voiceEnabled && !this.stopping
        && this.boundary.sample(rms * 3, performance.now()) && this.recorder?.state === 'recording') {
        this.segmentEndsUtterance = true;
        this.recorder.stop();
      }
      if (this.pcmBytes > 600_000 && !this.stopping) {
        options.onError?.('语音处理积压，已停止录音；已有录音已保留。');
        options.onCaptureStopped?.();
        void this.stop(); return;
      }
      if (!this.voiceEnabled || this.stopping) return;
      this.voiceFrames.push(pcm);
      if (this.voiceFrames.length > 12) {
        this.voiceEnabled = false; this.voiceFrames = []; this.boundary.reset();
        options.onError?.('唤醒检测处理过慢，已改用音量断句；仍可通过转写唤醒。');
        return;
      }
      if (!this.voiceFrameInFlight) this.voiceDone = this.drainVoice(options);
    };
    this.voiceProcessor = processor;
  }

  private async drainVoice(options: MeetingAudioRecorderOptions): Promise<void> {
    if (this.voiceFrameInFlight || !options.onPcmFrame) return;
    this.voiceFrameInFlight = true;
    try {
      while (this.voiceFrames.length && this.voiceEnabled && !this.stopping) {
        const frame = joinPcm(this.voiceFrames.splice(0));
        const activation = await options.onPcmFrame(frame, 16_000);
        if (this.stopping || !this.voiceEnabled) break;
        if (activation.speechDetected) this.segmentHasSpeech = true;
        if (this.boundary.speech(activation.speechDetected, performance.now()) && this.recorder?.state === 'recording') {
          this.segmentEndsUtterance = true;
          this.recorder.stop();
        }
      }
    } catch {
      this.voiceEnabled = false; this.voiceFrames = []; this.boundary.reset();
      options.onError?.('唤醒检测暂不可用，已改用音量断句；录音继续。');
    } finally { this.voiceFrameInFlight = false; }
  }

  private startSegment(
    options: MeetingAudioRecorderOptions,
    mimeType: 'audio/webm' | 'audio/webm;codecs=opus',
  ): void {
    if (!this.destination || this.stopping) return;
    const recorder = new MediaRecorder(this.destination.stream, { mimeType, audioBitsPerSecond: 64_000 });
    let resolveSegment!: () => void;
    this.segmentDone = new Promise<void>((resolve) => { resolveSegment = resolve; });
    this.recorder = recorder;
    this.segmentEndsUtterance = false;
    this.segmentCapturedAt = new Date().toISOString();
    this.segmentHasSpeech = false;
    this.segmentContainsPlayback = options.shouldSkipTranscription?.() ?? false;
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      const utteranceEnd = this.segmentEndsUtterance;
      const pcm = joinPcm(this.pcmFrames.splice(0));
      this.pcmBytes = 0;
      const capture: CapturedPcm = {
        ...(pcm.length ? { pcm } : {}),
        capturedAt: this.segmentCapturedAt,
        skipTranscription: !this.segmentHasSpeech || this.segmentContainsPlayback,
      };
      this.pendingChunks += 1;
      if (this.pendingChunks >= 4 && !this.stopping) {
        options.onError?.('转写速度跟不上录音，已停止采集并保存已有录音。');
        options.onCaptureStopped?.();
        void this.stop();
      }
      this.chunkQueue = this.chunkQueue.catch(() => undefined).then(async () => {
        const bytes = new Uint8Array(await event.data.arrayBuffer());
        await options.onChunk(bytes, mimeType, utteranceEnd, capture);
      }).catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error.message : 'MEETING_AUDIO_CHUNK_FAILED');
      }).finally(() => { this.pendingChunks -= 1; });
    };
    recorder.onerror = () => {
      options.onLevel?.(0);
      options.onError?.('MEETING_AUDIO_RECORDER_FAILED');
    };
    recorder.onstop = () => {
      if (this.segmentTimer !== null) window.clearTimeout(this.segmentTimer);
      this.segmentTimer = null;
      resolveSegment();
      if (!this.stopping) {
        try { this.startSegment(options, mimeType); }
        catch (error) {
          options.onError?.(error instanceof Error ? error.message : 'MEETING_AUDIO_RECORDER_FAILED');
        }
      }
    };
    try { recorder.start(); }
    catch (error) {
      resolveSegment();
      this.segmentDone = null;
      this.recorder = null;
      throw error;
    }
    this.segmentTimer = window.setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, TRANSCRIPTION_SEGMENT_MS);
  }

  private startArchive(
    options: MeetingAudioRecorderOptions,
    mimeType: 'audio/webm' | 'audio/webm;codecs=opus',
  ): void {
    if (!this.destination || this.stopping) return;
    const recorder = new MediaRecorder(this.destination.stream, { mimeType, audioBitsPerSecond: 64_000 });
    const now = new Date();
    const part = (value: number) => String(value).padStart(2, '0');
    const sessionId = `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}T${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}-${crypto.randomUUID().slice(0, 8)}`;
    let sequence = 0;
    let pending: Blob | null = null;
    let resolveArchive!: () => void;
    this.archiveDone = new Promise<void>((resolve) => { resolveArchive = resolve; });
    this.archiveRecorder = recorder;
    const enqueue = (blob: Blob, final: boolean) => {
      sequence += 1;
      const currentSequence = sequence;
      this.pendingArchiveChunks += 1;
      if (this.pendingArchiveChunks >= 12 && !this.stopping) {
        options.onError?.('录音保存速度过慢，已停止采集并等待已有录音写入。');
        options.onCaptureStopped?.();
        void this.stop();
      }
      this.archiveQueue = this.archiveQueue.catch(() => undefined).then(async () => {
        await options.onArchiveChunk(new Uint8Array(await blob.arrayBuffer()), {
          sessionId, sequence: currentSequence, mimeType, final,
        });
      }).catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error.message : 'MEETING_AUDIO_ARCHIVE_FAILED');
        options.onCaptureStopped?.();
        if (!this.stopping) void this.stop();
      }).finally(() => { this.pendingArchiveChunks -= 1; });
    };
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      if (pending) enqueue(pending, false);
      pending = event.data;
    };
    recorder.onerror = () => options.onError?.('MEETING_AUDIO_ARCHIVE_FAILED');
    recorder.onstop = () => {
      if (pending) enqueue(pending, true);
      resolveArchive();
    };
    try { recorder.start(5_000); }
    catch (error) {
      resolveArchive();
      this.archiveDone = null;
      this.archiveRecorder = null;
      throw error;
    }
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void captureHost.__meetingAgentRecorder?.stop();
  });
}

function joinPcm(frames: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let offset = 0;
  for (const frame of frames) { output.set(frame, offset); offset += frame.length; }
  return output;
}
