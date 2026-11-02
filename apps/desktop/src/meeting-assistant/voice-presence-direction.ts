import type { SpeakerDirection } from './speaker-direction';

/** Mono voice activity turns the character aside. This is not left/right localization. */
export class VoicePresenceDirection {
  private current: SpeakerDirection = 'center';
  private candidateSince = 0;
  private lastSignal = 0;
  private lastChange = -Infinity;
  private hearing = false;

  sample(level: number, at: number): SpeakerDirection {
    const heard = Number.isFinite(level) && level >= 0.06;
    if (!heard) {
      this.hearing = false;
      this.candidateSince = at;
      if (at - this.lastSignal >= 1400) this.current = 'center';
      return this.current;
    }
    if (!this.hearing) {
      this.hearing = true;
      this.candidateSince = at;
    }
    this.lastSignal = at;
    if (this.current !== 'left' && at - this.candidateSince >= 800 && at - this.lastChange >= 2200) {
      this.current = 'left';
      this.lastChange = at;
    }
    return this.current;
  }
}
