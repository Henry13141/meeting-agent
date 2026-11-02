export function meetingErrorMessage(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught || 'UNKNOWN');
  const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '');
  if (/MODEL_[A-Z_]*(?:NOT_CONFIGURED|CREDENTIAL_REQUIRED|EXPIRED)/u.test(message)) {
    return '请在本机.env.local配置模型接口后重启。录音和已保存的记录不受影响。';
  }
  if (message === 'CONTEXT_LIMIT_EXCEEDED') {
    return '模型对话历史已超过上下文上限，请点击“重新连接会议 Agent”重置模型对话历史。录音和逐字稿会保留；随后可重新提问或重新总结。';
  }
  if (message === 'MODEL_REQUEST_FAILED') return '模型接口请求失败，请检查模型服务及本机.env.local配置。录音和逐字稿已保留。';
  if (message === 'MODEL_REPLY_INVALID') return '模型未返回有效文字，请重试。录音和逐字稿已保留。';
  if (message === 'TOOLS_UNAVAILABLE') return '会议模型请求了不支持的工具，未执行任何外部操作。请重试或更换模型。';
  if (message === 'RUN_INTERRUPTED') return '上次模型请求已中断，请重新提问。录音和逐字稿已保留。';
  if (message.includes('EPERM') && message.includes('rename')) {
    return '录音目录正在被其他程序使用。录音文件仍然安全，请关闭资源管理器后重试归档。';
  }
  if (message === 'MEETING_AUDIO_SOURCE_REQUIRED') {
    return '开始记录需要打开麦克风。会议助手的回答会写入文字稿，不从扬声器回录。';
  }
  if (message === 'MEETING_AUDIO_ALREADY_RECORDING') {
    return '会议已经在记录中，请继续说话；如果要重新开始，请先暂停当前会议。';
  }
  if (message === 'MEETING_AUDIO_UNAVAILABLE') {
    return '当前环境无法启动会议录音，请检查麦克风和录音设备。';
  }
  if (message === 'MEETING_SUMMARY_FORMAT_INVALID') {
    return '模型返回的纪要格式不完整，已保留原纪要，请点击“重新总结”重试。';
  }
  if (message.includes('MEETING_ASR_UNAVAILABLE') || message.includes('MEETING_ASR_TRANSCRIPTION_FAILED')) {
    return '本地 ASR 失败，录音仍在保存。请检查本地模型与运行环境，稍后重新开始记录以重试转写。';
  }
  return message;
}
