import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROJECT_QWEN_ALIGNER_MODEL_DIR,
  PROJECT_MEETING_WAKE_FILES,
  resolveManagedMeetingAsrPaths,
  resolveProjectMeetingAsrModelPath,
  resolveProjectWakeModelDir,
} from './meeting-asr-project-models';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function repoFixture(options: {
  asr?: boolean;
  aligner?: boolean;
  wake?: boolean;
  incompleteWake?: boolean;
}): Promise<{ appPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-meeting-models-'));
  roots.push(root);
  const appPath = path.join(root, 'apps', 'desktop');
  const asrDir = path.join(root, 'models', 'meeting-asr', 'SenseVoiceSmall');
  const alignerDir = path.join(root, 'models', 'meeting-asr', PROJECT_QWEN_ALIGNER_MODEL_DIR);
  const wakeDir = path.join(root, 'models', 'meeting-asr', 'wake');
  await mkdir(appPath, { recursive: true });
  if (options.asr) {
    await mkdir(asrDir, { recursive: true });
    await writeFile(path.join(asrDir, 'config.yaml'), 'model: SenseVoiceSmall\n');
    await writeFile(path.join(asrDir, 'model.pt'), 'weights');
  }
  if (options.aligner) {
    await mkdir(alignerDir, { recursive: true });
    for (const filename of [
      'config.json', 'preprocessor_config.json', 'tokenizer_config.json',
      'model.safetensors',
    ]) {
      await writeFile(path.join(alignerDir, filename), '{}');
    }
  }
  if (options.wake || options.incompleteWake) {
    await mkdir(wakeDir, { recursive: true });
    const files = options.incompleteWake
      ? PROJECT_MEETING_WAKE_FILES.slice(0, 3)
      : PROJECT_MEETING_WAKE_FILES;
    for (const filename of files) {
      await writeFile(path.join(wakeDir, filename), filename);
    }
  }
  return { appPath };
}

describe('project meeting ASR models', () => {
  it('selects only complete Qwen weights and preserves explicit SenseVoice selection', async () => {
    const { appPath } = await repoFixture({ asr: true });
    const qwen = path.resolve(appPath, '../../models/meeting-asr/Qwen3-ASR-1.7B');
    await mkdir(qwen, { recursive: true });
    await writeFile(path.join(qwen, 'config.json'), JSON.stringify({ model_type: 'qwen3_asr' }));
    expect((await resolveManagedMeetingAsrPaths({ appPath, packaged: false, environment: {} }))?.engine).toBeUndefined();
    for (const file of ['model.safetensors.index.json', 'model-00001-of-00002.safetensors',
      'model-00002-of-00002.safetensors', 'tokenizer_config.json', 'vocab.json', 'merges.txt', 'preprocessor_config.json']) {
      await writeFile(path.join(qwen, file), 'test');
    }
    expect((await resolveManagedMeetingAsrPaths({ appPath, packaged: false, environment: {} }))?.engine).toBe('qwen');
    expect((await resolveManagedMeetingAsrPaths({ appPath, packaged: false,
      environment: { MEETING_ASR_ENGINE: 'sensevoice' } }))?.modelPath).toContain('SenseVoiceSmall');
  });

  it('auto-discovers a complete local Qwen forced aligner next to the ASR model', async () => {
    const { appPath } = await repoFixture({ aligner: true });
    const qwen = path.resolve(appPath, '../../models/meeting-asr/Qwen3-ASR-1.7B');
    await mkdir(qwen, { recursive: true });
    for (const file of ['config.json', 'model.safetensors.index.json',
      'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors',
      'tokenizer_config.json', 'vocab.json', 'merges.txt', 'preprocessor_config.json']) {
      await writeFile(path.join(qwen, file), file === 'config.json'
        ? JSON.stringify({ model_type: 'qwen3_asr' })
        : 'test');
    }
    const resolved = await resolveManagedMeetingAsrPaths({
      appPath,
      packaged: false,
      environment: {},
    });
    expect(resolved?.alignerModelPath?.endsWith(PROJECT_QWEN_ALIGNER_MODEL_DIR)).toBe(true);
    expect(resolved?.engine).toBe('qwen');
  });
  it('ignores a checkout that has no local meeting models', async () => {
    const { appPath } = await repoFixture({});
    await expect(resolveProjectMeetingAsrModelPath(appPath)).resolves.toBeUndefined();
    await expect(resolveProjectWakeModelDir(appPath)).resolves.toBeUndefined();
    await expect(resolveManagedMeetingAsrPaths({
      environment: {},
      packaged: false,
      appPath,
    })).resolves.toBeUndefined();
  });

  it('discovers unpackaged SenseVoice and wake files from the repo models directory', async () => {
    const { appPath } = await repoFixture({ asr: true, wake: true });
    const modelPath = await resolveProjectMeetingAsrModelPath(appPath);
    const wakeModelDir = await resolveProjectWakeModelDir(appPath);
    expect(modelPath?.endsWith(path.join('models', 'meeting-asr', 'SenseVoiceSmall'))).toBe(true);
    expect(wakeModelDir?.endsWith(path.join('models', 'meeting-asr', 'wake'))).toBe(true);
    await expect(resolveManagedMeetingAsrPaths({
      environment: {},
      packaged: false,
      appPath,
    })).resolves.toEqual({ modelPath, wakeModelDir });
  });

  it('does not treat an incomplete wake directory as configured', async () => {
    const { appPath } = await repoFixture({ asr: true, incompleteWake: true });
    await expect(resolveProjectWakeModelDir(appPath)).resolves.toBeUndefined();
    const resolved = await resolveManagedMeetingAsrPaths({
      environment: {},
      packaged: false,
      appPath,
    });
    expect(resolved?.modelPath).toBeDefined();
    expect(resolved?.wakeModelDir).toBeUndefined();
  });

  it('lets environment paths override the project directory and ignores it when packaged', async () => {
    const { appPath } = await repoFixture({ asr: true, wake: true });
    await expect(resolveManagedMeetingAsrPaths({
      environment: {
        MEETING_ASR_MODEL_PATH: '/explicit/SenseVoiceSmall',
        MEETING_ASR_WAKE_MODEL_DIR: '/explicit/wake',
      },
      packaged: false,
      appPath,
    })).resolves.toEqual({
      modelPath: '/explicit/SenseVoiceSmall',
      wakeModelDir: '/explicit/wake',
    });
    await expect(resolveManagedMeetingAsrPaths({
      environment: {},
      packaged: true,
      appPath,
    })).resolves.toBeUndefined();
  });
});
