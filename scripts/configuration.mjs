import { readFile, stat, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const fields = new Set(['runtimePython', 'asrPython', 'asrModelPath']);
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LOCAL_CONFIG_INVALID');
  for (const [key, entry] of Object.entries(value)) {
    if (!fields.has(key)) throw new Error('LOCAL_CONFIG_UNKNOWN_FIELD');
    if (typeof entry !== 'string' || !entry.trim() || /[\r\n\0]/.test(entry)) throw new Error('LOCAL_CONFIG_INVALID');
  }
  return value;
}

export async function readLocalPaths(root) {
  try { return validate(JSON.parse(await readFile(path.join(root, '.local-paths.json'), 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error.message === 'LOCAL_CONFIG_UNKNOWN_FIELD') throw error;
    throw new Error('LOCAL_CONFIG_INVALID');
  }
}

function resolveChoices(root, existing, overrides) {
  validate(overrides);
  const chosen = { ...existing, ...overrides };
  const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  for (const key of Object.keys(chosen)) chosen[key] = path.resolve(root, chosen[key]);
  chosen.runtimePython ??= path.join(root, 'services/runtime/.venv', executable);
  chosen.asrPython ??= path.join(root, 'services/meeting-asr/.venv', executable);
  chosen.asrModelPath ??= path.join(root, 'models/meeting-asr/SenseVoiceSmall');
  return chosen;
}

async function inspect(chosen) {
  const file = async (value) => stat(value).then((s) => s.isFile()).catch(() => false);
  const checks = {
    runtimePython: await file(chosen.runtimePython),
    asrPython: await file(chosen.asrPython),
    asrModelPath: (await Promise.all(['model.pt', 'config.yaml'].map((name) => file(path.join(chosen.asrModelPath, name))))).every(Boolean),
  };
  const missing = Object.keys(checks).filter((key) => !checks[key]);
  return { ready: missing.length === 0, checks, missing };
}

export async function inspectLocalPaths(root) {
  const chosen = await resolveLocalPaths(root);
  return inspect(chosen);
}

export async function resolveLocalPaths(root, overrides = {}) {
  return resolveChoices(root, await readLocalPaths(root), overrides);
}

export async function configureLocalPaths(root, overrides) {
  const chosen = resolveChoices(root, await readLocalPaths(root), overrides);
  const report = await inspect(chosen);
  if (!report.ready) return { ...report, written: false };
  const destination = path.join(root, '.local-paths.json');
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(chosen, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  return { ...report, written: true };
}
