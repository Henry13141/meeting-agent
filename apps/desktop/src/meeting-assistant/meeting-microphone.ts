export type MeetingMicrophoneOpen = Readonly<{
  stream: MediaStream;
  stereo: boolean;
}>;

export function isStereoAudioTrack(track: MediaStreamTrack): boolean {
  return track.getSettings().channelCount === 2;
}

export function meetingMicrophoneAttempts(): readonly MediaTrackConstraints[] {
  return [
    { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 2 },
    { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 2 } },
    { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  ];
}

export async function openMeetingMicrophone(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
): Promise<MeetingMicrophoneOpen> {
  let lastError: unknown;
  const attempts = meetingMicrophoneAttempts();
  for (const [index, audio] of attempts.entries()) {
    try {
      const stream = await getUserMedia({ audio, video: false });
      const track = stream.getAudioTracks()[0];
      if (track && !isStereoAudioTrack(track)) {
        await track.applyConstraints({ channelCount: 2, echoCancellation: true }).catch(() => undefined);
      }
      const stereo = Boolean(track && isStereoAudioTrack(track));
      if (stereo || index === attempts.length - 1) return { stream, stereo };
      stream.getTracks().forEach((item) => item.stop());
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('MEETING_AUDIO_UNAVAILABLE');
}
