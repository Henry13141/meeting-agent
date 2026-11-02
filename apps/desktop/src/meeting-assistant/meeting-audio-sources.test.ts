import { describe, expect, it, vi } from 'vitest';
import { MeetingAudioSources } from './meeting-audio-sources';

function source() {
  return { stop: vi.fn(), disconnect: vi.fn(), onended: null as (() => void) | null };
}

describe('meeting audio source ownership', () => {
  it('stops all queued PCM nodes and ignores their delayed ended events on interruption', () => {
    const sources = new MeetingAudioSources();
    const first = source(), queued = source(), onEnded = vi.fn();
    sources.add(first as unknown as AudioBufferSourceNode, onEnded);
    sources.add(queued as unknown as AudioBufferSourceNode, onEnded);
    const late = first.onended;
    sources.stop();
    late?.();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(queued.stop).toHaveBeenCalledOnce();
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(onEnded).not.toHaveBeenCalled();
    expect(sources.size).toBe(0);
  });

  it('releases ended nodes before notifying queue drain without stopping them twice', () => {
    const sources = new MeetingAudioSources();
    const node = source();
    const onEnded = vi.fn(() => expect(sources.size).toBe(0));
    sources.add(node as unknown as AudioBufferSourceNode, onEnded);
    node.onended?.();
    sources.stop();
    expect(onEnded).toHaveBeenCalledOnce();
    expect(node.stop).not.toHaveBeenCalled();
    expect(node.disconnect).toHaveBeenCalledOnce();
  });
});
