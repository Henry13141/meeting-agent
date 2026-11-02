import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.join(root, 'test-results');
await fs.mkdir(evidence, { recursive: true });
const env = { ...process.env, MEETING_AGENT_SMOKE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let application;
const errors = [];
const launch = () => _electron.launch({ executablePath: require('electron'), args: [root,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'], env, timeout: 60_000 });
async function clickControl(page, name) {
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.mouse.move(size.width / 2, size.height - 25);
  const button = page.getByRole('button', { name, exact: true });
  await button.focus();
  await button.press('Enter');
}
try {
  application = await launch();
  application.process().stderr.on('data', (chunk) => process.stderr.write(chunk));
  let page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.meetingAgent?.meetings && window.meetingHost), { timeout: 20_000 });
  await page.getByRole('button', { name: /Meeting Agent ·/ }).waitFor();
  await page.waitForFunction(async () => (await window.meetingHost.status()).runtime.ready, { timeout: 60_000 });
  const status = await page.evaluate(() => window.meetingHost.status());
  assert.equal(status.runtime.modelReady, false, 'Smoke must run without a real model credential');
  const cap = await page.evaluate(() => window.meetingAgent.meetings.getCapabilities());
  assert.equal(cap.localAsr, true);
  assert.equal(cap.voiceActivation, false);
  const isolated = await page.evaluate(() => ({ node: typeof window.process, require: typeof window.require,
    apiKeys: Object.keys(window.meetingAgent), hasRuntimeTransport: 'fetchRuntime' in window.meetingAgent }));
  assert.equal(isolated.node, 'undefined'); assert.equal(isolated.require, 'undefined');
  assert.equal(isolated.hasRuntimeTransport, false);
  const rejection = await page.evaluate(async () => {
    const thread = await window.meetingAgent.agent.ensureConversationThread({ surface: 'dialog', contextId: 'meeting-assistant' });
    const catalog = await window.meetingAgent.agent.listModels();
    const capability = await window.meetingAgent.agent.getCodeWorkspaceCapability(thread.id);
    const request = { requestId: crypto.randomUUID(), threadId: thread.id, message: '请根据会议内容回答。',
      modelProfileId: catalog.defaultProfileId, thinking: { enabled: false }, catalogRevision: catalog.revision,
      capabilityRevision: capability.revision, accessMode: 'read_only', mcpTools: [] };
    let noModel = ''; let unsafe = '';
    try { await window.meetingAgent.agent.startRun(request); } catch (e) { noModel = String(e); }
    try { await window.meetingAgent.agent.startRun({ ...request, fullAccess: true }); } catch (e) { unsafe = String(e); }
    return { noModel, unsafe };
  });
  assert.match(rejection.noModel, /MODEL_NOT_CONFIGURED/);
  assert.match(rejection.unsafe, /MEETING_REQUEST_INVALID/);
  const before = await page.evaluate(() => window.meetingAgent.meetings.list(50));
  await clickControl(page, '开始记录');
  await page.waitForFunction(async (existing) => (await window.meetingAgent.meetings.list(50)).some((m) => !existing.includes(m.id) && m.status === 'recording'), before.map((m) => m.id), { timeout: 30_000 });
  const current = await page.evaluate(async (existing) => (await window.meetingAgent.meetings.list(50)).find((m) => !existing.includes(m.id)), before.map((m) => m.id));
  assert.ok(current);
  await page.waitForFunction(async (id) => (await window.meetingAgent.meetings.list(50)).find((m) => m.id === id)?.audio.length > 0, current.id, { timeout: 40_000 });
  await page.screenshot({ path: path.join(evidence, 'meeting-recording.png') });
  await clickControl(page, '暂停记录');
  await page.evaluate((id) => window.meetingAgent.meetings.appendTranscript({ meetingId: id, speaker: '运行验证', text: '独立版运行验证：先保存录音，再核对纪要，任务负责人待确认。', capturedAt: new Date().toISOString() }), current.id);
  const settings = page.getByText('会议设置与技能', { exact: true });
  await settings.click();
  await page.getByRole('button', { name: '结束会议', exact: true }).click();
  await page.waitForFunction(async (id) => (await window.meetingAgent.meetings.list(50)).find((m) => m.id === id)?.status === 'completed', current.id, { timeout: 30_000 });
  const archived = await page.evaluate(async (id) => (await window.meetingAgent.meetings.list(50)).find((m) => m.id === id), current.id);
  assert.ok(archived.audio.length > 0);
  assert.ok(archived.transcript.some((line) => line.text.includes('独立版运行验证')));
  const lastPage = await page.evaluate(({ id, after }) => window.meetingAgent.meetings.readTranscript(id, after), { id: current.id, after: archived.transcript.at(-1).sequence });
  assert.equal(lastPage.transcript.length, 0, 'Transcript paging terminates');
  await page.screenshot({ path: path.join(evidence, 'meeting-running.png') });
  await application.close(); application = null;
  application = await launch();
  page = await application.firstWindow();
  await page.waitForFunction(() => Boolean(window.meetingAgent?.meetings));
  const persisted = await page.evaluate(async (id) => (await window.meetingAgent.meetings.list(50)).find((m) => m.id === id), current.id);
  assert.equal(persisted.status, 'completed');
  assert.equal(persisted.audio.length, archived.audio.length);
  assert.ok(persisted.transcript.some((line) => line.text.includes('独立版运行验证')));
  // Close while a short new recording is still buffered: shutdown must flush its tail.
  const beforeClose = await page.evaluate(() => window.meetingAgent.meetings.list(50));
  await clickControl(page, '开始记录');
  await page.getByRole('button', { name: '暂停记录', exact: true }).waitFor({ timeout: 30_000 });
  const closingMeeting = await page.evaluate(async (existing) => (await window.meetingAgent.meetings.list(50)).find((m) => !existing.includes(m.id)), beforeClose.map((m) => m.id));
  assert.ok(closingMeeting);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await application.close(); application = null;
  application = await launch();
  page = await application.firstWindow();
  await page.waitForFunction(() => Boolean(window.meetingAgent?.meetings));
  const closedRecord = await page.evaluate(async (id) => (await window.meetingAgent.meetings.list(50)).find((m) => m.id === id), closingMeeting.id);
  assert.equal(closedRecord.status, 'completed');
  assert.ok(closedRecord.audio.length > 0, 'The sub-five-second recording tail was persisted on window close');
  const directories = await fs.readdir(path.join(root, '.local-data/smoke/recordings'));
  const directory = directories.find((name) => name.endsWith('_' + closingMeeting.id.slice(0, 8)));
  assert.ok(directory);
  const sessions = await fs.readdir(path.join(root, '.local-data/smoke/recordings', directory, '完整录音片段'));
  assert.ok(sessions.some((name) => name.endsWith('.webm')), 'Close flush finalized the continuous archive');
  assert.ok(!sessions.some((name) => name.endsWith('.partial')), 'No unfinalized tail after normal close');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(evidence, 'electron-smoke.json'), JSON.stringify({ passed: true, testedAt: new Date().toISOString(),
    simulatedAudioDevice: true, realMicrophoneAccepted: false, realModelAccepted: false,
    asrCapabilities: cap, nodeIsolation: isolated, runtimeRejection: rejection,
    archived: { id: current.id, audioChunks: archived.audio.length, transcriptRows: archived.transcript.length },
    closeFlush: { id: closingMeeting.id, audioChunks: closedRecord.audio.length, finalizedArchive: true },
    restartPersistence: true, rendererErrors: errors }, null, 2));
  console.log('PASS: Electron UI, fake-microphone recording, archive, restart persistence, IPC isolation and explicit unconfigured model rejection.');
} finally {
  await application?.close();
}
