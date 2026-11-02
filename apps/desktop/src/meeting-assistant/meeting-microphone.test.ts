import { describe, expect, it, vi } from 'vitest';
import { isStereoAudioTrack, meetingMicrophoneAttempts, openMeetingMicrophone } from './meeting-microphone';

function track(channelCount: number | undefined, apply = vi.fn(async () => undefined)) {
  return {
    getSettings: () => ({ channelCount }),
    applyConstraints: apply,
    stop: vi.fn(),
  };
}

describe('meeting microphone stereo admission', () => {
  it('keeps echo cancellation enabled for every microphone attempt', () => {
    expect(meetingMicrophoneAttempts().every((attempt) => attempt.echoCancellation === true)).toBe(true);
  });

  it('keeps a stereo stream from an earlier attempt', async () => {
    const stereo = track(2);
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(new Error('OverconstrainedError'))
      .mockResolvedValueOnce({ getAudioTracks: () => [stereo], getTracks: () => [stereo] });
    await expect(openMeetingMicrophone(getUserMedia)).resolves.toEqual({
      stream: expect.objectContaining({ getAudioTracks: expect.any(Function) }),
      stereo: true,
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(stereo.stop).not.toHaveBeenCalled();
  });

  it('falls back to the last stream when the device stays mono', async () => {
    const first = track(1);
    const last = track(1);
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce({ getAudioTracks: () => [first], getTracks: () => [first] })
      .mockResolvedValueOnce({ getAudioTracks: () => [track(1)], getTracks: () => [track(1)] })
      .mockResolvedValueOnce({ getAudioTracks: () => [last], getTracks: () => [last] });
    await expect(openMeetingMicrophone(getUserMedia)).resolves.toMatchObject({ stereo: false });
    expect(first.stop).toHaveBeenCalled();
    expect(isStereoAudioTrack(last as unknown as MediaStreamTrack)).toBe(false);
  });
});
