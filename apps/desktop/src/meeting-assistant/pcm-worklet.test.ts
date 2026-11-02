import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('continuous PCM worklet', () => {
  it('keeps all samples across render blocks and flushes the last partial frame', () => {
    const messages: (ArrayBuffer | string)[] = [];
    let Processor: new () => { process(inputs: Float32Array[][]): boolean; port: { onmessage: () => void } };
    const source = readFileSync(new URL('./pcm-worklet.js', import.meta.url), 'utf8');
    vm.runInNewContext(source, {
      AudioWorkletProcessor: class {
        port = { postMessage: (value: ArrayBuffer | string) => messages.push(value), onmessage: () => {} };
      },
      registerProcessor: (_: string, implementation: typeof Processor) => { Processor = implementation; },
    });
    const processor = new Processor!();
    for (let index = 0; index < 13; index += 1) {
      processor.process([[new Float32Array(128).fill(0.5)]]);
    }
    processor.port.onmessage();
    const frames = messages.filter((message) => typeof message !== 'string') as ArrayBuffer[];
    expect(frames.map((frame) => frame.byteLength)).toEqual([2560, 768]);
    expect(frames.reduce((sum, frame) => sum + frame.byteLength / 2, 0)).toBe(13 * 128);
    expect(new Int16Array(frames[1])[0]).toBe(16383);
    expect(messages.at(-1)).toBe('flushed');
  });
});
