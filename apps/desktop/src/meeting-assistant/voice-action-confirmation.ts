export type VoiceActionDecision = 'confirm' | 'cancel' | 'unknown';

function canonical(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/[\s，。！？、,.!?：:；;“”"']/g, '');
}

const CONFIRM_PHRASES = [
  '确认执行', '我确认执行', '确认', '可以执行', '执行吧', '开始执行', '同意执行', '就这么办',
] as const;
const CANCEL_PHRASES = [
  '取消执行', '取消', '不要执行', '不确认执行', '不能执行', '不可以执行', '先不要', '算了', '停止执行',
] as const;

export function voiceActionDecision(value: string): VoiceActionDecision {
  const normalized = canonical(value);
  if (CANCEL_PHRASES.some((phrase) => normalized === canonical(phrase))) return 'cancel';
  if (CONFIRM_PHRASES.some((phrase) => normalized === canonical(phrase))) return 'confirm';
  return 'unknown';
}
