/** Local archive export checkpoints; contains no external service integration. */
export type MeetingExportCheckpoint = { fingerprint: string; documentId: string | null; offset: number; pending: boolean; documentUrl?: string };
export type MeetingExportJournal = {
  read(): Promise<MeetingExportCheckpoint | null>;
  save(checkpoint: MeetingExportCheckpoint): Promise<void>;
};
export type MeetingBackendExportJournal = MeetingExportJournal & { clear(): Promise<void> };
