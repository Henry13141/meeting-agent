import { describe, expect, it } from 'vitest';
import { IDLE_CLIPS, MeetingVideoSequence } from './meeting-video-sequence';

function afterEntrance(random?: () => number) {
  const sequence = new MeetingVideoSequence(random);
  sequence.ended('entrance');
  return sequence;
}

describe('meeting character sequence', () => {
  it('plays the entrance once, then idle; direction changes never restart the entrance', () => {
    const sequence = new MeetingVideoSequence();
    expect(sequence.clip).toBe('entrance');
    expect(sequence.update(false, 'left')).toBe('entrance');
    expect(IDLE_CLIPS).toContain(sequence.ended('entrance'));
    expect(sequence.update(false, 'left')).toBe('turn-left');
  });

  it('lets real speech interrupt the entrance without replaying it later', () => {
    const sequence = new MeetingVideoSequence();
    expect(sequence.update(true, 'center')).toBe('speaking-start');
    expect(sequence.ended('entrance')).toBe('speaking-start');
    expect(sequence.update(false, 'center')).toBe('speaking-end');
    expect(IDLE_CLIPS).toContain(sequence.ended('speaking-end'));
    expect(sequence.clip).not.toBe('entrance');
  });

  it('rotates idle clips without adjacent repeats and never invents a turn', () => {
    let value = 0;
    const sequence = afterEntrance(() => (value = (value + 0.27) % 1));
    const visited = new Set([sequence.clip]);
    for (let i = 0; i < 30; i++) {
      const previous = sequence.clip;
      expect(IDLE_CLIPS).toContain(sequence.ended(previous));
      expect(sequence.clip).not.toBe(previous);
      visited.add(sequence.clip);
    }
    expect(visited.size).toBe(4);
  });

  it('enters the closing tail immediately when a short response stops', () => {
    const sequence = afterEntrance();
    expect(sequence.update(true, 'center')).toBe('speaking-start');
    expect(sequence.update(false, 'center')).toBe('speaking-end');
    expect(sequence.ended('speaking-start')).toBe('speaking-end');
    expect(IDLE_CLIPS).toContain(sequence.ended('speaking-end'));
  });

  it('returns from the closing take to its matched neutral idle, then resumes idle variation', () => {
    for (const random of [0, .4, .9]) {
      const sequence = afterEntrance(() => random);
      sequence.update(true, 'center');
      sequence.update(false, 'center');
      expect(sequence.next()).toBe('idle-4');
      expect(sequence.ended('speaking-end')).toBe('idle-4');
      expect(sequence.next()).not.toBe('idle-4');
    }
  });

  it('does not keep speaking until the middle cycle finishes after audio stops', () => {
    const sequence = afterEntrance();
    sequence.update(true, 'center');
    expect(sequence.ended('speaking-start')).toBe('speaking-loop');
    for (let i = 0; i < 5; i++) expect(sequence.ended('speaking-loop')).toBe('speaking-loop');
    expect(sequence.update(false, 'center')).toBe('speaking-end');
    expect(IDLE_CLIPS).toContain(sequence.next());
    expect(sequence.ended('speaking-loop')).toBe('speaking-end');
    expect(IDLE_CLIPS).toContain(sequence.ended('speaking-end'));
  });

  it('returns through center and an idle clip before changing sides', () => {
    const sequence = afterEntrance();
    expect(sequence.update(false, 'left')).toBe('turn-left');
    expect(sequence.update(false, 'right')).toBe('turn-left');
    expect(sequence.next()).toBe('return-left');
    expect(sequence.ended('turn-left')).toBe('return-left');
    expect(sequence.update(false, 'right')).toBe('return-left');
    expect(sequence.next()).toBe('center-bridge');
    expect(sequence.ended('return-left')).toBe('center-bridge');
    expect(IDLE_CLIPS).toContain(sequence.ended('center-bridge'));
    expect(sequence.ended(sequence.clip)).toBe('turn-right');
    expect(sequence.ended('turn-right')).toBe('return-right');
    expect(sequence.ended('return-right')).toBe('center-bridge');
  });

  it('does not replace a left turn with a right turn until return-left finishes', () => {
    const sequence = afterEntrance();
    sequence.update(false, 'left');
    expect(sequence.update(false, 'right')).toBe('turn-left');
    expect(sequence.ended('turn-left')).toBe('return-left');
    expect(sequence.ended('return-left')).not.toBe('turn-right');
  });

  it('finishes the turn before returning after silence, avoiding a jump to a side-facing pose', () => {
    const sequence = afterEntrance();
    sequence.update(false, 'right');
    expect(sequence.update(false, 'center')).toBe('turn-right');
    expect(sequence.next()).toBe('return-right');
    expect(sequence.ended('turn-right')).toBe('return-right');
  });

  it('keeps the preloaded random choice stable until it is played', () => {
    let draws = 0;
    const sequence = afterEntrance(() => { draws++; return 0.4; });
    const current = sequence.clip;
    const next = sequence.next();
    for (let i = 0; i < 100; i++) expect(sequence.next()).toBe(next);
    expect(draws).toBe(2);
    expect(sequence.clip).toBe(current);
    expect(sequence.ended(current)).toBe(next);
    expect(sequence.next()).not.toBe(next);
  });

  it('replaces the prepared speech loop when a short reply finishes during the opening', () => {
    const sequence = afterEntrance();
    sequence.update(true, 'center');
    expect(sequence.next()).toBe('speaking-loop');
    sequence.update(false, 'center');
    expect(sequence.clip).toBe('speaking-end');
    expect(IDLE_CLIPS).toContain(sequence.next());
    expect(sequence.ended('speaking-start')).toBe('speaking-end');
  });

  it('prioritizes a new reply over turns and an unfinished previous ending', () => {
    const sequence = afterEntrance();
    sequence.update(false, 'left');
    expect(sequence.update(true, 'left')).toBe('speaking-start');
    expect(sequence.ended('turn-left')).toBe('speaking-start');
    sequence.ended('speaking-start');
    sequence.update(false, 'center');
    sequence.ended('speaking-loop');
    expect(sequence.update(true, 'center')).toBe('speaking-start');
    expect(sequence.ended('speaking-end')).toBe('speaking-start');
  });
});
