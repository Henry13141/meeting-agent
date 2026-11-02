import { useEffect, useState } from 'react';
import type { MeetingExtensionCatalog } from '../shared/contracts';
import type { MeetingToolApproval, MeetingToolProgress } from './meeting-tool-events';
import { meetingToolProgressText } from './meeting-tool-events';

export function selectedExtensionSkills(catalog: MeetingExtensionCatalog | null, selected: readonly string[]): string[] {
  const available = new Set(catalog?.skills.filter(skill => skill.available).map(skill => skill.id) ?? []);
  return [...new Set(selected.filter(id => available.has(id)))];
}

export function ExtensionCatalogView({ catalog, loading, selected, onChange, onRefresh }: {
  catalog: MeetingExtensionCatalog | null; loading: boolean; selected: readonly string[];
  onChange: (ids: string[]) => void; onRefresh: () => void;
}) {
  const statuses = { ready: '已连接', disabled: '未启用', error: '连接失败' };
  return <section className="meeting-extensions" aria-label="扩展技能与办公工具">
    <header><strong>扩展技能与办公工具</strong><button type="button" disabled={loading} onClick={onRefresh}>{loading ? '正在读取目录…' : '重新读取目录'}</button></header>
    <p>勾选技能后，会议助手可使用其关联的已配置工具。写入操作每次都需要确认；会议分段总结不会启用扩展。</p>
    <p>修改本机扩展配置或 Skill 文件后，请重启应用再使用。</p>
    {catalog?.error ? <p role="alert">扩展配置读取失败，请检查本地配置并参照仓库扩展指南。</p> : null}
    {!loading && !catalog?.skills.length ? <p>尚未加载扩展技能。请参照仓库扩展指南（docs/扩展接入指南.md）配置本地技能和办公工具；录音与内置会议技能仍可使用。</p> : null}
    <div className="meeting-extensions__skills">
      {catalog?.skills.map(skill => <label key={skill.id}>
        <input type="checkbox" checked={selected.includes(skill.id)} disabled={!skill.available || loading || (!selected.includes(skill.id) && selected.length >= 16)} onChange={event => onChange(event.currentTarget.checked ? [...selected, skill.id] : selected.filter(id => id !== skill.id))} />
        <span><strong>{skill.name}</strong>{!skill.available ? '（工具未就绪）' : ''}<small>{skill.description}</small><small>关联工具：{skill.tools.length ? skill.tools.join('、') : '仅提供技能指引'}</small></span>
      </label>)}
    </div>
    {catalog?.servers.length ? <ul aria-label="扩展服务器状态">{catalog.servers.map(server => <li key={server.id}>{server.id}：{statuses[server.status]}{server.error ? '，请检查本地扩展配置' : ''}</li>)}</ul> : null}
    {catalog?.tools.length ? <ul aria-label="已配置办公工具">{catalog.tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong> · {tool.effect === 'write' ? '写入 · 每次确认' : '只读'} · {tool.serverId}<small>{tool.description}</small></li>)}</ul> : null}
  </section>;
}

export function MeetingExtensions({ selected, onChange }: { selected: readonly string[]; onChange: (ids: string[]) => void }) {
  const [catalog, setCatalog] = useState<MeetingExtensionCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const list = window.meetingAgent.agent.listExtensions;
    // Static render fixtures may provide only the pre-extension API surface.
    if (typeof list !== 'function') return;
    setLoading(true);
    void list().then(result => { if (active) setCatalog(result); }).catch(() => {
      if (active) setCatalog({ revision: '', skills: [], tools: [], servers: [], error: 'EXTENSION_CONFIG_INVALID' });
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  useEffect(() => {
    if (loading || !catalog) return;
    const allowed = selectedExtensionSkills(catalog, selected);
    if (allowed.length !== selected.length) onChange(allowed);
  }, [catalog, loading, selected, onChange]);
  return <ExtensionCatalogView catalog={catalog} loading={loading} selected={selected} onChange={onChange} onRefresh={() => setRevision(value => value + 1)} />;
}

export function MeetingToolApprovalCard({ approval, onDecision }: {
  approval: MeetingToolApproval; onDecision: (approval: MeetingToolApproval, decision: 'approve' | 'deny') => void;
}) {
  return <section className="meeting-tool-approval" role="region" aria-label="办公工具写入确认">
    <h3>确认这一次写入操作</h3>
    <p><strong>工具：</strong>{approval.toolName} · {approval.serverId}</p>
    <p><strong>用途：</strong>{approval.description || '工具未提供用途说明，请核对工具名称与本次参数。'}</p>
    <p>请核对本次操作参数。只有点击允许后才会提交；允许不代表执行已经成功。</p>
    <p>确认截止：<time dateTime={new Date(approval.expiresAt).toISOString()}>{new Date(approval.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}</time>；超时不会自动允许。</p>
    <pre aria-label="本次工具参数">{JSON.stringify(approval.arguments, null, 2)}</pre>
    <div><button type="button" disabled={approval.submitting} onClick={() => onDecision(approval, 'approve')}>{approval.submitting ? '正在提交决定…' : '允许这一次'}</button><button type="button" disabled={approval.submitting} onClick={() => onDecision(approval, 'deny')}>拒绝执行</button></div>
  </section>;
}

export function MeetingToolProgressView({ progress }: { progress: MeetingToolProgress | null }) {
  return progress ? <p className="meeting-tool-progress" role="status">{meetingToolProgressText(progress)}</p> : null;
}
