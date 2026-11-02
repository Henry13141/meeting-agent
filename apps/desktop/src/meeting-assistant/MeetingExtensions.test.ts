// @vitest-environment happy-dom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MeetingExtensionCatalog } from '../shared/contracts';
import { ExtensionCatalogView, MeetingToolApprovalCard, MeetingToolProgressView, selectedExtensionSkills } from './MeetingExtensions';
import { parseMeetingToolApproval } from './meeting-tool-events';

const catalog: MeetingExtensionCatalog = {
  revision: 'one',
  skills: [{ id: 'office', name: '文档协作', description: '检查后写入文档', tools: ['office_read', 'office_write'], available: true },
    { id: 'offline', name: '未连接技能', description: '', tools: ['offline_read'], available: false }],
  tools: [{ name: 'office_read', description: '读取文档', serverId: 'office', effect: 'read' },
    { name: 'office_write', description: '更新文档', serverId: 'office', effect: 'write' }],
  servers: [{ id: 'office', status: 'ready' }, { id: 'offline', status: 'error', error: 'MCP_SERVER_UNAVAILABLE' }],
};
const dom = (node: Parameters<typeof renderToStaticMarkup>[0]) => {
  const element = document.createElement('div'); element.innerHTML = renderToStaticMarkup(node); return element;
};

describe('extension settings', () => {
  it('shows an empty-state guide without blocking built-in meeting functions', () => {
    const view = dom(createElement(ExtensionCatalogView, { catalog: { revision: 'empty', skills: [], tools: [], servers: [] }, loading: false, selected: [], onChange: vi.fn(), onRefresh: vi.fn() }));
    expect(view.textContent).toContain('尚未加载扩展技能');
    expect(view.textContent).toContain('扩展指南');
    expect(view.textContent).toContain('录音与内置会议技能仍可使用');
    expect(view.querySelectorAll('input')).toHaveLength(0);
  });
  it('shows the real read/write effects, connection state and selected available skills', () => {
    const selected = selectedExtensionSkills(catalog, ['office', 'offline', 'missing', 'office']);
    expect(selected).toEqual(['office']);
    const view = dom(createElement(ExtensionCatalogView, { catalog, loading: false, selected, onChange: vi.fn(), onRefresh: vi.fn() }));
    const inputs = view.querySelectorAll('input');
    expect(inputs[0].checked).toBe(true); expect(inputs[1].disabled).toBe(true);
    expect(view.textContent).toContain('只读');
    expect(view.textContent).toContain('写入 · 每次确认');
    expect(view.textContent).toContain('office：已连接');
    expect(view.textContent).toContain('offline：连接失败');
  });
});

describe('specific tool confirmation', () => {
  it('renders complete JSON and purpose as safe text, including a large valid argument', () => {
    const text = '<img src=x onerror="alert(1)">' + '甲'.repeat(65_536);
    const approval = parseMeetingToolApproval('request', 'thread', 'run', { approvalId: 'approval', threadId: 'thread', runId: 'run', toolName: 'office_write', serverId: 'office', description: '<script>execute()</script>', arguments: { text } });
    expect(approval).not.toBeNull();
    const view = dom(createElement(MeetingToolApprovalCard, { approval: approval!, onDecision: vi.fn() }));
    expect(view.querySelector('img, script')).toBeNull();
    expect(view.querySelector('pre')?.textContent).toBe(JSON.stringify({ text }, null, 2));
    expect(view.textContent).toContain('允许这一次'); expect(view.textContent).toContain('拒绝执行');
    expect(view.textContent).toContain('允许不代表执行已经成功');
    const submitting = dom(createElement(MeetingToolApprovalCard, { approval: { ...approval!, submitting: true }, onDecision: vi.fn() }));
    expect([...submitting.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
  });
  it('does not turn a tool-result receipt into a success claim', () => {
    const view = dom(createElement(MeetingToolProgressView, { progress: { toolName: 'office_write', serverId: 'office', phase: 'result', status: 'failed' } }));
    expect(view.textContent).toContain('工具报告失败');
    expect(view.textContent).not.toContain('成功');
  });
});

it('rejects unreasonable approval deadlines rather than presenting an unbounded wait', () => {
  const data = { approvalId: 'approval', threadId: 'thread', runId: 'run', toolName: 'write', serverId: 'office', description: '说明', arguments: {} };
  expect(parseMeetingToolApproval('request', 'thread', 'run', { ...data, expiresAt: Date.now() + 1_801_000 })).toBeNull();
  expect(parseMeetingToolApproval('request', 'thread', 'run', { ...data, expiresAt: Number.NaN })).toBeNull();
  expect(parseMeetingToolApproval('request', 'thread', 'run', data)?.expiresAt).toBeGreaterThan(Date.now());
});
