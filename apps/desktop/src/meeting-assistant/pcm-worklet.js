// Runs on the audio render thread. Send continuous 80ms mono PCM frames.
class MeetingPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(1280);
    this.offset = 0;
    this.port.onmessage = () => {
      if (this.offset) this.port.postMessage(this.frame.slice(0, this.offset).buffer);
      this.offset = 0;
      this.port.postMessage('flushed');
    };
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const value of input) {
      const sample = Math.max(-1, Math.min(1, value));
      this.frame[this.offset++] = sample < 0 ? sample * 32768 : sample * 32767;
      if (this.offset === this.frame.length) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(1280);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('meeting-pcm', MeetingPcmProcessor);
