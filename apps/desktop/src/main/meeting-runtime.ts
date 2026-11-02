import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface MeetingRuntimeOptions {
  projectRoot: string;
  /** Explicit interpreter path; dependencies may come from an existing source venv. */
  sourcePython: string;
  /** Main-only overrides, constrained to projectRoot/.local-data descendants. */
  dataRoot?: string;
  workspacesRoot?: string;
  environment?: NodeJS.ProcessEnv;
}
export interface MeetingRuntimeHealth {
  ready: boolean; scaffoldMode: boolean; protocolVersion: string;
  [key: string]: unknown;
}
export interface MeetingRuntimeStatus {
  ready: boolean; modelReady: boolean; configured: boolean;
  phase: 'stopped' | 'starting' | 'ready' | 'failed';
  error?: string; health?: MeetingRuntimeHealth;
}
export interface MeetingThread {
  id: string; workspaceRoot: string; title: string; mode: 'basic';
  createdAt: number; hasRuns: boolean;
}
export interface MeetingCatalog {
  revision: string; defaultProfileId: string;
  profiles: Array<{ id: string; displayName: string; enabled: boolean; [key: string]: unknown }>;
}
export interface MeetingCapability { revision: string; [key: string]: unknown }
export interface MeetingRun { id: string; requestId: string; threadId: string; status: string; [key: string]: unknown }
export interface MeetingEventPage {
  events: Array<{ sequence: number; event: string; data: unknown; createdAt: number }>;
  status: string; nextAfter: number;
}
export interface MeetingRunInput {
  requestId?: string; message: string; modelProfileId?: string;
  thinking?: { enabled: boolean; effort?: 'low' | 'high' | 'max' };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_FIELDS = new Set(['requestId', 'message', 'modelProfileId', 'thinking', 'accessMode',
  'workspaceReadAllowed', 'fullAccess', 'mcpTools', 'mcpWriteTools', 'durableMemoryWrite', 'approvalMode']);

function fail(code: string): never { throw new Error(code); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
    const timer = setTimeout(done, timeoutMs); child.once('exit', done);
  });
}
function boundedInteger(value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) fail('MEETING_RUNTIME_PARAMETER_INVALID');
}
function modelFromEnvironment(env: NodeJS.ProcessEnv): { apiBase: string; apiKey: string; model: string } | null {
  const apiBase = env.MEETING_AGENT_API_BASE?.trim();
  const apiKey = env.MEETING_AGENT_API_KEY?.trim() ?? '';
  const model = env.MEETING_AGENT_MODEL?.trim();
  if (!apiBase && !apiKey && !model) return null;
  if (!apiBase || !model) fail('MODEL_CONFIGURATION_INCOMPLETE');
  let url: URL;
  try { url = new URL(apiBase); } catch { return fail('MODEL_CONFIGURATION_INVALID'); }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash || apiBase.length > 2048
      || apiKey.length > 4096 || /[\r\n]/.test(apiKey) || model.length > 256 || /[\r\n]/.test(model)) fail('MODEL_CONFIGURATION_INVALID');
  return { apiBase: apiBase.replace(/\/+$/, ''), apiKey, model };
}
async function freePort(): Promise<number> {
  const server = net.createServer();
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('MEETING_RUNTIME_PORT_UNAVAILABLE')); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

/** Main-only adapter. No Runtime URL, bearer, credentials or unrestricted HTTP escape hatch crosses IPC. */
export class MeetingRuntime {
  private readonly root: string;
  private readonly runtimeRoot: string;
  private readonly localRoot: string;
  private readonly dataRoot: string;
  private readonly workspacesRoot: string;
  private readonly environment: NodeJS.ProcessEnv;
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private baseUrl = '';
  private bearer = '';
  private health: MeetingRuntimeHealth | undefined;
  private phase: MeetingRuntimeStatus['phase'] = 'stopped';
  private error: string | undefined;
  private configured = false;
  private lifecycleAbort = new AbortController();
  private readonly threads = new Map<string, MeetingThread>();
  private readonly admittedThreads = new Set<string>();
  private readonly threadJobs = new Map<string, Promise<MeetingThread>>();
  private readonly streamReaders = new Set<Promise<void>>();

  constructor(private readonly options: MeetingRuntimeOptions) {
    if (!path.isAbsolute(options.projectRoot) || !path.isAbsolute(options.sourcePython)) fail('MEETING_RUNTIME_PATH_INVALID');
    this.root = path.resolve(options.projectRoot);
    this.runtimeRoot = path.join(this.root, 'services/runtime');
    this.localRoot = path.join(this.root, '.local-data');
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(this.localRoot, 'runtime'));
    this.workspacesRoot = path.resolve(options.workspacesRoot ?? path.join(this.localRoot, 'meeting-workspaces'));
    for (const storage of [this.dataRoot, this.workspacesRoot]) {
      const relative = path.relative(this.localRoot, storage);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('MEETING_RUNTIME_STORAGE_OUTSIDE_LOCAL_DATA');
    }
    this.environment = { ...(options.environment ?? process.env) };
  }

  async status(): Promise<MeetingRuntimeStatus> {
    if (this.child && this.phase === 'ready') {
      try { this.health = await this.request<MeetingRuntimeHealth>('/v1/health'); }
      catch { this.error = 'MEETING_RUNTIME_UNAVAILABLE'; this.health = undefined; }
    }
    return { ready: this.phase === 'ready' && this.health?.ready === true,
      modelReady: this.phase === 'ready' && this.health?.modelReady === true,
      configured: this.configured, phase: this.phase,
      ...(this.error ? { error: this.error } : {}), ...(this.health ? { health: this.health } : {}) };
  }

  async catalog(): Promise<MeetingCatalog> { await this.ensureStarted(); return await this.request('/v1/models'); }

  async ensureThread(contextId: string): Promise<MeetingThread> {
    if (typeof contextId !== 'string' || !contextId.trim() || contextId.length > 256) fail('MEETING_CONTEXT_INVALID');
    await this.ensureStarted();
    const cached = this.threads.get(contextId);
    if (cached) return cached;
    const running = this.threadJobs.get(contextId);
    if (running) return await running;
    const job = this.createThread(contextId);
    this.threadJobs.set(contextId, job);
    try { return await job; } finally { this.threadJobs.delete(contextId); }
  }

  async capability(threadId: string): Promise<MeetingCapability> {
    await this.ensureStarted(); this.assertThread(threadId);
    return await this.request(`/v1/threads/${threadId}/workspace-capability`);
  }

  async startRun(threadId: string, input: MeetingRunInput): Promise<{ runId: string; requestId: string }> {
    this.validateRunInput(input);
    await this.ensureStarted(); this.assertThread(threadId);
    this.health = await this.request<MeetingRuntimeHealth>('/v1/health');
    if (!this.health.modelReady) fail('MODEL_NOT_CONFIGURED');
    const catalog = await this.catalog();
    const profileId = input.modelProfileId ?? catalog.defaultProfileId;
    if (!catalog.profiles.some((p) => p.id === profileId && p.enabled)) fail('MEETING_MODEL_UNAVAILABLE');
    const capability = await this.capability(threadId);
    const requestId = input.requestId ?? randomUUID();
    if (!UUID.test(requestId)) fail('MEETING_REQUEST_ID_INVALID');
    const response = await this.fetchResponse(`/v1/threads/${threadId}/runs/stream`, {
      method: 'POST', body: JSON.stringify({ requestId, message: input.message.trim(),
        conversationMode: 'daily_chat', modelProfileId: profileId,
        thinking: input.thinking ?? { enabled: false }, catalogRevision: catalog.revision,
        capabilityRevision: capability.revision, accessMode: 'read_only', workspaceReadAllowed: false,
        fullAccess: false, approvalMode: 'on_request', durableMemoryWrite: 'unavailable', mcpTools: [], mcpWriteTools: [] }),
    }, 60_000);
    const runId = response.headers.get('x-meeting-agent-run-id');
    if (!runId || !UUID.test(runId)) { await response.body?.cancel(); fail('MEETING_RUNTIME_RUN_ID_MISSING'); }
    const reader = response.body?.getReader();
    if (!reader) fail('MEETING_RUNTIME_STREAM_MISSING');
    // Consume without buffering token history; durable event pages drive the UI and recovery.
    let pump!: Promise<void>;
    pump = (async () => {
      try { while (!(await reader.read()).done) { /* Runtime persists each event. */ } }
      catch { /* getRun/events remain authoritative after a stream disconnect. */ }
      finally { reader.releaseLock(); this.streamReaders.delete(pump); }
    })();
    this.streamReaders.add(pump);
    return { runId, requestId };
  }

  async getRun(threadId: string, runId: string): Promise<MeetingRun> {
    await this.ensureStarted(); this.assertRun(threadId, runId);
    return await this.request(`/v1/threads/${threadId}/runs/${runId}`);
  }

  async events(threadId: string, runId: string, after = 0, waitMs = 0): Promise<MeetingEventPage> {
    await this.ensureStarted(); this.assertRun(threadId, runId);
    boundedInteger(after, 0, Number.MAX_SAFE_INTEGER); boundedInteger(waitMs, 0, 30_000);
    return await this.request(`/v1/threads/${threadId}/runs/${runId}/events?after=${after}&waitMs=${waitMs}`, undefined, waitMs + 10_000);
  }

  async cancel(threadId: string, runId: string): Promise<{ cancelled: boolean; run: MeetingRun; event: unknown }> {
    await this.ensureStarted(); this.assertRun(threadId, runId);
    return await this.request(`/v1/threads/${threadId}/runs/${runId}/cancel`, { method: 'POST' });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return await this.stopPromise;
    const stopping = this.stopInternal(); this.stopPromise = stopping;
    try { await stopping; } finally { this.stopPromise = null; }
  }

  private async stopInternal(): Promise<void> {
    this.lifecycleAbort.abort();
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await waitForExit(child, 7_000);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await waitForExit(child, 3_000);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
    }
    this.child = null; this.health = undefined; this.baseUrl = ''; this.bearer = '';
    this.threads.clear(); this.admittedThreads.clear(); this.phase = 'stopped'; this.error = undefined;
  }

  private async ensureStarted(): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    if (this.phase === 'ready' && this.child) return;
    if (!this.startPromise) {
      this.startPromise = this.start().catch(async (error: unknown) => {
        this.phase = 'failed'; this.error = error instanceof Error ? error.message : 'MEETING_RUNTIME_START_FAILED';
        const failedChild = this.child; failedChild?.kill('SIGTERM');
        if (failedChild) await waitForExit(failedChild, 3_000);
        if (failedChild && failedChild.exitCode === null && failedChild.signalCode === null) { failedChild.kill('SIGKILL'); await waitForExit(failedChild, 3_000); }
        if (this.child === failedChild) this.child = null; this.health = undefined; throw error;
      }).finally(() => { this.startPromise = null; });
    }
    await this.startPromise;
  }

  private async start(): Promise<void> {
    this.lifecycleAbort = new AbortController();
    this.phase = 'starting'; this.error = undefined;
    await access(this.options.sourcePython, constants.X_OK);
    await access(path.join(this.runtimeRoot, 'src/meeting_runtime/__main__.py'));
    if (!(await stat(this.options.sourcePython)).isFile()) fail('MEETING_RUNTIME_PYTHON_INVALID');
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.workspacesRoot, { recursive: true, mode: 0o700 });
    // Storage may not be redirected into another product's data by a local symlink.
    const canonicalRoot = await realpath(this.root);
    for (const target of [this.localRoot, this.dataRoot, this.workspacesRoot]) {
      const canonical = await realpath(target);
      if (canonical !== path.resolve(canonicalRoot, path.relative(this.root, target))) fail('MEETING_RUNTIME_STORAGE_REDIRECTED');
    }
    let model: ReturnType<typeof modelFromEnvironment> = null;
    try { model = modelFromEnvironment(this.environment); }
    catch (error) { this.error = error instanceof Error ? error.message : 'MODEL_CONFIGURATION_INVALID'; }
    this.configured = model !== null;
    const port = await freePort();
    this.bearer = randomBytes(48).toString('base64url'); this.baseUrl = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR', 'USERPROFILE']) {
      if (this.environment[key] !== undefined) env[key] = this.environment[key];
    }
    Object.assign(env, { PYTHONPATH: path.join(this.runtimeRoot, 'src'), PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' });
    const child = spawn(this.options.sourcePython, ['-m', 'meeting_runtime'], { cwd: this.runtimeRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.resume(); child.stderr.resume();
    child.stdin.on('error', () => { /* An early Runtime exit is handled by health/startup checks. */ });
    child.once('error', () => { if (this.child === child) { this.phase = 'failed'; this.error = 'MEETING_RUNTIME_SPAWN_FAILED'; } });
    child.once('exit', () => {
      if (this.child === child) { this.lifecycleAbort.abort(); this.child = null; this.health = undefined;
        if (this.phase !== 'stopped') { this.phase = 'failed'; this.error = 'MEETING_RUNTIME_EXITED'; } }
    });
    child.stdin.write(JSON.stringify({ schemaVersion: 'meeting-runtime.v1', port,
      bearerToken: this.bearer, dataRoot: this.dataRoot,
      model, exitOnStdinClose: true }) + '\n');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.child !== child || child.exitCode !== null || child.signalCode !== null) fail('MEETING_RUNTIME_START_FAILED');
      try { this.health = await this.request<MeetingRuntimeHealth>('/v1/health', undefined, 1_000); if (this.health.ready) break; }
      catch { /* Python imports and database recovery complete before health is available. */ }
      await delay(100);
    }
    if (!this.health?.ready) fail('MEETING_RUNTIME_START_TIMEOUT');
    this.phase = 'ready';
  }

  private async createThread(contextId: string): Promise<MeetingThread> {
    const canonicalWorkspaces = await realpath(this.workspacesRoot);
    const expectedRoot = path.resolve(await realpath(this.root), path.relative(this.root, this.workspacesRoot));
    if (canonicalWorkspaces !== expectedRoot) fail('MEETING_RUNTIME_STORAGE_REDIRECTED');
    const directory = path.join(canonicalWorkspaces, createHash('sha256').update(contextId).digest('hex'));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) fail('MEETING_RUNTIME_STORAGE_REDIRECTED');
    const threads = await this.request<MeetingThread[]>(`/v1/threads?workspaceRoot=${encodeURIComponent(directory)}&limit=1`);
    const thread = threads[0] ?? await this.request<MeetingThread>('/v1/threads', {
      method: 'POST', body: JSON.stringify({ workspaceRoot: directory, mode: 'basic' }),
    });
    if (!UUID.test(thread.id) || thread.workspaceRoot !== directory || thread.mode !== 'basic') fail('MEETING_RUNTIME_THREAD_INVALID');
    this.threads.set(contextId, thread); this.admittedThreads.add(thread.id); return thread;
  }
  private assertThread(threadId: string): void {
    if (typeof threadId !== 'string' || !UUID.test(threadId) || !this.admittedThreads.has(threadId)) fail('MEETING_THREAD_NOT_AUTHORIZED');
  }
  private assertRun(threadId: string, runId: string): void {
    this.assertThread(threadId); if (typeof runId !== 'string' || !UUID.test(runId)) fail('MEETING_RUN_ID_INVALID');
  }
  private validateRunInput(input: MeetingRunInput): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('MEETING_RUN_INPUT_INVALID');
    const raw = input as unknown as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !INPUT_FIELDS.has(key))) fail('MEETING_READ_ONLY_REQUIRED');
    if ((raw.accessMode !== undefined && raw.accessMode !== 'read_only')
        || (raw.workspaceReadAllowed !== undefined && raw.workspaceReadAllowed !== false)
        || (raw.fullAccess !== undefined && raw.fullAccess !== false)
        || (raw.approvalMode !== undefined && raw.approvalMode !== 'on_request')
        || (raw.durableMemoryWrite !== undefined && raw.durableMemoryWrite !== 'unavailable')
        || ['mcpTools', 'mcpWriteTools'].some((key) => raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].length !== 0))) {
      fail('MEETING_READ_ONLY_REQUIRED');
    }
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 24_000) fail('MEETING_MESSAGE_INVALID');
  }
  private async request<T>(route: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
    const response = await this.fetchResponse(route, init, timeoutMs);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
  private async fetchResponse(route: string, init?: RequestInit, timeoutMs = 15_000): Promise<Response> {
    if (!this.baseUrl || !this.bearer) fail('MEETING_RUNTIME_STOPPED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.baseUrl + route, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.bearer}` } });
      if (!response.ok) {
        // Never surface response payloads containing credential inputs or private prompt content.
        await response.body?.cancel(); fail(`MEETING_RUNTIME_HTTP_${response.status}`);
      }
      return response;
    } finally { clearTimeout(timer); }
  }
}
