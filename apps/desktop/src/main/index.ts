import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { mkdir, readFile, writeFile, lstat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as C from '../shared/contracts';
import type { StandaloneStatus } from '../shared/standalone-contracts';
import { MeetingRuntime } from './meeting-runtime';
import { LocalMeetingService } from './local-meeting-service';
import { projectMeetingRun, projectMeetingCancellation } from './meeting-run-projection';
import { loadModelEnvironment } from './model-environment';

const projectRoot = path.resolve(__dirname, '../../../..');
const smoke = process.env.MEETING_AGENT_SMOKE === '1';
const dataRoot = path.join(projectRoot, '.local-data', ...(smoke ? ['smoke'] : []));
app.setName('Meeting Agent');
app.setPath('userData', path.join(dataRoot, 'electron'));
let window: BrowserWindow | null = null;
let runtime: MeetingRuntime;
let meetings: LocalMeetingService;
let modelEnvironmentError: string | undefined;
let quitting = false;
let rendererCloseReady = false;
let shutdownJob: Promise<void> | null = null;
let pendingFlush: { nonce: string; resolve: () => void; reject: (error: Error) => void } | null = null;
let asrReady = false;
let asrError: string | undefined;
const runRequests = new Map<string, { threadId: string; requestId: string }>();
const runEventCursor = new Map<string, number>();

const localPathsSchema = z.object({
  runtimePython: z.string().optional(),
  asrPython: z.string().optional(),
  asrModelPath: z.string().optional(),
}).strict();

function trusted(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('MEETING_IPC_SENDER_REJECTED');
  const expected = process.env.ELECTRON_RENDERER_URL;
  const actual = event.senderFrame.url;
  if (expected ? new URL(actual).origin !== new URL(expected).origin : actual !== pathToFileURL(path.join(__dirname, '../renderer/index.html')).href) {
    throw new Error('MEETING_IPC_ORIGIN_REJECTED');
  }
}

function safeError(error: unknown): Error {
  if (error instanceof z.ZodError) return new Error('MEETING_REQUEST_INVALID');
  const message = error instanceof Error ? error.message : '';
  return new Error(/^[A-Z][A-Z0-9_:.-]{1,179}$/.test(message) ? message : 'MEETING_OPERATION_FAILED');
}

function register(channel: string, methodTable: Record<string, (args: unknown[]) => unknown | Promise<unknown>>) {
  ipcMain.handle(channel, async (event, method: unknown, args: unknown) => {
    trusted(event);
    if (typeof method !== 'string' || !Object.hasOwn(methodTable, method) || !Array.isArray(args) || args.length > 4) throw new Error('MEETING_IPC_METHOD_REJECTED');
    try { return await methodTable[method]!(args); } catch (error) { throw safeError(error); }
  });
}

const id = (value: unknown) => C.identifierSchema.parse(value);
const unavailable = (code: string): never => { throw new Error(code); };
const noArgs = (args: unknown[]) => z.tuple([]).parse(args);

async function flushRenderer(): Promise<void> {
  if (!window || window.isDestroyed() || !rendererCloseReady) return;
  const nonce = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingFlush = null;
      reject(new Error('MEETING_CLOSE_FLUSH_TIMEOUT'));
    }, 45_000);
    pendingFlush = { nonce, resolve: () => { clearTimeout(timer); pendingFlush = null; resolve(); },
      reject: (error) => { clearTimeout(timer); pendingFlush = null; reject(error); } };
    window!.webContents.send('meeting-agent:prepare-close', nonce);
  });
}

function shutdown(): Promise<void> {
  if (shutdownJob) return shutdownJob;
  shutdownJob = (async () => {
    try {
      await flushRenderer();
      await Promise.all([meetings?.stop(), runtime?.stop()]);
      quitting = true;
      app.quit();
    } catch {
      shutdownJob = null;
      dialog.showErrorBox('会议记录尚未保存完成', '已保留会议窗口和现有录音。请等待转写保存结束，或先暂停记录后再次退出。');
    }
  })();
  return shutdownJob;
}

async function setup() {
  await mkdir(dataRoot, { recursive: true });
  const configPath = path.join(projectRoot, '.local-paths.json');
  const localPaths = await readFile(configPath, 'utf8').then((text) => localPathsSchema.parse(JSON.parse(text))).catch(() => ({} as z.infer<typeof localPathsSchema>));
  const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const python = process.env.MEETING_AGENT_RUNTIME_PYTHON || localPaths.runtimePython || path.join(projectRoot, 'services/runtime/.venv', executable);
  let environment: NodeJS.ProcessEnv;
  try { environment = await loadModelEnvironment(projectRoot); }
  catch { modelEnvironmentError = 'MODEL_ENV_INVALID'; environment = { ...process.env, MEETING_AGENT_API_BASE: '', MEETING_AGENT_API_KEY: '', MEETING_AGENT_MODEL: '' }; }
  runtime = new MeetingRuntime({ projectRoot, sourcePython: python,
    ...(smoke ? { dataRoot: path.join(dataRoot, 'runtime'), workspacesRoot: path.join(dataRoot, 'meeting-workspaces') } : {}),
    environment,
  });
  meetings = new LocalMeetingService({ projectRoot, dataRoot,
    recordingsRoot: path.join(dataRoot, 'recordings'),
    environment: { ...process.env,
      ...(localPaths.asrPython ? { MEETING_AGENT_ASR_PYTHON: localPaths.asrPython } : {}),
      ...(localPaths.asrModelPath ? { MEETING_AGENT_ASR_MODEL_PATH: localPaths.asrModelPath } : {}),
    },
  });

  register('meeting-agent:agent', {
    listModels: async (args) => { noArgs(args); return C.modelCatalogSchema.parse(await runtime.catalog()); },
    ensureConversationThread: async ([request]) => {
      const input = C.conversationThreadRequestSchema.parse(request);
      if (input.surface !== 'dialog' || !/^(meeting-assistant|meeting-(?:summary|dialog):[0-9a-f-]{36})$/.test(input.contextId)) throw new Error('MEETING_THREAD_SCOPE_REJECTED');
      const thread = await runtime.ensureThread(input.contextId);
      return C.threadSchema.parse({ id: thread.id, workspaceGrantId: thread.id, workspaceLabel: '会议专用会话',
        title: '会议', mode: thread.mode, createdAt: thread.createdAt, hasRuns: thread.hasRuns });
    },
    getCodeWorkspaceCapability: async ([threadId]) => C.codeWorkspaceCapabilitySchema.parse(await runtime.capability(id(threadId))),
    startRun: async ([request]) => {
      const input = C.runRequestSchema.parse(request);
      if (input.knowledgeProjectId) throw new Error('MEETING_KNOWLEDGE_NOT_CONNECTED');
      const accepted = await runtime.startRun(input.threadId, { requestId: input.requestId, message: input.message, modelProfileId: input.modelProfileId, thinking: input.thinking });
      runRequests.set(accepted.runId, { threadId: input.threadId, requestId: input.requestId });
      return { accepted: true, runId: accepted.runId };
    },
    getRun: async ([threadId, runId]) => projectMeetingRun(await runtime.getRun(id(threadId), id(runId))),
    getRunEvents: async ([threadId, runId, after = 0, waitMs = 0]) => {
      const thread = id(threadId); const run = id(runId);
      const page = C.runEventPageSchema.parse(await runtime.events(thread, run,
        z.number().int().min(0).parse(after), z.number().int().min(0).max(30_000).parse(waitMs)));
      const owner = runRequests.get(run);
      if (owner && owner.threadId === thread) for (const event of page.events) {
        if (event.sequence <= (runEventCursor.get(run) ?? 0)) continue;
        runEventCursor.set(run, event.sequence);
        if (window && !window.isDestroyed()) window.webContents.send('meeting-agent:run-event', { requestId: owner.requestId, event: event.event, data: event.data });
      }
      return page;
    },
    cancelRun: async ([threadId, runId, requestId]) => {
      const run = id(runId); const owner = runRequests.get(run);
      if (!owner || owner.threadId !== id(threadId) || owner.requestId !== id(requestId)) throw new Error('MEETING_RUN_SCOPE_REJECTED');
      return projectMeetingCancellation(await runtime.cancel(owner.threadId, run));
    },
    pickWorkspace: (args) => { noArgs(args); return null; },
    createThread: () => unavailable('MEETING_PROJECT_NOT_CONNECTED'),
  });

  const avatar = { provider: 'browser' as const, state: 'idle' as const, videoAttached: false };
  register('meeting-agent:meetings', {
    getCapabilities: async (args) => {
      noArgs(args);
      try {
        const capabilities = C.meetingCapabilitiesSchema.parse(await meetings.getCapabilities());
        asrReady = capabilities.localAsr;
        asrError = meetings.asrError ?? undefined;
        return { ...capabilities, tts: { provider: 'browser', configured: false, available: false } };
      } catch { asrError = 'MEETING_ASR_UNAVAILABLE'; throw new Error(asrError); }
    },
    warmAnswer: (args) => { noArgs(args); },
    list: async ([limit = 50]) => z.array(C.meetingRecordSchema).parse(await meetings.list(z.number().int().min(1).max(50).parse(limit))),
    create: async ([request]) => {
      const parsed = C.meetingCreateRequestSchema.parse(request);
      if (parsed.knowledgeProjectId) throw new Error('MEETING_KNOWLEDGE_NOT_CONNECTED');
      return C.meetingRecordSchema.parse(await meetings.create(parsed));
    },
    appendTranscript: async ([request]) => C.meetingRecordSchema.parse(await meetings.appendTranscript(C.meetingAppendTranscriptRequestSchema.parse(request))),
    appendAudio: async ([request]) => C.meetingRecordSchema.parse(await meetings.appendAudio(C.meetingAppendAudioRequestSchema.parse(request))),
    appendArchiveAudio: async ([request]) => { await meetings.appendArchiveAudio(C.meetingAppendArchiveAudioRequestSchema.parse(request)); },
    analyzeVoice: async ([request]) => C.meetingVoiceActivationResultSchema.parse(await meetings.analyzeVoice(C.meetingVoiceFrameRequestSchema.parse(request))),
    complete: async ([request]) => C.meetingRecordSchema.parse(await meetings.complete(C.meetingCompleteRequestSchema.parse(request))),
    readTranscript: async ([meetingId, after]) => C.meetingRecordSchema.parse(await meetings.readTranscript(id(meetingId), z.number().int().min(0).parse(after))),
    search: async ([request]) => z.array(C.meetingRecordSchema).parse(await meetings.search(C.meetingSearchRequestSchema.parse(request))),
    openAudioFolder: async ([meetingId]) => {
      const error = await shell.openPath(await meetings.getAudioDirectory(id(meetingId)));
      if (error) throw new Error('MEETING_AUDIO_OPEN_FAILED');
    },
    playAudio: async ([meetingId]) => {
      const error = await shell.openPath(await meetings.getPlayableAudioPath(id(meetingId)));
      if (error) throw new Error('MEETING_AUDIO_OPEN_FAILED');
    },
    exportAudio: async ([meetingId]) => {
      const meeting = id(meetingId);
      const result = await dialog.showOpenDialog(window!, { title: '选择录音导出目录', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths[0]) return null;
      const source = await meetings.exportAudio(meeting);
      const receipt = C.meetingAudioExportResultSchema.parse({ fileCount: source.files.length + 1 });
      const destination = path.join(result.filePaths[0], `会议录音-${randomUUID().slice(0, 8)}`);
      await mkdir(destination, { recursive: false });
      for (const file of [...source.files, path.join(source.directory, '播放完整录音.html')]) {
        const relative = path.relative(source.directory, file);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !(await lstat(file)).isFile()) throw new Error('MEETING_AUDIO_EXPORT_INVALID');
        const target = path.join(destination, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(file, target, 1);
      }
      return receipt;
    },
    getAvatarSession: (args) => { noArgs(args); return avatar; },
    prepareAvatar: (args) => { noArgs(args); return avatar; },
    releaseAvatar: (args) => { noArgs(args); return avatar; },
    interruptAvatar: (args) => { noArgs(args); },
    setAvatarLayout: ([request]) => { C.meetingAvatarLayoutRequestSchema.parse(request); },
    getAvatarUiUrl: () => unavailable('MEETING_AVATAR_NOT_CONNECTED'),
    speakAvatar: () => unavailable('MEETING_AVATAR_NOT_CONNECTED'),
    sendAvatarText: () => unavailable('MEETING_AVATAR_NOT_CONNECTED'),
    synthesizeSpeech: () => unavailable('MEETING_SPEECH_NOT_CONNECTED'),
    lookupWeather: () => unavailable('MEETING_WEB_SEARCH_NOT_CONNECTED'),
    exportDocument: () => unavailable('MEETING_DOCUMENT_NOT_CONNECTED'),
    listKnowledgeProjects: (args) => { noArgs(args); return []; },
    publishKnowledge: () => unavailable('MEETING_KNOWLEDGE_NOT_CONNECTED'),
    refreshKnowledge: async ([meetingId]) => C.meetingRecordSchema.parse(await meetings.get(id(meetingId))),
  });
  register('meeting-agent:standalone', {
    closeListenerReady: (args) => { noArgs(args); rendererCloseReady = true; },
    closeFlushed: ([nonce, succeeded]) => {
      if (!pendingFlush || id(nonce) !== pendingFlush.nonce) throw new Error('MEETING_CLOSE_RECEIPT_REJECTED');
      if (succeeded === true) pendingFlush.resolve();
      else pendingFlush.reject(new Error('MEETING_CLOSE_FLUSH_FAILED'));
    },
    status: async (args): Promise<StandaloneStatus> => {
      noArgs(args); const state = await runtime.status();
      return { application: 'Meeting Agent', runtime: { ready: state.ready, modelReady: state.modelReady && !modelEnvironmentError, phase: state.phase, error: modelEnvironmentError ?? state.error },
        asr: { ready: asrReady, error: meetings.asrError ?? asrError }, storage: '项目目录下 .local-data',
        externalIntegrations: '云文档与外部协作平台按需选配，当前仅本地保存' };
    },
    openDataDirectory: async (args) => { noArgs(args); const error = await shell.openPath(dataRoot); if (error) throw new Error('MEETING_DATA_OPEN_FAILED'); },
    exportMarkdown: async ([meetingId]) => {
      const meeting = await meetings.get(id(meetingId));
      if (meeting.status !== 'completed') throw new Error('MEETING_NOT_COMPLETED');
      const destination = await dialog.showSaveDialog(window!, { title: '导出会议纪要', defaultPath: meeting.title.replace(/[\\/:*?"<>|]/g, '_') + '.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (destination.canceled || !destination.filePath) return { exported: false };
      const transcript = await meetings.fullTranscript(meeting.id);
      const text = ['# ' + meeting.title, '', '开始时间：' + meeting.startedAt, '', '## 会议纪要', '', meeting.summary || '待生成纪要', '', '## 行动项', '', ...meeting.actionItems.map((item) => '- ' + item), '', '## 完整逐字稿', '', ...transcript.map((line) => `${line.capturedAt} ${line.speaker}：${line.text}`)].join('\n');
      await writeFile(destination.filePath, text, { encoding: 'utf8', mode: 0o600 });
      return { exported: true };
    },
  });

  window = new BrowserWindow({ width: 1440, height: 920, minWidth: 900, minHeight: 680, title: 'Meeting Agent', show: false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false } });
  const appSession = window.webContents.session;
  appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const correctWindow = contents === window?.webContents;
    const audioOnly = permission === 'media' && 'mediaTypes' in details && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
    callback(Boolean(correctWindow && audioOnly));
  });
  appSession.setPermissionCheckHandler((contents, permission, _origin, details) => contents === window?.webContents && permission === 'media' && details.mediaType === 'audio');
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) console.error('[renderer]', message);
  });
  window.once('ready-to-show', () => window?.show());
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    void shutdown();
  });
  window.on('closed', () => { window = null; });
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  void shutdown();
});
void app.whenReady().then(setup).catch((error) => {
  console.error('[startup]', safeError(error).message);
  dialog.showErrorBox('Meeting Agent 启动失败', safeError(error).message);
  app.quit();
});
