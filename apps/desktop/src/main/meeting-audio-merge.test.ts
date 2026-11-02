import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeMeetingAudio } from './meeting-audio-merge';
const roots: string[] = [];
async function root() { const result = await mkdtemp(path.join(os.tmpdir(), 'meeting-merge-')); roots.push(result); return result; }
afterEach(async () => { vi.unstubAllEnvs(); for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });
const sessions = ['20260909T120000-1234abcd', '20260909T120100-1234abcd'];
describe('meeting audio merge', () => {
  it('rejects paths as session identifiers before executing media processing', async () => {
    await expect(mergeMeetingAudio(await root(), [sessions[0]!, '../other'])).rejects.toThrow('MEETING_ARCHIVE_SESSIONS_INVALID');
  });
  it('does not overwrite an existing integrated archive', async () => {
    const directory = await root();
    await writeFile(path.join(directory, '完整录音.webm'), 'existing recording');
    expect(await mergeMeetingAudio(directory, sessions)).toBe(true);
    expect(await readFile(path.join(directory, '完整录音.webm'), 'utf8')).toBe('existing recording');
  });
  it('keeps originals and explains the playlist fallback when ffmpeg is unavailable', async () => {
    const directory = await root();
    vi.stubEnv('MEETING_AGENT_FFMPEG_PATH', path.join(directory, 'missing-ffmpeg'));
    expect(await mergeMeetingAudio(directory, sessions)).toBe(false);
    expect(await readFile(path.join(directory, '归档说明.txt'), 'utf8')).toContain('原始录音已保留');
    expect((await readdir(directory)).filter((name) => name.startsWith('merge-'))).toEqual([]);
  });
});
