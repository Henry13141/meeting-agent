import { describe, expect, it, vi } from 'vitest';
import { MeetingAudioRecorder, type MeetingAudioRecorderOptions } from './audio-recorder';

describe('meeting audio recorder admission', () => {
  it('stops an older capture before another recorder starts in the same window', async () => {
    const first = new MeetingAudioRecorder();
    const second = new MeetingAudioRecorder();
    const firstCapture = first as unknown as { startCapture: () => Promise<void>; stopCapture: () => Promise<void> };
    const secondCapture = second as unknown as { startCapture: () => Promise<void>; stopCapture: () => Promise<void> };
    vi.spyOn(firstCapture, 'startCapture').mockResolvedValue();
    const firstStop = vi.spyOn(firstCapture, 'stopCapture').mockResolvedValue();
    vi.spyOn(secondCapture, 'startCapture').mockResolvedValue();
    vi.spyOn(secondCapture, 'stopCapture').mockResolvedValue();
    const options = { microphone: true } as MeetingAudioRecorderOptions;

    await first.start(options);
    await second.start(options);
    expect(firstStop).toHaveBeenCalledOnce();
    await second.stop();
  });
});
