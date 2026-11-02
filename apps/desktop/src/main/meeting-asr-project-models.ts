import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MeetingAsrEnvironment } from './meeting-asr-client';

export const PROJECT_MEETING_ASR_DIR = ['models', 'meeting-asr'] as const;
export const PROJECT_MEETING_ASR_MODEL_DIR = 'SenseVoiceSmall';
export const PROJECT_QWEN_ASR_MODEL_DIR = 'Qwen3-ASR-1.7B';
export const PROJECT_QWEN_ALIGNER_MODEL_DIR = 'Qwen3-ForcedAligner-0.6B';
export const PROJECT_MEETING_WAKE_DIR = 'wake';
export const PROJECT_MEETING_WAKE_FILES = [
  'silero_vad.onnx',
  'tokens.txt',
  'encoder.onnx',
  'decoder.onnx',
  'joiner.onnx',
  'keywords.txt',
] as const;

function optional(environment: MeetingAsrEnvironment, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value || undefined;
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function isRegularDirectory(dirPath: string): Promise<boolean> {
  try {
    const stats = await lstat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export function projectMeetingAsrRoot(appPath: string): string {
  return path.resolve(appPath, '..', '..', ...PROJECT_MEETING_ASR_DIR);
}

export async function resolveProjectMeetingAsrModelPath(appPath: string): Promise<string | undefined> {
  const modelPath = path.join(projectMeetingAsrRoot(appPath), PROJECT_MEETING_ASR_MODEL_DIR);
  if (!await isRegularDirectory(modelPath)) return undefined;
  if (!await isRegularFile(path.join(modelPath, 'config.yaml'))) return undefined;
  if (!await isRegularFile(path.join(modelPath, 'model.pt'))) return undefined;
  return modelPath;
}

async function resolveQwenPath(appPath: string): Promise<string | undefined> {
  const modelPath = path.join(projectMeetingAsrRoot(appPath), PROJECT_QWEN_ASR_MODEL_DIR);
  if (!await isRegularDirectory(modelPath)) return undefined;
  for (const file of ['config.json', 'model.safetensors.index.json',
    'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors',
    'tokenizer_config.json', 'vocab.json', 'merges.txt', 'preprocessor_config.json']) {
    if (!await isRegularFile(path.join(modelPath, file))) return undefined;
  }
  return modelPath;
}

async function resolveQwenAlignerPath(appPath: string): Promise<string | undefined> {
  const modelPath = path.join(projectMeetingAsrRoot(appPath), PROJECT_QWEN_ALIGNER_MODEL_DIR);
  if (!await isRegularDirectory(modelPath)) return undefined;
  if (!await isRegularFile(path.join(modelPath, 'config.json'))
    || !await isRegularFile(path.join(modelPath, 'preprocessor_config.json'))
    || !await isRegularFile(path.join(modelPath, 'tokenizer_config.json'))) return undefined;
  for (const file of ['model.safetensors', 'pytorch_model.bin']) {
    if (await isRegularFile(path.join(modelPath, file))) return modelPath;
  }
  for (const indexFile of ['model.safetensors.index.json', 'pytorch_model.bin.index.json']) {
    const shards = await readFile(path.join(modelPath, indexFile), 'utf8')
      .then((value) => JSON.parse(value) as { weight_map?: Record<string, unknown> })
      .then((index) => index.weight_map
        ? [...new Set(Object.values(index.weight_map).filter((file): file is string => typeof file === 'string'))]
        : [])
      .catch(() => []);
    if (shards.length && (await Promise.all(
      shards.map((file) => isRegularFile(path.join(modelPath, file))),
    )).every(Boolean)) return modelPath;
  }
  return undefined;
}

export async function resolveProjectWakeModelDir(appPath: string): Promise<string | undefined> {
  const wakeDir = path.join(projectMeetingAsrRoot(appPath), PROJECT_MEETING_WAKE_DIR);
  if (!await isRegularDirectory(wakeDir)) return undefined;
  for (const filename of PROJECT_MEETING_WAKE_FILES) {
    if (!await isRegularFile(path.join(wakeDir, filename))) return undefined;
  }
  return wakeDir;
}

export async function resolveManagedMeetingAsrPaths(options: {
  environment: MeetingAsrEnvironment;
  packaged: boolean;
  appPath: string;
}): Promise<{
  modelPath: string;
  wakeModelDir?: string;
  alignerModelPath?: string;
  engine?: 'qwen';
} | undefined> {
  const requested = optional(options.environment, 'MEETING_ASR_ENGINE');
  if (requested && !['qwen', 'sensevoice'].includes(requested)) throw new Error('MEETING_ASR_ENGINE_INVALID');
  const qwenPath = !options.packaged && requested !== 'sensevoice'
    && options.environment.MEETING_ASR_DIARIZATION?.trim().toLowerCase() !== 'true'
    && !optional(options.environment, 'MEETING_ASR_SPEAKER_MODEL_PATH')
    ? await resolveQwenPath(options.appPath) : undefined;
  const modelPath = optional(options.environment, 'MEETING_ASR_MODEL_PATH')
    ?? qwenPath
    ?? (options.packaged || requested === 'qwen' ? undefined : await resolveProjectMeetingAsrModelPath(options.appPath));
  if (!modelPath) return undefined;
  const config = await readFile(path.join(modelPath, 'config.json'), 'utf8')
    .then((value) => JSON.parse(value) as { model_type?: string }).catch(() => null);
  const qwen = requested === 'qwen' || (!requested && config?.model_type === 'qwen3_asr');
  const alignerModelPath = optional(options.environment, 'MEETING_ASR_ALIGNER_MODEL_PATH')
    ?? (qwen && !options.packaged ? await resolveQwenAlignerPath(options.appPath) : undefined);
  const wakeModelDir = optional(options.environment, 'MEETING_ASR_WAKE_MODEL_DIR')
    ?? (options.packaged ? undefined : await resolveProjectWakeModelDir(options.appPath));
  return {
    modelPath,
    wakeModelDir,
    ...(alignerModelPath ? { alignerModelPath } : {}),
    ...(qwen ? { engine: 'qwen' as const } : {}),
  };
}
