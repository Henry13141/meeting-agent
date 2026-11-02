import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const MEETING_ASR_ARTIFACT_SCHEMA_VERSION = 'meeting-asr-artifact.v2';
export const MEETING_ASR_PROTOCOL_VERSION = 'meeting-asr.v2';
export const MEETING_ASR_FUNASR_VERSION = '1.4.12';
export const MEETING_ASR_SHERPA_ONNX_VERSION = '1.13.7';
export const MEETING_ASR_ONNXRUNTIME_VERSION = '1.29.0';

const meetingAsrArtifactManifestSchema = z.object({
  schemaVersion: z.literal(MEETING_ASR_ARTIFACT_SCHEMA_VERSION),
  serviceVersion: z.string().min(1).max(64),
  protocolVersion: z.literal(MEETING_ASR_PROTOCOL_VERSION),
  funasrVersion: z.literal(MEETING_ASR_FUNASR_VERSION),
  sherpaOnnxVersion: z.literal(MEETING_ASR_SHERPA_ONNX_VERSION),
  onnxruntimeVersion: z.literal(MEETING_ASR_ONNXRUNTIME_VERSION),
  qwenAsrVersion: z.literal('0.0.6').optional(),
  platform: z.enum(['darwin', 'linux', 'win32']),
  arch: z.enum(['arm64', 'x64']),
  filename: z.string().min(1).max(64),
  size: z.number().int().positive().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  build: z.object({
    mode: z.enum(['development-adhoc', 'unsigned-development']),
    pythonVersion: z.string().min(1).max(32),
    pyinstallerVersion: z.string().min(1).max(32),
    sourceDateEpoch: z.string().regex(/^\d+$/),
  }).strict(),
}).strict();

export type MeetingAsrArtifactManifest = z.infer<typeof meetingAsrArtifactManifestSchema>;

export interface VerifiedMeetingAsrArtifact {
  executablePath: string;
  workingDirectory: string;
  manifest: MeetingAsrArtifactManifest;
}

function expectedFilename(platformName: NodeJS.Platform): string {
  return platformName === 'win32' ? 'meeting-asr.exe' : 'meeting-asr';
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

export async function verifyPackagedMeetingAsr(
  resourcesPath: string,
  platformName: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): Promise<VerifiedMeetingAsrArtifact> {
  if (!['darwin', 'linux', 'win32'].includes(platformName)) {
    throw new Error(`MEETING_ASR_ARTIFACT_UNSUPPORTED_PLATFORM_${platformName}`);
  }
  if (!['arm64', 'x64'].includes(architecture)) {
    throw new Error(`MEETING_ASR_ARTIFACT_UNSUPPORTED_ARCH_${architecture}`);
  }
  const workingDirectory = path.resolve(
    resourcesPath,
    'meeting-asr',
    `${platformName}-${architecture}`,
  );
  const manifestPath = path.join(workingDirectory, 'manifest.json');
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 64 * 1024) {
    throw new Error('MEETING_ASR_ARTIFACT_INVALID_MANIFEST_FILE');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error('MEETING_ASR_ARTIFACT_INVALID_MANIFEST_JSON', { cause: error });
  }
  const manifest = meetingAsrArtifactManifestSchema.parse(parsed);
  if (manifest.platform !== platformName || manifest.arch !== architecture) {
    throw new Error('MEETING_ASR_ARTIFACT_TARGET_MISMATCH');
  }
  const expectedBuildMode = platformName === 'darwin'
    ? 'development-adhoc'
    : 'unsigned-development';
  if (manifest.build.mode !== expectedBuildMode) {
    throw new Error('MEETING_ASR_ARTIFACT_BUILD_MODE_MISMATCH');
  }
  const filename = expectedFilename(platformName);
  if (manifest.filename !== filename) throw new Error('MEETING_ASR_ARTIFACT_FILENAME_MISMATCH');
  const executablePath = path.join(workingDirectory, filename);
  const executableStat = await lstat(executablePath);
  if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
    throw new Error('MEETING_ASR_ARTIFACT_INVALID_EXECUTABLE');
  }
  if (executableStat.size !== manifest.size) throw new Error('MEETING_ASR_ARTIFACT_SIZE_MISMATCH');
  if (platformName !== 'win32' && (executableStat.mode & 0o111) === 0) {
    throw new Error('MEETING_ASR_ARTIFACT_NOT_EXECUTABLE');
  }
  const actual = await sha256File(executablePath);
  if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(manifest.sha256, 'hex'))) {
    throw new Error('MEETING_ASR_ARTIFACT_SHA256_MISMATCH');
  }
  return { executablePath, workingDirectory, manifest };
}
