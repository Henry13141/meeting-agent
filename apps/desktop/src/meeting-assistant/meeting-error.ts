export function meetingErrorMessage(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught || 'UNKNOWN');
  const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '');
  if (/MODEL_[A-Z_]*(?:NOT_CONFIGURED|CREDENTIAL_REQUIRED|EXPIRED)/u.test(message)) {
    return '请在本机.env.local配置模型接口后重启。录音和已保存的记录不受影响。';
  }
  const extensionErrors: Record<string, string> = {
    EXTENSION_CONFIG_INVALID: '扩展配置无效，请检查本地扩展配置并参照扩展指南。录音不受影响。',
    SKILL_NOT_FOUND: '所选扩展技能已不存在，请刷新扩展配置后重新选择。',
    SKILL_UNAVAILABLE: '所选技能关联的工具未就绪，请检查扩展服务器状态。',
    TOOL_NOT_ALLOWED: '此工具不在本次技能的允许范围内，未执行操作。',
    TOOL_ARGUMENTS_INVALID: '工具参数未通过校验，未提交执行。请核对后重试。',
    TOOL_CALL_LIMIT_EXCEEDED: '本次请求已达到工具调用次数上限，已停止继续调用。请缩小任务后重试。',
    TOOL_TIMEOUT: '工具执行超时，不能确认操作结果。请先核对目标系统，再决定是否重试。',
    TOOL_APPROVAL_TIMEOUT: '本次写入确认已超时，未因等待而自动允许执行。请重新提出请求。',
    TOOL_APPROVAL_DENIED: '已拒绝本次写入操作，会议记录仍保存在本地。',
    TOOL_APPROVAL_RESOLUTION_FAILED: '本次确认决定未被服务接受，无法确认执行状态。请检查目标系统后再重试。',
    MCP_SERVER_UNAVAILABLE: '办公工具服务器不可用，请检查本地扩展配置与连接。',
    MCP_TOOL_FAILED: '工具返回执行失败。请核对目标系统中的实际结果，再决定是否重试。',
    TOOL_RESULT_TOO_LARGE: '工具回执超过配置的大小上限，未截断内容供模型使用。请缩小查询范围后重试。',
    SKILL_TOO_LARGE: '技能文件超过配置的大小上限，请检查并精简技能内容。',
    EXTENSION_LIMIT_EXCEEDED: '扩展配置超过数量或大小上限，请检查配置并缩小范围。',
    MODEL_RESPONSE_TOO_LARGE: '模型回复超过配置的大小上限，请缩小任务后重试。',
    MEETING_RUN_IDLE_TIMEOUT: '模型或工具长时间没有新进度，本次等待已停止。请核对工具执行状态后再重试；录音和逐字稿已保留。',
  };
  if (Object.hasOwn(extensionErrors, message)) return extensionErrors[message]!;
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
