/** Own every local PCM node, including buffers scheduled in the future. */
export class MeetingAudioSources {
  private readonly sources = new Set<AudioBufferSourceNode>();
  get size(): number { return this.sources.size; }
  add(source: AudioBufferSourceNode, onEnded: () => void): void {
    this.sources.add(source);
    source.onended = () => {
      if (!this.sources.delete(source)) return;
      source.disconnect();
      onEnded();
    };
  }
  stop(): void {
    const sources = [...this.sources];
    this.sources.clear();
    for (const source of sources) {
      source.onended = null;
      try { source.stop(); } catch { /* already ended */ }
      source.disconnect();
    }
  }
}
