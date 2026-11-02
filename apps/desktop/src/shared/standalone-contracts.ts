export type StandaloneStatus = {
  application: 'Meeting Agent';
  runtime: { ready: boolean; modelReady: boolean; phase?: string; error?: string };
  asr: { ready: boolean; error?: string };
  storage: '项目目录下 .local-data';
  externalIntegrations: '云文档与外部协作平台按需选配，当前仅本地保存';
};

export type StandaloneApi = {
  status(): Promise<StandaloneStatus>;
  openDataDirectory(): Promise<void>;
  exportMarkdown(meetingId: string): Promise<{ exported: boolean }>;
  onPrepareClose(listener: (nonce: string) => Promise<void> | void): () => void;
};

declare global {
  interface Window { meetingHost: StandaloneApi; }
}
