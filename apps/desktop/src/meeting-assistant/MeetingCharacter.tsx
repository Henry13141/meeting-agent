import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { MeetingClip } from './meeting-video-sequence';
import type { SpeakerDirection } from './speaker-direction';
import { MeetingVideoPlayer, type MeetingVideoSource } from './meeting-video-player';
import idle1 from './assets/character/idle-1.mp4';
import idle2 from './assets/character/idle-2.mp4';
import idle3 from './assets/character/idle-3.mp4';
import idle4 from './assets/character/idle-4.mp4';
import speakingStart from './assets/character/speaking-start.mp4';
import speakingLoop from './assets/character/speaking-loop.mp4';
import speakingEnd from './assets/character/speaking-end.mp4';
import turnLeft from './assets/character/turn-left.mp4';
import returnLeft from './assets/character/return-left.mp4';
import turnRight from './assets/character/turn-right.mp4';
import centerBridge from './assets/character/center-bridge.mp4';
import entrance from './assets/character/entrance.mp4';

export interface MeetingCharacterPlayback {
  startSpeech(): Promise<boolean>;
  stopSpeech(): void;
}

const CLIPS: Record<MeetingClip, MeetingVideoSource> = {
  entrance: { src: entrance },
  // Manually inspected blink + recovery windows; the right boundary is open-eyed.
  'idle-1': { src: idle1, avoidSpeechCutRanges: [[30 / 24, 38 / 24], [50 / 24, 57 / 24]] },
  'idle-2': { src: idle2, avoidSpeechCutRanges: [[4 / 24, 14 / 24], [84 / 24, 92 / 24]] },
  'idle-3': { src: idle3, avoidSpeechCutRanges: [[7 / 24, 24 / 24], [79 / 24, 89 / 24]] },
  'idle-4': { src: idle4, avoidSpeechCutRanges: [[7 / 24, 20 / 24], [98 / 24, 110 / 24]] },
  // Measured at 24 fps: opening mouth at .25s; the ending only closes at frames 117–120.
  // Show the opening from frame zero; release audio when its decoded cue is visible.
  // Keep original assets intact and retain the final neutral frame (no early handoff).
  'speaking-start': { src: speakingStart, speechCue: .25, closedMouthRanges: [[80 / 24, 81 / 24], [94 / 24, 96 / 24], [108 / 24, 110 / 24]] },
  'speaking-loop': { src: speakingLoop, closedMouthRanges: [[43 / 24, 44 / 24], [73 / 24, 75 / 24]] },
  // Four existing frames at 0.8x allow a ~208ms closure without adding synthetic frames.
  'speaking-end': { src: speakingEnd, start: 117 / 24, end: 121 / 24, handoffLead: 0, playbackRate: .8 },
  'turn-left': { src: turnLeft }, 'return-left': { src: returnLeft },
  // These are phases of the same take; the player crosses 10s without loading or seeking.
  'turn-right': { src: turnRight, end: 10 }, 'return-right': { src: turnRight, start: 10 },
  // Skip the reference-image flash before this take settles into its actual exposure.
  'center-bridge': { src: centerBridge, start: .3 },
};

export function MeetingCharacter({ speaking, direction, active, playbackRef }: {
  speaking: boolean; direction: SpeakerDirection; active: boolean; playbackRef: RefObject<MeetingCharacterPlayback | null>;
}) {
  const videos = useRef<(HTMLVideoElement | null)[]>([null, null, null]);
  const player = useRef<MeetingVideoPlayer | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const toneCurves = useRef<(SVGFEComponentTransferElement | null)[]>([null, null, null]);
  const toneId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [error, setError] = useState('');

  useEffect(() => {
    const [first, second, ending] = videos.current;
    if (!first || !second || !ending || !canvas.current) return;
    const controller = new MeetingVideoPlayer([first, second, ending], CLIPS, setError, (slot, gamma) => {
      const curve = toneCurves.current[slot];
      if (curve) for (const channel of curve.children) channel.setAttribute('exponent', gamma.toFixed(4));
      return `url(#${toneId}-tone-${slot})`;
    }, canvas.current);
    player.current = controller;
    playbackRef.current = controller;
    return () => { controller.dispose(); player.current = null; playbackRef.current = null; };
  }, [toneId, playbackRef]);

  useEffect(() => { player.current?.update(speaking, direction, active); }, [speaking, direction, active]);

  return <>
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
      <defs>{[0, 1, 2].map(slot => <filter key={slot} id={`${toneId}-tone-${slot}`} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
        <feComponentTransfer ref={element => { toneCurves.current[slot] = element; }}>
          <feFuncR type="gamma" amplitude="1" exponent="1" offset="0" />
          <feFuncG type="gamma" amplitude="1" exponent="1" offset="0" />
          <feFuncB type="gamma" amplitude="1" exponent="1" offset="0" />
        </feComponentTransfer>
      </filter>)}</defs>
    </svg>
    {[0, 1, 2].map(slot => <video
      key={slot}
      ref={element => { videos.current[slot] = element; }}
      className="meeting-stage__video is-inactive"
      data-active="false"
      muted playsInline preload="auto" aria-hidden="true"
    />)}
    <canvas ref={canvas} className="meeting-stage__canvas" aria-hidden="true" />
    {error ? <p className="meeting-stage__video-error" role="status">{error}</p> : null}
  </>;
}
