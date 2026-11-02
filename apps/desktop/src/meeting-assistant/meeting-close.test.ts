import { describe, expect, it, vi } from 'vitest';
import { drainMeetingBeforeClose } from './meeting-close';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('meeting close drain', () => {
  it('cancels both runs immediately but waits for in-flight startup before stopping', async () => {
    const startup = deferred();
    const stopRecording = vi.fn().mockResolvedValue(undefined);
    const cancelLive = vi.fn().mockResolvedValue(undefined);
    const cancelSummary = vi.fn().mockResolvedValue(undefined);
    const done = drainMeetingBeforeClose({ waitForStart: () => startup.promise, stopRecording, cancelRuns: [cancelLive, cancelSummary], programWrites: new Set() });
    await Promise.resolve();
    expect(cancelLive).toHaveBeenCalledOnce();
    expect(cancelSummary).toHaveBeenCalledOnce();
    expect(stopRecording).not.toHaveBeenCalled();
    startup.resolve();
    await done;
    expect(stopRecording).toHaveBeenCalledOnce();
  });
  it('does not finish before final audio/ASR and program writes have drained', async () => {
    const audio = deferred();
    const write = deferred();
    const writes = new Set<Promise<void>>();
    let finished = false;
    const done = drainMeetingBeforeClose({
      waitForStart: () => Promise.resolve(), cancelRuns: [], programWrites: writes,
      stopRecording: async () => {
        await audio.promise;
        const pending = write.promise.finally(() => { writes.delete(pending); });
        writes.add(pending);
      },
    }).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    audio.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    write.resolve();
    await done;
    expect(finished).toBe(true);
    expect(writes.size).toBe(0);
  });
  it('still saves audio when model cancellation fails, without requesting summaries', async () => {
    const stopRecording = vi.fn().mockResolvedValue(undefined);
    await drainMeetingBeforeClose({ waitForStart: () => Promise.resolve(), stopRecording, cancelRuns: [async () => { throw new Error('model unavailable'); }], programWrites: new Set() });
    expect(stopRecording).toHaveBeenCalledOnce();
  });
  it('does not report successful preparation when stopping capture fails', async () => {
    await expect(drainMeetingBeforeClose({ waitForStart: () => Promise.resolve(), stopRecording: async () => { throw new Error('recording stop failed'); }, cancelRuns: [], programWrites: new Set() })).rejects.toThrow('recording stop failed');
  });
});
