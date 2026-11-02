import { describe, expect, it, vi } from 'vitest';
import { MeetingAsrClient } from './meeting-asr-client';

const environment = {
  MEETING_ASR_URL: 'http://127.0.0.1:8000/v1/audio/transcriptions',
  MEETING_ASR_BEARER: 'local-test-bearer-token',
  MEETING_ASR_MODEL: 'sensevoice',
};

describe('MeetingAsrClient', () => {
  it('uses PCM directly and retries WebM only for an older server rejecting its type', async () => {
    const types: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      const file = (init?.body as FormData).get('file') as Blob;
      types.push(file.type);
      if (file.type === 'audio/pcm') return new Response('', { status: 415 });
      return new Response(JSON.stringify({ text: '兼容转写' }));
    });
    const client = MeetingAsrClient.fromEnvironment(environment, fetchImplementation)!;
    expect((await client.transcribeCapture(new Uint8Array([1]), 'audio/webm', new Uint8Array([1, 0]))).text).toBe('兼容转写');
    expect(types).toEqual(['audio/pcm', 'audio/webm']);
    fetchImplementation.mockResolvedValue(new Response('', { status: 504 }));
    const previousCalls = fetchImplementation.mock.calls.length;
    await expect(client.transcribeCapture(new Uint8Array([1]), 'audio/webm', new Uint8Array([1, 0]))).rejects.toThrow('504');
    expect(fetchImplementation.mock.calls.length).toBe(previousCalls + 1);
  });
  it('constructs a managed loopback client without exposing its bearer', async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ text: '收到' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = MeetingAsrClient.forManagedLoopback(
      19421,
      'managed-bearer-token-long-enough',
      'sensevoice',
      false,
      false,
      fetchImplementation as typeof fetch,
    );
    await expect(client.transcribe(new Uint8Array([1]), 'audio/webm')).resolves.toMatchObject({ text: '收到' });
    expect(String(fetchImplementation.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:19421/v1/audio/transcriptions',
    );
  });

  it('posts bounded PCM frames to the optional local voice activation endpoint', async () => {
    const fetchImplementation = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8000/v1/audio/voice-activation');
      expect(init?.headers).toEqual({ authorization: 'Bearer local-test-bearer-token' });
      const body = init?.body as FormData;
      expect(body.get('sample_rate')).toBe('16000');
      expect(body.get('file')).toBeInstanceOf(Blob);
      return new Response(JSON.stringify({ speechDetected: true, keyword: '会议助手' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const client = MeetingAsrClient.fromEnvironment({
      ...environment,
      MEETING_ASR_VOICE_ACTIVATION: 'true',
    }, fetchImplementation as typeof fetch);
    await expect(client?.analyzeVoice(new Uint8Array([0, 0, 1, 0]), 16_000)).resolves.toEqual({
      speechDetected: true,
      keyword: '会议助手',
    });
  });
  it('posts an authenticated multipart WebM request and validates the response', async () => {
    const fetchImplementation = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(init?.headers).toEqual({ authorization: 'Bearer local-test-bearer-token' });
      const body = init?.body as FormData;
      expect(body.get('model')).toBe('sensevoice');
      expect(body.get('response_format')).toBe('json');
      expect(body.get('file')).toBeInstanceOf(Blob);
      return new Response(JSON.stringify({ text: '  九月上线。 ' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const client = MeetingAsrClient.fromEnvironment(environment, fetchImplementation as typeof fetch);
    await expect(client?.transcribe(new Uint8Array([1, 2, 3]), 'audio/webm')).resolves.toEqual({
      text: '九月上线。', segments: [],
    });
  });

  it('parses bounded speaker segments when diarization is explicitly enabled', async () => {
    const fetchImplementation = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect((init?.body as FormData).get('response_format')).toBe('verbose_json');
      return new Response(JSON.stringify({
        text: '确认上线。开始联调。',
        segments: [
          { text: '确认上线。', speaker: 0, start: 0.4 },
          { text: '开始联调。', spk: 'B', start: 2.1 },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = MeetingAsrClient.fromEnvironment({
      ...environment, MEETING_ASR_DIARIZATION: 'true',
    }, fetchImplementation as typeof fetch);
    expect(client?.speakerDiarization).toBe(true);
    await expect(client?.transcribe(new Uint8Array([1]), 'audio/webm')).resolves.toMatchObject({
      segments: [
        { text: '确认上线。', speaker: '说话人 0', startSeconds: 0.4 },
        { text: '开始联调。', speaker: '说话人 B', startSeconds: 2.1 },
      ],
    });
  });

  it('keeps Qwen timestamp segments when diarization is disabled', async () => {
    const fetchImplementation = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect((init?.body as FormData).get('response_format')).toBe('verbose_json');
      return new Response(JSON.stringify({
        text: '确认上线开始联调',
        segments: [
          { text: '确认上线', start: 0.4, end: 1.7 },
          { text: '开始联调', start: 2.1, end: 3.2 },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = MeetingAsrClient.fromEnvironment({
      ...environment,
      MEETING_ASR_TIMESTAMPS: 'true',
    }, fetchImplementation as typeof fetch);
    expect(client?.speakerDiarization).toBe(false);
    await expect(client?.transcribe(new Uint8Array([1]), 'audio/webm')).resolves.toMatchObject({
      segments: [
        { text: '确认上线', speaker: null, startSeconds: 0.4, endSeconds: 1.7 },
        { text: '开始联调', speaker: null, startSeconds: 2.1, endSeconds: 3.2 },
      ],
    });
  });

  it('allows only an authenticated loopback transcription endpoint', () => {
    expect(() => MeetingAsrClient.fromEnvironment({
      ...environment, MEETING_ASR_URL: 'https://asr.example.com/v1/audio/transcriptions',
    })).toThrow('MEETING_ASR_CONFIGURATION_INVALID');
    expect(() => MeetingAsrClient.fromEnvironment({
      ...environment, MEETING_ASR_BEARER: '',
    })).toThrow('MEETING_ASR_CONFIGURATION_INVALID');
  });

  it('is disabled when no local ASR variables are present', () => {
    expect(MeetingAsrClient.fromEnvironment({})).toBeNull();
  });

  it('posts spoken text to the local speech endpoint and returns MPEG audio', async () => {
    const fetchImplementation = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8000/v1/audio/speech');
      expect(init?.headers).toEqual({
        authorization: 'Bearer local-test-bearer-token',
        'content-type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        input: '我是会议助手。',
        voice: 'zh-CN-XiaoxiaoNeural',
      });
      return new Response(new Uint8Array(32).fill(7), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });
    const client = MeetingAsrClient.fromEnvironment(environment, fetchImplementation as typeof fetch);
    await expect(client?.synthesize('  我是会议助手。  ')).resolves.toEqual({
      mimeType: 'audio/mpeg',
      data: new Uint8Array(32).fill(7),
    });
  });
});
