import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MeetingAssistant } from '../../meeting-assistant/MeetingAssistant';
import type { StandaloneStatus } from '../../shared/standalone-contracts';
import type { MeetingRecord } from '../../shared/contracts';
import './style.css';

function App() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<StandaloneStatus | null>(null);
  const [records, setRecords] = useState<MeetingRecord[]>([]);
  const [error, setError] = useState('');
  const refresh = async () => {
    const [next, meetings] = await Promise.all([window.meetingHost.status(), window.meetingAgent.meetings.list(50)]);
    setStatus(next); setRecords(meetings);
  };
  useEffect(() => {
    void refresh().catch(() => setError('运行状态读取失败'));
    const timer = setInterval(() => { void refresh().catch(() => undefined); }, 5_000);
    return () => clearInterval(timer);
  }, []);
  return <>
    <main><MeetingAssistant /></main>
    <button className="standalone-status-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      Meeting Agent · {status?.runtime.modelReady ? '模型已配置' : '模型待配置'}
    </button>
    {open ? <aside className="standalone-panel" aria-label="独立版运行状态">
      <header><h1>Meeting Agent</h1><button onClick={() => setOpen(false)} aria-label="关闭运行状态">×</button></header>
      <p>录音、本地转写与可配置模型的会议助手</p>
      <dl>
        <dt>会议运行服务</dt><dd>{status?.runtime.ready ? '已启动' : status?.runtime.phase || '正在启动'}</dd>
        <dt>模型问答与纪要</dt><dd>{status?.runtime.modelReady ? '接口已配置，实际效果以调用结果为准' : '请在本机 .env.local 配置模型接口后重启'}</dd>
        <dt>本地语音识别</dt><dd>{status?.asr.ready ? '已就绪' : status?.asr.error ? '不可用，请检查本机配置' : '正在准备本机服务'}</dd>
        <dt>数据保存</dt><dd>本项目 .local-data 目录</dd>
        <dt>云文档与协作软件</dt><dd>第一步先保存到本机；后续按实际办公软件选择接入，当前未同步云文档。</dd>
      </dl>
      {status?.runtime.error ? <p role="status">运行提示：{status.runtime.error}</p> : null}
      {status?.asr.error ? <p role="status">转写提示：{status.asr.error}</p> : null}
      <div className="standalone-actions">
        <button onClick={() => void window.meetingHost.openDataDirectory()}>打开本地数据目录</button>
      </div>
      <h2>已保存的会议</h2>
      {records.length ? <ul>{records.map((m) => <li key={m.id}><strong>{m.title}</strong><small>{m.status === 'completed' ? '已归档' : '记录中'} · {m.transcript.length} 条可见文字 · {m.audio.length} 个可见录音分片</small><button disabled={m.status !== 'completed'} onClick={() => void window.meetingHost.exportMarkdown(m.id).catch(() => setError('导出失败'))}>导出 Markdown</button></li>)}</ul> : <p>尚无会议。使用“开始记录”创建第一场会议。</p>}
      {error ? <p role="alert">{error}</p> : null}
      <p className="standalone-note">首次使用可按 README 或配置指引准备本机依赖。模型服务由使用者自行选择；会议文件默认保存在本机，云文档同步可后续选配。</p>
    </aside> : null}
  </>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
