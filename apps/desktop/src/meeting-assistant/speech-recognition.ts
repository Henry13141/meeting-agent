export interface SpeechRecognitionUpdate {
  readonly text: string;
  readonly final: boolean;
}

interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

interface BrowserSpeechRecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<BrowserSpeechRecognitionResult>;
}

interface BrowserSpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: { readonly error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognitionLike;

function constructorForCurrentWindow(): BrowserSpeechRecognitionConstructor | null {
  const speechWindow = window as unknown as Record<string, unknown>;
  const candidate = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
  return typeof candidate === 'function'
    ? candidate as BrowserSpeechRecognitionConstructor
    : null;
}

export class BrowserSpeechRecognitionSource {
  private recognition: BrowserSpeechRecognitionLike | null = null;
  private shouldRun = false;

  static available(): boolean {
    return constructorForCurrentWindow() !== null;
  }

  start(
    onUpdate: (update: SpeechRecognitionUpdate) => void,
    onError: (message: string) => void,
  ): void {
    if (this.shouldRun) return;
    const Constructor = constructorForCurrentWindow();
    if (!Constructor) throw new Error('当前 Electron 环境没有可用的语音识别服务');
    this.shouldRun = true;
    const recognition = new Constructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript?.trim();
        if (text) onUpdate({ text, final: result.isFinal });
      }
    };
    recognition.onerror = (event) => {
      if (event.error === 'aborted') return;
      if (event.error === 'network' || event.error === 'not-allowed') {
        this.shouldRun = false;
        try { recognition.stop(); } catch {}
      }
      onError(`语音识别失败：${event.error ?? 'UNKNOWN'}`);
    };
    recognition.onend = () => {
      if (!this.shouldRun) return;
      try {
        recognition.start();
      } catch {
        this.shouldRun = false;
        onError('语音识别意外停止，请重新开启聆听');
      }
    };
    this.recognition = recognition;
    recognition.start();
  }

  stop(): void {
    this.shouldRun = false;
    this.recognition?.stop();
    this.recognition = null;
  }
}
