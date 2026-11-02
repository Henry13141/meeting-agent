import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { integrationEnvironment } from './integration-environment';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); roots.length = 0; });
async function fixture(config: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-extensions-env-'));
  roots.push(root); await mkdir(path.join(root, '.agent'));
  await writeFile(path.join(root, '.agent/extensions.json'), JSON.stringify(config));
  return root;
}

it('only forwards explicit environment references from enabled adapters', async () => {
  const root = await fixture({ schemaVersion: 1, servers: [
    { enabled: true, env: { OFFICE_KEY: { env: 'OFFICE_SECRET' } }, headers: { Authorization: { env: 'HTTP_SECRET', prefix: 'Bearer ' } } },
    { enabled: false, env: { KEY: { env: 'DISABLED_SECRET' } } },
  ] });
  expect(await integrationEnvironment(root, { OFFICE_SECRET: 'office-key', HTTP_SECRET: 'http-key',
    DISABLED_SECRET: 'disabled-key', MEETING_AGENT_API_KEY: 'model-key', UNRELATED_PRIVATE_KEY: 'unrelated' }))
    .toEqual({ OFFICE_SECRET: 'office-key', HTTP_SECRET: 'http-key' });
});

it('does not treat literal credentials or unsafe names as references', async () => {
  const root = await fixture({ schemaVersion: 1, servers: [{ enabled: true,
    env: { literal: 'do-not-forward', malformed: { env: 'BAD\nNAME' }, absent: { env: 'MISSING' }, badValue: { env: 'BAD_VALUE' } } }] });
  expect(await integrationEnvironment(root, { 'BAD\nNAME': 'bad', BAD_VALUE: 'line\nbreak' })).toEqual({});
});

it('leaves extension config errors separate from ordinary model setup', async () => {
  const root = await fixture({ schemaVersion: 1, servers: [] });
  await writeFile(path.join(root, '.agent/extensions.json'), '{invalid');
  expect(await integrationEnvironment(root, { SECRET: 'key' })).toEqual({});
  await rm(path.join(root, '.agent/extensions.json'));
  expect(await integrationEnvironment(root, { SECRET: 'key' })).toEqual({});
});

it('refuses credentials from a redirected config directory', async () => {
  const root = await fixture({ schemaVersion: 1, servers: [] });
  const outside = await fixture({ schemaVersion: 1, servers: [{ enabled: true, env: { KEY: { env: 'SECRET' } } }] });
  await rm(path.join(root, '.agent'), { recursive: true });
  await symlink(path.join(outside, '.agent'), path.join(root, '.agent'));
  expect(await integrationEnvironment(root, { SECRET: 'private-key' })).toEqual({});
});
