import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MEETING_ASR_ARTIFACT_SCHEMA_VERSION,
  MEETING_ASR_FUNASR_VERSION,
  MEETING_ASR_PROTOCOL_VERSION,
  MEETING_ASR_ONNXRUNTIME_VERSION,
  MEETING_ASR_SHERPA_ONNX_VERSION,
  verifyPackagedMeetingAsr,
} from './meeting-asr-artifact';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture(overrides: Record<string, unknown> = {}) {
  const resourcesPath = await mkdtemp(path.join(os.tmpdir(), 'meeting-meeting-asr-artifact-'));
  roots.push(resourcesPath);
  const directory = path.join(resourcesPath, 'meeting-asr', 'win32-x64');
  await mkdir(directory, { recursive: true });
  const executablePath = path.join(directory, 'meeting-asr.exe');
  const contents = Buffer.from('fake meeting asr executable');
  await writeFile(executablePath, contents);
  const manifest = {
    schemaVersion: MEETING_ASR_ARTIFACT_SCHEMA_VERSION,
    serviceVersion: '0.1.0',
    protocolVersion: MEETING_ASR_PROTOCOL_VERSION,
    funasrVersion: MEETING_ASR_FUNASR_VERSION,
    sherpaOnnxVersion: MEETING_ASR_SHERPA_ONNX_VERSION,
    onnxruntimeVersion: MEETING_ASR_ONNXRUNTIME_VERSION,
    platform: 'win32',
    arch: 'x64',
    filename: 'meeting-asr.exe',
    size: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex'),
    build: {
      mode: 'unsigned-development',
      pythonVersion: '3.12.0',
      pyinstallerVersion: '6.22.2',
      sourceDateEpoch: '0',
    },
    ...overrides,
  };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { resourcesPath, executablePath };
}

describe('packaged meeting ASR artifact verification', () => {
  it('accepts an exact target with matching pinned metadata and digest', async () => {
    const { resourcesPath, executablePath } = await fixture();
    const result = await verifyPackagedMeetingAsr(resourcesPath, 'win32', 'x64');
    expect(result.executablePath).toBe(executablePath);
    expect(result.manifest.funasrVersion).toBe('1.4.12');
    expect(result.manifest.sherpaOnnxVersion).toBe('1.13.7');
    expect(result.manifest.onnxruntimeVersion).toBe('1.29.0');
  });

  it('rejects modified executable bytes', async () => {
    const { resourcesPath, executablePath } = await fixture();
    await writeFile(executablePath, 'fake meeting asr executablE');
    await expect(verifyPackagedMeetingAsr(resourcesPath, 'win32', 'x64')).rejects.toThrow(
      'MEETING_ASR_ARTIFACT_SHA256_MISMATCH',
    );
  });

  it('rejects a different target or pinned speech dependency version', async () => {
    const target = await fixture({ arch: 'arm64' });
    await expect(verifyPackagedMeetingAsr(target.resourcesPath, 'win32', 'x64')).rejects.toThrow(
      'MEETING_ASR_ARTIFACT_TARGET_MISMATCH',
    );
    const dependency = await fixture({ funasrVersion: '1.4.13' });
    await expect(verifyPackagedMeetingAsr(dependency.resourcesPath, 'win32', 'x64')).rejects.toThrow();
    const wakeDependency = await fixture({ sherpaOnnxVersion: '1.13.6' });
    await expect(verifyPackagedMeetingAsr(wakeDependency.resourcesPath, 'win32', 'x64')).rejects.toThrow();
    const ortDependency = await fixture({ onnxruntimeVersion: '1.28.0' });
    await expect(verifyPackagedMeetingAsr(ortDependency.resourcesPath, 'win32', 'x64')).rejects.toThrow();
  });
});
