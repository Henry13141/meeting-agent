import { describe, expect, it } from 'vitest';
import { meetingVideoFraming } from './meeting-video-framing';
import type { MeetingClip } from './meeting-video-sequence';

describe('meeting character camera', () => {
  it('gives smaller turn openings and the larger bridge ending the same apparent scale', () => {
    for (const [clip, time, sourceScale] of [
      ['idle-1', 0, 1], ['turn-left', 0, .978], ['turn-right', 0, .978],
      ['return-left', 4.88, .984], ['center-bridge', 4.88, 1.032],
    ] as [MeetingClip, number, number][]) {
      expect(meetingVideoFraming(clip, time, 1498, 950).scale * sourceScale).toBeCloseTo(1.04, 6);
    }
  });

  it('uses the same camera on both sides of the continuous right-turn boundary', () => {
    const turn = meetingVideoFraming('turn-right', 10, 1000, 760);
    expect(meetingVideoFraming('return-right', 10, 1000, 760)).toEqual(turn);
    expect(Math.abs(meetingVideoFraming('return-right', 10.001, 1000, 760).scale - turn.scale)).toBeLessThan(.000001);
  });

  it('keeps the picture covering the stage in wide and narrow windows', () => {
    const clips: MeetingClip[] = ['entrance', 'idle-1', 'speaking-start', 'speaking-loop', 'speaking-end', 'turn-left', 'return-left', 'turn-right', 'return-right', 'center-bridge'];
    for (const [width, height] of [[1000, 760], [1498, 950], [1920, 900]]) {
      const pixel = Math.max(width / 480, height / 270);
      for (const clip of clips) for (let time = 0; time <= 15; time += .25) {
        const f = meetingVideoFraming(clip, time, width, height);
        const top = 95 * pixel * (1 - f.scale) + f.y;
        const bottom = top + height * f.scale;
        expect(top).toBeLessThanOrEqual(0);
        expect(bottom).toBeGreaterThanOrEqual(height);
        expect(width / 2 * (1 - f.scale) + f.x).toBeLessThanOrEqual(0);
        expect(width / 2 * (1 + f.scale) + f.x).toBeGreaterThanOrEqual(width);
      }
    }
  });
});
