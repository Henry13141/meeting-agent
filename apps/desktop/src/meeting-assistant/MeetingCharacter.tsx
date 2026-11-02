import { useEffect, type RefObject } from 'react';
import type { SpeakerDirection } from './speaker-direction';

export interface MeetingCharacterPlayback {
  startSpeech(): Promise<boolean>;
  stopSpeech(): void;
}

/** Original, asset-free status visual. Speech never waits on video loading. */
export function MeetingCharacter({ speaking, direction, active, playbackRef }: {
  speaking: boolean; direction: SpeakerDirection; active: boolean; playbackRef: RefObject<MeetingCharacterPlayback | null>;
}) {
  useEffect(() => {
    playbackRef.current = { startSpeech: async () => true, stopSpeech: () => {} };
    return () => { playbackRef.current = null; };
  }, [playbackRef]);
  return <div className={`meeting-character ${speaking ? 'is-speaking' : ''} ${active ? 'is-active' : ''}`} data-direction={direction} role="img" aria-label={speaking ? '会议助手正在回答' : active ? '会议助手正在聆听' : '会议助手已暂停'}>
    <svg viewBox="0 0 240 240" aria-hidden="true" focusable="false">
      <circle className="meeting-character__halo" cx="120" cy="120" r="100" />
      <rect className="meeting-character__face" x="55" y="65" width="130" height="110" rx="42" />
      <circle cx="93" cy="108" r="8" /><circle cx="147" cy="108" r="8" />
      <path className="meeting-character__mouth" d="M 100 141 Q 120 153 140 141" />
      <path className="meeting-character__antenna" d="M 120 65 V 43" /><circle cx="120" cy="38" r="7" />
    </svg>
    <div className="meeting-character__signal" aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <i key={i} />)}</div>
  </div>;
}
