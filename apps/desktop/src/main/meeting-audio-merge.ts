import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const merging = new Map<string, Promise<boolean>>();

/** App-owned media processing, not an Agent execute capability. No shell/network. */
export async function mergeMeetingAudio(directory: string, sessions: readonly string[]): Promise<boolean> {
  const existing = merging.get(directory);
  if (existing) return existing;
  const job = merge(directory, sessions).finally(() => merging.delete(directory));
  merging.set(directory, job);
  return job;
}

async function merge(directory: string, sessions: readonly string[]): Promise<boolean> {
  if (sessions.length < 2 || sessions.some((session) => !/^\d{8}T\d{6}-[0-9a-f]{8}$/.test(session))) {
    throw new Error('MEETING_ARCHIVE_SESSIONS_INVALID');
  }
  const output = path.join(directory, '完整录音.webm');
  if (await stat(output).then((value) => value.isFile() && value.size > 0).catch(() => false)) return true;
  const taskId = randomUUID();
  const manifest = path.join(directory, `merge-${taskId}.txt`);
  const temporary = path.join(directory, `merge-${taskId}.webm`);
  try {
    await writeFile(manifest, sessions.map((session) => `file '完整录音片段/${session}.webm'`).join('\n'), { flag: 'wx' });
    await execute(process.env.MEETING_AGENT_FFMPEG_PATH?.trim() || 'ffmpeg', [
      '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-f', 'concat', '-safe', '0',
      '-i', manifest, '-map', '0:a:0', '-vn', '-c:a', 'libopus', '-b:a', '64k', '-n', temporary,
    ], { cwd: directory, windowsHide: true, timeout: 300_000, maxBuffer: 64_000 });
    if ((await stat(temporary)).size < 16) throw new Error('MEETING_ARCHIVE_MERGE_EMPTY');
    await copyFile(temporary, output, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return true;
  } catch {
    // Preserve every original session and a usable playlist even without FFmpeg.
    await writeFile(path.join(directory, '归档说明.txt'), '单文件音频合并尚未成功。原始录音已保留，请打开“播放完整录音.html”连续播放。请检查本机 FFmpeg 或 MEETING_AGENT_FFMPEG_PATH 后重新打开播放器以重试。', 'utf8');
    return false;
  } finally {
    await Promise.all([manifest, temporary].map((file) => rm(file, { force: true }).catch(() => undefined)));
  }
}
