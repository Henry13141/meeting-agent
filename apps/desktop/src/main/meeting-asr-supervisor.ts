import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { hasChildExited, terminateChildProcess } from './child-process-lifecycle';
import { MeetingAsrClient, type MeetingAsrEnvironment } from './meeting-asr-client';
import {
  MEETING_ASR_PROTOCOL_VERSION,
  verifyPackagedMeetingAsr,
} from './meeting-asr-artifact';
import { resolveManagedMeetingAsrPaths } from './meeting-asr-project-models';

type MeetingAsrSupervisorOptions = Readonly<{
  environment: MeetingAsrEnvironment;
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
  homePath: string;
  /** Independent app: execute copied service with an existing, unchanged venv. */
  serviceProjectPath?: string;
  pythonExecutable?: string;
  fetchImplementation?: typeof fetch;
  spawnImplementation?: MeetingAsrSpawn;
}>;

type MeetingAsrSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export type MeetingAsrCapabilities = Readonly<{
  localAsr: boolean;
  speakerDiarization: boolean;
  voiceActivation: boolean;
  speechSynthesis: boolean;
}>;

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('MEETING_ASR_PORT_UNAVAILABLE'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function optional(environment: MeetingAsrEnvironment, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value || undefined;
}

function enabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (!['true', 'false'].includes(value.trim().toLowerCase())) {
    throw new Error('MEETING_ASR_CONFIGURATION_INVALID');
  }
  return value.trim().toLowerCase() === 'true';
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isRegularDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await lstat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

export function meetingAsrVenvPython(venv: string): string {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

async function venvHasSitePackage(venv: string, name: string): Promise<boolean> {
  if (await isRegularDirectory(path.join(venv, 'Lib', 'site-packages', name))) return true;
  try {
    const lib = path.join(venv, 'lib');
    for (const entry of await readdir(lib)) {
      if (entry.startsWith('python')
        && await isRegularDirectory(path.join(lib, entry, 'site-packages', name))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function venvHasCurrentProject(venv: string, project: string): Promise<boolean> {
  const sites = process.platform === 'win32'
    ? [path.join(venv, 'Lib', 'site-packages')]
    : await readdir(path.join(venv, 'lib')).then((entries) => entries
      .filter((entry) => entry.startsWith('python'))
      .map((entry) => path.join(venv, 'lib', entry, 'site-packages'))).catch(() => []);
  const expected = path.normalize(path.join(project, 'src'));
  for (const site of sites) {
    if (await isRegularDirectory(path.join(site, 'meeting_asr'))) return true;
    const editable = await readFile(path.join(site, '_editable_impl_meeting_asr.pth'), 'utf8')
      .catch(() => '');
    if (editable.split(/\r?\n/u).some((line) => {
      const actual = path.normalize(line.trim());
      return process.platform === 'win32'
        ? actual.toLowerCase() === expected.toLowerCase()
        : actual === expected;
    })) return true;
  }
  return false;
}

export async function resolveReadyMeetingAsrVenv(
  project: string,
  environment: MeetingAsrEnvironment,
  engine: 'qwen' | 'sensevoice' = 'sensevoice',
): Promise<string | undefined> {
  const candidates = [
    optional(environment, 'UV_PROJECT_ENVIRONMENT'),
    optional(environment, 'MEETING_ASR_VENV'),
    path.join(project, '.venv-asr-v2'),
    path.join(project, '.venv'),
  ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
  for (const venv of candidates) {
    if (!await isRegularFile(meetingAsrVenvPython(venv))) continue;
    if (await venvHasSitePackage(venv, 'torch')
      && await venvHasSitePackage(venv, 'funasr')
      && (engine !== 'qwen' || await venvHasSitePackage(venv, 'qwen_asr'))
      && await venvHasCurrentProject(venv, project)) {
      return venv;
    }
  }
  return undefined;
}

export class MeetingAsrSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private managedClient: MeetingAsrClient | null = null;
  private starting: Promise<MeetingAsrClient | null> | null = null;
  private managedUnavailable: Error | null = null;
  private managedUnavailableAt = 0;
  private readonly fetchImplementation: typeof fetch;
  private readonly spawnImplementation: MeetingAsrSpawn;

  constructor(private readonly options: MeetingAsrSupervisorOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.spawnImplementation = options.spawnImplementation ?? ((command, args, spawnOptions) => (
      spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams
    ));
  }

  get unavailableReason(): string | null {
    return this.managedUnavailable?.message ?? null;
  }

  get running(): boolean {
    return this.child !== null && !hasChildExited(this.child);
  }

  async client(): Promise<MeetingAsrClient | null> {
    const external = MeetingAsrClient.fromEnvironment(
      this.options.environment,
      this.fetchImplementation,
    );
    if (external) return external;
    if (!await resolveManagedMeetingAsrPaths(this.options)) return null;
    if (this.managedUnavailable && Date.now() - this.managedUnavailableAt < 15_000) return null;
    if (this.managedClient && this.child && !hasChildExited(this.child)) return this.managedClient;
    if (this.starting) return await this.starting;
    this.starting = this.spawnAndWait().then(
      (client) => {
        this.managedUnavailable = null;
        this.managedUnavailableAt = 0;
        return client;
      },
      (error: unknown) => {
        this.managedUnavailable = error instanceof Error ? error : new Error('MEETING_ASR_START_FAILED');
        this.managedUnavailableAt = Date.now();
        console.error('[meeting-asr] managed sidecar unavailable', this.managedUnavailable.message);
        return null;
      },
    );
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async capabilities(): Promise<MeetingAsrCapabilities> {
    const client = await this.client();
    return {
      localAsr: client !== null,
      speakerDiarization: client?.speakerDiarization ?? false,
      voiceActivation: client?.voiceActivation ?? false,
      speechSynthesis: client ? await client.speechSynthesisAvailable() : false,
    };
  }

  private async spawnAndWait(): Promise<MeetingAsrClient> {
    const environment = this.options.environment;
    const resolved = await resolveManagedMeetingAsrPaths(this.options);
    const modelPath = resolved?.modelPath;
    if (!modelPath) throw new Error('MEETING_ASR_CONFIGURATION_INVALID');
    const engine = resolved.engine ?? 'sensevoice';
    const model = optional(environment, 'MEETING_ASR_MODEL') ?? (engine === 'qwen' ? 'qwen3-asr' : 'sensevoice');
    const device = optional(environment, 'MEETING_ASR_DEVICE') ?? 'auto';
    const language = optional(environment, 'MEETING_ASR_LANGUAGE') ?? 'Chinese';
    const threads = optional(environment, 'MEETING_ASR_THREADS') ?? '4';
    if (!['Chinese', 'auto'].includes(language) || !/^\d+$/.test(threads)
      || Number(threads) < 1 || Number(threads) > 32) throw new Error('MEETING_ASR_CONFIGURATION_INVALID');
    const diarization = enabled(environment.MEETING_ASR_DIARIZATION);
    const vadPath = optional(environment, 'MEETING_ASR_VAD_MODEL_PATH');
    const speakerPath = optional(environment, 'MEETING_ASR_SPEAKER_MODEL_PATH');
    const alignerPath = optional(environment, 'MEETING_ASR_ALIGNER_MODEL_PATH')
      ?? resolved.alignerModelPath;
    const glossaryPath = optional(environment, 'MEETING_ASR_GLOSSARY_PATH');
    const wakeModelDirectory = resolved.wakeModelDir;
    const wakeFile = (environmentName: string, filename: string): string | undefined => (
      optional(environment, environmentName)
      ?? (wakeModelDirectory ? path.join(wakeModelDirectory, filename) : undefined)
    );
    const wakePaths = [
      ['--wake-vad-model-path', wakeFile('MEETING_ASR_WAKE_VAD_MODEL_PATH', 'silero_vad.onnx')],
      ['--wake-tokens-path', wakeFile('MEETING_ASR_WAKE_TOKENS_PATH', 'tokens.txt')],
      ['--wake-encoder-path', wakeFile('MEETING_ASR_WAKE_ENCODER_PATH', 'encoder.onnx')],
      ['--wake-decoder-path', wakeFile('MEETING_ASR_WAKE_DECODER_PATH', 'decoder.onnx')],
      ['--wake-joiner-path', wakeFile('MEETING_ASR_WAKE_JOINER_PATH', 'joiner.onnx')],
      ['--wake-keywords-path', wakeFile('MEETING_ASR_WAKE_KEYWORDS_PATH', 'keywords.txt')],
    ] as const;
    const voiceActivation = wakePaths.every(([, value]) => Boolean(value));
    if (
      model.length > 200
      || device.length > 64
      || (diarization && !speakerPath)
      || (alignerPath && engine !== 'qwen')
    ) {
      throw new Error('MEETING_ASR_CONFIGURATION_INVALID');
    }
    if (wakePaths.some(([, value]) => Boolean(value)) && !voiceActivation) {
      throw new Error('MEETING_ASR_CONFIGURATION_INVALID');
    }
    const port = await availablePort();
    const bearer = randomBytes(32).toString('base64url');
    const commonArgs = [
      '--host', '127.0.0.1',
      '--port', String(port),
      '--model-alias', model,
      '--model-path', modelPath,
      '--engine', engine,
      '--device', device,
      '--language', language,
      '--threads', threads,
      ...(vadPath ? ['--vad-model-path', vadPath] : []),
      ...(speakerPath ? ['--speaker-model-path', speakerPath] : []),
      ...(alignerPath ? ['--aligner-model-path', alignerPath] : []),
      ...(glossaryPath ? ['--glossary-path', glossaryPath] : []),
      ...(diarization ? ['--diarization'] : []),
      ...wakePaths.flatMap(([name, value]) => value ? [name, value] : []),
    ];
    const project = this.options.serviceProjectPath
      ?? path.resolve(this.options.appPath, '../../services/meeting-asr');
    const explicitPython = this.options.pythonExecutable;
    if (explicitPython && (!path.isAbsolute(explicitPython)
      || !await stat(explicitPython).then((value) => value.isFile()).catch(() => false))) {
      throw new Error('MEETING_ASR_PYTHON_UNAVAILABLE');
    }
    if (explicitPython && !await isRegularFile(
      path.join(project, 'src', 'meeting_asr', '__main__.py'),
    )) throw new Error('MEETING_ASR_SERVICE_SOURCE_UNAVAILABLE');
    const readyVenv = this.options.packaged || explicitPython
      ? undefined
      : await resolveReadyMeetingAsrVenv(project, environment, engine);
    const launch = this.options.packaged
      ? await verifyPackagedMeetingAsr(this.options.resourcesPath)
      : explicitPython
        ? {
          executablePath: explicitPython,
          workingDirectory: project,
          args: ['-B', '-m', 'meeting_asr', ...commonArgs],
        }
        : readyVenv
        ? {
          executablePath: meetingAsrVenvPython(readyVenv),
          workingDirectory: project,
          args: ['-m', 'meeting_asr', ...commonArgs],
        }
        : {
          executablePath: 'uv',
          workingDirectory: project,
          args: [
            'run',
            '--offline',
            '--inexact',
            '--project',
            project,
            '--extra',
            'funasr',
            '--extra',
            'voice',
            ...(engine === 'qwen' ? ['--extra', 'qwen'] : []),
            'python', '-m', 'meeting_asr',
            ...commonArgs,
          ],
        };
    if (engine === 'qwen' && 'manifest' in launch && !launch.manifest.qwenAsrVersion) {
      throw new Error('MEETING_ASR_ARTIFACT_QWEN_UNAVAILABLE');
    }
    const child = this.spawnImplementation(
      launch.executablePath,
      'args' in launch ? launch.args : commonArgs,
      {
        cwd: launch.workingDirectory,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: this.options.environment.PATH ?? this.options.environment.Path ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: this.options.environment.HOME ?? this.options.homePath,
          USERPROFILE: this.options.environment.USERPROFILE ?? this.options.homePath,
          ...(this.options.environment.LOCALAPPDATA ? { LOCALAPPDATA: this.options.environment.LOCALAPPDATA } : {}),
          ...(this.options.environment.UV_CACHE_DIR ? { UV_CACHE_DIR: this.options.environment.UV_CACHE_DIR } : {}),
          LANG: this.options.environment.LANG ?? 'C.UTF-8',
          ...(this.options.environment.SystemRoot
            ? { SystemRoot: this.options.environment.SystemRoot }
            : {}),
          ...(this.options.environment.TEMP ? { TEMP: this.options.environment.TEMP } : {}),
          ...(this.options.environment.TMP ? { TMP: this.options.environment.TMP } : {}),
          NO_PROXY: '127.0.0.1,localhost,::1',
          no_proxy: '127.0.0.1,localhost,::1',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          MODELSCOPE_OFFLINE: '1',
          ...(explicitPython ? {
            PYTHONPATH: path.join(project, 'src'),
            PYTHONDONTWRITEBYTECODE: '1',
          } : {}),
          ...(!this.options.packaged && !explicitPython
            ? { UV_PROJECT_ENVIRONMENT: readyVenv ?? path.join(project, '.venv-asr-v2') }
            : {}),
          MEETING_ASR_BEARER: bearer,
        },
      },
    );
    this.child = child;
    let launchError: Error | null = null;
    child.stdin.end();
    child.once('error', (error) => {
      launchError = error;
    });
    child.stdout.on('data', (chunk) => console.info(`[meeting-asr] ${String(chunk).trimEnd()}`));
    child.stderr.on('data', (chunk) => console.error(`[meeting-asr] ${String(chunk).trimEnd()}`));
    child.once('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.managedClient = null;
      }
    });
    const client = MeetingAsrClient.forManagedLoopback(
      port,
      bearer,
      model,
      diarization,
      voiceActivation,
      this.fetchImplementation,
      Boolean(alignerPath),
    );
    const deadline = Date.now() + 240_000;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      if (launchError) {
        if (this.child === child) this.child = null;
        throw launchError;
      }
      if (hasChildExited(child)) throw new Error(`MEETING_ASR_EXITED_${child.exitCode}`);
      try {
        const response = await this.fetchImplementation(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2_000),
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`MEETING_ASR_HEALTH_${response.status}`);
        const health = await response.json() as Record<string, unknown>;
        if (
          health.ready !== true
          || health.service !== 'meeting-asr'
          || health.protocolVersion !== MEETING_ASR_PROTOCOL_VERSION
          || health.speakerDiarization !== diarization
          || (health.timestampSegments === true) !== Boolean(alignerPath)
          || health.voiceActivation !== voiceActivation
        ) throw new Error('MEETING_ASR_HEALTH_INVALID');
        this.managedClient = client;
        return client;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await terminateChildProcess(child);
    if (this.child === child) this.child = null;
    throw lastError instanceof Error ? lastError : new Error('MEETING_ASR_START_TIMEOUT');
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.managedClient = null;
    if (!child || hasChildExited(child)) return;
    if (!await terminateChildProcess(child)) throw new Error('MEETING_ASR_STOP_TIMEOUT');
    if (this.child === child) this.child = null;
  }
}
