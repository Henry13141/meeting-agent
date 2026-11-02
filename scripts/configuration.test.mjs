import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configureLocalPaths, readLocalPaths, inspectLocalPaths } from './configuration.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-agent-first-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const python = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  for (const service of ['runtime', 'meeting-asr']) {
    const file = path.join(root, 'services', service, '.venv', python);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'test-interpreter');
  }
  const model = path.join(root, 'models/meeting-asr/SenseVoiceSmall');
  await mkdir(model, { recursive: true });
  await writeFile(path.join(model, 'model.pt'), 'test-model');
  await writeFile(path.join(model, 'config.yaml'), 'test-config');
  return root;
}

test('first configuration discovers this project environments without another checkout', async (t) => {
  const root = await fixture(t);
  const result = await configureLocalPaths(root, {});
  assert.equal(result.written, true);
  const saved = await readLocalPaths(root);
  assert.equal(saved.runtimePython, path.join(root, 'services/runtime/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  assert.deepEqual(Object.keys(saved).sort(), ['asrModelPath', 'asrPython', 'runtimePython']);
  assert.equal((await inspectLocalPaths(root)).ready, true);
});

test('missing model is a named blocker and does not create a misleading usable config', async (t) => {
  const root = await fixture(t);
  await rm(path.join(root, 'models'), { recursive: true });
  const result = await configureLocalPaths(root, {});
  assert.equal(result.written, false);
  assert.ok(result.missing.includes('asrModelPath'));
  await assert.rejects(readFile(path.join(root, '.local-paths.json')), { code: 'ENOENT' });
});

test('explicit paths resolve relative to this project and preserve other existing choices', async (t) => {
  const root = await fixture(t);
  await configureLocalPaths(root, {});
  const alternate = path.join(root, 'my-python'); await writeFile(alternate, 'interpreter');
  const result = await configureLocalPaths(root, { runtimePython: './my-python' });
  assert.equal(result.written, true);
  assert.equal((await readLocalPaths(root)).runtimePython, alternate);
  assert.equal((await readLocalPaths(root)).asrModelPath, path.join(root, 'models/meeting-asr/SenseVoiceSmall'));
});

test('malformed existing JSON is reported and left intact', async (t) => {
  const root = await fixture(t); const file = path.join(root, '.local-paths.json');
  await writeFile(file, '{bad json');
  await assert.rejects(configureLocalPaths(root, {}), /LOCAL_CONFIG_INVALID/);
  assert.equal(await readFile(file, 'utf8'), '{bad json');
});

test('path config rejects credential fields and reports missing required model files', async (t) => {
  const root = await fixture(t);
  await assert.rejects(configureLocalPaths(root, { token: 'do-not-store' }), /LOCAL_CONFIG_UNKNOWN_FIELD/);
  await configureLocalPaths(root, {});
  await rm(path.join(root, 'models/meeting-asr/SenseVoiceSmall/model.pt'));
  const result = await inspectLocalPaths(root);
  assert.equal(result.ready, false);
  assert.ok(result.missing.includes('asrModelPath'));
});
