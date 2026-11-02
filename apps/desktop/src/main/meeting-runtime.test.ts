import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MeetingRuntime, type MeetingRunInput } from './meeting-runtime';

const sourcePython = process.env.MEETING_AGENT_RUNTIME_TEST_PYTHON;
const copiedRuntime = path.resolve('services/runtime');
const roots: string[] = [];
const adapters: MeetingRuntime[] = [];
afterAll(async () => {
  await Promise.all(adapters.map((adapter) => adapter.stop()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(environment: NodeJS.ProcessEnv = {}): Promise<MeetingRuntime> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-agent-runtime-test-'));
  roots.push(root);
  await mkdir(path.join(root, 'services'));
  await symlink(copiedRuntime, path.join(root, 'services/runtime'));
  const adapter = new MeetingRuntime({ projectRoot: root, sourcePython: sourcePython!, environment });
  adapters.push(adapter);
  return adapter;
}

it('constrains Main storage overrides to this project local data', () => {
  expect(() => new MeetingRuntime({ projectRoot: '/tmp/meeting-agent-test', sourcePython: '/missing/python', dataRoot: '/tmp/other-product' }))
    .toThrow('MEETING_RUNTIME_STORAGE_OUTSIDE_LOCAL_DATA');
});

it('rejects unsafe intent before starting Python or touching user workspaces', async () => {
  const adapter = new MeetingRuntime({ projectRoot: '/tmp/not-created-meeting-agent-test', sourcePython: '/missing/python', environment: {} });
  for (const unsafe of [{ fullAccess: true }, { workspaceReadAllowed: true }, { accessMode: 'workspace' },
    { mcpTools: ['tracker/read'] }, { mcpWriteTools: ['tracker/write'] }, { botPersona: {} }, { workspaceRoot: '/Users' }]) {
    await expect(adapter.startRun('invalid', { message: 'hello', ...unsafe } as MeetingRunInput)).rejects.toThrow('MEETING_READ_ONLY_REQUIRED');
  }
  expect((await adapter.status()).phase).toBe('stopped');
});

describe.skipIf(!sourcePython)('copied Python Runtime loopback integration', () => {
  it('supports real health/catalog/internal threads/capability without a model and blocks scaffold runs', async () => {
    const adapter = await fixture();
    const catalog = await adapter.catalog();
    expect(catalog.revision).toBe('meeting-model-catalog.v1');
    expect(catalog.profiles.some((profile) => profile.id === 'meeting-model')).toBe(true);
    const status = await adapter.status();
    expect(status.ready).toBe(true);
    expect(status.modelReady).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.health?.scaffoldMode).toBe(true);
    const [first, same] = await Promise.all([adapter.ensureThread('integration-only'), adapter.ensureThread('integration-only')]);
    expect(first.id).toBe(same.id);
    expect(first.workspaceRoot).toContain('/.local-data/meeting-workspaces/');
    const capability = await adapter.capability(first.id);
    expect(capability.revision).toMatch(/^[0-9a-f]{64}$/);
    await expect(adapter.startRun(first.id, { message: '真实模型未配置时必须拒绝，不得演示。' })).rejects.toThrow('MODEL_NOT_CONFIGURED');
    await expect(adapter.capability('00000000-0000-0000-0000-000000000000')).rejects.toThrow('MEETING_THREAD_NOT_AUTHORIZED');
    const pid = (adapter as unknown as { child: { pid: number } }).child.pid;
    await adapter.stop();
    expect((await adapter.status()).phase).toBe('stopped');
    expect(() => process.kill(pid, 0)).toThrow();
  }, 45_000);

  it('keeps capture infrastructure usable when explicit credentials are incomplete', async () => {
    const adapter = await fixture({ MEETING_AGENT_API_BASE: 'https://gateway.invalid/v1' });
    await adapter.catalog();
    expect(await adapter.status()).toMatchObject({ ready: true, modelReady: false, configured: false,
      error: 'MODEL_CONFIGURATION_INCOMPLETE' });
    await adapter.stop();
  }, 45_000);
});


describe.skipIf(!sourcePython)('generic model transport and durable meeting conversations', () => {
  it('uses the configured provider, isolates summary threads, cancels and recovers after restart', async () => {
    const requests: Array<{ body: { messages: Array<{ role: string; content: string }>; [key: string]: unknown }; auth?: string }> = [];
    const server = createServer(async (req, res) => {
      let body = '';
      try { for await (const chunk of req) body += chunk; }
      catch (error) { if (req.aborted) return; throw error; }
      const parsed = JSON.parse(body);
      requests.push({ body: parsed, auth: req.headers.authorization });
      if (parsed.messages.at(-1).content === 'slow') return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `answer-${requests.length}` } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const adapter = await fixture({ MEETING_AGENT_API_BASE: `http://127.0.0.1:${port}/v1`,
      MEETING_AGENT_API_KEY: 'test-private-key', MEETING_AGENT_MODEL: 'configured-model', UNRELATED_PRIVATE_KEY: 'not-forwarded' });
    try {
      const thread = await adapter.ensureThread('conversation');
      const poll = async (tid: string, rid: string) => {
        for (let n = 0; n < 100; n++) {
          const run = await adapter.getRun(tid, rid);
          if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        throw new Error('test run timeout');
      };
      const first = await adapter.startRun(thread.id, { message: 'meeting question' });
      expect((await poll(thread.id, first.runId)).status).toBe('completed');
      expect((await adapter.events(thread.id, first.runId)).events).toContainEqual(expect.objectContaining({ event: 'final', data: { reply: 'answer-1' } }));
      expect((await adapter.getRun(thread.id, first.runId)).requestId).toBe(first.requestId);
      await adapter.stop();
      const restored = await adapter.ensureThread('conversation');
      expect(restored.id).toBe(thread.id);
      const second = await adapter.startRun(restored.id, { message: 'follow up' });
      expect((await poll(restored.id, second.runId)).status).toBe('completed');
      expect(requests[1].body.messages.map((m) => m.content)).toContain('answer-1');
      const summary = await adapter.ensureThread('summary-isolated');
      const summaryRun = await adapter.startRun(summary.id, { message: 'summary evidence' });
      await poll(summary.id, summaryRun.runId);
      expect(requests[2].body.messages).toHaveLength(2);
      expect(requests[0].body).not.toHaveProperty('tools');
      expect(requests[0].body.model).toBe('configured-model');
      expect(requests[0].auth).toBe('Bearer test-private-key');
      expect(JSON.stringify(await adapter.status())).not.toContain('test-private-key');
      expect(JSON.stringify(await adapter.catalog())).not.toContain('test-private-key');
      const slow = await adapter.startRun(restored.id, { message: 'slow' });
      expect((await adapter.cancel(restored.id, slow.runId)).run.status).toBe('cancelled');
      expect((await adapter.events(restored.id, slow.runId)).status).toBe('cancelled');
    } finally {
      await adapter.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 45_000);
});
