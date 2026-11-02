export type StandaloneStatus = {
  application: 'Meeting Agent';
  runtime: { ready: boolean; modelReady: boolean; phase?: string; error?: string };
  asr: { ready: boolean; error?: string };
  storage: '项目目录下 .local-data';
  externalIntegrations: '会议记录本地保存；外部工具按本机配置与本次确认执行';
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
