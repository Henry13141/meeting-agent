import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function argument(name, environmentName) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : process.env[environmentName];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute local path`);
  return value;
}
const python = argument('--python', 'MEETING_AGENT_ASR_PYTHON');
const modelPath = argument('--model-path', 'MEETING_AGENT_ASR_MODEL_PATH');
const example = argument('--audio', 'MEETING_AGENT_SMOKE_AUDIO');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'meeting-agent-asr-live-'));
let service;
let evidence;
try {
  const bundled = path.join(temporary, 'local-meeting-service.mjs');
  await build({
    entryPoints: [path.join(projectRoot, 'apps/desktop/src/main/local-meeting-service.ts')],
    outfile: bundled, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
  });
  const { LocalMeetingService } = await import(pathToFileURL(bundled).href);
  service = new LocalMeetingService({ projectRoot,
    dataRoot: path.join(temporary, 'data'), recordingsRoot: path.join(temporary, 'recordings'),
    environment: { MEETING_AGENT_ASR_PYTHON: python, MEETING_AGENT_ASR_MODEL_PATH: modelPath },
  });
  const before = performance.now();
  const capabilities = await service.getCapabilities();
  const startupMs = Math.round(performance.now() - before);
  assert.equal(capabilities.localAsr, true, service.asrError ?? 'ASR failed to become ready');
  assert.equal(capabilities.voiceActivation, false, 'No optional wake model was configured');
  const { stdout: pcm } = await execute('ffmpeg', ['-nostdin', '-v', 'error', '-i', example,
    '-t', '20', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1_000_000 });
  const { stdout: webm } = await execute('ffmpeg', ['-nostdin', '-v', 'error', '-i', example,
    '-t', '20', '-f', 'webm', '-ac', '1', '-c:a', 'libopus', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1_000_000 });
  assert(pcm.length > 0 && pcm.length <= 640_000 && pcm.length % 2 === 0);
  const meeting = await service.create({ title: '本机真实 ASR 验证' });
  const startTranscription = performance.now();
  const result = await service.appendAudio({ meetingId: meeting.id, mimeType: 'audio/webm',
    data: new Uint8Array(webm), pcm: new Uint8Array(pcm), capturedAt: new Date().toISOString() });
  const transcriptionMs = Math.round(performance.now() - startTranscription);
  assert(result.transcript.length > 0 && result.transcript[0].text.length > 0);
  const audioDirectory = await service.getAudioDirectory(meeting.id);
  assert.deepEqual(await readFile(path.join(audioDirectory, '分片/000001.webm')), webm);
  evidence = { checkedAt: new Date().toISOString(), status: 'PASS', engine: 'sensevoice', device: 'cpu',
    copiedServiceSource: true, sharedVenvSync: false, modelDownloads: false,
    startupMs, transcriptionMs, pcmBytes: pcm.length, audioSeconds: pcm.length / 32_000,
    capabilities, transcript: result.transcript.map(({ text, speaker }) => ({ text, speaker })),
  };
} finally {
  if (service) await service.stop();
  await rm(temporary, { recursive: true, force: true });
}
console.log('MEETING_AGENT_REAL_ASR_SMOKE=' + JSON.stringify({ ...evidence, processStopped: true }));
