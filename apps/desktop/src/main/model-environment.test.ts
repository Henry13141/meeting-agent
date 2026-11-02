import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { loadModelEnvironment, parseModelEnvironment } from './model-environment';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it('parses quoted provider configuration literally without shell expansion', () => {
  const config = parseModelEnvironment('# local config\nMEETING_AGENT_API_BASE="http://127.0.0.1:8001/v1"\nMEETING_AGENT_MODEL=test-model\nMEETING_AGENT_API_KEY=\'literal-$KEY\'\n');
  expect(config.MEETING_AGENT_API_KEY).toBe('literal-$KEY');
  expect(config.MEETING_AGENT_MODEL).toBe('test-model');
});
it('rejects unknown or duplicated keys without including their values in the error', () => {
  expect(() => parseModelEnvironment('OTHER_KEY=private-value')).toThrow('MODEL_ENV_INVALID');
  expect(() => parseModelEnvironment('MEETING_AGENT_MODEL=a\nMEETING_AGENT_MODEL=b')).toThrow('MODEL_ENV_INVALID');
});
it('gives explicit process configuration precedence over the local file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-model-env-')); roots.push(root);
  await writeFile(path.join(root, '.env.local'), 'MEETING_AGENT_MODEL=file-model\nMEETING_AGENT_API_KEY=local-secret');
  const env = await loadModelEnvironment(root, { MEETING_AGENT_MODEL: 'process-model' });
  expect(env.MEETING_AGENT_MODEL).toBe('process-model');
  expect(env.MEETING_AGENT_API_KEY).toBe('local-secret');
});
it('allows first launch without a model configuration file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-model-env-')); roots.push(root);
  expect(await loadModelEnvironment(root, { PATH: '/bin' })).toEqual({ PATH: '/bin' });
});
