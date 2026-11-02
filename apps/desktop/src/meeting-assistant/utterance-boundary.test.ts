import { describe, expect, it } from 'vitest';
import { UtteranceBoundary } from './utterance-boundary';
describe('utterance boundary', () => {
  it('uses neural speech state even for quiet voices and resets between sessions', () => {
    const boundary = new UtteranceBoundary();
    expect(boundary.speech(false, 0)).toBe(false);
    expect(boundary.speech(true, 100)).toBe(false);
    expect(boundary.speech(false, 200)).toBe(false);
    expect(boundary.speech(false, 400)).toBe(false);
    expect(boundary.speech(false, 999)).toBe(false);
    expect(boundary.speech(false, 1000)).toBe(true);
    boundary.speech(true, 1000);
    boundary.reset();
    expect(boundary.speech(false, 2000)).toBe(false);
  });
  it('ignores initial silence and short pauses, emits once after speech ends', () => {
    const boundary = new UtteranceBoundary();
    expect(boundary.sample(0, 1000)).toBe(false);
    expect(boundary.sample(0.1, 2000)).toBe(false);
    expect(boundary.sample(0, 2600)).toBe(false);
    expect(boundary.sample(0.1, 2800)).toBe(false);
    expect(boundary.sample(0, 3700)).toBe(true);
    expect(boundary.sample(0, 4700)).toBe(false);
  });
});
