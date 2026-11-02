import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { _electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = path.join(root, '.agent/extensions.json');
const evidence = path.join(root, 'test-results');
const storage = path.join(root, '.local-data/extensions-smoke', randomUUID());
let application;
let ownsConfig = false;
let server;
let page;
const errors = [];
const modelRequests = [];
const files = async () => (await fs.readdir(storage)).filter(name => name.endsWith('.json'));
async function controls() {
  const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.mouse.move(width / 2, height / 2);
  await page.mouse.move(width / 2, height - 25, { steps: 5 });
}
async function ask(text) {
  await controls();
  await page.evaluate(() => { window.__extensionSmokeEvents = []; });
  const input = page.getByPlaceholder('直接说：会议助手，请总结刚才的讨论');
  await input.fill('会议助手，' + text);
  await input.press('Enter');
}
async function finalReply() {
  await page.waitForFunction(() => window.__extensionSmokeEvents.some(event => event.event === 'final'), null, { timeout: 30_000 });
}
try {
  try { await fs.lstat(configFile); throw new Error('EXTENSION_SMOKE_REQUIRES_ABSENT_LOCAL_CONFIG'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(storage, { recursive: true });
  await fs.mkdir(evidence, { recursive: true });
  const seed = { id: randomUUID(), kind: 'document', title: '测试会议文档', content: '本机模拟会议记录', storage: 'local-mock' };
  await fs.writeFile(path.join(storage, 'document-seed.json'), JSON.stringify(seed));
  const config = JSON.parse(await fs.readFile(path.join(root, 'agent-extensions.example.json'), 'utf8'));
  config.servers[0].enabled = true;
  config.servers[0].env = { MOCK_OFFICE_DATA_ROOT: { env: 'MEETING_AGENT_SMOKE_OFFICE_ROOT' } };
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  ownsConfig = true;
  server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); modelRequests.push(body);
    const messages = body.messages;
    let message;
    if (messages.at(-1).role === 'tool') {
      message = { role: 'assistant', content: JSON.stringify({ spokenAnswer: '已收到本地模拟工具回执，请核对结果。', title: '本地模拟结果', bullets: [], sources: [], media: [], action: null }) };
    } else {
      const question = messages.findLast(item => item.role === 'user').content;
      const consecutive = question.includes('连续创建两篇测试纪要');
      const write = consecutive || question.includes('创建测试纪要') || question.includes('创建应拒绝的纪要');
      const name = write ? 'office__create_document' : 'office__search_documents';
      const args = write ? { title: question.includes('应拒绝') ? '应拒绝的纪要' : '测试纪要', content: '本机模拟测试正文，未连接真实办公平台。' } : { query: '测试会议' };
      assert.ok(body.tools?.some(tool => tool.function.name === name), 'Selected skill exposes its tool schema');
      const calls = [{ id: 'call_' + randomUUID().replaceAll('-', ''), type: 'function', function: { name, arguments: JSON.stringify(consecutive ? { ...args, title: '连续测试第一篇' } : args) } }];
      if (consecutive) calls.push({ id: 'call_' + randomUUID().replaceAll('-', ''), type: 'function',
        function: { name, arguments: JSON.stringify({ ...args, title: '连续测试应拒绝的第二篇' }) } });
      message = { role: 'assistant', content: null, tool_calls: calls };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, MEETING_AGENT_SMOKE: '1', MEETING_AGENT_SMOKE_OFFICE_ROOT: storage,
    MEETING_AGENT_API_BASE: `http://127.0.0.1:${server.address().port}/v1`, MEETING_AGENT_MODEL: 'local-smoke-model', MEETING_AGENT_API_KEY: '',
    MEETING_AGENT_RUNTIME_PYTHON: path.join(root, 'services/runtime/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: require('electron'), args: [root, ...(process.env.CI ? ['--no-sandbox'] : [])], env, timeout: 60_000 });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.meetingAgent?.agent.listExtensions), null, { timeout: 20_000 });
  await page.waitForFunction(async () => (await window.meetingHost.status()).runtime.modelReady, null, { timeout: 30_000 });
  const catalog = await page.evaluate(() => window.meetingAgent.agent.listExtensions());
  assert.equal(catalog.error, undefined);
  assert.equal(catalog.skills.find(skill => skill.id === 'office-assistant')?.available, true);
  assert.equal(catalog.tools.find(tool => tool.name === 'office__search_documents')?.effect, 'read');
  assert.equal(catalog.tools.find(tool => tool.name === 'office__create_document')?.effect, 'write');
  await page.evaluate(() => {
    window.__extensionSmokeEvents = [];
    window.meetingAgent.agent.onRunEvent(event => window.__extensionSmokeEvents.push(event));
  });
  await controls();
  await page.getByText('会议设置与技能', { exact: true }).click();
  await page.getByRole('checkbox', { name: /办公助手示例/ }).check();
  await ask('查找测试会议文档');
  await finalReply();
  const readEvents = await page.evaluate(() => window.__extensionSmokeEvents);
  assert.ok(readEvents.some(event => event.event === 'tool_result' && event.data.toolName === 'office__search_documents'));
  assert.equal(readEvents.some(event => event.event === 'tool_approval'), false);
  assert.equal((await files()).length, 1);

  await ask('创建测试纪要');
  const card = page.getByRole('region', { name: '办公工具写入确认' });
  await card.waitFor({ timeout: 30_000 });
  assert.match(await card.textContent(), /测试纪要/);
  assert.equal((await files()).length, 1, 'A pending approval cannot write');
  const approval = await page.evaluate(() => window.__extensionSmokeEvents.find(event => event.event === 'tool_approval').data);
  await page.screenshot({ path: path.join(evidence, 'office-tool-approval.png') });
  await card.getByRole('button', { name: '允许这一次', exact: true }).click();
  await finalReply();
  assert.equal((await files()).length, 2, 'An approved tool writes exactly one new document');
  const created = await Promise.all((await files()).map(async file => JSON.parse(await fs.readFile(path.join(storage, file), 'utf8'))));
  assert.equal(created.filter(record => record.title === '测试纪要').length, 1);
  const receipt = await page.evaluate(({ threadId, runId }) => window.meetingAgent.agent.getToolCalls(threadId, runId), approval);
  assert.equal(receipt.filter(call => call.toolName === 'office__create_document' && call.status === 'completed').length, 1);
  await ask('创建应拒绝的纪要');
  await card.waitFor({ timeout: 30_000 });
  await card.getByRole('button', { name: '拒绝执行', exact: true }).click();
  await finalReply();
  assert.equal((await files()).length, 2, 'Denied tool does not write');
  await ask('连续创建两篇测试纪要');
  await card.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('.meeting-tool-approval pre')?.textContent.includes('连续测试第一篇'));
  await card.getByRole('button', { name: '允许这一次', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.meeting-tool-approval pre')?.textContent.includes('连续测试应拒绝的第二篇'), null, { timeout: 30_000 });
  assert.equal((await files()).length, 3, 'The second same-name tool stays pending after the first result');
  await card.getByRole('button', { name: '拒绝执行', exact: true }).click();
  await finalReply();
  assert.equal((await files()).length, 3, 'Same-name second tool denial does not create a file');
  assert.deepEqual(errors, []);
  const result = { passed: true, testedAt: new Date().toISOString(),
    realExternalOfficePlatform: false, localMockModel: true, mcpTransport: 'stdio',
    skillSelectedInUi: true, readToolWithoutApproval: true, pendingWriteBlocked: true,
    approvedWrites: 2, deniedWriteBlocked: true, consecutiveSameNameApprovals: true,
    auditReceipt: true, rendererErrors: errors };
  await fs.writeFile(path.join(evidence, 'extensions-smoke.json'), JSON.stringify(result, null, 2));
  console.log('PASS: Electron skill selection, real MCP read tool, write preview, single approval, persisted mock document, denial and audit receipt.');
} catch (error) {
  await page?.screenshot({ path: path.join(evidence, 'extensions-smoke-failure.png') }).catch(() => {});
  throw error;
} finally {
  await application?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (ownsConfig) await fs.rm(configFile);
}
