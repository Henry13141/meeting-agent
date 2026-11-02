/** Local capture timing only; never used as identity/authorization evidence. */
export class UtteranceBoundary {
  private lastSpeech: number | null = null;
  private noiseFloor = 0.008;
  sample(level: number, at: number): boolean {
    if (this.lastSpeech === null) this.noiseFloor = this.noiseFloor * 0.98 + Math.min(level, 0.03) * 0.02;
    if (level >= Math.max(0.04, this.noiseFloor * 3)) this.lastSpeech = at;
    if (this.lastSpeech === null || at - this.lastSpeech < 900) return false;
    this.lastSpeech = null;
    return true;
  }
  speech(detected: boolean, at: number): boolean {
    if (detected) { this.lastSpeech = at; return false; }
    // Silero can briefly report silence inside a sentence. Keep enough
    // context for Qwen ASR instead of sending one- or two-word fragments.
    if (this.lastSpeech === null || at - this.lastSpeech < 900) return false;
    this.lastSpeech = null;
    return true;
  }
  reset(): void { this.lastSpeech = null; this.noiseFloor = 0.008; }
}
