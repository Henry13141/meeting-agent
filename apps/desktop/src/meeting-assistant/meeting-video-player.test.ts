import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingVideoPlayer, type MeetingVideoSource } from './meeting-video-player';
import { IDLE_CLIPS, type MeetingClip } from './meeting-video-sequence';

// A controllable decoder lets us withhold loadeddata/presented frames and exercise races.
class Decoder extends EventTarget {
  src = '';
  duration = 5;
  currentTime = 0;
  playbackRate = 1;
  readyState = 4;
  videoWidth = 1920;
  paused = true;
  dataset: Record<string, string> = { active: 'false' };
  style = { zIndex: '' };
  classes = new Set(['is-inactive']);
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) };
  frames = new Map<number, VideoFrameRequestCallback>();
  frameId = 0;
  load = vi.fn(() => { this.currentTime = 0; this.playbackRate = 1; });
  pause = vi.fn(() => { this.paused = true; });
  play = vi.fn(async () => { this.paused = false; });
  animate = vi.fn(() => ({ cancel: vi.fn() }));
  get ended() { return this.currentTime >= this.duration; }
  removeAttribute() { this.src = ''; }
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) { this.frames.set(++this.frameId, callback); return this.frameId; }
  cancelVideoFrameCallback(id: number) { this.frames.delete(id); }
  loaded() { this.dispatchEvent(new Event('loadeddata')); }
  present(mediaTime = this.currentTime) { const callbacks = [...this.frames.values()]; this.frames.clear(); callbacks.forEach(callback => callback(0, { mediaTime } as VideoFrameCallbackMetadata)); }
}

describe('meeting video handoff', () => {
  let clock: Map<number, FrameRequestCallback>;
  let first: Decoder, second: Decoder, player: MeetingVideoPlayer;
  let sources: Record<MeetingClip, MeetingVideoSource>;
  const step = () => { const callbacks = [...clock.values()]; clock.clear(); callbacks.forEach(callback => callback(0)); };
  beforeEach(() => {
    vi.useFakeTimers();
    clock = new Map(); let clockId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { clock.set(++clockId, callback); return clockId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clock.delete(id));
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const clips: MeetingClip[] = [...IDLE_CLIPS, 'speaking-start', 'speaking-loop', 'speaking-end', 'turn-left', 'return-left', 'turn-right', 'return-right', 'center-bridge', 'entrance'];
    sources = Object.fromEntries(clips.map(clip => [clip, { src: `${clip}.mp4` }])) as Record<MeetingClip, MeetingVideoSource>;
    sources['turn-right'] = { src: 'right.mp4', end: 10 };
    sources['return-right'] = { src: 'right.mp4', start: 10 };
    sources['speaking-end'] = { src: 'speaking-end.mp4', start: 4.875, end: 121 / 24, handoffLead: 0 };
    first = new Decoder(); second = new Decoder();
    player = new MeetingVideoPlayer([first, second] as unknown as [HTMLVideoElement, HTMLVideoElement], sources, vi.fn());
  });
  afterEach(() => { player.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  function start(speaking = false, direction: 'left' | 'right' | 'center' = 'center') {
    if (speaking) {
      player.update(true, direction, true);
      first.loaded();
      step();
      first.present();
      step();
      return;
    }
    player.update(false, 'center', true);
    first.loaded();
    step();
    first.present();
    step();
    first.currentTime = 4.95;
    step();
    second.loaded();
    step();
    second.present();
    step();
    [first, second] = [second, first];
    if (direction === 'center') return;
    player.update(false, direction, true);
    second.loaded();
    step();
    second.present();
    step();
    [first, second] = [second, first];
  }

  it('preloads while the current clip moves and swaps opaque frames without overlapping faces', () => {
    start();
    expect(second.src).toBe('idle-2.mp4');
    expect(second.paused).toBe(true);
    first.currentTime = 4.95; step(); // Deliberately withhold the second decoder.
    expect(first.paused).toBe(false);
    expect(first.classes.has('is-inactive')).toBe(false);
    second.loaded(); step();
    expect(first.dataset.active).toBe('true');
    second.present();
    expect(second.dataset.active).toBe('true');
    expect(first.paused).toBe(true);
    expect(first.classes.has('is-inactive')).toBe(true);
    expect(first.animate).not.toHaveBeenCalled();
    expect(second.animate).not.toHaveBeenCalled();
  });

  it('repeats the middle clip with a prepared decoder instead of freezing on the last frame', () => {
    start(true); second.loaded(); first.currentTime = 4.95; step(); second.present();
    step(); first.loaded();
    expect(second.dataset.clip).toBe('speaking-loop');
    expect(first.dataset.clip).toBe('speaking-loop');
    second.currentTime = 4.95; step(); first.present();
    expect(first.dataset.active).toBe('true');
    expect(first.currentTime).toBe(0);
    expect(first.paused).toBe(false);
  });

  it('does not cut a left turn when the opposite side arrives mid-gesture', () => {
    start(false, 'left');
    expect(first.dataset.clip).toBe('turn-left');
    const loads = first.load.mock.calls.length;
    player.update(false, 'right', true);
    step();
    expect(first.dataset.clip).toBe('turn-left');
    expect(first.paused).toBe(false);
    expect(first.load).toHaveBeenCalledTimes(loads);
    expect(second.dataset.clip).toBe('return-left');
    expect(second.src).toBe('return-left.mp4');
  });

  it('keeps the same right-turn decoder and time position when crossing into the return', () => {
    start(false, 'right'); first.duration = 15;
    const loads = first.load.mock.calls.length;
    const pauses = first.pause.mock.calls.length;
    player.update(false, 'center', true);
    first.currentTime = 10.03; step();
    expect(first.dataset.clip).toBe('return-right');
    expect(first.dataset.active).toBe('true');
    expect(first.currentTime).toBe(10.03);
    expect(first.load).toHaveBeenCalledTimes(loads);
    expect(first.pause).toHaveBeenCalledTimes(pauses);
  });

  it('retains one opaque output canvas while the next decoder waits for a real frame', () => {
    player.dispose();
    const context = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), translate: vi.fn(), scale: vi.fn(), drawImage: vi.fn(), clearRect: vi.fn(), filter: 'none' };
    const canvas = { width: 480, height: 300, clientWidth: 480, clientHeight: 300, getContext: vi.fn(() => context) };
    const sources = Object.fromEntries(['entrance', ...IDLE_CLIPS].map(clip => [clip, { src: clip + '.mp4' }])) as Record<MeetingClip, MeetingVideoSource>;
    player = new MeetingVideoPlayer([first, second] as unknown as [HTMLVideoElement, HTMLVideoElement], sources, vi.fn(), undefined, canvas as unknown as HTMLCanvasElement);
    start();
    expect(canvas.getContext).toHaveBeenCalledWith('2d', { alpha: false });
    expect(context.drawImage.mock.calls.at(-1)?.[0]).toBe(first);
    first.currentTime = 4.95; step();
    expect(context.drawImage.mock.calls.at(-1)?.[0]).toBe(first);
    second.loaded(); step(); second.present();
    expect(context.drawImage.mock.calls.at(-1)?.[0]).toBe(second);
    expect(context.clearRect).not.toHaveBeenCalled();
  });

  it('discards a late frame from an interrupted clip and stops decoders when leaving', () => {
    start(); player.update(true, 'center', true); second.loaded(); step();
    player.update(false, 'center', false); second.present();
    expect(first.dataset.active).toBe('true');
    expect(first.paused && second.paused).toBe(true);
    expect(clock.size).toBe(0);
    player.update(false, 'center', true); second.loaded(); second.dispatchEvent(new Event('seeked')); step(); second.present();
    expect(second.dataset.clip).toBe('speaking-end');
    expect(second.dataset.active).toBe('true');
    player.dispose();
    first.loaded(); second.present();
    expect(first.src).toBe('');
    expect(second.src).toBe('');
    expect(clock.size).toBe(0);
  });

  it('freezes speech immediately while decoding the short closing tail', () => {
    start(true);
    first.currentTime = 1;
    player.update(false, 'center', true);
    expect(first.paused).toBe(true);
    expect(second.dataset.clip).toBe('speaking-end');
    second.duration = 5.06195;
    second.loaded(); second.dispatchEvent(new Event('seeked')); step(); second.present(); step();
    expect(second.currentTime).toBe(4.875);
    first.loaded();
    second.currentTime = 4.98; step(); first.present();
    expect(second.dataset.active).toBe('true'); // Do not skip the final closed-mouth frame.
    second.currentTime = 5; second.present(); step();
    expect(second.dataset.active).toBe('true');
    second.currentTime = 121 / 24; step(); first.present();
    expect(first.dataset.active).toBe('true');
  });

  it('keeps a dedicated closing decoder warm so stop does not freeze for a cold seek', () => {
    player.dispose();
    const ending = new Decoder();
    sources['speaking-end'].playbackRate = .8;
    player = new MeetingVideoPlayer([first, second, ending] as unknown as [HTMLVideoElement, HTMLVideoElement, HTMLVideoElement], sources, vi.fn());
    start(true);
    expect(second.dataset.clip).toBe('speaking-loop');
    expect(ending.dataset.clip).toBe('speaking-end');
    ending.loaded(); ending.dispatchEvent(new Event('seeked')); step();
    expect(ending.currentTime).toBe(4.875);
    expect(ending.paused).toBe(true);
    const loads = ending.load.mock.calls.length;
    first.currentTime = 1;
    player.stopSpeech();
    expect(ending.load).toHaveBeenCalledTimes(loads);
    expect(ending.paused).toBe(false);
    expect(ending.playbackRate).toBe(.8);
    expect(first.paused).toBe(false);
    ending.present(); step();
    expect(first.paused).toBe(true);
    expect(ending.dataset.active).toBe('true');
    expect(first.dataset.clip).toBe('idle-4');
    first.loaded();
    ending.currentTime = 121 / 24; step(); first.present(); step();
    expect(first.dataset.active).toBe('true');
    expect(first.playbackRate).toBe(1);
    expect(ending.load).toHaveBeenCalledTimes(loads + 1);
    player.dispose();
    expect(ending.src).toBe('');
    expect(ending.frames.size).toBe(0);
  });

  it('never flashes a prepared closing frame after a new reply supersedes it', () => {
    player.dispose();
    const ending = new Decoder();
    player = new MeetingVideoPlayer([first, second, ending] as unknown as [HTMLVideoElement, HTMLVideoElement, HTMLVideoElement], sources, vi.fn());
    start(true);
    ending.loaded(); ending.dispatchEvent(new Event('seeked')); step();
    player.stopSpeech();
    const late = [...ending.frames.values()][0]!;
    ending.currentTime = 5;
    player.update(true, 'center', true);
    late(0, { mediaTime: 5 } as VideoFrameCallbackMetadata);
    expect(ending.dataset.active).toBe('false');
    expect(ending.paused).toBe(true);
    ending.loaded(); ending.dispatchEvent(new Event('seeked')); step();
    player.stopSpeech();
    expect(ending.currentTime).toBe(4.875);
  });

  it('restarts an uncommitted opening when a new answer arrives with a warm ending', async () => {
    player.dispose();
    const ending = new Decoder();
    sources['speaking-start'].speechCue = .25;
    player = new MeetingVideoPlayer([first, second, ending] as unknown as [HTMLVideoElement, HTMLVideoElement, HTMLVideoElement], sources, vi.fn());
    start();
    ending.loaded(); ending.dispatchEvent(new Event('seeked'));
    const old = player.startSpeech();
    second.loaded(); step();
    const late = [...second.frames.values()][0]!;
    second.currentTime = .4;
    const fresh = player.startSpeech();
    expect(await old).toBe(false);
    expect(second.currentTime).toBe(0);
    late(0, { mediaTime: .4 } as VideoFrameCallbackMetadata);
    expect(first.dataset.active).toBe('true');
    const ready = vi.fn(); fresh.then(ready);
    second.loaded(); step(); second.present(0); await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    second.currentTime = .25; second.present();
    expect(await fresh).toBe(true);
  });

  it('does not reopen an already closed mouth merely to play the generic ending', () => {
    sources['speaking-start'].closedMouthRanges = [[94 / 24, 96 / 24]];
    start(true);
    first.currentTime = 94 / 24; first.present();
    player.stopSpeech();
    expect(first.paused).toBe(true); // Keep this neutral picture until idle is decoded.
    expect(second.dataset.clip).toBe('idle-4');
    second.loaded(); step(); second.present();
    expect(second.dataset.active).toBe('true');
    expect(second.dataset.clip).toBe('idle-4');
  });

  it('bounds a warm ending that becomes ready but never presents a frame', async () => {
    player.dispose();
    const ending = new Decoder();
    player = new MeetingVideoPlayer([first, second, ending] as unknown as [HTMLVideoElement, HTMLVideoElement, HTMLVideoElement], sources, vi.fn());
    start(true);
    ending.loaded(); ending.dispatchEvent(new Event('seeked')); step();
    player.stopSpeech();
    const late = [...ending.frames.values()][0]!;
    await vi.advanceTimersByTimeAsync(500);
    expect(first.paused).toBe(true);
    step(); second.loaded(); step(); second.present();
    expect(second.dataset.active).toBe('true');
    expect(second.dataset.clip).toMatch(/^idle-/);
    late(0, { mediaTime: 4.875 } as VideoFrameCallbackMetadata);
    expect(ending.dataset.active).toBe('false');
  });

  it('only releases speech audio after the first speaking frame is committed', async () => {
    start();
    const ready = vi.fn();
    const pending = player.startSpeech().then(ready);
    second.loaded(); step(); await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    second.present(); await pending;
    expect(ready).toHaveBeenCalledWith(true);
    expect(second.dataset.active).toBe('true');
  });

  it('lets an idle blink finish while preparing the opening, then releases voice at its cue', async () => {
    sources['idle-1'].avoidSpeechCutRanges = [[1, 1.125]];
    sources['speaking-start'].speechCue = .25;
    start();
    first.currentTime = 1; first.present();
    const pending = player.startSpeech();
    second.loaded(); step();
    expect(second.dataset.clip).toBe('speaking-start');
    expect(second.paused).toBe(true);
    expect(first.paused).toBe(false);
    first.currentTime = 1.125; first.present(); step(); second.present(0);
    expect(second.dataset.active).toBe('true');
    second.currentTime = .25; second.present();
    expect(await pending).toBe(true);
  });

  it('bounds waiting for an idle blink instead of delaying voice indefinitely', async () => {
    sources['idle-1'].avoidSpeechCutRanges = [[1, 1.125]];
    start(); first.currentTime = 1; first.present();
    const pending = player.startSpeech();
    second.loaded(); step();
    expect(second.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(200); step(); second.present();
    expect(await pending).toBe(true);
  });

  it('checks the visible idle again after the opening has loaded', async () => {
    sources['idle-1'].avoidSpeechCutRanges = [[1, 1.125]];
    start(); first.currentTime = .9; first.present();
    const pending = player.startSpeech();
    first.currentTime = 1; first.present(); second.loaded(); step();
    expect(second.paused).toBe(true);
    first.currentTime = 1.125; first.present(); step(); second.present();
    expect(await pending).toBe(true);
  });

  it('does not add a fruitless wait for a blink with more than 200ms remaining', async () => {
    sources['idle-1'].avoidSpeechCutRanges = [[1, 4]];
    start(); first.currentTime = 1; first.present();
    const pending = player.startSpeech();
    second.loaded(); step(); second.present();
    expect(await pending).toBe(true);
  });

  it('shows the opening preroll but waits for a decoded frame at the speech cue', async () => {
    Object.assign(sources['speaking-start'], { speechCue: .25 });
    start();
    const ready = vi.fn();
    const pending = player.startSpeech().then(ready);
    second.loaded(); step(); second.present(); await Promise.resolve();
    expect(second.currentTime).toBe(0);
    expect(second.dataset.active).toBe('true');
    expect(second.paused).toBe(false);
    expect(ready).not.toHaveBeenCalled();

    second.currentTime = .25; step(); await Promise.resolve();
    expect(ready).not.toHaveBeenCalled(); // A playback clock tick is not a decoded picture.
    second.present(.208333); await Promise.resolve(); // Decoded time can lag currentTime.
    expect(ready).not.toHaveBeenCalled();
    second.present(.25); await pending;
    expect(ready).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledWith(true);
  });

  it('waits until the decoded cue frame can be drawn onto the foreground canvas', async () => {
    player.dispose();
    Object.assign(sources['speaking-start'], { speechCue: .25 });
    const context = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), translate: vi.fn(), scale: vi.fn(), drawImage: vi.fn(), filter: 'none' };
    const canvas = { width: 480, height: 300, clientWidth: 480, clientHeight: 300, getContext: vi.fn(() => context) };
    player = new MeetingVideoPlayer([first, second] as unknown as [HTMLVideoElement, HTMLVideoElement], sources, vi.fn(), undefined, canvas as unknown as HTMLCanvasElement);
    start();
    const ready = vi.fn();
    const pending = player.startSpeech().then(ready);
    second.loaded(); step(); second.present(); await Promise.resolve();
    expect(context.drawImage.mock.calls.at(-1)?.[0]).toBe(second);
    expect(ready).not.toHaveBeenCalled();

    canvas.clientWidth = 0;
    const draws = context.drawImage.mock.calls.length;
    second.currentTime = .25; second.present(); step(); await Promise.resolve();
    expect(context.drawImage).toHaveBeenCalledTimes(draws);
    expect(ready).not.toHaveBeenCalled();
    canvas.clientWidth = 480; step(); await pending;
    expect(context.drawImage.mock.calls.at(-1)?.[0]).toBe(second);
    expect(ready).toHaveBeenCalledWith(true);
  });

  it.each(['stop', 'deactivate', 'dispose', 'timeout'] as const)('cancels a visible preroll on %s and rejects a late cue frame', async action => {
    Object.assign(sources['speaking-start'], { speechCue: .25 });
    start();
    const pending = player.startSpeech();
    second.loaded(); step(); second.present();
    const lateFrame = [...second.frames.values()][0]!;
    if (action === 'stop') player.stopSpeech();
    else if (action === 'deactivate') player.update(false, 'center', false);
    else if (action === 'dispose') player.dispose();
    else await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toBe(false);
    lateFrame(0, { mediaTime: .25 } as VideoFrameCallbackMetadata);
    expect(second.paused).toBe(true);
    expect(second.frames.size).toBe(0);
  });

  it('cancels the previous preroll and requires a new answer to present its own cue', async () => {
    Object.assign(sources['speaking-start'], { speechCue: .25 });
    start();
    const previous = player.startSpeech();
    second.loaded(); step(); second.present();
    const lateFrame = [...second.frames.values()][0]!;
    const ready = vi.fn();
    const pending = player.startSpeech().then(ready);
    expect(await previous).toBe(false);
    lateFrame(0, { mediaTime: .25 } as VideoFrameCallbackMetadata);
    step(); await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    expect(second.paused).toBe(true);
    expect(second.frames.size).toBe(0);
    first.loaded(); step(); first.present(); await Promise.resolve();
    expect(first.currentTime).toBe(0);
    expect(ready).not.toHaveBeenCalled();
    first.currentTime = .25; first.present(); await pending;
    expect(ready).toHaveBeenCalledWith(true);
  });

  it('cancels pending speech readiness on interruption and ignores late frames', async () => {
    start();
    const pending = player.startSpeech();
    second.loaded(); step();
    player.stopSpeech();
    expect(await pending).toBe(false);
    second.present();
    expect(first.dataset.active).toBe('true');
  });

  it('bounds decoder waiting and cancels it on disposal', async () => {
    start();
    const pending = player.startSpeech();
    await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toBe(false);
    const next = player.startSpeech();
    player.dispose();
    expect(await next).toBe(false);
  });
});
