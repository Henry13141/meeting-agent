import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalMeetingService } from './local-meeting-service';

const services: LocalMeetingService[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function service() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-agent-meeting-service-'));
  roots.push(root);
  const instance = new LocalMeetingService({
    projectRoot: root, dataRoot: path.join(root, 'private-data'),
    recordingsRoot: path.join(root, 'recordings'), environment: {},
  });
  services.push(instance);
  return { instance, root };
}

describe('LocalMeetingService', () => {
  it('preserves original audio before reporting that local recognition is unavailable', async () => {
    const { instance } = await service();
    const meeting = await instance.create({ title: '录音不丢失' });
    await expect(instance.appendAudio({
      meetingId: meeting.id, mimeType: 'audio/webm', data: new Uint8Array([1, 2, 3]),
      pcm: new Uint8Array([1, 0]), capturedAt: '2026-11-02T08:00:00.000Z',
    })).rejects.toThrow('MEETING_ASR_UNAVAILABLE');
    const stored = await instance.get(meeting.id);
    expect(stored.audio).toHaveLength(1);
    const directory = await instance.getAudioDirectory(meeting.id);
    expect(await readFile(path.join(directory, '分片/000001.webm'))).toEqual(Buffer.from([1, 2, 3]));
    expect((await instance.getCapabilities()).localAsr).toBe(false);
    expect((await instance.getCapabilities()).voiceActivation).toBe(false);
    expect(instance.asrError).toBe('MEETING_ASR_NOT_CONFIGURED');
  });

  it('keeps archive-only capture usable and closes recording meetings at shutdown', async () => {
    const { instance, root } = await service();
    const meeting = await instance.create({ title: '仅归档' });
    const result = await instance.appendAudio({
      meetingId: meeting.id, mimeType: 'audio/webm', data: new Uint8Array([4, 5]),
      capturedAt: '2026-11-02T08:00:00.000Z', skipTranscription: true,
    });
    expect(result.audio).toHaveLength(1);
    await instance.stop();
    await expect(instance.create({ title: '结束后不可写' })).rejects.toThrow('MEETING_SERVICE_STOPPED');
    const reopened = new LocalMeetingService({
      projectRoot: root, dataRoot: path.join(root, 'private-data'),
      recordingsRoot: path.join(root, 'recordings'), environment: {},
    });
    services.push(reopened);
    expect((await reopened.get(meeting.id)).status).toBe('completed');
  });
});
