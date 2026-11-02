import { describe, expect, it } from 'vitest';
import { StereoSpeakerDirection } from './stereo-speaker-direction';

describe('stereo speaker direction estimate', () => {
  it('requires sustained directional input and ignores brief peaks', () => {
    const tracker = new StereoSpeakerDirection();
    expect(tracker.sample(0.08, 0.025, 0)).toBe('center');
    expect(tracker.sample(0.08, 0.025, 700)).toBe('center');
    expect(tracker.sample(0.08, 0.025, 800)).toBe('left');
    expect(tracker.sample(0.02, 0.09, 900)).toBe('left');
    expect(tracker.sample(0.08, 0.025, 1000)).toBe('left');
  });

  it('holds direction through short pauses then returns to center', () => {
    const tracker = new StereoSpeakerDirection();
    tracker.sample(0.02, 0.08, 0);
    expect(tracker.sample(0.02, 0.08, 900)).toBe('right');
    expect(tracker.sample(0, 0, 1400)).toBe('right');
    expect(tracker.sample(0, 0, 2400)).toBe('center');
  });

  it('does not claim a side for duplicate mono, quiet noise or a missing channel', () => {
    for (const [left, right] of [[0.07, 0.07], [0.004, 0.001], [0.1, 0], [NaN, 0.04]]) {
      const tracker = new StereoSpeakerDirection();
      for (let t = 0; t < 10000; t += 100) expect(tracker.sample(left!, right!, t)).toBe('center');
    }
  });

  it('limits rapid switching between competing sides', () => {
    const tracker = new StereoSpeakerDirection();
    tracker.sample(0.08, 0.02, 0);
    expect(tracker.sample(0.08, 0.02, 800)).toBe('left');
    tracker.sample(0.02, 0.08, 1000);
    expect(tracker.sample(0.02, 0.08, 1800)).toBe('left');
    expect(tracker.sample(0.02, 0.08, 3100)).toBe('right');
  });
});
