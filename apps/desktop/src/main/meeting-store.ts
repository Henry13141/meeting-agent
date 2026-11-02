import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  MeetingAppendTranscriptRequest,
  MeetingAppendAudioRequest,
  MeetingAppendArchiveAudioRequest,
  MeetingCompleteRequest,
  MeetingCreateRequest,
  MeetingRecord,
  MeetingSearchRequest,
  MeetingTranscriptChunk,
  MeetingAudioChunk,
} from '../shared/contracts';
import type { RuntimeIdentity } from './runtime-identity';
import { meetingSearchTerms } from '../meeting-assistant/meeting-retrieval';
import { mergeMeetingAudio } from './meeting-audio-merge';
import type { MeetingExportCheckpoint, MeetingBackendExportJournal } from './meeting-archive-export';

type MeetingRow = {
  id: string;
  title: string;
  status: 'recording' | 'completed';
  started_at: string;
  ended_at: string | null;
  summary_status: 'pending' | 'completed';
  summary: string;
  action_items_json: string;
  archive_document_url: string | null;
  knowledge_article_id: string | null;
  knowledge_status: 'reviewing' | 'approved' | 'rejected' | null;
  knowledge_project_name: string | null;
  knowledge_scope_project_id: string | null;
  knowledge_scope_project_name: string | null;
  archive_directory_name: string | null;
};
type TranscriptRow = { sequence: number; speaker: string; text: string; captured_at: string };
type AudioRow = { sequence: number; mime_type: MeetingAudioChunk['mimeType']; byte_length: number; captured_at: string };

export class MeetingStore {
  private database: DatabaseSync | null = null;
  private opening: Promise<DatabaseSync> | null = null;

  constructor(
    private readonly dataRoot: string,
    private readonly identity: RuntimeIdentity,
    private readonly recordingArchiveRoot = path.join(dataRoot, 'recordings'),
  ) {}

  async create(
    request: MeetingCreateRequest,
    knowledgeScope?: Readonly<{ id: string; name: string }>,
  ): Promise<MeetingRecord> {
    const db = await this.open();
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const title = request.title ?? `会议 ${startedAt.slice(0, 16).replace('T', ' ')}`;
    db.prepare(`
      INSERT INTO meetings (
        id, title, status, started_at, ended_at, summary_status, summary,
        action_items_json, archive_document_url, knowledge_scope_project_id,
        knowledge_scope_project_name
      )
      VALUES (?, ?, 'recording', ?, NULL, 'pending', '', '[]', NULL, ?, ?)
    `).run(id, title, startedAt, knowledgeScope?.id ?? null, knowledgeScope?.name ?? null);
    const created = this.meetingRow(db, id)!;
    await this.ensureMeetingArchive(db, created);
    return this.getRequired(db, id);
  }

  async appendTranscript(request: MeetingAppendTranscriptRequest): Promise<MeetingRecord> {
    const db = await this.open();
    const meeting = this.meetingRow(db, request.meetingId);
    if (!meeting || meeting.status !== 'recording') throw new Error('MEETING_NOT_RECORDING');
    const next = db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM meeting_transcript WHERE meeting_id = ?',
    ).get(request.meetingId) as { sequence: number };
    db.prepare(`
      INSERT INTO meeting_transcript (meeting_id, sequence, speaker, text, captured_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(request.meetingId, next.sequence, request.speaker, request.text, request.capturedAt);
    return this.getRequired(db, request.meetingId);
  }

  async appendAsrTranscript(request: MeetingAppendTranscriptRequest): Promise<MeetingRecord> {
    const db = await this.open();
    const capturedAt = Date.parse(request.capturedAt);
    if (!Number.isFinite(capturedAt)) throw new Error('MEETING_TRANSCRIPT_TIME_INVALID');
    const nearby = db.prepare(`
      SELECT sequence FROM meeting_transcript
      WHERE meeting_id = ? AND speaker = ? AND text = ? AND captured_at BETWEEN ? AND ?
      LIMIT 1
    `).get(
      request.meetingId, request.speaker, request.text,
      new Date(capturedAt - 750).toISOString(), new Date(capturedAt + 750).toISOString(),
    );
    if (nearby) return this.getRequired(db, request.meetingId);
    return this.appendTranscript(request);
  }

  async appendAudio(request: MeetingAppendAudioRequest): Promise<MeetingRecord> {
    const db = await this.open();
    const meeting = this.meetingRow(db, request.meetingId);
    if (!meeting || meeting.status !== 'recording') throw new Error('MEETING_NOT_RECORDING');
    const next = db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM meeting_audio WHERE meeting_id = ?',
    ).get(request.meetingId) as { sequence: number };
    const directory = path.join(await this.ensureMeetingArchive(db, meeting), '分片');
    await mkdir(directory, { recursive: true });
    const filename = `${String(next.sequence).padStart(6, '0')}.webm`;
    await writeFile(path.join(directory, filename), request.data, { flag: 'wx' });
    db.prepare(`
      INSERT INTO meeting_audio (meeting_id, sequence, mime_type, relative_path, byte_length, captured_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(request.meetingId, next.sequence, request.mimeType, `分片/${filename}`, request.data.byteLength, request.capturedAt);
    return this.getRequired(db, request.meetingId);
  }

  async appendArchiveAudio(request: MeetingAppendArchiveAudioRequest): Promise<void> {
    const db = await this.open();
    const meeting = this.meetingRow(db, request.meetingId);
    if (!meeting || meeting.status !== 'recording') throw new Error('MEETING_NOT_RECORDING');
    const directory = path.join(await this.ensureMeetingArchive(db, meeting), '完整录音片段');
    const partialPath = path.join(directory, `${request.sessionId}.webm.partial`);
    const completedPath = path.join(directory, `${request.sessionId}.webm`);
    const existing = db.prepare(`
      SELECT last_sequence, finalized FROM meeting_audio_archive_sessions
      WHERE meeting_id = ? AND session_id = ?
    `).get(request.meetingId, request.sessionId) as { last_sequence: number; finalized: number } | undefined;
    if (existing?.finalized) throw new Error('MEETING_ARCHIVE_SESSION_FINALIZED');
    if (request.sequence !== (existing?.last_sequence ?? 0) + 1) {
      throw new Error('MEETING_ARCHIVE_SEQUENCE_INVALID');
    }
    if (!existing) {
      await writeFile(partialPath, request.data, { flag: 'wx' });
      db.prepare(`
        INSERT INTO meeting_audio_archive_sessions
          (meeting_id, session_id, last_sequence, byte_length, finalized, created_at)
        VALUES (?, ?, ?, ?, 0, ?)
      `).run(request.meetingId, request.sessionId, request.sequence, request.data.byteLength, new Date().toISOString());
    } else {
      await appendFile(partialPath, request.data);
      const size = (await stat(partialPath)).size;
      db.prepare(`
        UPDATE meeting_audio_archive_sessions SET last_sequence = ?, byte_length = ?
        WHERE meeting_id = ? AND session_id = ?
      `).run(request.sequence, size, request.meetingId, request.sessionId);
    }
    if (request.final) {
      await rename(partialPath, completedPath);
      db.prepare(`
        UPDATE meeting_audio_archive_sessions SET finalized = 1
        WHERE meeting_id = ? AND session_id = ?
      `).run(request.meetingId, request.sessionId);
    }
  }

  async complete(request: MeetingCompleteRequest): Promise<MeetingRecord> {
    const db = await this.open();
    const meeting = this.meetingRow(db, request.meetingId);
    if (!meeting) throw new Error('MEETING_NOT_FOUND');
    await this.organizeCompletedArchive(db, meeting, request.title);
    db.prepare(`
      UPDATE meetings
      SET status = 'completed', ended_at = ?, summary_status = 'completed', title = ?, summary = ?, action_items_json = ?
      WHERE id = ?
    `).run(meeting.ended_at ?? new Date().toISOString(), request.title, request.summary, JSON.stringify(request.actionItems), request.meetingId);
    return this.getRequired(db, request.meetingId);
  }

  async finalizeRecordingMeetings(endedAt?: string): Promise<MeetingRecord[]> {
    const db = await this.open();
    const recordings = db.prepare(
      "SELECT * FROM meetings WHERE status = 'recording' ORDER BY started_at ASC",
    ).all() as MeetingRow[];
    const completed: MeetingRecord[] = [];
    for (const meeting of recordings) {
      const lastActivity = db.prepare(`
        SELECT MAX(captured_at) AS captured_at FROM (
          SELECT captured_at FROM meeting_transcript WHERE meeting_id = ?
          UNION ALL
          SELECT captured_at FROM meeting_audio WHERE meeting_id = ?
        )
      `).get(meeting.id, meeting.id) as { captured_at: string | null };
      const completedAt = endedAt ?? lastActivity.captured_at ?? meeting.started_at;
      const transcriptCount = db.prepare(
        'SELECT COUNT(*) AS count FROM meeting_transcript WHERE meeting_id = ?',
      ).get(meeting.id) as { count: number };
      const summary = meeting.summary || (transcriptCount.count
        ? '应用关闭时自动结束；完整内容请查看逐字稿。'
        : '应用关闭时自动结束；本次会议没有可用逐字稿。');
      db.prepare(`
        UPDATE meetings
        SET status = 'completed', ended_at = ?, summary_status = 'pending', summary = ?
        WHERE id = ? AND status = 'recording'
      `).run(completedAt, summary, meeting.id);
      await this.organizeCompletedArchive(
        db,
        { ...meeting, status: 'completed', ended_at: completedAt, summary },
        meeting.title,
      ).catch((error: unknown) => {
        console.warn(
          '[meeting] automatic archive organization failed',
          error instanceof Error ? error.message : 'MEETING_ARCHIVE_ORGANIZATION_FAILED',
        );
      });
      completed.push(this.getRequired(db, meeting.id));
    }
    return completed;
  }

  async list(limit = 20): Promise<MeetingRecord[]> {
    const db = await this.open();
    const rows = db.prepare('SELECT * FROM meetings ORDER BY started_at DESC LIMIT ?').all(limit) as MeetingRow[];
    return rows.map((row) => this.project(db, row));
  }

  async search(request: MeetingSearchRequest): Promise<MeetingRecord[]> {
    const db = await this.open();
    const terms = meetingSearchTerms(request.query);
    if (!terms.length) return [];
    const patterns = terms.map((term) => `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    const score = patterns.map(() => `(CASE WHEN m.title LIKE ? ESCAPE '\\' OR m.summary LIKE ? ESCAPE '\\' OR EXISTS
      (SELECT 1 FROM meeting_transcript t WHERE t.meeting_id = m.id AND t.text LIKE ? ESCAPE '\\') THEN 1 ELSE 0 END)`).join(' + ');
    const rows = db.prepare(`
      SELECT m.*, (${score}) AS relevance
      FROM meetings m
      WHERE m.id != ? AND relevance > 0
      ORDER BY relevance DESC, m.started_at DESC
      LIMIT ?
    `).all(...patterns.flatMap((pattern) => [pattern, pattern, pattern]), request.excludeMeetingId ?? '', request.limit) as MeetingRow[];
    return rows.map((row) => {
      const record = this.project(db, row);
      const matches = db.prepare(`SELECT sequence, speaker, text, captured_at FROM meeting_transcript
        WHERE meeting_id = ? AND (${patterns.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ')})
        ORDER BY sequence ASC LIMIT 100`).all(row.id, ...patterns) as TranscriptRow[];
      return { ...record, transcript: matches.length ? matches.map(this.transcriptChunk) : record.transcript };
    });
  }

  private transcriptChunk(row: TranscriptRow): MeetingTranscriptChunk {
    return { sequence: row.sequence, speaker: row.speaker, text: row.text, capturedAt: row.captured_at };
  }

  async readTranscript(id: string, afterSequence: number): Promise<MeetingRecord> {
    const db = await this.open();
    const record = this.getRequired(db, id);
    const rows = db.prepare(`SELECT sequence, speaker, text, captured_at FROM meeting_transcript
      WHERE meeting_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT 1000`).all(id, afterSequence) as TranscriptRow[];
    return { ...record, audio: [], transcript: rows.map(this.transcriptChunk) };
  }

  async fullTranscript(id: string): Promise<MeetingTranscriptChunk[]> {
    const result: MeetingTranscriptChunk[] = [];
    let after = 0;
    for (;;) {
      const page = await this.readTranscript(id, after);
      if (!page.transcript.length) return result;
      result.push(...page.transcript);
      after = page.transcript.at(-1)!.sequence;
    }
  }

  async get(id: string): Promise<MeetingRecord> {
    return this.getRequired(await this.open(), id);
  }

  async getDayPosition(id: string): Promise<{ sequence: number; total: number }> {
    const db = await this.open();
    const meeting = this.meetingRow(db, id);
    if (!meeting) throw new Error('MEETING_NOT_FOUND');
    const target = new Date(meeting.started_at);
    const sameDay = (db.prepare('SELECT id, started_at FROM meetings ORDER BY started_at ASC').all() as Array<{ id: string; started_at: string }>)
      .filter((candidate) => {
        const date = new Date(candidate.started_at);
        return date.getFullYear() === target.getFullYear()
          && date.getMonth() === target.getMonth()
          && date.getDate() === target.getDate();
      });
    return { sequence: sameDay.findIndex((candidate) => candidate.id === id) + 1, total: sameDay.length };
  }

  async getAudioDirectory(id: string): Promise<string> {
    const db = await this.open();
    const meeting = this.meetingRow(db, id);
    if (!meeting) throw new Error('MEETING_NOT_FOUND');
    const audio = db.prepare(
      'SELECT COUNT(*) AS count FROM meeting_audio WHERE meeting_id = ?',
    ).get(id) as { count: number };
    if (audio.count < 1) throw new Error('MEETING_AUDIO_NOT_FOUND');
    return await this.ensureMeetingArchive(db, meeting);
  }

  async getPlayableAudioPath(id: string): Promise<string> {
    const db = await this.open();
    const meeting = this.meetingRow(db, id);
    if (!meeting) throw new Error('MEETING_NOT_FOUND');
    const directory = await this.ensureMeetingArchive(db, meeting);
    await this.writePlayer(db, meeting, directory);
    return path.join(directory, '播放完整录音.html');
  }

  async attachArchiveDocument(id: string, documentUrl: string): Promise<MeetingRecord> {
    const db = await this.open();
    if (!this.meetingRow(db, id)) throw new Error('MEETING_NOT_FOUND');
    db.prepare('UPDATE meetings SET archive_document_url = ? WHERE id = ?').run(documentUrl, id);
    return this.getRequired(db, id);
  }

  exportJournal(id: string): MeetingBackendExportJournal {
    return {
      read: async () => {
        const db = await this.open();
        if (!this.meetingRow(db, id)) throw new Error('MEETING_NOT_FOUND');
        const row = db.prepare('SELECT checkpoint_json FROM meeting_archive_exports WHERE meeting_id = ?').get(id) as { checkpoint_json: string } | undefined;
        return row ? JSON.parse(row.checkpoint_json) as MeetingExportCheckpoint : null;
      },
      save: async (checkpoint) => {
        const db = await this.open();
        db.prepare('INSERT OR REPLACE INTO meeting_archive_exports (meeting_id, checkpoint_json) VALUES (?, ?)').run(id, JSON.stringify(checkpoint));
      },
      clear: async () => {
        const db = await this.open();
        db.prepare('DELETE FROM meeting_archive_exports WHERE meeting_id = ?').run(id);
      },
    };
  }

  async attachKnowledgeArticle(
    id: string,
    articleId: string,
    status: 'reviewing' | 'approved' | 'rejected',
    projectName: string | null,
  ): Promise<MeetingRecord> {
    const db = await this.open();
    if (!this.meetingRow(db, id)) throw new Error('MEETING_NOT_FOUND');
    db.prepare(`
      UPDATE meetings
      SET knowledge_article_id = ?, knowledge_status = ?, knowledge_project_name = ?
      WHERE id = ?
    `).run(articleId, status, projectName, id);
    return this.getRequired(db, id);
  }

  async updateKnowledgeStatus(
    id: string,
    status: 'reviewing' | 'approved' | 'rejected',
  ): Promise<MeetingRecord> {
    const db = await this.open();
    if (!this.meetingRow(db, id)) throw new Error('MEETING_NOT_FOUND');
    db.prepare('UPDATE meetings SET knowledge_status = ? WHERE id = ?').run(status, id);
    return this.getRequired(db, id);
  }

  close(): void {
    this.database?.close();
    this.database = null;
    this.opening = null;
  }

  private async open(): Promise<DatabaseSync> {
    if (this.database) return this.database;
    if (this.opening) return await this.opening;
    this.opening = (async () => {
      if (!/^(local-profile-v1|user-[0-9a-f]{64})$/.test(this.identity.namespace)) {
        throw new Error('MEETING_IDENTITY_INVALID');
      }
      const directory = this.meetingDirectory();
      await mkdir(directory, { recursive: true });
      const db = new DatabaseSync(path.join(directory, 'meetings.sqlite3'));
      try {
        db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        db.exec(`
          CREATE TABLE IF NOT EXISTS meetings (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('recording', 'completed')),
            started_at TEXT NOT NULL,
            ended_at TEXT,
            summary_status TEXT NOT NULL DEFAULT 'completed' CHECK(summary_status IN ('pending', 'completed')),
            summary TEXT NOT NULL DEFAULT '',
            action_items_json TEXT NOT NULL DEFAULT '[]',
            archive_document_url TEXT,
            knowledge_article_id TEXT,
            knowledge_status TEXT,
            knowledge_project_name TEXT,
            knowledge_scope_project_id TEXT,
            knowledge_scope_project_name TEXT,
            archive_directory_name TEXT
          );
          CREATE TABLE IF NOT EXISTS meeting_transcript (
            meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            speaker TEXT NOT NULL,
            text TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            PRIMARY KEY (meeting_id, sequence)
          );
          CREATE TABLE IF NOT EXISTS meeting_audio (
            meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            mime_type TEXT NOT NULL CHECK(mime_type IN ('audio/webm', 'audio/webm;codecs=opus')),
            relative_path TEXT NOT NULL,
            byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 10000000),
            captured_at TEXT NOT NULL,
            PRIMARY KEY (meeting_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS meeting_transcript_meeting_idx
            ON meeting_transcript(meeting_id, sequence);
          CREATE TABLE IF NOT EXISTS meeting_audio_archive_sessions (
            meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL,
            last_sequence INTEGER NOT NULL,
            byte_length INTEGER NOT NULL,
            finalized INTEGER NOT NULL CHECK(finalized IN (0, 1)),
            created_at TEXT NOT NULL,
            PRIMARY KEY (meeting_id, session_id)
          );
          CREATE TABLE IF NOT EXISTS meeting_archive_exports (
            meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
            checkpoint_json TEXT NOT NULL
          );
        `);
        this.ensureColumn(db, 'knowledge_article_id', 'TEXT');
        this.ensureColumn(db, 'summary_status', "TEXT NOT NULL DEFAULT 'completed'");
        this.ensureColumn(db, 'knowledge_status', 'TEXT');
        this.ensureColumn(db, 'knowledge_project_name', 'TEXT');
        this.ensureColumn(db, 'knowledge_scope_project_id', 'TEXT');
        this.ensureColumn(db, 'knowledge_scope_project_name', 'TEXT');
        this.ensureColumn(db, 'archive_directory_name', 'TEXT');
        this.database = db;
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    })();
    try { return await this.opening; } finally { this.opening = null; }
  }

  private meetingRow(db: DatabaseSync, id: string): MeetingRow | undefined {
    return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as MeetingRow | undefined;
  }

  private meetingDirectory(): string {
    return path.join(this.dataRoot, 'users', this.identity.namespace, 'meeting-assistant');
  }

  private archiveDirectoryName(row: MeetingRow, title = row.title): string {
    const started = new Date(row.started_at);
    const part = (value: number) => String(value).padStart(2, '0');
    const timestamp = `${started.getFullYear()}-${part(started.getMonth() + 1)}-${part(started.getDate())}_${part(started.getHours())}-${part(started.getMinutes())}-${part(started.getSeconds())}`;
    const safeTitle = title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 48) || '未命名会议';
    return `${timestamp}_${safeTitle}_${row.id.slice(0, 8)}`;
  }

  private async ensureMeetingArchive(db: DatabaseSync, row: MeetingRow): Promise<string> {
    await mkdir(this.recordingArchiveRoot, { recursive: true });
    const name = row.archive_directory_name ?? this.archiveDirectoryName(row);
    const directory = path.join(this.recordingArchiveRoot, name);
    await mkdir(path.join(directory, '分片'), { recursive: true });
    await mkdir(path.join(directory, '完整录音片段'), { recursive: true });
    if (!row.archive_directory_name) {
      db.prepare('UPDATE meetings SET archive_directory_name = ? WHERE id = ?').run(name, row.id);
      row.archive_directory_name = name;
    }
    const legacyDirectory = path.join(this.meetingDirectory(), 'audio', row.id);
    const legacyFiles = await readdir(legacyDirectory).catch(() => []);
    for (const file of legacyFiles.filter((item) => /^\d{6}\.webm$/.test(item))) {
      const destination = path.join(directory, '分片', file);
      try {
        await copyFile(path.join(legacyDirectory, file), destination, fsConstants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return directory;
  }

  private async organizeCompletedArchive(db: DatabaseSync, row: MeetingRow, title: string): Promise<void> {
    // The archive directory is a stable storage identity. Renaming it when the
    // generated title arrives makes completion fail on Windows whenever the
    // user has the directory open in Explorer. Keep the original directory and
    // update the human-readable title in the database and player instead.
    const directory = await this.ensureMeetingArchive(db, row);
    await this.writePlayer(db, { ...row, title }, directory, true);
  }

  private async writePlayer(
    db: DatabaseSync,
    row: MeetingRow,
    directory: string,
    completed = row.status === 'completed',
  ): Promise<void> {
    const sessions = db.prepare(`
      SELECT session_id FROM meeting_audio_archive_sessions
      WHERE meeting_id = ? AND finalized = 1 ORDER BY created_at ASC
    `).all(row.id) as Array<{ session_id: string }>;
    let files = sessions.map((item) => `完整录音片段/${item.session_id}.webm`);
    const integrated = path.join(directory, '完整录音.webm');
    if (completed && files.length === 1) {
      await copyFile(path.join(directory, files[0]!), integrated, fsConstants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      files = ['完整录音.webm'];
    } else if (completed && files.length > 1) {
      if (await mergeMeetingAudio(directory, sessions.map((session) => session.session_id))) files = ['完整录音.webm'];
    }
    if (!files.length) {
      files = (await readdir(path.join(directory, '分片')).catch(() => []))
        .filter((item) => /^\d{6}\.webm$/.test(item))
        .sort()
        .map((item) => `分片/${item}`);
    }
    if (!files.length) return;
    const serialized = JSON.stringify(files).replaceAll('<', '\\u003c');
    const title = JSON.stringify(row.title).replaceAll('<', '\\u003c');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><title>播放完整录音</title><style>body{max-width:760px;margin:48px auto;padding:0 24px;font-family:system-ui;color:#202124}audio{width:100%}li{padding:6px;color:#666}.active{color:#6d3bd1;font-weight:700}</style></head><body><h1 id="title"></h1><p>录音会按顺序连续播放；WebM 由 Chrome、Edge、Firefox 或 VLC 支持。</p><audio id="player" controls preload="metadata"></audio><ol id="list"></ol><script>const files=${serialized};const player=document.getElementById('player');const list=document.getElementById('list');document.getElementById('title').textContent=${title};let index=0;for(const [i,file]of files.entries()){const li=document.createElement('li');li.textContent=(i+1)+' / '+files.length+' · '+file;list.append(li)}function load(){player.src=encodeURI(files[index]);[...list.children].forEach((item,i)=>item.className=i===index?'active':'')}player.addEventListener('ended',()=>{if(index+1<files.length){index++;load();player.play()}});load();</script></body></html>`;
    await writeFile(path.join(directory, '播放完整录音.html'), html, 'utf8');
  }

  private ensureColumn(db: DatabaseSync, name: string, declaration: string): void {
    const columns = db.prepare('PRAGMA table_info(meetings)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE meetings ADD COLUMN ${name} ${declaration}`);
    }
  }

  private getRequired(db: DatabaseSync, id: string): MeetingRecord {
    const row = this.meetingRow(db, id);
    if (!row) throw new Error('MEETING_NOT_FOUND');
    return this.project(db, row);
  }

  private project(db: DatabaseSync, row: MeetingRow): MeetingRecord {
    const chunks = db.prepare(`
      SELECT sequence, speaker, text, captured_at
      FROM meeting_transcript WHERE meeting_id = ? ORDER BY sequence DESC LIMIT 2000
    `).all(row.id).reverse() as TranscriptRow[];
    const audio = db.prepare(`
      SELECT sequence, mime_type, byte_length, captured_at
      FROM meeting_audio WHERE meeting_id = ? ORDER BY sequence DESC LIMIT 2000
    `).all(row.id).reverse() as AudioRow[];
    let actionItems: string[] = [];
    try {
      const parsed = JSON.parse(row.action_items_json) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) actionItems = parsed;
    } catch { actionItems = []; }
    return {
      schemaVersion: 1,
      id: row.id,
      title: row.title,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      summaryStatus: row.summary_status,
      summary: row.summary,
      actionItems,
      archiveDocumentUrl: row.archive_document_url,
      knowledgeArticleId: row.knowledge_article_id,
      knowledgeStatus: row.knowledge_status,
      knowledgeProjectName: row.knowledge_project_name,
      knowledgeScopeProjectId: row.knowledge_scope_project_id,
      knowledgeScopeProjectName: row.knowledge_scope_project_name,
      transcript: chunks.map((chunk): MeetingTranscriptChunk => ({
        sequence: chunk.sequence,
        speaker: chunk.speaker,
        text: chunk.text,
        capturedAt: chunk.captured_at,
      })),
      audio: audio.map((chunk): MeetingAudioChunk => ({
        sequence: chunk.sequence,
        mimeType: chunk.mime_type,
        byteLength: chunk.byte_length,
        capturedAt: chunk.captured_at,
      })),
    };
  }
}
