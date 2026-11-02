import type { MeetingProposedAction } from './meeting-answer';

function canonical(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/[\s，。！？、,.!?：:；;“”"']/g, '');
}

/**
 * Resolve a small, explicit set of local meeting commands without asking the
 * model to infer which Electron capability exists. Every result remains a
 * proposal and must pass through the same confirmation gate as model output.
 */
export function localMeetingActionIntent(value: string): MeetingProposedAction | null {
  const command = canonical(value);
  if (!command) return null;

  if (/^(播放|打开播放|帮我播放|请播放)(本次|这次|当前)?(会议)?(完整)?录音(文件)?$/.test(command)
    || /^(听|试听|听一下)(本次|这次|当前)?(会议)?(完整)?录音$/.test(command)
    || /^(打开|启动)(本次|这次|当前)?(会议)?录音播放器$/.test(command)) {
    return { kind: 'play_audio' };
  }
  if (/^(打开|帮我打开|请打开)(本次|这次|当前)?(会议)?录音(文件夹|目录)$/.test(command)) {
    return { kind: 'open_audio_folder' };
  }
  if (/^(结束|停止)(本次|这次|当前)?(会议|记录|录音)$/.test(command)
    || /^(结束并归档|归档)(本次|这次|当前)?会议$/.test(command)) {
    return { kind: 'end_meeting' };
  }
  return null;
}
