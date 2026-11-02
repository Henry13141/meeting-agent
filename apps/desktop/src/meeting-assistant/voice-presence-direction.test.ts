import { describe, expect, it } from 'vitest';
import { VoicePresenceDirection } from './voice-presence-direction';

describe('voice presence direction', () => {
  it('turns aside only after sustained speech', () => {
    const tracker = new VoicePresenceDirection();
    expect(tracker.sample(0.2, 0)).toBe('center');
    expect(tracker.sample(0.2, 700)).toBe('center');
    expect(tracker.sample(0.2, 800)).toBe('left');
  });

  it('ignores brief peaks and returns after a pause', () => {
    const tracker = new VoicePresenceDirection();
    expect(tracker.sample(0.2, 0)).toBe('center');
    expect(tracker.sample(0.01, 200)).toBe('center');
    expect(tracker.sample(0.2, 400)).toBe('center');
    expect(tracker.sample(0.2, 1200)).toBe('left');
    expect(tracker.sample(0, 1600)).toBe('left');
    expect(tracker.sample(0, 2600)).toBe('center');
  });
});
