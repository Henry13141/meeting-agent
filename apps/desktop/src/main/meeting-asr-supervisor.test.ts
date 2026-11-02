import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeetingAsrSupervisor, meetingAsrVenvPython, resolveReadyMeetingAsrVenv } from './meeting-asr-supervisor';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function supervisor(
  environment: Record<string, string | undefined>,
  fetchImplementation: typeof fetch = fetch,
): MeetingAsrSupervisor {
  return new MeetingAsrSupervisor({
    environment,
    packaged: false,
    appPath: 'E:/repo/apps/desktop',
    resourcesPath: 'E:/repo/resources',
    homePath: 'E:/home',
    fetchImplementation,
  });
}

function failedSidecar(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: 1,
    signalCode: null,
    pid: 4242,
    kill: () => true,
  });
  return child;
}

describe('MeetingAsrSupervisor', () => {
  it('stays disabled when neither an external endpoint nor a local model is configured', async () => {
    await expect(supervisor({}).capabilities()).resolves.toEqual({
      localAsr: false,
      speakerDiarization: false,
      voiceActivation: false,
      speechSynthesis: false,
    });
  });

  it('prefers an explicitly configured authenticated loopback endpoint', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ready: true,
      service: 'meeting-asr',
      protocolVersion: 'meeting-asr.v2',
      speakerDiarization: true,
      voiceActivation: false,
      speechSynthesis: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const instance = supervisor({
      MEETING_ASR_URL: 'http://127.0.0.1:9421/v1/audio/transcriptions',
      MEETING_ASR_BEARER: 'external-asr-bearer-long-enough',
      MEETING_ASR_MODEL_PATH: 'E:/models/local',
      MEETING_ASR_DIARIZATION: 'true',
    }, fetchImplementation);
    await expect(instance.capabilities()).resolves.toEqual({
      localAsr: true,
      speakerDiarization: true,
      voiceActivation: false,
      speechSynthesis: true,
    });
    expect(String(fetchImplementation.mock.calls[0]?.[0])).toBe('http://127.0.0.1:9421/health');
    await expect(instance.stop()).resolves.toBeUndefined();
  });

  it('fails closed for malformed external service configuration', async () => {
    await expect(supervisor({
      MEETING_ASR_URL: 'https://example.com/v1/audio/transcriptions',
      MEETING_ASR_BEARER: 'external-asr-bearer-long-enough',
    }).client()).rejects.toThrow('MEETING_ASR_CONFIGURATION_INVALID');
  });

  it('backs off after a failed managed sidecar, then permits a retry', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-meeting-asr-'));
    roots.push(root);
    const appPath = path.join(root, 'apps', 'desktop');
    const modelDir = path.join(root, 'models', 'meeting-asr', 'SenseVoiceSmall');
    await mkdir(appPath, { recursive: true });
    await mkdir(modelDir, { recursive: true });
    await writeFile(path.join(modelDir, 'config.yaml'), 'model: SenseVoiceSmall\n');
    await writeFile(path.join(modelDir, 'model.pt'), 'weights');
    const spawnImplementation = vi.fn(() => failedSidecar());
    const instance = new MeetingAsrSupervisor({
      environment: {},
      packaged: false,
      appPath,
      resourcesPath: path.join(root, 'resources'),
      homePath: path.join(root, 'home'),
      spawnImplementation,
    });
    await expect(instance.client()).resolves.toBeNull();
    await expect(instance.capabilities()).resolves.toEqual({
      localAsr: false,
      speakerDiarization: false,
      voiceActivation: false,
      speechSynthesis: false,
    });
    expect(spawnImplementation).toHaveBeenCalledTimes(1);
    now.mockReturnValue(115_001);
    await expect(instance.client()).resolves.toBeNull();
    expect(spawnImplementation).toHaveBeenCalledTimes(2);
  });

  it('uses only a venv bound to the current project and with the selected engine', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-meeting-asr-venv-'));
    roots.push(root);
    const project = path.join(root, 'services', 'meeting-asr');
    const venv = path.join(project, '.venv');
    const python = meetingAsrVenvPython(venv);
    const site = process.platform === 'win32'
      ? path.join(venv, 'Lib', 'site-packages')
      : path.join(venv, 'lib', 'python3.12', 'site-packages');
    await mkdir(path.dirname(python), { recursive: true });
    await mkdir(path.join(site, 'torch'), { recursive: true });
    await mkdir(path.join(site, 'funasr'), { recursive: true });
    await writeFile(python, '');
    await writeFile(path.join(site, '_editable_impl_meeting_asr.pth'), path.join(root, 'old-checkout', 'src'));
    await expect(resolveReadyMeetingAsrVenv(project, {})).resolves.toBeUndefined();
    await writeFile(path.join(site, '_editable_impl_meeting_asr.pth'), path.join(project, 'src'));
    await expect(resolveReadyMeetingAsrVenv(project, {})).resolves.toBe(venv);
    await expect(resolveReadyMeetingAsrVenv(project, {}, 'qwen')).resolves.toBeUndefined();
    await mkdir(path.join(site, 'qwen_asr'));
    await expect(resolveReadyMeetingAsrVenv(project, {}, 'qwen')).resolves.toBe(venv);
    await expect(resolveReadyMeetingAsrVenv(project, {
      UV_PROJECT_ENVIRONMENT: path.join(project, '.venv-asr-v2'),
    })).resolves.toBe(venv);
  });
});


describe('independent ASR source checkout', () => {
  it('executes a configured Python against copied service source without synchronizing the shared venv', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'independent-meeting-asr-'));
    roots.push(root);
    const project = path.join(root, 'copied-service');
    const python = path.join(root, 'source-venv', 'python');
    const model = path.join(root, 'model');
    await mkdir(path.join(project, 'src/meeting_asr'), { recursive: true });
    await writeFile(path.join(project, 'src/meeting_asr/__main__.py'), '# copied service');
    await mkdir(path.dirname(python), { recursive: true });
    await mkdir(model);
    await writeFile(python, 'python-placeholder');
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, pid: 4242,
      kill(signal: string) { Object.assign(child, { signalCode: signal }); child.emit('exit'); return true; },
    });
    const launch = vi.fn((_command: string, _args: readonly string[], _options: import('node:child_process').SpawnOptions) => child);
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ready: true, service: 'meeting-asr', protocolVersion: 'meeting-asr.v2',
      speakerDiarization: false, timestampSegments: false, voiceActivation: false,
    })));
    const instance = new MeetingAsrSupervisor({
      environment: { MEETING_ASR_MODEL_PATH: model, MEETING_ASR_ENGINE: 'sensevoice' },
      packaged: false, appPath: path.join(root, 'apps/desktop'), resourcesPath: root, homePath: root,
      serviceProjectPath: project, pythonExecutable: python,
      fetchImplementation, spawnImplementation: launch,
    });
    try {
      expect(await instance.client()).not.toBeNull();
      const [command, args, options] = launch.mock.calls[0]!;
      expect(command).toBe(python);
      expect(args.slice(0, 3)).toEqual(['-B', '-m', 'meeting_asr']);
      expect(options.cwd).toBe(project);
      expect(options.env?.PYTHONPATH).toBe(path.join(project, 'src'));
      expect(options.env?.PYTHONDONTWRITEBYTECODE).toBe('1');
      expect(options.env?.HF_HUB_OFFLINE).toBe('1');
      expect(options.env?.UV_PROJECT_ENVIRONMENT).toBeUndefined();
    } finally { await instance.stop(); }
  });

  it('fails closed rather than invoking uv when configured Python is missing', async () => {
    const launch = vi.fn();
    const instance = new MeetingAsrSupervisor({
      environment: { MEETING_ASR_MODEL_PATH: '/local/model', MEETING_ASR_ENGINE: 'sensevoice' },
      packaged: false, appPath: '/independent/apps/desktop', resourcesPath: '/independent', homePath: '/local/home',
      serviceProjectPath: '/independent/services/meeting-asr', pythonExecutable: '/missing/python',
      spawnImplementation: launch,
    });
    expect(await instance.client()).toBeNull();
    expect(instance.unavailableReason).toBe('MEETING_ASR_PYTHON_UNAVAILABLE');
    expect(launch).not.toHaveBeenCalled();
  });
});
