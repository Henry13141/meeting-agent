import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MeetingStore } from './meeting-store';
import { LOCAL_RUNTIME_IDENTITY, authenticatedRuntimeIdentity } from './runtime-identity';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-meeting-store-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe('MeetingStore', () => {
  it('releases a failed database open without deleting damaged data and can reopen after repair', async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, 'users', LOCAL_RUNTIME_IDENTITY.namespace, 'meeting-assistant');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'meetings.sqlite3');
    const damaged = Buffer.from('damaged meeting database');
    await writeFile(file, damaged);
    const store = new MeetingStore(root, LOCAL_RUNTIME_IDENTITY);
    try {
      await expect(store.list()).rejects.toThrow();
      expect(await readFile(file)).toEqual(damaged);
      // On Windows an unclosed SQLite connection prevents this repair rename.
      await rename(file, `${file}.backup`);
      expect(await store.list()).toEqual([]);
      expect(await readFile(`${file}.backup`)).toEqual(damaged);
    } finally { store.close(); }
  });
  it('keeps one ASR line when overlapping capture sessions transcribe the same words', async () => {
    const store = new MeetingStore(await temporaryRoot(), LOCAL_RUNTIME_IDENTITY);
    const meeting = await store.create({ title: '重复转写检查' });
    const line = { meetingId: meeting.id, speaker: '本地 ASR', text: '小佳米，帮我解释一下。', capturedAt: '2026-10-08T03:56:38.779Z' };
    await store.appendAsrTranscript(line);
    const duplicate = await store.appendAsrTranscript({ ...line, capturedAt: '2026-10-08T03:56:38.842Z' });
    expect(duplicate.transcript).toHaveLength(1);
    const later = await store.appendAsrTranscript({ ...line, capturedAt: '2026-10-08T03:56:42.000Z' });
    expect(later.transcript).toHaveLength(2);
    store.close();
  });
  it('retrieves natural-language history without returning the current question itself', async () => {
    const store = new MeetingStore(await temporaryRoot(), LOCAL_RUNTIME_IDENTITY);
    try {
      const old = await store.create({ title: '蓝鲸预算决策' });
      await store.appendTranscript({ meetingId: old.id, speaker: '主持人', text: '蓝鲸项目预算批准为十万元。', capturedAt: new Date().toISOString() });
      const current = await store.create({ title: '本次会议' });
      const query = '上次蓝鲸项目最终批准的预算是多少？';
      await store.appendTranscript({ meetingId: current.id, speaker: '主持人', text: query, capturedAt: new Date().toISOString() });
      const result = await store.search({ query, limit: 6, excludeMeetingId: current.id });
      expect(result.map((item) => item.id)).toEqual([old.id]);
      expect(result[0]?.transcript[0]?.text).toContain('十万元');
    } finally { store.close(); }
  });

  it('returns latest live records and all archived transcript pages beyond 2000', async () => {
    const root = await temporaryRoot();
    const store = new MeetingStore(root, LOCAL_RUNTIME_IDENTITY);
    const meeting = await store.create({ title: '长会议' });
    const db = new DatabaseSync(path.join(root, 'users', LOCAL_RUNTIME_IDENTITY.namespace, 'meeting-assistant', 'meetings.sqlite3'));
    try {
      const insert = db.prepare('INSERT INTO meeting_transcript (meeting_id, sequence, speaker, text, captured_at) VALUES (?, ?, ?, ?, ?)');
      db.exec('BEGIN');
      for (let sequence = 1; sequence <= 2001; sequence += 1) insert.run(meeting.id, sequence, '参会者', '记录' + sequence, new Date().toISOString());
      db.exec('COMMIT');
      expect((await store.get(meeting.id)).transcript.at(-1)?.sequence).toBe(2001);
      expect((await store.readTranscript(meeting.id, 0)).transcript).toHaveLength(1000);
      const full = await store.fullTranscript(meeting.id);
      expect(full).toHaveLength(2001);
      expect(full[0]?.sequence).toBe(1);
      expect(full.at(-1)?.sequence).toBe(2001);
      const journal = store.exportJournal(meeting.id);
      const checkpoint = { fingerprint: 'test', documentId: 'DocToken123', offset: 50, pending: true };
      await journal.save(checkpoint);
      expect(await journal.read()).toEqual(checkpoint);
      const other = await store.create({ title: '另一场会议' });
      await store.exportJournal(other.id).save(checkpoint);
      await journal.clear();
      expect(await journal.read()).toBeNull();
      expect(await store.exportJournal(other.id).read()).toEqual(checkpoint);
    } finally { db.close(); store.close(); }
  });
  it('persists transcript, completion metadata, listing, and search', async () => {
    const root = await temporaryRoot();
    const archiveRoot = path.join(root, 'Desktop', '录音');
    const store = new MeetingStore(root, LOCAL_RUNTIME_IDENTITY, archiveRoot);
    const meeting = await store.create({ title: '产品评审会' });
    await store.appendTranscript({
      meetingId: meeting.id,
      speaker: '张一鸣',
      text: '决定九月发布会议助手。',
      capturedAt: '2026-09-02T08:00:00.000Z',
    });
    await store.appendAudio({
      meetingId: meeting.id,
      mimeType: 'audio/webm;codecs=opus',
      data: new Uint8Array([1, 2, 3, 4]),
      capturedAt: '2026-09-02T08:00:05.000Z',
    });
    await store.appendArchiveAudio({
      meetingId: meeting.id,
      sessionId: '20260902T160000-1234abcd',
      sequence: 1,
      mimeType: 'audio/webm;codecs=opus',
      data: new Uint8Array([10, 11]),
      final: false,
    });
    await store.appendArchiveAudio({
      meetingId: meeting.id,
      sessionId: '20260902T160000-1234abcd',
      sequence: 2,
      mimeType: 'audio/webm;codecs=opus',
      data: new Uint8Array([12]),
      final: true,
    });
    const audioDirectoryBeforeCompletion = await store.getAudioDirectory(meeting.id);
    const completed = await store.complete({
      meetingId: meeting.id,
      title: '会议助手九月发布评审',
      summary: '确认会议助手九月发布。',
      actionItems: ['完成会议文档归档'],
    });
    const published = await store.attachKnowledgeArticle(
      meeting.id,
      'knowledge-article-1',
      'reviewing',
      '示例项目',
    );
    expect(published).toMatchObject({
      knowledgeArticleId: 'knowledge-article-1',
      knowledgeStatus: 'reviewing',
      knowledgeProjectName: '示例项目',
    });
    await store.updateKnowledgeStatus(meeting.id, 'approved');
    expect(completed.status).toBe('completed');
    expect(completed.title).toBe('会议助手九月发布评审');
    expect(completed.transcript[0]?.text).toContain('九月发布');
    expect(completed.audio[0]).toMatchObject({ sequence: 1, byteLength: 4 });
    const audioDirectory = await store.getAudioDirectory(meeting.id);
    expect(audioDirectory).toBe(audioDirectoryBeforeCompletion);
    expect(path.basename(audioDirectory)).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_产品评审会_[0-9a-f]{8}$/);
    await expect(readFile(path.join(audioDirectory, '分片', '000001.webm'))).resolves.toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
    await expect(readFile(path.join(audioDirectory, '完整录音.webm'))).resolves.toEqual(
      Buffer.from([10, 11, 12]),
    );
    await expect(readFile(await store.getPlayableAudioPath(meeting.id), 'utf8')).resolves.toContain(
      '完整录音.webm',
    );
    expect((await store.list())[0]).toMatchObject({
      actionItems: ['完成会议文档归档'],
      knowledgeStatus: 'approved',
    });
    expect((await store.search({ query: '会议助手', limit: 6 }))[0]?.id).toBe(meeting.id);
    store.close();

    const reopened = new MeetingStore(root, LOCAL_RUNTIME_IDENTITY, archiveRoot);
    expect((await reopened.list())[0]).toMatchObject({
      summary: '确认会议助手九月发布。',
      knowledgeArticleId: 'knowledge-article-1',
      knowledgeStatus: 'approved',
      knowledgeProjectName: '示例项目',
    });
    reopened.close();
  });

  it('keeps authenticated meeting histories in separate namespaces', async () => {
    const root = await temporaryRoot();
    const first = new MeetingStore(root, authenticatedRuntimeIdentity('user-a'));
    const second = new MeetingStore(root, authenticatedRuntimeIdentity('user-b'));
    await first.create({ title: '甲的会议' });
    expect(await second.list()).toEqual([]);
    first.close();
    second.close();
  });

  it('counts separately opened sessions as ordered meetings on the same day', async () => {
    const store = new MeetingStore(await temporaryRoot(), LOCAL_RUNTIME_IDENTITY);
    const first = await store.create({ title: '测试一' });
    const second = await store.create({ title: '测试二' });
    await expect(store.getDayPosition(first.id)).resolves.toEqual({ sequence: 1, total: 2 });
    await expect(store.getDayPosition(second.id)).resolves.toEqual({ sequence: 2, total: 2 });
    store.close();
  });

  it('automatically finalizes recording meetings when the application closes', async () => {
    const store = new MeetingStore(await temporaryRoot(), LOCAL_RUNTIME_IDENTITY);
    const first = await store.create(
      { title: '关闭前的会议', knowledgeProjectId: 'project-1' },
      { id: 'project-1', name: '会议助手' },
    );
    await store.appendTranscript({
      meetingId: first.id,
      speaker: '参会者',
      text: '这段内容应该被保留。',
      capturedAt: '2026-09-12T09:05:00.000Z',
    });

    const completedAt = '2026-09-12T09:10:00.000Z';
    const finalized = await store.finalizeRecordingMeetings(completedAt);

    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({
      id: first.id,
      status: 'completed',
      endedAt: completedAt,
      summaryStatus: 'pending',
      knowledgeScopeProjectId: 'project-1',
      knowledgeScopeProjectName: '会议助手',
      summary: '应用关闭时自动结束；完整内容请查看逐字稿。',
    });
    expect(finalized[0]?.transcript[0]?.text).toBe('这段内容应该被保留。');
    await expect(store.finalizeRecordingMeetings(completedAt)).resolves.toEqual([]);

    const next = await store.create({ title: '重新打开后的会议' });
    expect(next.id).not.toBe(first.id);
    expect(next.status).toBe('recording');
    expect(next.summaryStatus).toBe('pending');
    const summarized = await store.complete({
      meetingId: first.id,
      title: '关闭后生成的纪要',
      summary: '已在下次启动后完成总结。',
      actionItems: [],
    });
    expect(summarized.summaryStatus).toBe('completed');
    expect(summarized.endedAt).toBe(completedAt);
    store.close();
  });
});
