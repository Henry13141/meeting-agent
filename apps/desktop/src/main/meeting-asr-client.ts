const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type MeetingAsrEnvironment = Readonly<Record<string, string | undefined>>;
export type MeetingAsrSegment = Readonly<{
  text: string;
  speaker: string | null;
  startSeconds: number | null;
  endSeconds: number | null;
}>;
export type MeetingAsrResult = Readonly<{ text: string; segments: MeetingAsrSegment[] }>;
export type MeetingVoiceActivationResult = Readonly<{
  speechDetected: boolean;
  keyword: string | null;
}>;
export type MeetingSpeechAudio = Readonly<{
  mimeType: 'audio/mpeg';
  data: Uint8Array;
}>;

export class MeetingAsrClient {
  private lastVoiceAt = 0;
  private constructor(
    private readonly endpoint: URL,
    private readonly bearer: string,
    private readonly model: string,
    readonly speakerDiarization: boolean,
    readonly voiceActivation: boolean,
    private readonly timestampSegments: boolean,
    private readonly fetchImplementation: typeof fetch,
  ) {}

  static fromEnvironment(
    environment: MeetingAsrEnvironment,
    fetchImplementation: typeof fetch = fetch,
  ): MeetingAsrClient | null {
    const rawEndpoint = environment.MEETING_ASR_URL?.trim();
    const bearer = environment.MEETING_ASR_BEARER?.trim();
    const model = environment.MEETING_ASR_MODEL?.trim() || 'sensevoice';
    const diarizationValue = environment.MEETING_ASR_DIARIZATION?.trim().toLowerCase();
    const voiceActivationValue = environment.MEETING_ASR_VOICE_ACTIVATION?.trim().toLowerCase();
    const timestampValue = environment.MEETING_ASR_TIMESTAMPS?.trim().toLowerCase();
    if (!rawEndpoint && !bearer) return null;
    if (!rawEndpoint || !bearer || bearer.length < 16 || bearer.length > 4_096) {
      throw new Error('MEETING_ASR_CONFIGURATION_INVALID');
    }
    let endpoint: URL;
    try { endpoint = new URL(rawEndpoint); }
    catch { throw new Error('MEETING_ASR_CONFIGURATION_INVALID'); }
    if (
      endpoint.protocol !== 'http:'
      || !LOOPBACK_HOSTS.has(endpoint.hostname)
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
      || endpoint.pathname.replace(/\/$/, '') !== '/v1/audio/transcriptions'
      || model.length > 200
      || (diarizationValue !== undefined && !['true', 'false'].includes(diarizationValue))
      || (voiceActivationValue !== undefined && !['true', 'false'].includes(voiceActivationValue))
      || (timestampValue !== undefined && !['true', 'false'].includes(timestampValue))
    ) throw new Error('MEETING_ASR_CONFIGURATION_INVALID');
    return new MeetingAsrClient(
      endpoint,
      bearer,
      model,
      diarizationValue === 'true',
      voiceActivationValue === 'true',
      timestampValue === 'true',
      fetchImplementation,
    );
  }

  static forManagedLoopback(
    port: number,
    bearer: string,
    model: string,
    speakerDiarization: boolean,
    voiceActivation: boolean,
    fetchImplementation: typeof fetch = fetch,
    timestampSegments = false,
  ): MeetingAsrClient {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error('MEETING_ASR_CONFIGURATION_INVALID');
    }
    const client = MeetingAsrClient.fromEnvironment({
      MEETING_ASR_URL: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
      MEETING_ASR_BEARER: bearer,
      MEETING_ASR_MODEL: model,
      MEETING_ASR_DIARIZATION: String(speakerDiarization),
      MEETING_ASR_VOICE_ACTIVATION: String(voiceActivation),
      MEETING_ASR_TIMESTAMPS: String(timestampSegments),
    }, fetchImplementation);
    if (!client) throw new Error('MEETING_ASR_CONFIGURATION_INVALID');
    return client;
  }

  async analyzeVoice(data: Uint8Array, sampleRate: number): Promise<MeetingVoiceActivationResult> {
    if (!this.voiceActivation) throw new Error('MEETING_VOICE_ACTIVATION_UNAVAILABLE');
    if (
      !(data instanceof Uint8Array)
      || data.byteLength < 2
      || data.byteLength > 256_000
      || data.byteLength % 2 !== 0
      || !Number.isSafeInteger(sampleRate)
      || sampleRate < 8_000
      || sampleRate > 48_000
    ) throw new Error('MEETING_VOICE_FRAME_INVALID');
    const body = new FormData();
    body.set('file', new Blob([Uint8Array.from(data).buffer], { type: 'audio/pcm' }), 'frame.pcm');
    body.set('sample_rate', String(sampleRate));
    body.set('reset', String(Date.now() - this.lastVoiceAt > 2_000));
    this.lastVoiceAt = Date.now();
    const endpoint = new URL('/v1/audio/voice-activation', this.endpoint);
    const response = await this.fetchImplementation(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.bearer}` },
      body,
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`MEETING_VOICE_ACTIVATION_HTTP_${response.status}`);
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('MEETING_VOICE_ACTIVATION_RESPONSE_INVALID');
    }
    const record = payload as Record<string, unknown>;
    if (
      typeof record.speechDetected !== 'boolean'
      || (record.keyword !== null && typeof record.keyword !== 'string')
      || (typeof record.keyword === 'string' && record.keyword.length > 100)
    ) throw new Error('MEETING_VOICE_ACTIVATION_RESPONSE_INVALID');
    return {
      speechDetected: record.speechDetected,
      keyword: typeof record.keyword === 'string' && record.keyword.trim()
        ? record.keyword.trim()
        : null,
    };
  }

  async transcribe(
    bytes: Uint8Array,
    mimeType: 'audio/webm' | 'audio/webm;codecs=opus' | 'audio/pcm',
  ): Promise<MeetingAsrResult> {
    const body = new FormData();
    body.set('file', new Blob([Uint8Array.from(bytes).buffer], { type: mimeType }),
      mimeType === 'audio/pcm' ? 'meeting-segment.pcm' : 'meeting-segment.webm');
    if (mimeType === 'audio/pcm') body.set('sample_rate', '16000');
    body.set('model', this.model);
    body.set('language', 'zh');
    body.set('response_format', this.speakerDiarization || this.timestampSegments
      ? 'verbose_json'
      : 'json');
    const response = await this.fetchImplementation(this.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.bearer}` },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`MEETING_ASR_HTTP_${response.status}`);
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('MEETING_ASR_RESPONSE_INVALID');
    }
    const record = payload as Record<string, unknown>;
    const text = record.text;
    if (typeof text !== 'string') throw new Error('MEETING_ASR_RESPONSE_INVALID');
    const segments = Array.isArray(record.segments) ? record.segments.slice(0, 100).flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const segment = value as Record<string, unknown>;
      if (typeof segment.text !== 'string' || !segment.text.trim()) return [];
      const rawSpeaker = segment.speaker ?? segment.spk;
      const speaker = typeof rawSpeaker === 'string' || typeof rawSpeaker === 'number'
        ? `说话人 ${String(rawSpeaker).trim().slice(0, 40)}`
        : null;
      const startSeconds = typeof segment.start === 'number' && Number.isFinite(segment.start)
        && segment.start >= 0 && segment.start <= 86_400 ? segment.start : null;
      const endSeconds = typeof segment.end === 'number' && Number.isFinite(segment.end)
        && segment.end >= 0 && segment.end <= 86_400 ? segment.end : null;
      return [{ text: segment.text.trim().slice(0, 4_000), speaker, startSeconds, endSeconds }];
    }) : [];
    return { text: text.trim().slice(0, 4_000), segments };
  }

  async transcribeCapture(
    archive: Uint8Array,
    mimeType: 'audio/webm' | 'audio/webm;codecs=opus',
    pcm?: Uint8Array,
  ): Promise<MeetingAsrResult> {
    if (!pcm) return this.transcribe(archive, mimeType);
    try { return await this.transcribe(pcm, 'audio/pcm'); }
    catch (error) {
      // Older explicitly configured loopback servers only understand WebM.
      if (!(error instanceof Error) || error.message !== 'MEETING_ASR_HTTP_415') throw error;
      return this.transcribe(archive, mimeType);
    }
  }

  async speechSynthesisAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchImplementation(new URL('/health', this.endpoint), {
        signal: AbortSignal.timeout(1_500),
        cache: 'no-store',
      });
      if (!response.ok) return false;
      const payload = await response.json() as unknown;
      return Boolean(
        payload
        && typeof payload === 'object'
        && !Array.isArray(payload)
        && (payload as Record<string, unknown>).speechSynthesis === true,
      );
    } catch {
      return false;
    }
  }

  async synthesize(text: string): Promise<MeetingSpeechAudio> {
    const spoken = text.trim();
    if (!spoken || spoken.length > 2_000) throw new Error('MEETING_TTS_TEXT_INVALID');
    const response = await this.fetchImplementation(new URL('/v1/audio/speech', this.endpoint), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: spoken, voice: 'zh-CN-XiaoxiaoNeural' }),
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 404) throw new Error('MEETING_TTS_UNAVAILABLE');
    if (!response.ok) throw new Error(`MEETING_TTS_HTTP_${response.status}`);
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim();
    if (mimeType !== 'audio/mpeg') throw new Error('MEETING_TTS_RESPONSE_INVALID');
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength < 16 || buffer.byteLength > 2_000_000) throw new Error('MEETING_TTS_RESPONSE_INVALID');
    return { mimeType: 'audio/mpeg', data: buffer };
  }
}
