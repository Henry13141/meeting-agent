import type { SpeakerDirection } from './speaker-direction';
export type { SpeakerDirection } from './speaker-direction';
export const IDLE_CLIPS = ['idle-1', 'idle-2', 'idle-3', 'idle-4'] as const;
export type MeetingClip = typeof IDLE_CLIPS[number] | 'speaking-start' | 'speaking-loop' | 'speaking-end'
  | 'turn-left' | 'return-left' | 'turn-right' | 'return-right' | 'center-bridge' | 'entrance';

/** Visual sequencing only. Speech/audio and microphone permissions remain with the meeting. */
export class MeetingVideoSequence {
  clip: MeetingClip;
  private speaking = false;
  private direction: SpeakerDirection = 'center';
  private lastIdle: MeetingClip | undefined;
  private planned: MeetingClip | undefined;

  constructor(private readonly random: () => number = Math.random) {
    this.clip = 'entrance';
  }

  private idle(): MeetingClip {
    const choices = IDLE_CLIPS.filter(clip => clip !== this.lastIdle);
    const index = Math.min(choices.length - 1, Math.max(0, Math.floor(this.random() * choices.length)));
    return choices[index]!;
  }

  private turning(): boolean {
    return this.clip.startsWith('turn-') || this.clip.startsWith('return-');
  }

  update(speaking: boolean, direction: SpeakerDirection): MeetingClip {
    const startedSpeaking = speaking && !this.speaking;
    if (speaking !== this.speaking) this.planned = undefined;
    this.speaking = speaking;
    this.direction = direction;
    // A new answer takes priority over listening gestures, including an unfinished outro.
    if (startedSpeaking) this.clip = 'speaking-start';
    // Audio owns the stop boundary; never finish a silent five-second speaking cycle.
    else if (!speaking && (this.clip === 'speaking-start' || this.clip === 'speaking-loop')) this.clip = 'speaking-end';
    // Keep the in-flight turn/return; only remember the new side for after this gesture.
    else if (!speaking && this.turning()) return this.clip;
    // Finish the turn before returning: the return clips begin in the side-facing pose.
    else if (!speaking && this.clip.startsWith('idle-') && direction !== 'center') {
      this.planned = undefined;
      this.clip = `turn-${direction}`;
    }
    return this.clip;
  }

  /** Reserve the next clip once, so the decoder can prepare it while this clip plays. */
  next(): MeetingClip {
    if (this.planned) return this.planned;
    switch (this.clip) {
      case 'entrance': this.planned = this.idle(); break;
      case 'speaking-start':
      case 'speaking-loop': this.planned = this.speaking ? 'speaking-loop' : 'speaking-end'; break;
      // The final closed-mouth frame of the ending matches idle-4's neutral entry.
      // Resume random listening gestures only after this first stable landing.
      case 'speaking-end': this.planned = this.speaking ? 'speaking-start' : 'idle-4'; break;
      case 'turn-left': this.planned = 'return-left'; break;
      case 'turn-right': this.planned = 'return-right'; break;
      case 'return-left':
      case 'return-right': this.planned = 'center-bridge'; break;
      case 'center-bridge': this.planned = this.idle(); break;
      default: this.planned = this.direction === 'center' ? this.idle() : `turn-${this.direction}`;
    }
    return this.planned;
  }

  ended(clip: MeetingClip): MeetingClip {
    if (clip !== this.clip) return this.clip;
    this.clip = this.next();
    if (this.clip.startsWith('idle-')) this.lastIdle = this.clip;
    this.planned = undefined;
    return this.clip;
  }

  replace(clip: MeetingClip): void {
    this.clip = clip;
    if (clip.startsWith('idle-')) this.lastIdle = clip;
    this.planned = undefined;
  }
}
