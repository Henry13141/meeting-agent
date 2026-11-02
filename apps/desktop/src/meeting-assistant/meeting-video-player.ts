import { IDLE_CLIPS, MeetingVideoSequence, type MeetingClip, type SpeakerDirection } from './meeting-video-sequence';
import { meetingVideoFraming } from './meeting-video-framing';
import { meetingVideoExposure } from './meeting-video-exposure';

export interface MeetingVideoSource {
  src: string; start?: number; end?: number; handoffLead?: number; speechCue?: number; playbackRate?: number;
  /** Manually verified, half-open decoded-media ranges where the mouth is already closed. */
  closedMouthRanges?: readonly (readonly [number, number])[];
  /** Half-open idle blink ranges, measured from the original 24 fps takes. */
  avoidSpeechCutRanges?: readonly (readonly [number, number])[];
}
type Slot = {
  video: HTMLVideoElement; clip?: MeetingClip; ready: boolean; starting: boolean;
  revision: number; cleanup: () => void; frame?: number; watch?: number; gamma?: number; filter?: string; mediaTime?: number;
  revealTimer?: number;
};
// The final video frame precedes the MP4's audio/container tail. Prepare the first
// incoming frame here, then swap opaque pictures; face dissolves create double eyes.
const HANDOFF_LEAD_SECONDS = 0.09;

/** Two rotating decoders plus an optional warm closing take. React never drives the frame clock. */
export class MeetingVideoPlayer {
  private readonly sequence = new MeetingVideoSequence();
  private readonly slots: Slot[];
  private readonly failed = new Set<MeetingClip>();
  private front = -1;
  private switching = false;
  private active = false;
  private disposed = false;
  private clock?: number;
  private speechReady?: { resolve: (ready: boolean) => void; timer: number };
  private openingWaitUntil = 0;
  private readonly context: CanvasRenderingContext2D | null;

  constructor(videos: [HTMLVideoElement, HTMLVideoElement] | [HTMLVideoElement, HTMLVideoElement, HTMLVideoElement],
    private readonly sources: Record<MeetingClip, MeetingVideoSource>,
    private readonly onError: (message: string) => void,
    private readonly onTone?: (slot: number, gamma: number) => string,
    private readonly canvas?: HTMLCanvasElement) {
    this.slots = videos.map(video => ({ video, ready: false, starting: false, revision: 0, cleanup: () => {} }));
    this.context = canvas?.getContext('2d', { alpha: false }) ?? null;
  }

  update(speaking: boolean, direction: SpeakerDirection, active: boolean): void {
    if (this.disposed) return;
    const previous = this.sequence.clip;
    this.sequence.update(speaking, direction);
    if (speaking && previous !== 'speaking-start' && this.sequence.clip === 'speaking-start') {
      this.openingWaitUntil = Date.now() + 200;
    }
    if (!speaking || !active) this.openingWaitUntil = 0;
    if (!speaking || !active) this.finishSpeechReady(false);
    const front = this.slots[this.front];
    const alreadyClosed = front?.clip && front.mediaTime !== undefined
      && this.sources[front.clip].closedMouthRanges?.some(([start, end]) => front.mediaTime! >= start && front.mediaTime! < end);
    if (!speaking && alreadyClosed) this.sequence.replace('idle-4');
    if (!speaking && (alreadyClosed || !this.warmEnding()?.ready || this.failed.has('speaking-end')) && (front?.clip === 'speaking-start' || front?.clip === 'speaking-loop')) {
      // Degraded/cold path only: retain the last picture without silently talking
      // through a decoder failure. The warm path keeps moving until its next frame.
      front.video.pause();
      this.cancelReveal(front);
    }
    if (!active) {
      this.active = false;
      if (this.clock !== undefined) cancelAnimationFrame(this.clock);
      this.clock = undefined;
      for (const slot of this.slots) {
        this.cancelReveal(slot); slot.video.pause();
        if (slot === this.warmEnding() && slot !== front) { slot.cleanup(); slot.clip = undefined; slot.ready = false; }
      }
      return;
    }
    const resuming = !this.active;
    this.active = true;
    if (resuming) {
      const slot = this.slots[this.front];
      if (slot && slot.clip === this.sequence.clip && !slot.video.ended) {
        const revision = slot.revision;
        void slot.video.play().catch(() => { if (this.active && slot.revision === revision) this.fail(slot); });
        this.watchFrames(slot);
      }
      this.tick();
    } else this.sync();
  }

  /** Audio waits for the decoded opening cue to be visible, including any preroll. */
  startSpeech(): Promise<boolean> {
    if (this.disposed || !this.active) return Promise.resolve(false);
    this.stopSpeech();
    // With a dedicated outro, stopping no longer reloads the old incoming slot.
    // A replacement answer still needs its own complete opening and callbacks.
    for (const slot of this.slots) if (slot !== this.slots[this.front] && slot.clip === 'speaking-start') {
      this.cancelReveal(slot);
      slot.cleanup();
      slot.clip = undefined;
    }
    this.switching = true;
    return new Promise(resolve => {
      this.speechReady = { resolve, timer: window.setTimeout(() => this.stopSpeech(), 750) };
      this.update(true, 'center', true);
    });
  }

  stopSpeech(): void { this.update(false, 'center', this.active); }

  private finishSpeechReady(ready: boolean): void {
    const pending = this.speechReady;
    this.speechReady = undefined;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pending.resolve(ready);
  }

  private tick = (): void => {
    if (!this.active || this.disposed) return;
    this.sync();
    const slot = this.slots[this.front];
    if (slot) this.render(slot);
    this.clock = requestAnimationFrame(this.tick);
  };

  private frame(slot: Slot, time: number): void {
    if (!slot.clip) return;
    slot.mediaTime = time;
    const gamma = meetingVideoExposure(slot.clip, time);
    if (gamma !== slot.gamma) {
      slot.gamma = gamma;
      slot.filter = this.onTone?.(this.slots.indexOf(slot), gamma);
    }
    if (slot === this.slots[this.front]) this.render(slot);
  }

  private render(slot: Slot): void {
    const canvas = this.canvas, context = this.context;
    if (canvas) {
      if (!context || !slot.clip || slot.video.readyState < 2 || !slot.video.videoWidth) return;
      const width = canvas.clientWidth, height = canvas.clientHeight;
      if (!width || !height) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 1920 / width, 1080 / height);
      const targetWidth = Math.max(1, Math.round(width * ratio));
      const targetHeight = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth; canvas.height = targetHeight;
      }
      const framing = meetingVideoFraming(slot.clip, slot.mediaTime ?? slot.video.currentTime, width, height);
      const pixel = Math.max(width / 480, height / 270);
      context.save();
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.filter = slot.filter ?? 'none';
      context.translate(framing.x, framing.y);
      context.translate(width / 2, 95 * pixel);
      context.scale(framing.scale, framing.scale);
      context.translate(-width / 2, -95 * pixel);
      // Do not clear the retained opaque picture between clips. A decoder/filter
      // surface that is momentarily unavailable must leave the previous frame intact.
      context.drawImage(slot.video, (width - 480 * pixel) / 2, 0, 480 * pixel, 270 * pixel);
      context.restore();
    }
    // mediaTime is recorded only by decoded-frame callbacks. A loaded/seeked event
    // or an advanced playback clock cannot release audio before the picture is drawn.
    if (this.speechReady && this.active && !this.disposed && !this.switching
      && slot === this.slots[this.front] && slot.clip === 'speaking-start' && slot.mediaTime !== undefined) {
      const cue = this.sources[slot.clip].speechCue;
      if (cue === undefined || slot.mediaTime >= cue) this.finishSpeechReady(true);
    }
  }

  private watchFrames(slot: Slot): void {
    if (slot.watch !== undefined) return;
    const revision = slot.revision;
    const watch = slot.video.requestVideoFrameCallback((_now, metadata) => {
      if (slot.watch !== watch || slot.revision !== revision) return;
      slot.watch = undefined;
      if (!this.active || this.disposed || slot !== this.slots[this.front]) return;
      // Match exposure to the decoded frame, not a playback clock one frame ahead.
      this.frame(slot, metadata.mediaTime);
      this.watchFrames(slot);
    });
    slot.watch = watch;
  }

  private sync(): void {
    if (!this.active || this.disposed) return;
    const ending = this.warmEnding();
    if (ending && ending !== this.slots[this.front]) {
      if (ending.starting && this.sequence.clip !== 'speaking-end') {
        this.cancelReveal(ending); ending.cleanup(); ending.clip = undefined;
      }
      this.prepare(ending, 'speaking-end');
    }
    const current = this.slots[this.front];
    if (this.failed.has(this.sequence.clip)) {
      const fallback = IDLE_CLIPS.find(clip => !this.failed.has(clip));
      if (!fallback) { this.onError('视频暂时无法播放，会议和语音仍可继续。'); return; }
      this.sequence.replace(fallback);
      this.switching = true;
    }
    if (!current || current.clip !== this.sequence.clip || this.switching) {
      const incoming = this.incoming(this.sequence.clip);
      this.prepare(incoming, this.sequence.clip);
      // Keep decoding the idle while preparing the opening. Only wait for a
      // blink that can finish within 200ms; long blinks retain the normal cut.
      // Check the latest presented frame, not the frame at the speech request.
      if (this.sequence.clip === 'speaking-start' && current?.clip && current.mediaTime !== undefined
        && Date.now() < this.openingWaitUntil
        && this.sources[current.clip].avoidSpeechCutRanges?.some(([start, end]) =>
          current.mediaTime! >= start && current.mediaTime! < end && end - current.mediaTime! <= .2)) return;
      this.revealWhenReady(incoming);
      return;
    }
    const source = this.sources[current.clip!];
    const next = this.sequence.next();
    const nextSource = this.sources[next];
    const end = source.end ?? current.video.duration;
    const contiguous = source.end !== undefined && source.src === nextSource.src && source.end === nextSource.start;
    if (contiguous) {
      // Right turn and return are one continuous take: never reload or seek backwards.
      if (current.video.currentTime >= end) {
        current.clip = this.sequence.ended(current.clip!);
        current.video.dataset.clip = current.clip;
      }
      return;
    }
    const incoming = this.incoming(next);
    this.prepare(incoming, next);
    if (current.video.ended || (Number.isFinite(end)
      && end - current.video.currentTime <= (source.handoffLead ?? HANDOFF_LEAD_SECONDS) * current.video.playbackRate)) {
      this.sequence.ended(current.clip!);
      this.switching = true;
      this.revealWhenReady(incoming);
    }
  }

  private warmEnding(): Slot | undefined { return this.slots[2]; }

  private incoming(clip: MeetingClip): Slot {
    if (clip === 'speaking-end' && this.warmEnding() && this.front !== 2) return this.warmEnding()!;
    return this.slots[this.front === 0 ? 1 : 0]!;
  }

  private cancelReveal(slot: Slot): void {
    if (slot.revealTimer !== undefined) window.clearTimeout(slot.revealTimer);
    slot.revealTimer = undefined;
    if (slot.frame !== undefined) slot.video.cancelVideoFrameCallback(slot.frame);
    if (slot.watch !== undefined) slot.video.cancelVideoFrameCallback(slot.watch);
    slot.frame = undefined;
    slot.watch = undefined;
    slot.starting = false;
  }

  private prepare(slot: Slot, clip: MeetingClip): void {
    if (slot.clip === clip || this.failed.has(clip)) return;
    this.cancelReveal(slot);
    slot.cleanup();
    const revision = ++slot.revision;
    const video = slot.video;
    video.pause();
    slot.clip = clip;
    slot.ready = false;
    slot.mediaTime = undefined;
    video.dataset.clip = clip;
    const valid = () => !this.disposed && slot.revision === revision;
    const ready = () => {
      if (!valid()) return;
      slot.ready = true;
      window.clearTimeout(timeout);
    };
    const loaded = () => {
      if (!valid()) return;
      const start = this.sources[clip].start ?? 0;
      if (Math.abs(video.currentTime - start) > 0.01) {
        video.addEventListener('seeked', ready, { once: true });
        video.currentTime = start;
      } else ready();
    };
    const error = () => { if (valid()) this.fail(slot); };
    const timeout = window.setTimeout(error, 10_000);
    video.addEventListener('loadeddata', loaded, { once: true });
    video.addEventListener('error', error);
    video.src = this.sources[clip].src;
    video.load();
    slot.cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('seeked', ready);
      video.removeEventListener('error', error);
    };
  }

  private revealWhenReady(slot: Slot): void {
    if (!slot.ready || slot.starting || this.failed.has(slot.clip!)) return;
    slot.starting = true;
    const revision = slot.revision;
    const valid = () => this.active && !this.disposed && slot.revision === revision
      && slot.clip === this.sequence.clip;
    // load() can restore the default playbackRate. Apply the per-take rate after
    // readiness, immediately before play, rather than before assigning src/load.
    slot.video.playbackRate = this.sources[slot.clip!].playbackRate ?? 1;
    slot.revealTimer = window.setTimeout(() => {
      if (!valid()) return;
      if (slot.clip === 'speaking-end') {
        const outgoing = this.slots[this.front];
        if (outgoing) { outgoing.video.pause(); this.cancelReveal(outgoing); }
      }
      this.fail(slot);
    }, 500);
    // Register before play so the first presented frame, not the second, becomes visible.
    const frame = slot.video.requestVideoFrameCallback((_now, metadata) => {
      if (slot.frame !== frame || slot.revision !== revision) return;
      slot.frame = undefined;
      if (slot.revealTimer !== undefined) window.clearTimeout(slot.revealTimer);
      slot.revealTimer = undefined;
      if (valid()) { this.frame(slot, metadata.mediaTime); this.commit(slot); this.watchFrames(slot); }
      else { slot.starting = false; slot.video.pause(); }
    });
    slot.frame = frame;
    void slot.video.play().catch(() => { if (valid()) this.fail(slot); });
  }

  private commit(incoming: Slot): void {
    const outgoing = this.slots[this.front];
    this.front = this.slots.indexOf(incoming);
    this.switching = false;
    incoming.starting = false;
    incoming.video.dataset.active = 'true';
    incoming.video.classList.remove('is-inactive');
    this.onError('');
    this.render(incoming);
    if (!outgoing) return;
    outgoing.video.dataset.active = 'false';
    // These visibility changes are committed in the same frame. Never show two faces.
    outgoing.video.classList.add('is-inactive');
    this.cancelReveal(outgoing);
    outgoing.video.pause();
    outgoing.clip = undefined;
  }

  private fail(slot: Slot): void {
    if (this.disposed || !slot.clip) return;
    this.failed.add(slot.clip);
    this.cancelReveal(slot);
    slot.cleanup();
    // Leave the last good picture visible until a healthy idle clip is decoded.
    if (slot === this.slots[this.front]) this.sequence.replace(slot.clip);
  }

  dispose(): void {
    this.finishSpeechReady(false);
    this.disposed = true;
    this.active = false;
    if (this.clock !== undefined) cancelAnimationFrame(this.clock);
    for (const slot of this.slots) {
      this.cancelReveal(slot);
      slot.cleanup();
      slot.video.pause();
      slot.video.removeAttribute('src');
      slot.video.load();
    }
  }
}
