import { describe, expect, it } from 'vitest';
import { meetingVideoExposure } from './meeting-video-exposure';

describe('meeting video exposure', () => {
  it('preserves neutral recent takes and compensates the darker return take', () => {
    expect(meetingVideoExposure('idle-1', 2)).toBe(1);
    expect(meetingVideoExposure('speaking-loop', 3)).toBe(1);
    const gamma = meetingVideoExposure('return-left', 1);
    expect(gamma).toBeGreaterThan(.4);
    expect(gamma).toBeLessThan(.7);
    // Gamma lifts mid-tones without changing black and white endpoints.
    expect(Math.pow(0, gamma)).toBe(0);
    expect(Math.pow(1, gamma)).toBe(1);
    expect(Math.pow(.5, gamma)).toBeGreaterThan(.5);
  });

  it('tracks the rapid source exposure change after the bright first frame', () => {
    expect(meetingVideoExposure('center-bridge', 0)).toBeGreaterThan(1);
    expect(meetingVideoExposure('center-bridge', .08)).toBeLessThan(.95);
    expect(meetingVideoExposure('center-bridge', .2)).toBeLessThan(.8);
    expect(meetingVideoExposure('center-bridge', .1)).toBeGreaterThan(meetingVideoExposure('center-bridge', .12));
    expect(meetingVideoExposure('center-bridge', .1)).toBeLessThan(meetingVideoExposure('center-bridge', .08));
  });

  it('keeps exposure continuous across the right turn and return phase', () => {
    for (const time of [9.99, 10, 10.01, 14]) {
      expect(meetingVideoExposure('return-right', time)).toBe(meetingVideoExposure('turn-right', time));
    }
  });
});
