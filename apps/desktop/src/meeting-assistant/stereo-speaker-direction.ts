import type { SpeakerDirection } from './speaker-direction';

/** Conservative stereo level estimate, not speaker identity or a microphone-array DOA API. */
export class StereoSpeakerDirection {
  private current: SpeakerDirection = 'center';
  private candidate: SpeakerDirection = 'center';
  private candidateSince = 0;
  private lastSignal = 0;
  private lastChange = -Infinity;

  sample(left: number, right: number, at: number): SpeakerDirection {
    if (!Number.isFinite(left + right) || Math.min(left, right) < 0.0002 || Math.max(left, right) < 0.018) {
      this.candidate = 'center';
      this.candidateSince = at;
      if (at - this.lastSignal >= 1400) this.current = 'center';
      return this.current;
    }
    this.lastSignal = at;
    const balance = (left - right) / (left + right);
    const next: SpeakerDirection = balance > 0.32 ? 'left' : balance < -0.32 ? 'right' : 'center';
    if (next !== this.candidate) {
      this.candidate = next;
      this.candidateSince = at;
    }
    if (next !== this.current && at - this.candidateSince >= 800 && at - this.lastChange >= 2200) {
      this.current = next;
      this.lastChange = at;
    }
    return this.current;
  }
}
